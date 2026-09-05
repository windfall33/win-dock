'use strict';
// P3-F1a main.js 拆分：dock 主窗口（创建/几何/层级/穿透/多屏跟随/工作区预留）。
// 纯平移：函数体自 main.js 逐行迁移，共享状态经 ctx 读写（与原全局变量一一对应）。
const { BrowserWindow, screen } = require('electron');
const path = require('path');

function createDockWindow(ctx) {
  const { log } = ctx;

  function currentDisplay() {
    if (ctx.settings && ctx.settings.get('multidisplay')) {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    }
    return screen.getPrimaryDisplay();
  }

  function dockPosition() {
    const p = ctx.settings ? String(ctx.settings.get('position') || 'bottom') : 'bottom';
    return (p === 'left' || p === 'right') ? p : 'bottom';
  }

  function dockMetrics() {
    const size = Number(ctx.settings.get('iconSize')) || 52;
    const mag = Math.min(2.2, Math.max(1, Number(ctx.settings.get('magnification')) || 1.8));
    const pos = dockPosition();
    // 条带厚度 = 容纳放大图标 + 指示点 + 内边距 + 留白（悬停预览面板在 DOM 内弹出，
    // 不能超出窗口边界，故窗口整体加厚；留白区透明且始终点击穿透）
    const strip = Math.ceil(size * mag + 44) + 240;
    const d = currentDisplay();
    if (pos === 'left' || pos === 'right') {
      // 侧栏：窗口延伸到屏幕真实侧边，贴边唤醒手势与 macOS 一致；
      // 侧边内嵌宽度（任务栏在侧边等场景）让开，条本体仍停在 workArea 边缘。
      const edgeInset = pos === 'left'
        ? Math.max(0, d.workArea.x - d.bounds.x)
        : Math.max(0, (d.bounds.x + d.bounds.width) - (d.workArea.x + d.workArea.width));
      return {
        width: strip + edgeInset,
        height: d.workArea.height,
        x: pos === 'left' ? d.bounds.x : d.bounds.x + d.bounds.width - (strip + edgeInset),
        y: d.workArea.y,
        size, mag, wa: d.workArea, pos, edgeInset,
      };
    }
    // 底部内嵌高度（Windows 任务栏等 workArea 之外的底部区域）：
    // Dock 窗口延伸到屏幕真实底边，贴底唤醒手势与 macOS 一致；
    // 透明+穿透，不影响任务栏交互，条本体仍停在 workArea 底边之上。
    const bottomInset = Math.max(0, (d.bounds.y + d.bounds.height) - (d.workArea.y + d.workArea.height));
    return {
      width: d.workArea.width,
      height: strip + bottomInset,
      x: d.workArea.x,
      y: d.bounds.y + d.bounds.height - (strip + bottomInset),
      size, mag, wa: d.workArea, pos, edgeInset: bottomInset,
    };
  }

  // ---- 工作区预留（SPI_SETWORKAREA）----
  // 开启后把 Dock 条占据的边缘从主显示器桌面工作区中扣除，
  // 最大化窗口会自动避开 Dock（macOS 原版行为）。仅主显示器生效。
  // 原始工作区直接取 Electron screen.workArea（已扣任务栏、未扣 Dock），
  // 不依赖桥接回读，天然规避「桥接崩溃期间残留预留导致二次收缩」的风险。
  let workareaApplied = false; // 当前是否处于预留状态
  let workareaBusy = false;    // 防重入（request 在途时忽略新调用）
  function applyWorkarea(mode) {
    if (!ctx.bridge || workareaBusy) return;
    // mode='restore'：无条件恢复（退出时用）；否则按设置决定
    let want = mode === 'restore' ? false : !!ctx.settings.get('workareaReserve');
    const primary = screen.getPrimaryDisplay();
    if (want && ctx.curDisplayId && ctx.curDisplayId !== primary.id) {
      want = false; // Dock 不在主屏：SPI 工作区只管主显示器，退化为不预留
    }
    const wa = primary.workArea;
    const orig = { l: wa.x, t: wa.y, r: wa.x + wa.width, b: wa.y + wa.height };
    if (!want && !workareaApplied) return; // 既不要求预留也没有已生效的预留
    const args = { reserve: want, orig };
    if (want) {
      const pos = ctx.settings.get('position');
      // 预留量：优先用渲染层上报的条矩形主轴尺寸，缺失时按 iconSize 估算
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

  function applyBounds() {
    const dockWin = ctx.dockWin;
    if (!dockWin) return;
    const m = dockMetrics();
    // 防御：dock 窗口不得越出显示器边界（某些分辨率/DPI/位置下 strip 或 inset 可能让坐标越界）
    const b = currentDisplay().bounds;
    const w = Math.min(m.width, b.width);
    const h = Math.min(m.height, b.height);
    const x = Math.min(Math.max(m.x, b.x), b.x + b.width - w);
    const y = Math.min(Math.max(m.y, b.y), b.y + b.height - h);
    dockWin.setBounds({ x, y, width: w, height: h });
    ctx.dockBoundsDip = dockWin.getBounds();
    ctx.curDisplayId = currentDisplay().id;
    log('dock-bounds', JSON.stringify({
      x, y, w, h, pos: m.pos, want: { x: m.x, y: m.y, w: m.width, h: m.height },
      screen: { x: b.x, y: b.y, w: b.width, h: b.height },
    }));
  }

  function createDock() {
    const m = dockMetrics();
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
    ctx.dockWin = dockWin;
    ctx.dockHwnd = dockWin.getNativeWindowHandle();
    // screen-saver 级：盖过普通置顶应用（topmost 会被 maximized 前台应用反超）
    dockWin.setAlwaysOnTop(true, 'screen-saver');
    dockWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    dockWin.once('ready-to-show', () => {
      dockWin.showInactive();
      // 初始：整体穿透，由渲染层在悬停到 Dock 上时再解除
      setClickThrough(true);
    });
    dockWin.on('closed', () => { ctx.dockWin = null; });

    // 阻止系统右键/菜单干扰
    dockWin.webContents.on('context-menu', (e) => e.preventDefault());
  }

  // 点击穿透控制：true = 整窗穿透（鼠标事件仍转发给渲染层用于热区判断）
  let clickThroughOn = true;
  function setClickThrough(on) {
    const dockWin = ctx.dockWin;
    if (!dockWin || dockWin.isDestroyed()) return;
    if (on === clickThroughOn && arguments.length === 1 && dockWin.__ctInitialized) return;
    dockWin.__ctInitialized = true;
    clickThroughOn = on;
    try {
      dockWin.setIgnoreMouseEvents(on, { forward: true });
    } catch (e) { log('setIgnoreMouseEvents failed', e.message); }
  }

  // 底边唤醒不再使用独立探针窗口：Dock 窗口本身贴屏幕底边，点击穿透模式下
  // 鼠标移动事件经 forward 转发进渲染层，由渲染层检测底边悬停后 request-show。
  // 省掉一个常驻渲染进程（约 65MB）。

  // 周期重申 z-order：topmost 带内后来者会反超（如常驻置顶应用、任务栏滑出），
  // 拖拽类应用反复插顶，Dock/探针需要定期回到 screen-saver 级。
  function assertWindowLevels() {
    try {
      const { dockWin, topbarWin, launchpadWin } = ctx;
      if (dockWin && !dockWin.isDestroyed()) dockWin.setAlwaysOnTop(true, 'screen-saver');
      if (topbarWin && !topbarWin.isDestroyed()) topbarWin.setAlwaysOnTop(true, 'screen-saver');
      if (launchpadWin && !launchpadWin.isDestroyed()) launchpadWin.setAlwaysOnTop(true, 'screen-saver');
    } catch {}
  }

  function maybeFollowCursorDisplay() {
    if (!ctx.settings || !ctx.settings.get('multidisplay')) return;
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (disp.id !== ctx.curDisplayId) {
      ctx.curDisplayId = disp.id;
      applyBounds();
      if (ctx.topbarWin && !ctx.topbarWin.isDestroyed()) ctx.topbarWin.setBounds(ctx.topbarMetrics());
    }
  }

  return {
    currentDisplay, dockPosition, dockMetrics,
    applyWorkarea, applyBounds, createDock, setClickThrough,
    assertWindowLevels, maybeFollowCursorDisplay,
  };
}

module.exports = { createDockWindow };
