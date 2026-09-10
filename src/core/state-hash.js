'use strict';
// pushState 增量签名：覆盖窗口级 m/f/t，否则最小化/前台变化不会推送到渲染层。
// P1-F6：entries 级加入 h（hung），无响应状态变化即时触发菜单刷新。
function stateSignature(snap) {
  const s = snap || {};
  return JSON.stringify([
    (s.entries || []).map((e) => [
      e.id, e.running, e.icon ? 1 : 0, e.badge || 0, e.hung ? 1 : 0,
      e.progress == null ? null : Math.round(e.progress * 100),
      (e.windows || []).map((w) => [w.h, w.m ? 1 : 0, w.f ? 1 : 0, w.t]),
    ]),
    (s.recent || []).map((r) => [r.id, r.icon ? 1 : 0]),
    (s.minimized || []).map((m) => [m.id, m.icon ? 1 : 0, m.title]),
    s.trash && s.trash.count,
    s.settings,
    s.env,
  ]);
}

module.exports = { stateSignature };
