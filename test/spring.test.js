'use strict';
// P2-F1 spring 积分器（纯函数）：半隐式欧拉，鱼眼缩放与拖拽避让共用同一积分器。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stepSpring, SETTLE_EPS } = require('../src/core/spring.js');

function run(pos, vel, target, stiff, damp, maxSteps = 500) {
  let last;
  let n = 0;
  for (; n < maxSteps; n++) {
    last = stepSpring(pos, vel, target, stiff, damp);
    pos = last.pos; vel = last.vel;
    if (last.settled) break;
  }
  return { pos, vel, settled: last ? last.settled : false, steps: n + 1 };
}

test('converges to target from arbitrary initial states', () => {
  const cases = [
    [0, 0, 1], [1, 0, 0], [0.3, -2, 1], [2, 5, 1], [-3, 0, 0.5], [0, 0, 0],
  ];
  for (const [p0, v0, tgt] of cases) {
    const r = run(p0, v0, tgt, 0.26, 0.58);
    assert.equal(r.settled, true, `初始 (${p0},${v0})→${tgt} 应收敛`);
    assert.equal(r.pos, tgt, 'settled 时应硬着陆在目标值');
  }
});

test('overshoot exists with damping < 1 (the source of the springy feel)', () => {
  // 从 0 到 1，鱼眼参数（0.26/0.58）路径上应出现 pos > target 的过冲
  let pos = 0, vel = 0, overshot = false;
  for (let i = 0; i < 60; i++) {
    const st = stepSpring(pos, vel, 1, 0.26, 0.58);
    pos = st.pos; vel = st.vel;
    if (pos > 1.0001) overshot = true;
    if (st.settled) break;
  }
  assert.equal(overshot, true, '欠阻尼弹簧应至少过冲一次');
});

test('settle threshold boundary: inside settles and snaps to target, outside keeps moving', () => {
  // |target-pos| 与 |vel| 都在 0.0015 内 → settled 且 pos 精确归位
  const inSt = stepSpring(1 - 0.0014, 0.0001, 1, 0.26, 0.58);
  assert.equal(inSt.settled, true);
  assert.equal(inSt.pos, 1);
  assert.equal(inSt.vel, 0);
  // 位置偏差超出阈值（积分一步后仍在阈值外）→ 不 settled
  const outSt = stepSpring(1 - 0.002, 0, 1, 0.26, 0.58);
  assert.equal(outSt.settled, false);
  // 位置在阈值内但积分后速度超阈值 → 不 settled
  const velSt = stepSpring(1 - 0.001, 0.003, 1, 0.26, 0.58);
  assert.equal(velSt.settled, false);
});

test('fisheye parameter regression: 0.26/0.58 settles within 30 steps', () => {
  // 锁定现有鱼眼手感的收敛速度：从静止/最大位移出发都应 ≤30 步硬着陆
  const r1 = run(0, 0, 1, 0.26, 0.58, 30);
  assert.equal(r1.settled, true, `30 步内收敛（实际 ${r1.steps} 步）`);
  const r2 = run(0, 0, 1.8, 0.26, 0.58, 30);
  assert.equal(r2.settled, true);
});

test('threshold constant matches the layoutTick hard-landing value', () => {
  assert.equal(SETTLE_EPS, 0.0015);
});
