'use strict';
/* =====================================================================
   P1-F4 清空废纸篓二次确认 — 状态机（纯函数）
   生命周期：idle --request--> armed --confirm(≤3s)--> 执行 → idle
                    ^                              |
                    +------- cancel / 超时(惰性失效) <-+
   设计要点：
   - 时间判定独立为 isConfirmValid(state, now)，便于测试时间边界；
   - nextState 内部对 armed 超窗做「惰性失效」：任何动作先归 idle 再处理，
     状态机本身不依赖定时器（renderer 的 setTimeout 只负责 UI 还原）。
   加载方式：CommonJS（node:test）+ 浏览器 <script> 全局 ConfirmArm
   （renderer 尚未模块化，P3 拆分时并入 ES modules 体系）。
   ===================================================================== */

const CONFIRM_WINDOW_MS = 3000;
const IDLE = Object.freeze({ phase: 'idle', armedAt: null });

function isConfirmValid(state, now) {
  if (!state || state.phase !== 'armed' || state.armedAt == null) return false;
  const dt = now - state.armedAt;
  return dt >= 0 && dt <= CONFIRM_WINDOW_MS;
}

// nextState(state, action, now) → { state, execute }
// execute 仅在 armed + confirm 时为 true；有效性（是否 ≤3s）由调用方
// 用 isConfirmValid 对「confirm 前的状态」另行判定。
function nextState(state, action, now) {
  let cur = state && state.phase === 'armed' ? { phase: 'armed', armedAt: state.armedAt } : IDLE;
  // 惰性失效：armed 已超窗 → 先归 idle，再按 idle 语义处理本次动作
  if (cur.phase === 'armed' && !isConfirmValid(cur, now)) {
    cur = IDLE;
  }
  if (action === 'cancel') {
    return { state: IDLE, execute: false };
  }
  if (action === 'request') {
    if (cur.phase === 'idle') {
      return { state: { phase: 'armed', armedAt: now }, execute: false };
    }
    // armed 期间重复 request：维持现有武装（armedAt 不刷新）
    return { state: cur, execute: false };
  }
  // confirm
  if (cur.phase === 'armed') {
    return { state: IDLE, execute: true };
  }
  return { state: IDLE, execute: false };
}

const api = { nextState, isConfirmValid, CONFIRM_WINDOW_MS, IDLE };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.ConfirmArm = api;
}
