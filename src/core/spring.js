'use strict';
/* =====================================================================
   P2-F1 spring 积分器 — 半隐式欧拉（纯函数）
   鱼眼缩放（0.26/0.58，参数与手感保持不变）与拖拽避让（更弹的参数）
   共用同一积分器；settled 判定阈值与 layoutTick 硬着陆一致（0.0015），
   保证终态精确归位、rAF 循环可据此自停。
   vel = (vel + (target - pos) * stiff) * damp; pos += vel
   加载方式：CommonJS（node:test）+ 浏览器 <script> 全局 Spring。
   ===================================================================== */

const SETTLE_EPS = 0.0015;

function stepSpring(pos, vel, target, stiff, damp) {
  let v = (vel + (target - pos) * stiff) * damp;
  let p = pos + v;
  if (Math.abs(target - p) < SETTLE_EPS && Math.abs(v) < SETTLE_EPS) {
    return { pos: target, vel: 0, settled: true };
  }
  return { pos: p, vel: v, settled: false };
}

const api = { stepSpring, SETTLE_EPS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.Spring = api;
}
