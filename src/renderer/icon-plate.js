'use strict';
// =====================================================================
// 图标底板（已从「检测式」退役为「全员式」）
//
// v1 按亮度/透明占比检测「需要板的图标」自动挂板，但边界 case 不断：
// 第一轮漏深色悬浮图标（GitHub/终端），加透明占比特征后又轮到彩色满幅
// 图标被漏（千问/豆包/CC Switch/PowerShell —— 用户两轮反馈）。根因是
// 用户期望的本就是 macOS 的统一观感：所有图标都是统一 squircle 容器。
//
// 底板样式现由 style.css 的 `.slot img.app-icon` 全员规则承担（废纸篓
// 显式排除），本文件只剩给 img 挂 plate-on 标记的兼容空壳；
// renderer.js 的调用点保持不动，class 目前不被 CSS 依赖，留作
// 「将来若需按图标定制底板」的挂载点。
// =====================================================================

function applyPlate(slot) {
  const img = slot.querySelector('img.app-icon');
  if (img && img.isConnected) img.classList.add('plate-on');
}

module.exports = { applyPlate };
