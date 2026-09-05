'use strict';
// 从窗口列表投影出「最小化窗口」分区（仿 macOS Dock 右侧），纯函数便于单测。
// appName/icon 取自所属应用条目（图标走同步缓存，无则由 fetchIconsFor 按 exe 兜底）。
function extractMinimized(winList, appEntries) {
  const nameByH = new Map();
  const iconByH = new Map();
  for (const app of appEntries || []) {
    for (const w of app.windows || []) {
      nameByH.set(w.h, app.name);
      if (app.icon) iconByH.set(w.h, app.icon);
    }
  }
  const out = [];
  for (const w of winList || []) {
    if (!w.m) continue;
    out.push({
      kind: 'min',
      id: 'min:' + w.h,
      h: w.h,
      title: w.t,
      exe: w.e || '',
      appName: nameByH.get(w.h) || '',
      icon: iconByH.get(w.h) || null,
    });
  }
  return out;
}

module.exports = { extractMinimized };
