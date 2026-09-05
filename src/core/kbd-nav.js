'use strict';
/* =====================================================================
   P1-F2 键盘导航 — 焦点移动纯函数
   槽位 id 序列（含 '__divider__' 等分隔线 id）上的环绕移动：
   - 分隔线槽位不可聚焦，移动时跳过；
   - 首尾环绕；空列表 / 全分隔线返回 -1；
   - 当前索引不在可选集时：+1 落到首个、-1 落到最后一个（从端点进入）。
   加载方式：CommonJS（node:test）+ 浏览器 <script> 全局 KbdNav。
   ===================================================================== */

const DIVIDER_RE = /^__divider/;

function isDividerId(id) {
  return DIVIDER_RE.test(String(id || ''));
}

function selectableIndexes(ids) {
  const out = [];
  (Array.isArray(ids) ? ids : []).forEach((id, i) => {
    if (!isDividerId(id)) out.push(i);
  });
  return out;
}

// moveFocus(ids, currentIndex, delta) → newIndex | -1
function moveFocus(ids, currentIndex, delta) {
  const sel = selectableIndexes(ids);
  if (!sel.length) return -1;
  const d = Number(delta) || 0;
  let pos = sel.indexOf(currentIndex);
  if (pos < 0) {
    // 当前不在可选集：视作从端点进入
    pos = d >= 0 ? sel.length - 1 : 0;
  }
  // (+1 → sel[0])、(-1 → sel[last])：先归一化再取模，任意大 delta 也落在有效槽位
  const next = (((pos + d) % sel.length) + sel.length) % sel.length;
  return sel[next];
}

function homeIndex(ids) {
  const sel = selectableIndexes(ids);
  return sel.length ? sel[0] : -1;
}

function lastIndex(ids) {
  const sel = selectableIndexes(ids);
  return sel.length ? sel[sel.length - 1] : -1;
}

const api = { moveFocus, homeIndex, lastIndex, isDividerId };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.KbdNav = api;
}
