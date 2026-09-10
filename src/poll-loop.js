'use strict';
// P3-F1a main.js 拆分：轮询与遮挡状态机（pollOnce / checkOcclusion / 状态推送 / 自愈）。
// 纯平移：函数体自 main.js 逐行迁移，共享状态经 ctx 读写。
const path = require('path');
const { screen } = require('electron');
const { stateSignature } = require('./core/state-hash.js');
const { updateRecent } = require('./core/recent.js');
const { isDesktopForeground, isCursorNearBar, decideOcclusionState } = require('./core/occlusion.js');

const SKIP_RECENT_HOSTS = new Set([
  'explorer.exe', 'searchhost.exe', 'shellexperiencehost.exe',
  'runtimebroker.exe', 'textinputhost.exe', 'applicationframehost.exe',
  'startmenuexperiencehost.exe', 'dwm.exe',
  // P1-F2：键盘导航期间 Dock 窗口自身成为前台，不污染最近使用 LRU
  'electron.exe', 'win dock.exe',
]);

// 桌面壳窗口类名：前台是这些类时 Dock 永远显示，忽略 autohide 与遮挡让位。
// 不含 ExploreWClass（那是真正的资源管理器窗口，属于应用窗口）。
const DESKTOP_CLASSES = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'SHELLDLL_DefView',
]);

