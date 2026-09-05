'use strict';
// P1-F4 清空废纸篓二次确认：状态机纯函数（core/confirm-arm.js）。
// 状态: { phase: 'idle' | 'armed', armedAt: number | null }
// 动作: 'request'（首点武装）| 'confirm'（再点执行）| 'cancel'（关菜单/点别处）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  nextState, isConfirmValid, CONFIRM_WINDOW_MS, IDLE,
} = require('../src/core/confirm-arm.js');

test('idle + request → armed with armedAt=now', () => {
  const res = nextState(IDLE, 'request', 1000);
  assert.equal(res.state.phase, 'armed');
  assert.equal(res.state.armedAt, 1000);
  assert.equal(res.execute, false);
});

test('armed + confirm inside window → idle + execute signal', () => {
  const armed = nextState(IDLE, 'request', 1000).state;
  const res = nextState(armed, 'confirm', 1000 + 1200);
  assert.equal(res.state.phase, 'idle');
  assert.equal(res.execute, true);
  // 有效性由调用方用 isConfirmValid 对「确认前的状态」判定
  assert.equal(isConfirmValid(armed, 1000 + 1200), true);
});

test('confirm on idle does nothing (no execute)', () => {
  const res = nextState(IDLE, 'confirm', 5000);
  assert.equal(res.state.phase, 'idle');
  assert.equal(res.execute, false);
});

test('cancel returns to idle from any state', () => {
  const armed = nextState(IDLE, 'request', 1000).state;
  const a = nextState(armed, 'cancel', 1100);
  assert.equal(a.state.phase, 'idle');
  assert.equal(a.execute, false);
  const b = nextState(IDLE, 'cancel', 1100);
  assert.equal(b.state.phase, 'idle');
  assert.equal(b.execute, false);
});

test('armed expires lazily: any action after window expires drops to idle first', () => {
  const armed = nextState(IDLE, 'request', 1000).state;
  // 超窗后的 confirm：先惰性失效回 idle，再处理 confirm → 无执行信号
  const c = nextState(armed, 'confirm', 1000 + CONFIRM_WINDOW_MS + 1);
  assert.equal(c.state.phase, 'idle');
  assert.equal(c.execute, false);
  // 超窗后的 request：失效后重新武装（armedAt 刷新为当前时刻）
  const r = nextState(armed, 'request', 1000 + CONFIRM_WINDOW_MS + 1);
  assert.equal(r.state.phase, 'armed');
  assert.equal(r.state.armedAt, 1000 + CONFIRM_WINDOW_MS + 1);
  // 超窗后的 cancel：回到 idle
  const x = nextState(armed, 'cancel', 1000 + CONFIRM_WINDOW_MS + 5000);
  assert.equal(x.state.phase, 'idle');
});

test('confirm validity boundary: 2999ms valid / 3001ms invalid', () => {
  const armed = nextState(IDLE, 'request', 1000).state;
  assert.equal(isConfirmValid(armed, 1000 + CONFIRM_WINDOW_MS - 1), true);
  assert.equal(isConfirmValid(armed, 1000 + CONFIRM_WINDOW_MS + 1), false);
});

test('confirm validity: exactly at the window edge counts as valid', () => {
  const armed = nextState(IDLE, 'request', 1000).state;
  assert.equal(isConfirmValid(armed, 1000 + CONFIRM_WINDOW_MS), true);
});

test('isConfirmValid is false for idle or malformed states', () => {
  assert.equal(isConfirmValid(IDLE, 999999), false);
  assert.equal(isConfirmValid(null, 999999), false);
  assert.equal(isConfirmValid({ phase: 'armed', armedAt: null }, 999999), false);
});
