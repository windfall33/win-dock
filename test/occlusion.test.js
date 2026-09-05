'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isDesktopForeground, isCursorNearBar, decideOcclusionState } = require('../src/core/occlusion.js');

const DESKTOP = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'SHELLDLL_DefView']);
const IDLE = { onDesktopNow: false, fullscreenHide: false, coveredHideNow: false, dockHiddenByUs: false };

test('isDesktopForeground: null/无exe/桌面类名 → 桌面；普通窗口 → 非桌面', () => {
  assert.equal(isDesktopForeground(null, DESKTOP), true);
  assert.equal(isDesktopForeground({ c: 'Progman', e: '' }, DESKTOP), true);
  assert.equal(isDesktopForeground({ c: 'Notepad', e: 'notepad.exe' }, DESKTOP), false);
  assert.equal(isDesktopForeground({ c: 'WorkerW', e: 'explorer.exe' }, DESKTOP), true);
});

test('isCursorNearBar: 条内及 ±margin 内为 true，超出为 false，无光标为 false', () => {
  const bar = { l: 100, t: 700, r: 900, b: 760 };
  assert.equal(isCursorNearBar({ x: 500, y: 730 }, bar), true);
  assert.equal(isCursorNearBar({ x: 500, y: 760 + 90 }, bar), true);   // 恰好贴边
  assert.equal(isCursorNearBar({ x: 500, y: 760 + 91 }, bar), false);
  assert.equal(isCursorNearBar({ x: 100 - 91, y: 730 }, bar), false);
  assert.equal(isCursorNearBar(null, bar), false);
  assert.equal(isCursorNearBar({ x: 500, y: 730 }, null), false);
  assert.equal(isCursorNearBar({ x: 500, y: 730 }, bar, 10), true);
  assert.equal(isCursorNearBar({ x: 500, y: 730 - 45 }, bar, 10), false);
});

test('状态机：桌面前台 → 永远显示，清全部隐藏标志', () => {
  const r = decideOcclusionState({
    isDesktop: true, occFull: false, occludeAway: true, cursorNear: false,
    prev: { onDesktopNow: false, fullscreenHide: true, coveredHideNow: true, dockHiddenByUs: true },
  });
  assert.deepEqual(r.next, { onDesktopNow: true, fullscreenHide: false, coveredHideNow: false, dockHiddenByUs: false });
  assert.equal(r.envChanged, true);
  assert.equal(r.fullscreenAwayChanged, null); // 桌面分支静默复位，不打日志
});

test('状态机：已在桌面再查询 → 不重复推 env', () => {
  const r = decideOcclusionState({
    isDesktop: true, occFull: false, occludeAway: false, cursorNear: false, prev: { ...IDLE, onDesktopNow: true },
  });
  assert.equal(r.envChanged, false);
});

test('状态机：真全屏 + 让位开启 + 光标不近 → 全屏让位', () => {
  const r = decideOcclusionState({
    isDesktop: false, occFull: true, occludeAway: true, cursorNear: false, prev: { ...IDLE },
  });
  assert.equal(r.next.fullscreenHide, true);
  assert.equal(r.next.coveredHideNow, false);
  assert.equal(r.envChanged, true);
  assert.equal(r.fullscreenAwayChanged, true);
});

test('状态机：光标贴近 Dock 时全屏让位被压制（防让位与唤醒打架）', () => {
  const r = decideOcclusionState({
    isDesktop: false, occFull: true, occludeAway: true, cursorNear: true, prev: { ...IDLE },
  });
  assert.equal(r.next.fullscreenHide, false);
});

test('状态机：让位开关关闭 → 真全屏也不让位', () => {
  const r = decideOcclusionState({
    isDesktop: false, occFull: true, occludeAway: false, cursorNear: false, prev: { ...IDLE },
  });
  assert.equal(r.next.fullscreenHide, false);
});

test('状态机：普通最大化窗口矩形覆盖 → 不让位（防隐藏↔唤醒抽搐的回归护栏）', () => {
  const r = decideOcclusionState({
    isDesktop: false, occFull: false, occludeAway: true, cursorNear: false, prev: { ...IDLE },
  });
  assert.equal(r.next.fullscreenHide, false);
  assert.equal(r.next.coveredHideNow, false);
  assert.equal(r.envChanged, false);
});

test('状态机：桌面切到普通窗口 → 即便无其他变化也推一次 env', () => {
  const r = decideOcclusionState({
    isDesktop: false, occFull: false, occludeAway: true, cursorNear: false,
    prev: { onDesktopNow: true, fullscreenHide: false, coveredHideNow: false, dockHiddenByUs: false },
  });
  assert.equal(r.next.onDesktopNow, false);
  assert.equal(r.envChanged, true);
});

test('状态机：让位解除（退出全屏）→ 状态翻转并给 off 日志信号', () => {
  const r = decideOcclusionState({
    isDesktop: false, occFull: false, occludeAway: true, cursorNear: false,
    prev: { onDesktopNow: false, fullscreenHide: true, coveredHideNow: false, dockHiddenByUs: false },
  });
  assert.equal(r.next.fullscreenHide, false);
  assert.equal(r.envChanged, true);
  assert.equal(r.fullscreenAwayChanged, false);
});

test('状态机：非桌面分支保留 dockHiddenByUs，不越权改动 autohide 标志', () => {
  const r = decideOcclusionState({
    isDesktop: false, occFull: false, occludeAway: false, cursorNear: false,
    prev: { onDesktopNow: false, fullscreenHide: false, coveredHideNow: false, dockHiddenByUs: true },
  });
  assert.equal(r.next.dockHiddenByUs, true);
});