function createPollLoop(ctx) {
  const { log } = ctx;

  // 未固定应用的会话稳定跟踪：首现顺序固定 + 连续两帧才显示（滤掉幽灵窗口）
  // 状态快照合成器：原先内联在 main.js 的 buildStateSnapshot 已下沉到 core/snapshot.js。
  // 外部状态（settings / icons / runningProc / env / 废纸篓计数）全部显式注入。
  // snapshotBuilder 由 main 在 bridge/icons 就绪后创建挂 ctx；此处运行时读取
  // ctx.snapshotBuilder（装配期捕获会拿到 null）。

  let pollBusy = false;

  // 自适应轮询：状态签名变化后短暂进入快速档（应用启动/关闭/切窗尽快可见），
  // 稳定后回落到慢档降低桥接往返。返回 {changed} 供主进程调度下一次。
  async function pollOnce() {
    if (pollBusy || !ctx.bridge) return { changed: false, skipped: true };

    pollBusy = true;
    try {
      const changed = await pollInner();
      if (changed) ctx.lastStateChangeTs = Date.now();
      return { changed: !!changed };
    } catch (e) {
      log('poll error:', e.message);
      return { changed: false };
    } finally {
      pollBusy = false;
    }
  }

  let trashTick = 0;
  let procTick = 0;              // 后台进程探测节流

  async function pollInner() {
    let winList = [];
    try {
      const res = await ctx.bridge.request('enum-windows', { excludePid: process.pid }, 8000);
      winList = Array.isArray(res) ? res : [];
    } catch (e) {
      log('enum-windows failed:', e.message);
      return false;
    }

    // 前台标志 f 已在 enum-windows 枚举时写入，无需再发一次 foreground 往返

    if (++trashTick % 4 === 0) {
      try {
        const t = await ctx.bridge.request('trash-count', {}, 6000);
        ctx.TrashLastCount = t.count | 0;
      } catch {}
    }

    // 后台进程感知：低频刷新「固定应用是否有进程在跑」（无窗口的托盘应用也算运行中）
    const pinNames = (ctx.settings.all.pins || [])
      .filter((x) => x.kind !== 'folder' && x.exe)
      .map((x) => x.exe);
    if (++procTick % 2 === 0 && pinNames.length) {
      try {
        const rp = await ctx.bridge.request('processes-running', { names: pinNames }, 8000);
        if (rp && rp.running) {
          // 必须原地更新（clear+add）：createSnapshotBuilder 的 deps 在 main.js
          // 装配时捕获的是当时的 Set 引用，这里若整体重新赋值，builder 永远看到
          // 旧的空 Set，托盘应用「运行中」判定会静默失效。
          ctx.runningProc.clear();
          for (const k of Object.keys(rp.running)) {
            if (rp.running[k]) ctx.runningProc.add(k);
          }
        }
      } catch {}
    }

    const snap = ctx.snapshotBuilder.build(winList, true);

    // 立即推送（图标已在快照里同步取缓存；仅新增应用首帧后异步补齐再推一次）
    const first = pushState(snap);
    await fetchIconsFor([...snap.entries, ...(snap.minimized || []), ...(snap.recent || [])]);
    const second = pushState(snap);
    return first || second;
  }

  async function fetchIconsFor(entries) {
    const jobs = [];
    for (const e of entries) {
      const iconPath = e.iconPath || e.exe;
      if (!e.icon && iconPath && !ctx.icons.hasFailed(iconPath)) {
        jobs.push(
          ctx.icons.fetch(ctx.bridge, iconPath)
            .then((url) => { if (url) { e.icon = url; } })
            .catch(() => {})
        );
      }
    }
    // 串行取图标：避免并发请求挤占桥接，拖慢 dock-occluded/其它高频指令
    for (const job of jobs) {
      try { await job; } catch {}
    }
  }

  // 遮挡检测独立于慢轮询：前台窗口覆盖 Dock 时尽快隐藏（约 350ms 一查）
  let zAssertTick = 0;
  let occFailCount = 0;         // 遮挡轮询连续失败计数（用于日志节奏与保底推送）
  let lastFgHwndStr = '';        // 上次前台窗口句柄（变化即触发一次状态刷新）

  async function checkOcclusion() {
    if (!ctx.bridge) return;
    ctx.maybeFollowCursorDisplay();
    if (++zAssertTick % 10 === 0) ctx.assertWindowLevels();
    try {
      if (ctx.dockWin && !ctx.dockWin.isDestroyed()) {
        const hbuf = ctx.dockHwnd;
        const hwnd = hbuf.readBigUInt64LE ? hbuf.readBigUInt64LE(0).toString() : String(hbuf.readUInt32LE(0));
        const occArgs = { hwnd };
        if (ctx.barRectDip && ctx.dockWin) {
          // 桥接进程为 DPI-unaware，其窗口坐标即 DIP（主屏虚拟化域），
          // 直接传 DIP 值与它的 GetWindowRect 同域可比
          const gb = ctx.dockBoundsDip || ctx.dockWin.getBounds();
          occArgs.bar = {
            l: gb.x + ctx.barRectDip.x, t: gb.y + ctx.barRectDip.y,
            r: gb.x + ctx.barRectDip.x + ctx.barRectDip.w, b: gb.y + ctx.barRectDip.y + ctx.barRectDip.h,
          };
        }
        const occ = await ctx.bridge.request('dock-occluded', occArgs, 3000);
        occFailCount = 0;
        const fg = occ && occ.fg;
        // 前台应用名变化 → 推送顶栏
        const fgName = (fg && fg.e) ? path.basename(ctx.normalizeExe(fg.e)).replace(/\.exe$/i, '') : '';
        if (fgName !== ctx.lastFgAppName) {
          ctx.lastFgAppName = fgName;
          if (ctx.topbarWin && !ctx.topbarWin.isDestroyed()) {
            ctx.topbarWin.webContents.send('topbar-app', fgName);
          }
        }
        // 事件驱动近似：前台窗口一变立即刷新状态，避免最长 1.4s 才响应的迟钝。
        const fgH = (fg && fg.h) ? String(fg.h) : '';
        if (fgH !== lastFgHwndStr) {
          lastFgHwndStr = fgH;
          if (!pollBusy) pollOnce();
        }
        // 全局光标兜底：透明窗口在穿透切换瞬间可能收不到 mouseleave，
        // 渲染层会卡在放大态；350ms 内据此强制复位。
        // 判据用可见条矩形（含放大溢出方向的 90px 余量）而非整条带窗口，
        // 否则侧栏/底部条带上的大量透明留白都会被误判为「指针在 Dock 区」。
        const cur = occ && occ.cursor;
        const near = isCursorNearBar(cur, occArgs.bar);
        if (near !== ctx.pointerNearDock) {
          ctx.pointerNearDock = near;
          ctx.sendEnv();
        }
        // 隐藏状态机（纯决策已下沉 core/occlusion.js，可单测；此处只做 IO）：
        // 桌面 → 永远显示；真全屏 + 让位开启 + 光标不近 → 让位；
        // 普通窗口覆盖一律不让位（Dock 置顶，矩形判 covered 曾致 250ms 抽搐）。
        const dec = decideOcclusionState({
          isDesktop: isDesktopForeground(fg, DESKTOP_CLASSES),
          occFull: !!(occ && occ.full),
          occludeAway: !!ctx.settings.get('occludeAway'),
          cursorNear: ctx.pointerNearDock === true,
          prev: {
            onDesktopNow: ctx.onDesktopNow,
            fullscreenHide: ctx.fullscreenHide,
            coveredHideNow: ctx.coveredHideNow,
            dockHiddenByUs: ctx.dockHiddenByUs,
          },
        });
        ctx.onDesktopNow = dec.next.onDesktopNow;
        ctx.fullscreenHide = dec.next.fullscreenHide;
        ctx.coveredHideNow = dec.next.coveredHideNow;
        ctx.dockHiddenByUs = dec.next.dockHiddenByUs;
        if (dec.fullscreenAwayChanged !== null) {
          log('fullscreen-away', dec.fullscreenAwayChanged ? 'on' : 'off', fg && fg.t || '');
        }
        if (dec.envChanged) ctx.sendEnv();
        // 最近使用跟踪（高频，350ms 一查；仅非桌面前台，桌面前台不污染 LRU）
        if (!dec.next.onDesktopNow) {
          const base = path.basename(ctx.normalizeExe(fg.e));
          // 跳过系统壳/宿主进程，避免污染最近使用
          if (!SKIP_RECENT_HOSTS.has(base)) {
            const upd = updateRecent(ctx.settings.all.recentApps || [], {
              name: base.replace(/\.exe$/i, ''),
              exe: fg.e,
            });
            if (upd.changed) ctx.settings.set('recentApps', upd.list);
          }
        }
      }
    } catch (e) {
      // 不再静默吞错：遮挡循环曾静默失败导致 Dock「失明」却无任何线索。
      // 第 1 次与之后每 20 次记一条日志（250ms 一拍，即 ~5s 一条，防刷屏）；
      // 连续 12 次（~3s）失败视为环境推送链路卡死，保底重发一次 sendEnv 自愈。
      occFailCount++;
      if (occFailCount === 1 || occFailCount % 20 === 0) {
        log('occlusion-tick failed', 'x' + occFailCount, (e && e.message) || String(e));
      }
      if (occFailCount === 12 && ctx.dockWin && !ctx.dockWin.isDestroyed()) {
        try { ctx.sendEnv(); } catch {}
      }
    }
  }

  let lastPayloadHash = '';

  function pushState(snap) {
    const wins = [];
    if (ctx.forEachDockWin) ctx.forEachDockWin((w) => wins.push(w));
    else if (ctx.dockWin && !ctx.dockWin.isDestroyed()) wins.push(ctx.dockWin);
    if (!wins.length) return false;
    const hash = stateSignature(snap);
    if (hash !== lastPayloadHash) {
      lastPayloadHash = hash;
      for (const w of wins) w.webContents.send('state', snap);
      return true;
    }
    // 签名未变：仍要给新建的多屏窗口补一帧（刚创建时 lastPayloadHash 已是该值）
    return false;
  }

  function sendEnv() {
    const wins = [];
    if (ctx.forEachDockWin) ctx.forEachDockWin((w) => wins.push(w));
    else if (ctx.dockWin && !ctx.dockWin.isDestroyed()) wins.push(ctx.dockWin);
    if (!wins.length) return;
    const m = ctx.dockMetrics();
    const env = {
      dockHidden: !ctx.onDesktopNow && ctx.dockHiddenByUs && !ctx.mouseAtBottom,
      fullscreenHide: ctx.fullscreenHide && !ctx.mouseAtBottom,
      coveredHide: ctx.coveredHideNow && !ctx.mouseAtBottom,
      pointerNearDock: ctx.pointerNearDock === null ? true : ctx.pointerNearDock,
      appActive: !ctx.onDesktopNow,
      position: m.pos,
      edgeInset: m.edgeInset,
    };
    for (const w of wins) w.webContents.send('env', env);
  }

  return { pollOnce, checkOcclusion, pushState, sendEnv, fetchIconsFor };
}

module.exports = { createPollLoop };
