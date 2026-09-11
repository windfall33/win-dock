'use strict';
// P3-F1a main.js 拆分：dock 主窗口（创建/几何/层级/穿透/多屏/工作区预留）。
// v5：支持 dockPerDisplay —— 每块显示器一条 Dock（macOS separate Spaces 语义）。
// 默认仍为「跟随鼠标」单条；ctx.dockWin 保持指向主/当前条，兼容既有 IPC。
const { BrowserWindow, screen } = require('electron');
const path = require('path');

function createDockWindow(ctx) {
  const { log } = ctx;
  /** @type {Map<number, Electron.BrowserWindow>} displayId -> dock window */
  ctx.dockWins = ctx.dockWins || new Map();

  function dockPosition() {
    const p = ctx.settings ? String(ctx.settings.get('position') || 'bottom') : 'bottom';
    return (p === 'left' || p === 'right') ? p : 'bottom';
  }

  function perDisplay() {
    return !!(ctx.settings && ctx.settings.get('dockPerDisplay'));
  }

  function currentDisplay() {
    if (perDisplay()) {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    }
    if (ctx.settings && ctx.settings.get('multidisplay')) {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    }
    return screen.getPrimaryDisplay();
  }

  function dockMetricsFor(display) {
    const size = Number(ctx.settings.get('iconSize')) || 52;
    const mag = Math.min(2.2, Math.max(1, Number(ctx.settings.get('magnification')) || 1.8));
    const pos = dockPosition();
    const strip = Math.ceil(size * mag + 44) + 240;
    const d = display || currentDisplay();
    if (pos === 'left' || pos === 'right') {
      const edgeInset = pos === 'left'
        ? Math.max(0, d.workArea.x - d.bounds.x)
        : Math.max(0, (d.bounds.x + d.bounds.width) - (d.workArea.x + d.workArea.width));
      return {
        width: strip + edgeInset,
        height: d.workArea.height,
        x: pos === 'left' ? d.bounds.x : d.bounds.x + d.bounds.width - (strip + edgeInset),
        y: d.workArea.y,
        size, mag, wa: d.workArea, pos, edgeInset, displayId: d.id,
      };
    }
    const bottomInset = Math.max(0, (d.bounds.y + d.bounds.height) - (d.workArea.y + d.workArea.height));
    return {
      width: d.workArea.width,
      height: strip + bottomInset,
      x: d.workArea.x,
      y: d.bounds.y + d.bounds.height - (strip + bottomInset),
      size, mag, wa: d.workArea, pos, edgeInset: bottomInset, displayId: d.id,
    };
  }

  function dockMetrics() {
    return dockMetricsFor(currentDisplay());
  }

  let workareaApplied = false;
  let workareaBusy = false;
  function applyWorkarea(mode) {
    if (!ctx.bridge || workareaBusy) return;
    let want = mode === 'restore' ? false : !!ctx.settings.get('workareaReserve');
    const primary = screen.getPrimaryDisplay();
    if (want && ctx.curDisplayId && ctx.curDisplayId !== primary.id && !perDisplay()) {
      want = false;
    }
    const wa = primary.workArea;
    const orig = { l: wa.x, t: wa.y, r: wa.x + wa.width, b: wa.y + wa.height };
    if (!want && !workareaApplied) return;
    const args = { reserve: want, orig };
    if (want) {
      const pos = ctx.settings.get('position');
      const barMain = ctx.barRectDip
        ? (pos === 'left' || pos === 'right' ? ctx.barRectDip.w : ctx.barRectDip.h)
        : (ctx.settings.get('iconSize') + 30);
      args.edge = pos;
      args.barSize = Math.max(40, Math.round(barMain + 4));
    }
    workareaBusy = true;
    ctx.bridge.request('set-workarea', args, 8000).then((res) => {
      workareaApplied = want;
      if (res && res.ok === false) log('workarea rejected', res.err || '');
      else log('workarea', want ? 'reserve' : 'restore', JSON.stringify(res && res.wa || orig));
    }).catch((e) => {
      log('workarea apply failed', e.message);
    }).finally(() => { workareaBusy = false; });
  }

  function makeDockWindow(display) {
    const m = dockMetricsFor(display);
    const dockWin = new BrowserWindow({
      x: m.x, y: m.y, width: m.width, height: m.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      type: 'toolbar',
      focusable: false,
      backgroundColor: '#00000000',
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    // floating 而非 screen-saver：screen-saver 会盖住系统托盘弹层/时钟等
    // 右下角浮层；floating 已足够压过普通应用，托盘可正常点开
    dockWin.setAlwaysOnTop(true, 'floating');
    dockWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    dockWin.once('ready-to-show', () => {
      dockWin.showInactive();
      try { dockWin.setIgnoreMouseEvents(true, { forward: true }); } catch {}
      // 多屏新建的条需要立刻拿到一帧状态，否则要等下一轮 poll
      try { if (ctx.pollOnce) ctx.pollOnce(); } catch {}
    });
    dockWin.webContents.on('context-menu', (e) => e.preventDefault());
    dockWin.__displayId = display.id;
    return dockWin;
  }

  function applyBoundsFor(display) {
    const dockWin = ctx.dockWins.get(display.id);
    if (!dockWin || dockWin.isDestroyed()) return;
    const m = dockMetricsFor(display);
    const b = display.bounds;
    const w = Math.min(m.width, b.width);
    const h = Math.min(m.height, b.height);
    const x = Math.min(Math.max(m.x, b.x), b.x + b.width - w);
    const y = Math.min(Math.max(m.y, b.y), b.y + b.height - h);
    dockWin.setBounds({ x, y, width: w, height: h });
    if (!ctx.dockWin || ctx.dockWin.isDestroyed() || ctx.dockWin === dockWin) {
      ctx.dockBoundsDip = dockWin.getBounds();
      ctx.dockHwnd = dockWin.getNativeWindowHandle();
      ctx.curDisplayId = display.id;
    }
    log('dock-bounds', JSON.stringify({
      display: display.id, x, y, w, h, pos: m.pos,
    }));
  }

  function applyBounds() {
    if (!ctx.dockWins.size) return;
    if (perDisplay()) {
      for (const d of screen.getAllDisplays()) {
        if (!ctx.dockWins.has(d.id)) {
          const win = makeDockWindow(d);
          ctx.dockWins.set(d.id, win);
        }
        applyBoundsFor(d);
      }
      // 销毁多余显示器上的条
      const live = new Set(screen.getAllDisplays().map((d) => d.id));
      for (const [id, win] of ctx.dockWins) {
        if (!live.has(id)) {
          try { if (!win.isDestroyed()) win.destroy(); } catch {}
          ctx.dockWins.delete(id);
        }
      }
    } else {
      // 单条：只保留一条，贴当前显示器
      const d = currentDisplay();
      const keep = ctx.dockWins.get(d.id) || ctx.dockWin;
      for (const [id, win] of [...ctx.dockWins]) {
        if (id !== d.id && win && !win.isDestroyed()) {
          try { win.destroy(); } catch {}
        }
        if (id !== d.id) ctx.dockWins.delete(id);
      }
      if (!keep || keep.isDestroyed()) {
        keep = makeDockWindow(d);
        ctx.dockWins.set(d.id, keep);
      } else {
        ctx.dockWins.set(d.id, keep);
      }
      ctx.dockWin = keep;
      ctx.dockHwnd = keep.getNativeWindowHandle();
      applyBoundsFor(d);
      ctx.dockBoundsDip = keep.getBounds();
      ctx.curDisplayId = d.id;
    }
    // 主引用：多屏时指向光标所在屏那条（供 occlusion 等单窗逻辑）
    const cur = currentDisplay();
    const ref = ctx.dockWins.get(cur.id);
    if (ref && !ref.isDestroyed()) {
      ctx.dockWin = ref;
      ctx.dockHwnd = ref.getNativeWindowHandle();
      ctx.dockBoundsDip = ref.getBounds();
      ctx.curDisplayId = cur.id;
    }
  }

  function createDock() {
    ctx.dockWins = new Map();
    if (perDisplay()) {
      for (const d of screen.getAllDisplays()) {
        ctx.dockWins.set(d.id, makeDockWindow(d));
      }
    } else {
      const d = currentDisplay();
      ctx.dockWins.set(d.id, makeDockWindow(d));
    }
    const first = ctx.dockWins.values().next().value;
    ctx.dockWin = first;
    if (first) {
      ctx.dockHwnd = first.getNativeWindowHandle();
      ctx.curDisplayId = first.__displayId;
    }
    applyBounds();
  }

  function forEachDockWin(fn) {
    for (const win of ctx.dockWins.values()) {
      if (win && !win.isDestroyed()) fn(win);
    }
  }

  // 点击穿透：可指定窗口（多屏时只应有一条处于交互态），默认作用于全部
  function setClickThrough(on, targetWin) {
    const apply = (win) => {
      if (!win || win.isDestroyed()) return;
      try { win.setIgnoreMouseEvents(!!on, { forward: true }); } catch {}
    };
    if (targetWin) apply(targetWin);
    else forEachDockWin(apply);
  }

  function assertWindowLevels() {
    try {
      forEachDockWin((w) => w.setAlwaysOnTop(true, 'floating'));
      const { topbarWin, launchpadWin } = ctx;
      if (topbarWin && !topbarWin.isDestroyed()) topbarWin.setAlwaysOnTop(true, 'floating');
      if (launchpadWin && !launchpadWin.isDestroyed()) launchpadWin.setAlwaysOnTop(true, 'floating');
    } catch {}
  }

  function maybeFollowCursorDisplay() {
    if (perDisplay()) return;
    if (!ctx.settings || !ctx.settings.get('multidisplay')) return;
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (disp.id !== ctx.curDisplayId) {
      ctx.curDisplayId = disp.id;
      applyBounds();
      if (ctx.topbarWin && !ctx.topbarWin.isDestroyed()) ctx.topbarWin.setBounds(ctx.topbarMetrics());
    }
  }

  return {
    currentDisplay, dockPosition, dockMetrics, dockMetricsFor,
    applyWorkarea, applyBounds, createDock, setClickThrough,
    assertWindowLevels, maybeFollowCursorDisplay, forEachDockWin,
  };
}

module.exports = { createDockWindow };
