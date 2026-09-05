'use strict';
// P3-F1a main.js 拆分：IPC 路由 — 固定项/文件夹域（pins 增删改、Stack 配置、排序）。
// 纯平移：函数体自 main.js 逐行迁移，共享状态经 ctx 读写。
const path = require('path');
const { createPinApp } = require('./core/pin-app.js');

function createPinRoutes(ctx) {
  // 「固定应用」核心逻辑已下沉 core/pin-app.js（依赖注入、可单测，test/pin-app.test.js）。
  // bridge 实例创建后不变，但用 getter 取值以规避工厂创建早于 bridge 赋值的时序问题。
  const pinAppFromPath = createPinApp({
    getBridge: () => ctx.bridge,
    getSettingsAll: () => ctx.settings.all,
    setSetting: (k, v) => ctx.settings.set(k, v),
  });

  function pinRemove(p) {
    const pins = (ctx.settings.all.pins || []).filter((x) => x.id !== p.id);
    ctx.settings.set('pins', pins);
    return { ok: true };
  }

  function pinAdd(p) {
    const pins = ctx.settings.all.pins || [];
    if (!pins.some((x) => x.id === p.id)) {
      pins.splice(Math.max(0, pins.length), 0, { id: p.id, name: p.name, exe: p.exe });
      ctx.settings.set('pins', pins);
    }
    return { ok: true };
  }

  function recentRemove(p) {
    const exe = String(p.exe || '');
    const list = (ctx.settings.all.recentApps || []).filter((x) => x.exe !== exe);
    ctx.settings.set('recentApps', list);
    return { ok: true };
  }

  function addFolder(p) {
    const folderPath = String(p.path || '');
    if (!folderPath) return { ok: false, err: 'no-path' };
    const pins = ctx.settings.all.pins || [];
    let existing = pins.find((x) => x.kind === 'folder' && x.exe === folderPath);
    if (!existing) {
      existing = {
        id: 'folder:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        kind: 'folder',
        name: path.basename(folderPath) || folderPath,
        exe: folderPath,
        iconPath: folderPath,
        args: '',
      };
      pins.push(existing);
      ctx.settings.set('pins', pins);
    }
    return { ok: true, id: existing.id, name: existing.name, exe: existing.exe };
  }

  function setStackView(p) {
    // 文件夹 Stack 展示方式：grid / fan / list / auto（P1-F5：自动按数量阈值）
    const stackPath = String(p.path || '');
    const view = ['grid', 'fan', 'list', 'auto'].includes(p.view) ? p.view : 'auto';
    const pins = ctx.settings.all.pins || [];
    const pin = pins.find((x) => x.kind === 'folder' && x.exe === stackPath);
    if (pin) { pin.stackView = view; ctx.settings.set('pins', pins); }
    return { ok: true };
  }

  function setStackSort(p) {
    // P1-F5 文件夹排序方式：名称 / 添加日期 / 创建日期 / 种类
    const stackPath = String(p.path || '');
    const sortBy = ['name', 'added', 'created', 'kind'].includes(p.sortBy) ? p.sortBy : 'name';
    const pins = ctx.settings.all.pins || [];
    const pin = pins.find((x) => x.kind === 'folder' && x.exe === stackPath);
    if (pin) { pin.stackSortBy = sortBy; ctx.settings.set('pins', pins); }
    return { ok: true };
  }

  function reorder(p) {
    // p.ids: 完整的展示顺序（pinned 与临时运行的都以 id 标识）
    const pins = ctx.settings.all.pins || [];
    const byId = new Map(pins.map((x) => [x.id, x]));
    const out = [];
    for (const id of p.ids || []) {
      if (byId.has(id)) out.push(byId.get(id));
    }
    // 兜底：漏掉的 pin 追加末尾
    for (const x of pins) if (!out.includes(x)) out.push(x);
    ctx.settings.set('pins', out);
    return { ok: true };
  }

  return { pinAppFromPath, pinRemove, pinAdd, recentRemove, addFolder, setStackView, setStackSort, reorder };
}

module.exports = { createPinRoutes };
