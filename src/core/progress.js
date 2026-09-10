'use strict';
// 从窗口标题提取下载/传输类进度百分比（如 "下载 45%"、"Chrome - 45%"）。
// 无系统统一进度接口，只能做标题启发式；返回 null 表示无进度信号。
function extractProgress(titles) {
  let best = null;
  for (const t of titles || []) {
    const s = String(t || '');
    // 常见： "45%"、"45 %"、"(45%)"、"下载 45%"；排除 "100% battery" 类噪音靠 0-100 钳制
    const m = s.match(/(\d{1,3})\s*%/);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0 || n > 100) continue;
    // 100% 视为完成，不显示进度环
    if (n >= 100) continue;
    if (best === null || n > best) best = n;
  }
  return best === null ? null : best / 100;
}

module.exports = { extractProgress };
