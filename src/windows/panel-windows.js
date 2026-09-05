'use strict';
// P3-F1a main.js 拆分：面板窗口群（settings / launchpad / expose / genie / topbar）。
// 纯平移：函数体自 main.js 逐行迁移，共享状态经 ctx 读写。
const { BrowserWindow, nativeTheme } = require('electron');
const path = require('path');

function createPanelWindows(ctx) {
  const { log } = ctx;

  // ---------------------------------------------------------------- settings

  function openSettingsWindow() {
    if (ctx.settingsWin && !ctx.settingsWin.isDestroyed()) {
      ctx.settingsWin.focus();
      return;
    }
    ctx.settingsWin = new BrowserWindow({
      width: 380, height: 520,
      resizable: false,
      minimizable: false, maximizable: false,
      title: 'Dock 设置',
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f5f5f7',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    ctx.settingsWin.setMenuBarVisibility(false);
    ctx.settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
    ctx.settingsWin.on('closed', () => { ctx.settingsWin = null; });
  }

  // ---------------------------------------------------------------- launchpad

  function closeLaunchpad() {
    const lw = ctx.launchpadWin;
    if (!lw || lw.isDestroyed()) { ctx.launchpadWin = null; return; }
    // 先给渲染层 ~170ms 播关闭淡出（launchpad.css 的 body.lp-closing）再销毁；
    // 渲染层 requestClose 延迟 invoke 到这里，__closing 幂等不重复计时
    if (lw.__closing) return;
    lw.__closing = true;
    setTimeout(() => {
      if (ctx.launchpadWin && !ctx.launchpadWin.isDestroyed()) ctx.launchpadWin.destroy();
      ctx.launchpadWin = null;
    }, 170);
  }

  function openLaunchpad() {
    if (ctx.launchpadWin && !ctx.launchpadWin.isDestroyed()) {
      if (ctx.launchpadWin.__closing) {
        // 上一次关闭动画还没播完就再次打开：直接废弃旧窗重开，避免 show 一个将死的窗
        ctx.launchpadWin.destroy();
        ctx.launchpadWin = null;
      } else {
        ctx.launchpadWin.show();
        ctx.launchpadWin.focus();
        return;
      }
    }
    const wa = ctx.currentDisplay().workArea;
    ctx.launchpadWin = new BrowserWindow({
      x: wa.x, y: wa.y, width: wa.width, height: wa.height,
      frame: false, transparent: true, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    ctx.launchpadWin.setAlwaysOnTop(true, 'screen-saver');
    ctx.launchpadWin.__createdAt = Date.now();
    ctx.launchpadWin.loadFile(path.join(__dirname, '..', 'renderer', 'launchpad.html'));
    ctx.launchpadWin.once('ready-to-show', () => {
      ctx.launchpadWin.show();
      ctx.launchpadWin.focus();
    });
    ctx.launchpadWin.on('closed', () => { ctx.launchpadWin = null; });
    ctx.launchpadWin.on('blur', () => {
      if (ctx.launchpadWin && Date.now() - (ctx.launchpadWin.__createdAt || 0) > 600) closeLaunchpad();
    });
  }

  async function getLaunchpadApps() {
    if (ctx.launchpadApps) return ctx.launchpadApps;
    try {
      const res = await ctx.bridge.request('list-start-menu', {}, 30000);
      const seen = new Set();
      ctx.launchpadApps = (res.apps || [])
        .filter((a) => a.target)
        .filter((a) => {
          const key = a.name + '→' + String(a.target).toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((a, i) => ({
          id: 'lp:' + i,
          name: a.name,
          target: a.target,
          args: a.args || '',
          iconPath: ctx.normalizeIconSource(a.iconLocation, a.target),
          icon: null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    } catch (e) {
      log('list-start-menu failed:', e.message);
      ctx.launchpadApps = [];
    }
    return ctx.launchpadApps;
  }

  // 图标懒加载：首开先出字母磁贴，解析完统一推一次（之后走磁盘缓存）
  async function fillLaunchpadIcons() {
    if (!ctx.launchpadApps || !ctx.launchpadApps.length) return;
    try {
      await ctx.fetchIconsFor(ctx.launchpadApps);
      if (ctx.launchpadWin && !ctx.launchpadWin.isDestroyed()) {
        ctx.launchpadWin.webContents.send('launchpad-icons',
          ctx.launchpadApps.filter((a) => a.icon).map((a) => ({ id: a.id, icon: a.icon })));
      }
    } catch {}
  }

  // ---------------------------------------------------------------- top bar

  function topbarMetrics() {
    const b = ctx.currentDisplay().bounds;
    return { x: b.x, y: b.y, width: b.width, height: 26 };
  }

  function closeTopbar() {
    if (ctx.topbarWin && !ctx.topbarWin.isDestroyed()) ctx.topbarWin.destroy();
    ctx.topbarWin = null;
  }

  function createTopbar() {
    if (!ctx.settings.get('showTopbar')) { closeTopbar(); return; }
    if (ctx.topbarWin && !ctx.topbarWin.isDestroyed()) {
      ctx.topbarWin.setBounds(topbarMetrics());
      return;
    }
    ctx.topbarWin = new BrowserWindow({
      ...topbarMetrics(),
      frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, hasShadow: false, show: false,
      type: 'toolbar',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    ctx.topbarWin.setAlwaysOnTop(true, 'screen-saver');
    ctx.topbarWin.loadFile(path.join(__dirname, '..', 'renderer', 'topbar.html'));
    ctx.topbarWin.once('ready-to-show', () => {
      ctx.topbarWin.showInactive();
      if (ctx.lastFgAppName !== null) ctx.topbarWin.webContents.send('topbar-app', ctx.lastFgAppName);
    });
    // 整条点击穿透：纯信息展示，绝不遮挡最大化窗口的标题栏交互
    ctx.topbarWin.setIgnoreMouseEvents(true, { forward: true });
  }

  // ---------------------------------------------------------------- exposé

  // 轻量 Exposé：中键点击 Dock 运行中图标 → 该应用窗口缩略图网格。
  // 用后即毁：关闭即 destroy，不驻留渲染进程（省 ~40MB）。
  function closeExpose() {
    if (ctx.exposeWin && !ctx.exposeWin.isDestroyed()) ctx.exposeWin.destroy();
    ctx.exposeWin = null;
  }

  function openExpose(appName, appIcon, windows) {
    const list = (Array.isArray(windows) ? windows : [])
      .filter((w) => w && w.h)
      .slice(0, 24);
    if (!list.length) return;
    if (ctx.exposeWin && !ctx.exposeWin.isDestroyed()) closeExpose();
    const wa = ctx.currentDisplay().workArea;
    ctx.exposeWin = new BrowserWindow({
      x: wa.x, y: wa.y, width: wa.width, height: wa.height,
      frame: false, transparent: true, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    ctx.exposeWin.setAlwaysOnTop(true, 'screen-saver');
    ctx.exposeWin.__createdAt = Date.now();
    ctx.exposeWin.loadFile(path.join(__dirname, '..', 'renderer', 'expose.html'));
    ctx.exposeWin.once('ready-to-show', () => {
      ctx.exposeWin.showInactive();
      ctx.exposeWin.webContents.send('expose-data', { appName, appIcon, windows: list });
    });
    ctx.exposeWin.on('closed', () => { ctx.exposeWin = null; });
    ctx.exposeWin.on('blur', () => {
      if (ctx.exposeWin && Date.now() - (ctx.exposeWin.__createdAt || 0) > 600) closeExpose();
    });
  }

  // ---------------------------------------------------------------- genie

  // genie 动画窗口用后闲置 30s 销毁：省一个常驻渲染进程（约 40MB），下次最小化时重建
  function scheduleGenieDestroy() {
    if (ctx.genieIdleTimer) clearTimeout(ctx.genieIdleTimer);
    ctx.genieIdleTimer = setTimeout(() => {
      ctx.genieIdleTimer = null;
      if (ctx.genieWin && !ctx.genieWin.isDestroyed()) ctx.genieWin.destroy();
      ctx.genieWin = null;
      ctx.genieReady = null;
    }, 30000);
  }

  function ensureGenieWindow() {
    if (ctx.genieIdleTimer) { clearTimeout(ctx.genieIdleTimer); ctx.genieIdleTimer = null; }
    if (ctx.genieWin && !ctx.genieWin.isDestroyed()) return ctx.genieWin;
    const b = ctx.currentDisplay().bounds;
    ctx.genieWin = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    ctx.genieWin.setAlwaysOnTop(true, 'screen-saver');
    ctx.genieWin.setIgnoreMouseEvents(true, { forward: false });
    ctx.genieWin.loadFile(path.join(__dirname, '..', 'renderer', 'genie.html'));
    ctx.genieReady = new Promise((resolve) => {
      ctx.genieWin.webContents.once('did-finish-load', resolve);
    });
    ctx.genieWin.on('closed', () => { ctx.genieWin = null; ctx.genieReady = null; });
    return ctx.genieWin;
  }

  async function getIconTargetForWindow(h) {
    if (!ctx.dockWin || ctx.dockWin.isDestroyed()) return null;
    try {
      const target = await ctx.dockWin.webContents.executeJavaScript(
        `(() => {
        const H = ${JSON.stringify(String(h))};
        for (const [, s] of slotMap) {
          if (s.entry && (s.entry.windows || []).some(w => String(w.h) === H)) {
            const r = s.el.getBoundingClientRect();
            return { x: window.screenX + r.left, y: window.screenY + r.top, w: r.width, h: r.height };
          }
        }
        const b = document.querySelector('#dock-bar').getBoundingClientRect();
        return { x: window.screenX + b.left + b.width / 2 - 20, y: window.screenY + b.top + b.height / 2 - 20, w: 40, h: 40 };
      })()`,
        true,
      );
      return target && target.x !== undefined ? target : null;
    } catch {
      return null;
    }
  }

  async function playGenie(h) {
    try {
      const shot = await ctx.bridge.request('window-shot', { h }, 8000);
      if (!shot || !shot.png) return;
      const rect = await ctx.bridge.request('window-rect', { h: String(h) }, 3000);
      if (!rect || !(rect.w > 0) || !(rect.h > 0)) return;
      const target = await getIconTargetForWindow(h);
      if (!target) return;
      const win = ensureGenieWindow();
      const b = ctx.currentDisplay().bounds;
      if (ctx.genieReady) await ctx.genieReady;
      win.webContents.send('genie:animate', {
        img: 'data:image/png;base64,' + shot.png,
        sx: rect.x - b.x, sy: rect.y - b.y, sw: rect.w, sh: rect.h,
        tx: target.x - b.x, ty: target.y - b.y, tw: target.w, th: target.h,
        mode: ctx.settings.get('minimizeEffect') || 'genie',
      });
      win.showInactive();
      setTimeout(() => {
        if (ctx.genieWin && !ctx.genieWin.isDestroyed()) ctx.genieWin.hide();
        scheduleGenieDestroy();
      }, 700);
    } catch {}
  }

  return {
    openSettingsWindow,
    closeLaunchpad, openLaunchpad, getLaunchpadApps, fillLaunchpadIcons,
    topbarMetrics, closeTopbar, createTopbar,
    closeExpose, openExpose,
    scheduleGenieDestroy, ensureGenieWindow, getIconTargetForWindow, playGenie,
  };
}

module.exports = { createPanelWindows };
