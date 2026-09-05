'use strict';
// P1-F1 修饰键点击：决策矩阵 + 「上一个运行中应用」解析（core/modifier-actions.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveModifierAction, previousRunningApp,
} = require('../src/core/modifier-actions.js');

// ---- 决策矩阵（alt/ctrl × 运行/聚焦）----

test('ctrl without alt → reveal (regardless of run state)', () => {
  assert.equal(resolveModifierAction({ alt: false, ctrl: true, targetRunning: false, targetFocused: false }), 'reveal');
  assert.equal(resolveModifierAction({ alt: false, ctrl: true, targetRunning: true, targetFocused: true }), 'reveal');
});

test('alt on focused running target → hide-current', () => {
  assert.equal(resolveModifierAction({ alt: true, ctrl: false, targetRunning: true, targetFocused: true }), 'hide-current');
});

test('alt on running but not focused target → plain activate (mac Option+click semantics)', () => {
  assert.equal(resolveModifierAction({ alt: true, ctrl: false, targetRunning: true, targetFocused: false }), 'activate');
});

test('alt on not-running target → activate (falls through to normal launch)', () => {
  assert.equal(resolveModifierAction({ alt: true, ctrl: false, targetRunning: false, targetFocused: false }), 'activate');
});

test('alt+ctrl on running target → hide-others', () => {
  assert.equal(resolveModifierAction({ alt: true, ctrl: true, targetRunning: true, targetFocused: true }), 'hide-others');
  assert.equal(resolveModifierAction({ alt: true, ctrl: true, targetRunning: true, targetFocused: false }), 'hide-others');
});

test('alt+ctrl on not-running target degrades to activate', () => {
  assert.equal(resolveModifierAction({ alt: true, ctrl: true, targetRunning: false, targetFocused: false }), 'activate');
});

test('no modifiers → activate', () => {
  assert.equal(resolveModifierAction({ alt: false, ctrl: false, targetRunning: true, targetFocused: false }), 'activate');
  assert.equal(resolveModifierAction({}, false), 'activate');
});

test('reveal has priority over alt branches', () => {
  // ctrl+alt 且目标聚焦运行中：文档规定判定优先级 reveal > hide-current/hide-others > activate
  assert.equal(resolveModifierAction({ alt: true, ctrl: true, targetRunning: true, targetFocused: true }), 'hide-others',
    '注意：ctrl+alt 是 hide-others 而非 reveal（reveal 仅 ctrl 单键）');
});

// ---- previousRunningApp（recent LRU 顺序中最近一个仍在运行、且不是当前应用）----

const recent = [
  { id: 'recent:c:\\c.exe', exe: 'C:\\c.exe' },
  { id: 'recent:c:\\b.exe', exe: 'C:\\b.exe' },
  { id: 'recent:c:\\a.exe', exe: 'C:\\a.exe' },
];

test('returns the most recent running app excluding the current one', () => {
  const running = ['C:\\a.exe', 'C:\\b.exe'];
  const r = previousRunningApp(recent, running, 'C:\\b.exe');
  assert.ok(r, '应找到候选');
  assert.equal(r.exe, 'C:\\a.exe', 'b 是当前应用，跳过取 a');
});

test('skips recent entries that are not running', () => {
  const running = ['C:\\a.exe'];
  const r = previousRunningApp(recent, running, 'C:\\x.exe');
  assert.equal(r.exe, 'C:\\a.exe', 'c/b 未运行，取 a');
});

test('exe match is case-insensitive', () => {
  const running = ['c:\\A.EXE'];
  const r = previousRunningApp(recent, running, '');
  assert.equal(r.exe, 'C:\\a.exe');
});

test('returns null when no candidate is running', () => {
  assert.equal(previousRunningApp(recent, [], ''), null);
  assert.equal(previousRunningApp(recent, ['C:\\b.exe'], 'C:\\b.exe'), null,
    '唯一运行中的就是当前应用 → 无候选');
});

test('returns null for empty/invalid recent list', () => {
  assert.equal(previousRunningApp([], ['C:\\a.exe'], ''), null);
  assert.equal(previousRunningApp(null, ['C:\\a.exe'], ''), null);
});
