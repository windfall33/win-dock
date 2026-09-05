'use strict';
// 状态快照合成的单测。
// 这段逻辑原先内联在 main.js 的 Electron 副作用之间，无法测试；下沉到
// core/snapshot.js 后可以用假依赖整段验证 —— 这也是后续拆分 main.js 的回归网。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotBuilder } = require('../src/core/snapshot.js');

// 假依赖：settings 用普通对象，icons 直接回显路径，env / trash 用固定值
function makeBuilder(over = {}) {
  const s = Object.assign({
    pins: [],
    recentApps: [],
    iconSize: 52,
    magnification: 1.8,
    autohide: false,
    appearance: 'dark',
    position: 'bottom',
    minimizeEffect: 'genie',
    minimizeIntoIcon: false,
    hideTaskbar: false,
    launchAtLogin: false,
  }, over.settings || {});
  return createSnapshotBuilder({
    getSettingsAll: () => s,
    getSetting: (k) => s[k],
    iconsGetSync: (p) => (p ? 'icon:' + p : null),
    runningProc: over.runningProc || new Set(),
    getEnv: () => ({ position: 'bottom', edgeInset: 8, appActive: false }),
    getTrashCount: () => (over.trash == null ? 0 : over.trash),
  });
}

const win = (h, t, e, extra = {}) => Object.assign({ h, t, e, m: false, f: false }, extra);

