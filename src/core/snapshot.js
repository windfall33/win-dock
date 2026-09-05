'use strict';
// =====================================================================
// 状态快照合成（从 main.js 的 buildStateSnapshot 提取）
//
// 这是 Dock 状态的唯一计算入口：把「窗口列表 + 固定项 + 运行中进程」合成为
// 渲染层直接消费的快照（固定区 / 最近区 / 最小化区 / 废纸篓 / 环境标志）。
//
// 提取动机：这段逻辑原先夹在 main.js 的 Electron 副作用之间，无法单测。
// 现在把所有外部状态（settings / icons / runningProc / env / trash）显式注入，
// 即可在 node:test 里用假依赖整段验证，为后续拆分 main.js 提供回归网。
//
// 约束：本模块不含任何 Electron API 与桥接调用，保持纯计算。
// =====================================================================

const path = require('node:path');
const { extractBadgeCount } = require('./badges.js');
const { extractMinimized } = require('./minimized.js');
const { visibleRecent } = require('./recent.js');

function normalizeExe(p) {
  return String(p || '').replace(/\//g, '\\').toLowerCase();
}

function exeKey(p) {
  const n = normalizeExe(p);
  return n ? path.basename(n) + '|' + n : '';
}

// deps:
//   getSettingsAll()  -> object        全部设置快照
//   getSetting(key)   -> any           单个设置项
//   iconsGetSync(p)   -> string|null   同步取图标（缓存未命中返回 null）
//   runningProc       -> Set<string>   无窗口但确实在跑的进程 exe（托盘应用）
//   getEnv()          -> object        Dock 可见性/位置等环境标志（依赖 screen）
//   getTrashCount()   -> number        废纸篓计数
//
// 返回 { build(winList, track) }；extrasSeq / extrasSeen 是 builder 的内部
// 会话状态（未固定应用的首现顺序与连续可见次数），由 builder 自己维护。
function createSnapshotBuilder(deps) {
  const {
    getSettingsAll,
    getSetting,
    iconsGetSync,
    runningProc,
    getEnv,
    getTrashCount,
  } = deps;

  const extrasSeq = new Map();   // gkey -> 序号（会话内首现顺序）
  let extrasCounter = 0;
  const extrasSeen = new Map();  // gkey -> 连续出现的轮询次数

  function updateExtrasTracking(extras) {
    const now = new Set(extras.map((g) => g.id));
    for (const k of [...extrasSeen.keys()]) {
      if (!now.has(k)) extrasSeen.delete(k);
    }
    for (const g of extras) {
      extrasSeen.set(g.id, (extrasSeen.get(g.id) || 0) + 1);
      if (!extrasSeq.has(g.id)) extrasSeq.set(g.id, ++extrasCounter);
    }
  }

  function build(winList, track) {
    const s = getSettingsAll();
    const pins = s.pins || [];

    const pinKeys = new Set();
    for (const p of pins) {
      if (p.kind !== 'folder') pinKeys.add(exeKey(p.exe));
    }

    // 给 pin 分配窗口
    const assigned = new Set(); // window.h -> used
    const statePins = [];

    for (const p of pins) {
      if (p.kind === 'folder') {
        statePins.push({
          kind: 'folder',
          id: p.id,
          name: p.name,
          exe: p.exe || '',
          folderPath: p.exe || '',
          iconPath: p.iconPath || p.exe || null,
          args: '',
          running: false,
          pinned: true,
          stackView: p.stackView || 'grid',
          icon: (p.iconPath || p.exe) ? iconsGetSync(p.iconPath || p.exe) : null,
          windows: [],
        });
        continue;
      }
      const pk = exeKey(p.exe);
      const wins = winList.filter((w) => exeKey(w.e) === pk && !assigned.has(w.h));
      wins.forEach((w) => assigned.add(w.h));
      statePins.push({
        kind: 'app',
        id: p.id,
        name: p.name,
        exe: p.exe || '',
        launch: p.launch || null,
        iconPath: p.iconPath || null,
        args: p.args || '',
        running: wins.length > 0 || runningProc.has(p.exe),
        pinned: true,
        // 同步取缓存，杜绝图标闪烁
        icon: (p.iconPath || p.exe) ? iconsGetSync(p.iconPath || p.exe) : null,
        windows: wins.map((w) => ({ h: w.h, t: w.t, m: !!w.m, f: !!w.f, hung: !!w.hung })),
        // P1-F6：任一窗口无响应 → 应用级 hung（仅影响菜单「强制退出」入口）
        hung: wins.some((w) => w.hung),
        badge: extractBadgeCount(wins.map((w) => w.t)),
      });
    }

    // 未固定的运行中应用：按会话内首现顺序排序，且连续两次轮询可见才显示
    const extras = [];
    const groups = new Map();
    for (const w of winList) {
      if (assigned.has(w.h)) continue;
      const base = path.basename(normalizeExe(w.e));
      let gkey, gname;
      if (base === 'applicationframehost.exe') { // UWP 商店应用
        // 分组键优先用窗口的 AppUserModelId（桥接枚举时随窗口带出的 `a` 字段）：
        // 它是 UWP 应用真实且稳定的标识，不随窗口标题变化 —— 修掉「标题一变
        // 就分裂出重复图标」的问题；AUMID 取不到时退回旧的标题前缀方案。
        gkey = w.a ? ('uwp:' + w.a) : ('uwp:' + w.t.slice(0, 40));
        gname = w.t;
      } else {
        gkey = base || ('hwnd:' + w.h);
        gname = base.replace(/\.exe$/i, '');
      }
      if (!groups.has(gkey)) {
        groups.set(gkey, {
          kind: 'app',
          id: gkey,
          name: gname,
          exe: base === 'applicationframehost.exe' ? '' : (w.e || ''),
          running: true,
          pinned: false,
          icon: null,
          hung: false,
          windows: [],
        });
        extras.push(groups.get(gkey));
      }
      groups.get(gkey).windows.push({ h: w.h, t: w.t, m: !!w.m, f: !!w.f, hung: !!w.hung });
    }

    if (track && winList.length > 0) updateExtrasTracking(extras);

    const shownExtras = track
      ? extras.filter((g) => (extrasSeen.get(g.id) || 0) >= 2)
      : extras;

    for (const g of shownExtras) {
      g.icon = g.exe ? iconsGetSync(g.exe) : null;
      g.badge = extractBadgeCount((g.windows || []).map((w) => w.t));
      // P1-F6：未固定应用同样聚合 hung（任一窗口无响应）
      g.hung = (g.windows || []).some((w) => w.hung);
    }

    const entries = [...statePins, ...shownExtras];
    // 最小化窗口投影（仿 macOS 右侧分区）；appName/icon 沿用所属应用条目
    // mac「最小化到应用图标」：开启时最小化窗口不显示在右侧分区，而是收进所属应用图标
    const minimized = getSetting('minimizeIntoIcon') ? [] : extractMinimized(winList, entries);
    // 最近打开：LRU（按使用时间），最多 3 个，标注是否正在运行
    const runningExes = entries.filter((e) => (e.windows || []).length > 0).map((e) => e.exe);
    const recent = visibleRecent(s.recentApps || [], runningExes);
    for (const r of recent) {
      r.icon = r.exe ? iconsGetSync(r.exe) : null;
    }
    return {
      entries,
      recent,
      minimized,
      trash: { count: getTrashCount() },
      settings: {
        iconSize: s.iconSize,
        magnification: s.magnification,
        autohide: s.autohide,
        appearance: s.appearance,
        hideTaskbar: !!s.hideTaskbar,
        position: s.position || 'bottom',
        minimizeEffect: s.minimizeEffect || 'genie',
        minimizeIntoIcon: !!s.minimizeIntoIcon,
      },
      env: getEnv(),
      extras: {
        launchAtLogin: !!s.launchAtLogin,
      },
    };
  }

  return { build };
}

module.exports = { createSnapshotBuilder, normalizeExe, exeKey };
