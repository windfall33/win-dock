'use strict';
/* =====================================================================
   P1-F1 修饰键点击 — 决策矩阵（纯函数）
   对齐 macOS Dock 修饰键语义：
   - Ctrl+点击                → 在资源管理器中显示（reveal）
   - Alt+点击当前聚焦应用      → 隐藏当前应用全部窗口（hide-current），
                                 焦点交给最近一个运行中的其他应用
   - Alt(Ctrl)+点击运行中应用  → 聚焦目标 + 最小化其他全部（hide-others）
   - 其余（含 Alt+未运行）     → 普通激活（activate），修饰键忽略
   加载方式：CommonJS（node:test）+ 浏览器 <script> 全局 ModifierActions。
   ===================================================================== */

// 决策优先级：reveal（ctrl 单键）> hide-current / hide-others > activate。
// ctrl+alt 组合下目标未运行时退化为 activate（hide-others 需要真实窗口可聚焦）。
function resolveModifierAction({ alt, ctrl, targetRunning, targetFocused }) {
  if (ctrl && !alt) return 'reveal';
  if (alt && !ctrl && targetRunning && targetFocused) return 'hide-current';
  if (alt && ctrl && targetRunning) return 'hide-others';
  return 'activate';
}

// 「上一个应用」解析：recent LRU 顺序中最近一个 exe ≠ 当前应用 且仍在运行的条目。
// exe 匹配大小写不敏感（Windows 路径不区分大小写）；无候选返回 null，
// 调用方退化为「只最小化当前应用全部窗口，焦点自然回桌面」。
function previousRunningApp(recent, runningExes, currentExe) {
  const run = new Set((runningExes || []).map((e) => String(e || '').toLowerCase()));
  const cur = String(currentExe || '').toLowerCase();
  for (const r of Array.isArray(recent) ? recent : []) {
    const ex = String((r && r.exe) || '').toLowerCase();
    if (!ex || ex === cur) continue;
    if (run.has(ex)) return r;
  }
  return null;
}

const api = { resolveModifierAction, previousRunningApp };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.ModifierActions = api;
}