test('pinned app receives its windows and the running flag', () => {
  const b = makeBuilder({
    settings: { pins: [{ id: 'p1', kind: 'app', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe' }] },
  });
  const snap = b.build([
    win('1', '无标题 - 记事本', 'C:\\Windows\\notepad.exe'),
    win('2', 'test.txt - 记事本', 'C:\\Windows\\notepad.exe'),
  ], false);
  const e = snap.entries.find((x) => x.id === 'p1');
  assert.equal(e.running, true);
  assert.equal(e.windows.length, 2);
  assert.deepEqual(e.windows.map((w) => w.h), ['1', '2']);
});

test('a window is assigned to at most one pin', () => {
  // 两个固定项指向同一个 exe 时，窗口只能归一个，否则会重复显示
  const b = makeBuilder({
    settings: {
      pins: [
        { id: 'p1', kind: 'app', name: 'A', exe: 'C:\\app.exe' },
        { id: 'p2', kind: 'app', name: 'B', exe: 'C:\\app.exe' },
      ],
    },
  });
  const snap = b.build([win('1', 'T', 'C:\\app.exe')], false);
  const total = snap.entries.reduce((n, e) => n + (e.windows || []).length, 0);
  assert.equal(total, 1);
});

test('unpinned app shows immediately when track=false', () => {
  const snap = makeBuilder().build([win('9', 'Foo', 'C:\\Tools\\foo.exe')], false);
  const e = snap.entries.find((x) => x.id === 'foo.exe');
  assert.ok(e, '未固定应用应出现在 entries 中');
  assert.equal(e.pinned, false);
  assert.equal(e.running, true);
});

test('unpinned app needs two consecutive polls when track=true', () => {
  // 连续两次可见才显示，避免窗口刚创建就闪现
  const b = makeBuilder();
  const w = win('9', 'Foo', 'C:\\Tools\\foo.exe');
  assert.ok(!b.build([w], true).entries.some((x) => x.id === 'foo.exe'),
    '首次轮询不应显示');
  assert.ok(b.build([w], true).entries.some((x) => x.id === 'foo.exe'),
    '连续第二次轮询应显示');
});

test('UWP apps group by window title prefix', () => {
  const snap = makeBuilder().build([
    win('1', '计算器', 'C:\\Windows\\System32\\applicationframehost.exe'),
    win('2', '计算器', 'C:\\Windows\\System32\\applicationframehost.exe'),
  ], false);
  const groups = snap.entries.filter((x) => String(x.id).startsWith('uwp:'));
  assert.equal(groups.length, 1, '同标题的 UWP 窗口应归为一组');
  assert.equal(groups[0].windows.length, 2);
  assert.equal(groups[0].exe, '', 'UWP 条目不带 exe（拿不到真实可执行文件路径）');
});

test('UWP grouping prefers the stable AppUserModelId over the volatile title', () => {
  // 标题随页面切换变化（如「标准/科学」），AUMID 稳定 —— 不同标题的窗口
  // 应归为一组，且键里不含标题片段（3.5 UWP 归组加固）
  const mk = (h, t) => win(h, t, 'C:\\Windows\\System32\\applicationframehost.exe',
    { a: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' });
  const snap = makeBuilder().build([mk('1', '标准'), mk('2', '科学')], false);
  const groups = snap.entries.filter((x) => String(x.id).startsWith('uwp:'));
  assert.equal(groups.length, 1, '同 AUMID 的 UWP 窗口应归为一组');
  assert.equal(groups[0].id, 'uwp:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App');
  assert.equal(groups[0].windows.length, 2);
});

test('UWP windows without AUMID still group by the title-prefix fallback', () => {
  const mk = (h, t) => win(h, t, 'C:\\Windows\\System32\\applicationframehost.exe');
  const snap = makeBuilder().build([mk('1', '某应用'), mk('2', '某应用')], false);
  const groups = snap.entries.filter((x) => String(x.id).startsWith('uwp:'));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'uwp:某应用', 'AUMID 取不到时回退标题前缀，不劣于旧行为');
});

test('UWP grouping by resolved app exe survives title changes across polls', () => {
  // 3.5 加固的核心场景：设置应用切页面标题从「设置」变成「蓝牙和其他设备」，
  // 稳定键（桥接解析出的真实 exe）不变 —— 不应分裂出第二个图标。
  // 按真实轮询序列：首帧不显示（防闪现需连续两帧），第二帧显示，标题变后仍在原组。
  const mk = (h, t) => win(h, t, 'C:\\Windows\\System32\\applicationframehost.exe',
    { a: 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe' });
  const b = makeBuilder();
  b.build([mk('1', '设置')], true);                          // 首帧：不显示
  const r2 = b.build([mk('1', '设置')], true);               // 第二帧：显示
  const r3 = b.build([mk('1', '蓝牙和其他设备')], true);     // 标题变化：不重新计数
  const g2 = r2.entries.filter((x) => String(x.id).startsWith('uwp:'));
  const g3 = r3.entries.filter((x) => String(x.id).startsWith('uwp:'));
  assert.equal(g2.length, 1);
  assert.equal(g3.length, 1, '标题变化后不应分裂出第二个图标');
  assert.equal(g2[0].id, g3[0].id, '标题变化前后应为同一组');
});

test('tray-only app counts as running without any window', () => {
  const b = makeBuilder({
    settings: { pins: [{ id: 'p1', kind: 'app', name: 'WeChat', exe: 'C:\\WeChat\\WeChat.exe' }] },
    runningProc: new Set(['C:\\WeChat\\WeChat.exe']),
  });
  const snap = b.build([], false);
  const e = snap.entries.find((x) => x.id === 'p1');
  assert.equal(e.running, true, '后台/托盘应用应显示为运行中');
  assert.equal(e.windows.length, 0);
});

test('minimizeIntoIcon moves minimized windows out of the right section', () => {
  const w = win('1', 'T', 'C:\\a\\b.exe', { m: true });
  const off = makeBuilder().build([w], false);
  assert.equal(off.minimized.length, 1);
  const on = makeBuilder({ settings: { minimizeIntoIcon: true } }).build([w], false);
  assert.equal(on.minimized.length, 0, '开启后最小化窗口收进应用图标，右侧分区为空');
});

test('badge count comes from window titles', () => {
  const b = makeBuilder({
    settings: { pins: [{ id: 'p1', kind: 'app', name: '微信', exe: 'C:\\WeChat.exe' }] },
  });
  const snap = b.build([win('1', '微信 (3)', 'C:\\WeChat.exe')], false);
  assert.equal(snap.entries.find((x) => x.id === 'p1').badge, 3);
});

test('folder pin keeps its stack view and never runs', () => {
  const b = makeBuilder({
    settings: { pins: [{ id: 'f1', kind: 'folder', name: '下载', exe: 'D:\\dl', stackView: 'fan' }] },
  });
  const snap = b.build([], false);
  const e = snap.entries.find((x) => x.id === 'f1');
  assert.equal(e.kind, 'folder');
  assert.equal(e.running, false);
  assert.equal(e.stackView, 'fan');
  assert.equal(e.folderPath, 'D:\\dl');
});

test('trash count and env pass through the injected deps', () => {
  const snap = makeBuilder({ trash: 7 }).build([], false);
  assert.equal(snap.trash.count, 7);
  assert.equal(snap.env.position, 'bottom');
  assert.equal(snap.settings.position, 'bottom');
});
