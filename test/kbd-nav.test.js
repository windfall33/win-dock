'use strict';
// P1-F2 键盘导航：焦点移动纯函数（core/kbd-nav.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { moveFocus, homeIndex, lastIndex, isDividerId } = require('../src/core/kbd-nav.js');

// 槽位 id 数组：apps + 分隔线 + recent + trash（reconcile 后 itemsEl 的顺序）
const IDS = ['a', 'b', '__divider__', 'recent:1', '__divider2__', '__trash__'];

test('isDividerId detects divider slots only', () => {
  assert.equal(isDividerId('__divider__'), true);
  assert.equal(isDividerId('__divider2__'), true);
  assert.equal(isDividerId('__divider3__'), true);
  assert.equal(isDividerId('__trash__'), false);
  assert.equal(isDividerId('app:1'), false);
  assert.equal(isDividerId(''), false);
});

test('moveFocus moves by delta skipping dividers', () => {
  assert.equal(moveFocus(IDS, 0, +1), 1,  'a → b');
  assert.equal(moveFocus(IDS, 1, +1), 3,  'b 跳过分隔线 → recent:1');
  assert.equal(moveFocus(IDS, 3, +1), 5,  'recent:1 跳过 divider2 → trash');
  assert.equal(moveFocus(IDS, 5, -1), 3,  'trash 往回跳过 divider2');
});

test('moveFocus wraps around both ends', () => {
  assert.equal(moveFocus(IDS, 5, +1), 0,  '末尾环绕到首个');
  assert.equal(moveFocus(IDS, 0, -1), 5,  '首个反向环绕到末尾');
});

test('moveFocus treats out-of-list index as entering from the end/start', () => {
  // 当前焦点不在可选集（如分隔线/未聚焦）：+1 落到首个，-1 落到最后一个
  assert.equal(moveFocus(IDS, 2, +1), 0);
  assert.equal(moveFocus(IDS, 2, -1), 5);
  assert.equal(moveFocus(IDS, -1, +1), 0);
});

test('homeIndex / lastIndex return first/last selectable', () => {
  assert.equal(homeIndex(IDS), 0);
  assert.equal(lastIndex(IDS), 5);
});

test('empty list or all-divider list returns -1', () => {
  assert.equal(moveFocus([], 0, 1), -1);
  assert.equal(homeIndex([]), -1);
  assert.equal(lastIndex([]), -1);
  assert.equal(moveFocus(['__divider__', '__divider2__'], -1, 1), -1);
  assert.equal(homeIndex(['__divider__']), -1);
});

test('single selectable slot stays on itself', () => {
  const ids = ['__divider__', 'only', '__divider2__'];
  assert.equal(moveFocus(ids, 1, +1), 1);
  assert.equal(moveFocus(ids, 1, -1), 1);
  assert.equal(homeIndex(ids), 1);
  assert.equal(lastIndex(ids), 1);
});

test('large deltas still land on a valid slot', () => {
  // 可选集 4 个槽位：+7 步 = 环绕一圈（4）再 3 步 → trash
  assert.equal(moveFocus(IDS, 0, +7), 5);
  assert.equal(moveFocus(IDS, 0, -7), 1, '-7 = 反向 3 步 = 正向 1 步 → b');
});
