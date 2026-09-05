'use strict';
// 最近打开应用：LRU 列表（按使用时间倒序，按 exe 去重）。

const RECENT_CAP = 20;
const VISIBLE_MAX = 3;

// 返回 { list, changed }；list 为更新后的完整 LRU
function updateRecent(list, entry) {
  const cur = Array.isArray(list) ? list : [];
  const exe = String(entry && entry.exe || '');
  if (!exe) return { list: cur, changed: false };
  const rest = cur.filter((x) => x.exe !== exe);
  const next = [{ id: entry.id || ('recent:' + exe), name: entry.name || '', exe, ts: Date.now() }, ...rest];
  if (next.length > RECENT_CAP) next.length = RECENT_CAP;
  const changed = next.length !== cur.length || cur.some((x, i) => x.exe !== (next[i] && next[i].exe));
  return { list: next, changed };
}

// 展示层：取最近 VISIBLE_MAX 个，并标注是否正在运行（点击时切换/聚焦）
function visibleRecent(list, runningExes) {
  const run = new Set((runningExes || []).map((e) => String(e).toLowerCase()));
  return (Array.isArray(list) ? list : [])
    .slice(0, VISIBLE_MAX)
    .map((x) => ({
      kind: 'recent',
      id: x.id || ('recent:' + x.exe),
      name: x.name,
      exe: x.exe,
      running: !!x.exe && run.has(String(x.exe).toLowerCase()),
      icon: null,
    }));
}

module.exports = { updateRecent, visibleRecent, RECENT_CAP, VISIBLE_MAX };
