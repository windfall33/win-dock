'use strict';
// 通知角标：Windows 不提供任务栏角标读取接口，从窗口标题的括号计数提取
// （微信 "微信 (3)"、Slack "[7] …"、钉钉 "【9】…" 等）。取同一应用全部窗口的最大值。
// 四位及以上数字视为年份/编号，忽略。

const PATTERN = /[\(\[【（]\s*(\d{1,3})\s*\+?\s*[\)\]】）]/g;

function extractBadgeCount(titles) {
  let max = 0;
  for (const t of titles || []) {
    const s = String(t || '');
    if (!s) continue;
    PATTERN.lastIndex = 0;
    let m;
    while ((m = PATTERN.exec(s))) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

function badgeLabel(n) {
  if (!n || n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}

module.exports = { extractBadgeCount, badgeLabel };
