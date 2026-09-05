'use strict';
const { app, BrowserWindow, ipcMain, screen, nativeTheme, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const { NativeBridge, IconCache } = require('./core/native.js');
const { Settings } = require('./core/settings.js');
const { updateRecent } = require('./core/recent.js');
const { stateSignature } = require('./core/state-hash.js');
// 状态快照合成已下沉到 core/snapshot.js（依赖注入、可单测）；
// extractMinimized / extractBadgeCount / visibleRecent 随之只在 core 内部使用。
const { createSnapshotBuilder, normalizeExe, exeKey } = require('./core/snapshot.js');
// 「固定应用 + 快捷方式图标源规范」下沉到 core/pin-app.js（依赖注入、可单测）
const { createPinApp, normalizeIconSource } = require('./core/pin-app.js');
const { isDesktopForeground, isCursorNearBar, decideOcclusionState } = require('./core/occlusion.js');

// ---------------------------------------------------------------------------
// globals

let settings;
let bridge;
let icons;

let dockWin = null;
let dockHwnd = null;
let dockBoundsDip = null;
let settingsWin = null;
let launchpadWin = null;
let topbarWin = null;
let genieWin = null;
let genieReady = null;
let launchpadApps = null;   // Launchpad 缓存：{ id, name, target, args, iconPath, icon }
let lastFgAppName = null;
let barRectDip = null;        // 渲染层上报的可见条矩形（DIP），遮挡判定用

let lastPayloadHash = '';
let dockHiddenByUs = false;   // autohide 状态
let fullscreenHide = false;   // 前台是真全屏应用（macOS 让位行为）
let coveredHideNow = false;   // 被普通窗口覆盖让位（仅 occludeAway 开启时）
let onDesktopNow = false;     // 前台是桌面：Dock 永远显示
let mouseAtBottom = false;    // 鼠标贴底边/悬停 Dock 时临时显示
let pointerNearDock = null;   // 全局光标是否在 Dock 区（null=未知）；渲染层放大态的兜底判据
let runningProc = new Set();   // 有进程在跑的固定应用 exe（含无窗口的托盘应用）
let procTick = 0;              // 后台进程探测节流
let lastFgHwndStr = '';        // 上次前台窗口句柄（变化即触发一次状态刷新）
let pollTimer = null;
let occTimer = null;
let occFailCount = 0;         // 遮挡轮询连续失败计数（用于日志节奏与保底推送）
let trashTick = 0;
let curDisplayId = null;      // 当前 Dock 所在显示器 id（多显示器跟随用）
const forceKillTimers = new Set(); // quit-app 优雅退出的强杀兜底定时器（退出时清理）

const SKIP_RECENT_HOSTS = new Set([
  'explorer.exe', 'searchhost.exe', 'shellexperiencehost.exe',
  'runtimebroker.exe', 'textinputhost.exe', 'applicationframehost.exe',
  'startmenuexperiencehost.exe', 'dwm.exe',
]);

// 桌面壳窗口类名：前台是这些类时 Dock 永远显示，忽略 autohide 与遮挡让位。
// 不含 ExploreWClass（那是真正的资源管理器窗口，属于应用窗口）。
const DESKTOP_CLASSES = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'SHELLDLL_DefView',
]);

app.commandLine.appendSwitch('disable-gpu-vsync');
// 常驻置顶透明窗口会被 Chromium 原生遮挡计算误判而节流，禁用之保动画丝滑
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 视觉回归调试：DOCK_DEBUG=1 启动时开放 CDP（9223），可用 cdp.js 抓渲染层原生截图
if (process.env.DOCK_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223');
}

// ---------------------------------------------------------------------------
// helpers

const log = (...a) => {
  try {
    const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'logs', 'main.log'), line);
  } catch {}
  console.log(...a);
};

// normalizeExe / exeKey 由 core/snapshot.js 导出，normalizeIconSource 由
// core/pin-app.js 导出 —— 此处与 checkOcclusion / launchpad 图标共享同一份实现

// 统一启动入口：尽可能交给 Windows 系统 ShellExecute（Start-Process / Electron shell），
// 完整保留工作目录、快捷方式参数、图标、UWP 注册、单实例语义；不再对 .exe 用 spawn 裸奔。
async function launchTarget(target, args) {
  if (!target) return;
  const ext = path.extname(target).toLowerCase();
  const argArr = Array.isArray(args)
    ? args.map(String)
    : (typeof args === 'string' && args.trim() ? [args] : []);

  // Windows Terminal 的应用执行别名：CreateProcess/start 都会把参数整串当成可执行名（0x80070002）。
  // 唯一稳的是用 PowerShell 的 & 调用，参数才会被正确拆分。
  if (/wt\.exe$/i.test(target)) {
    const quoted = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const psCmd = '& ' + [target, ...argArr].map(quoted).join(' ');
    try {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd,
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch { /* 交给兜底 */ }
    return;
  }

  // shell 命名空间（回收站 / AppsFolder 等）→ explorer
  if (target.startsWith('shell:')) {
    await bridge.request('open', { target }, 15000).catch(() => {});
    return;
  }

  // .lnk：原始快捷方式直接交给系统 ShellExecute，Windows 自行解析工作目录/参数/图标/UWP 注册
  if (ext === '.lnk') {
    await bridge.request('open', { target }, 15000).catch(() => {});
    return;
  }

  // .exe/.bat/.cmd 或带参数的目标 → bridge Start-Process（等同 ShellExecute，保留工作目录/提权/DDE 语义）
  if (['.exe', '.bat', '.cmd'].includes(ext) || argArr.length) {
    // 保留参数原类：字符串（快捷方式 Arguments/Launchpad）原样交桥接 Start-Process 解析，
    // 数组则逐元素加引号（含空格的文件路径等）。避免把 `--flag "path"` 当单个参数拆分错。
    const preserveArgs = typeof args === 'string' ? args : argArr;
    await bridge.request('open', { target, args: preserveArgs }, 15000).catch(() => {});
    return;
  }

  // 其余类型（文件/目录/协议）→ Electron shell
  shell.openPath(target);
}

// 开机自启：未打包的 Electron 必须显式传 path（electron.exe）与 args（应用目录），
// 否则注册表只写 exe 路径、不带应用参数，开机后起不来 Dock。
function applyLoginItem(open) {
  try {
    const opts = { openAtLogin: !!open };
    if (!app.isPackaged) {
      opts.path = process.execPath;
      opts.args = [app.getAppPath()];
    }
    app.setLoginItemSettings(opts);
  } catch (e) {
    log('setLoginItemSettings failed', e.message);
  }
}

function currentDisplay() {
  if (settings && settings.get('multidisplay')) {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  return screen.getPrimaryDisplay();
}

function dockPosition() {
  const p = settings ? String(settings.get('position') || 'bottom') : 'bottom';
  return (p === 'left' || p === 'right') ? p : 'bottom';
}

function dockMetrics() {
  const size = Number(settings.get('iconSize')) || 52;
  const mag = Math.min(2.2, Math.max(1, Number(settings.get('magnification')) || 1.8));
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
  if (!bridge || workareaBusy) return;
  // mode='restore'：无条件恢复（退出时用）；否则按设置决定
  let want = mode === 'restore' ? false : !!settings.get('workareaReserve');
  const primary = screen.getPrimaryDisplay();
  if (want && curDisplayId && curDisplayId !== primary.id) {
    want = false; // Dock 不在主屏：SPI 工作区只管主显示器，退化为不预留
  }
  const wa = primary.workArea;
  const orig = { l: wa.x, t: wa.y, r: wa.x + wa.width, b: wa.y + wa.height };
  if (!want && !workareaApplied) return; // 既不要求预留也没有已生效的预留
  const args = { reserve: want, orig };
  if (want) {
    const pos = settings.get('position');
    // 预留量：优先用渲染层上报的条矩形主轴尺寸，缺失时按 iconSize 估算
    const barMain = barRectDip
      ? (pos === 'left' || pos === 'right' ? barRectDip.w : barRectDip.h)
      : (settings.get('iconSize') + 30);
    args.edge = pos;
    args.barSize = Math.max(40, Math.round(barMain + 4));
  }
  workareaBusy = true;
  bridge.request('set-workarea', args, 8000).then((res) => {
    workareaApplied = want;
    if (res && res.ok === false) log('workarea rejected', res.err || '');
    else log('workarea', want ? 'reserve' : 'restore', JSON.stringify(res && res.wa || orig));
  }).catch((e) => {
    log('workarea apply failed', e.message);
  }).finally(() => { workareaBusy = false; });
}

function applyBounds() {
  if (!dockWin) return;
  const m = dockMetrics();
  // 防御：dock 窗口不得越出显示器边界（某些分辨率/DPI/位置下 strip 或 inset 可能让坐标越界）
  const b = currentDisplay().bounds;
  const w = Math.min(m.width, b.width);
  const h = Math.min(m.height, b.height);
  const x = Math.min(Math.max(m.x, b.x), b.x + b.width - w);
  const y = Math.min(Math.max(m.y, b.y), b.y + b.height - h);
  dockWin.setBounds({ x, y, width: w, height: h });
  dockBoundsDip = dockWin.getBounds();
  curDisplayId = currentDisplay().id;
  log('dock-bounds', JSON.stringify({
    x, y, w, h, pos: m.pos, want: { x: m.x, y: m.y, w: m.width, h: m.height },
    screen: { x: b.x, y: b.y, w: b.width, h: b.height },
  }));
}

function createDock() {
  const m = dockMetrics();
  dockWin = new BrowserWindow({
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  dockHwnd = dockWin.getNativeWindowHandle();
  // screen-saver 级：盖过普通置顶应用（topmost 会被 maximized 前台应用反超）
  dockWin.setAlwaysOnTop(true, 'screen-saver');
  dockWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  dockWin.once('ready-to-show', () => {
    dockWin.showInactive();
    // 初始：整体穿透，由渲染层在悬停到 Dock 上时再解除
    setClickThrough(true);
  });
  dockWin.on('closed', () => { dockWin = null; });

  // 阻止系统右键/菜单干扰
  dockWin.webContents.on('context-menu', (e) => e.preventDefault());
}

// 点击穿透控制：true = 整窗穿透（鼠标事件仍转发给渲染层用于热区判断）
let clickThroughOn = true;
function setClickThrough(on) {
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

// ---------------------------------------------------------------------------
// 应用状态合成（pins + 运行窗口合并）

async function fetchIconsFor(entries) {
  const jobs = [];
  for (const e of entries) {
    const iconPath = e.iconPath || e.exe;
    if (!e.icon && iconPath && !icons.hasFailed(iconPath)) {
      jobs.push(
        icons.fetch(bridge, iconPath)
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

// 未固定应用的会话稳定跟踪：首现顺序固定 + 连续两帧才显示（滤掉幽灵窗口）
// 状态快照合成器：原先内联在本文件的 buildStateSnapshot 已下沉到 core/snapshot.js。
// 外部状态（settings / icons / runningProc / env / 废纸篓计数）全部显式注入，
// 使这段最复杂的编排逻辑可以在 test/snapshot.test.js 里用假依赖整段验证；
// extrasSeq / extrasSeen 等会话状态随之由 builder 内部维护，不再散落在主进程。
const snapshotBuilder = createSnapshotBuilder({
  getSettingsAll: () => settings.all,
  getSetting: (k) => settings.get(k),
  iconsGetSync: (p) => icons.getSync(p),
  runningProc,
  getEnv: () => {
    const m = dockMetrics();
    return {
      dockHidden: !onDesktopNow && dockHiddenByUs && !mouseAtBottom,
      fullscreenHide: fullscreenHide && !mouseAtBottom,
      coveredHide: coveredHideNow && !mouseAtBottom,
      pointerNearDock: pointerNearDock === null ? true : pointerNearDock,
      appActive: !onDesktopNow,
      position: m.pos,
      edgeInset: m.edgeInset,
    };
  },
  getTrashCount: () => TrashLastCount,
});

let TrashLastCount = 0;

// ---------------------------------------------------------------------------
// 轮询

let pollBusy = false;

async function pollOnce() {
  if (pollBusy || !bridge) return;
  pollBusy = true;
  try {
    await pollInner();
  } catch (e) {
    log('poll error:', e.message);
  } finally {
    pollBusy = false;
  }
}

async function pollInner() {
  let winList = [];
  try {
    const res = await bridge.request('enum-windows', { excludePid: process.pid }, 8000);
    winList = Array.isArray(res) ? res : [];
  } catch (e) {
    log('enum-windows failed:', e.message);
    return;
  }

  // 前台标志 f 已在 enum-windows 枚举时写入，无需再发一次 foreground 往返

  if (++trashTick % 4 === 0) {
    try {
      const t = await bridge.request('trash-count', {}, 6000);
      TrashLastCount = t.count | 0;
    } catch {}
  }

  // 后台进程感知：低频刷新「固定应用是否有进程在跑」（无窗口的托盘应用也算运行中）
  const pinNames = (settings.all.pins || [])
    .filter((x) => x.kind !== 'folder' && x.exe)
    .map((x) => x.exe);
  if (++procTick % 2 === 0 && pinNames.length) {
    try {
      const rp = await bridge.request('processes-running', { names: pinNames }, 8000);
      if (rp && rp.running) {
        runningProc = new Set(Object.keys(rp.running).filter((k) => rp.running[k]));
      }
    } catch {}
  }

  const snap = snapshotBuilder.build(winList, true);

  // 立即推送（图标已在快照里同步取缓存；仅新增应用首帧后异步补齐再推一次）
  pushState(snap);
  await fetchIconsFor([...snap.entries, ...(snap.minimized || []), ...(snap.recent || [])]);
  pushState(snap);
}

// 遮挡检测独立于慢轮询：前台窗口覆盖 Dock 时尽快隐藏（约 350ms 一查）
let zAssertTick = 0;

// 周期重申 z-order：topmost 带内后来者会反超（如常驻置顶应用、任务栏滑出），
// 拖拽类应用反复插顶，Dock/探针需要定期回到 screen-saver 级。
function assertWindowLevels() {
  try {
    if (dockWin && !dockWin.isDestroyed()) dockWin.setAlwaysOnTop(true, 'screen-saver');
    if (topbarWin && !topbarWin.isDestroyed()) topbarWin.setAlwaysOnTop(true, 'screen-saver');
    if (launchpadWin && !launchpadWin.isDestroyed()) launchpadWin.setAlwaysOnTop(true, 'screen-saver');
  } catch {}
}

function maybeFollowCursorDisplay() {
  if (!settings || !settings.get('multidisplay')) return;
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (disp.id !== curDisplayId) {
    curDisplayId = disp.id;
    applyBounds();
    if (topbarWin && !topbarWin.isDestroyed()) topbarWin.setBounds(topbarMetrics());
  }
}

async function checkOcclusion() {
  if (!bridge) return;
  maybeFollowCursorDisplay();
  if (++zAssertTick % 10 === 0) assertWindowLevels();
  try {
    if (dockWin && !dockWin.isDestroyed()) {
      const hbuf = dockHwnd;
      const hwnd = hbuf.readBigUInt64LE ? hbuf.readBigUInt64LE(0).toString() : String(hbuf.readUInt32LE(0));
      const occArgs = { hwnd };
      if (barRectDip && dockWin) {
        // 桥接进程为 DPI-unaware，其窗口坐标即 DIP（主屏虚拟化域），
        // 直接传 DIP 值与它的 GetWindowRect 同域可比
        const gb = dockBoundsDip || dockWin.getBounds();
        occArgs.bar = {
          l: gb.x + barRectDip.x, t: gb.y + barRectDip.y,
          r: gb.x + barRectDip.x + barRectDip.w, b: gb.y + barRectDip.y + barRectDip.h,
        };
      }
      const occ = await bridge.request('dock-occluded', occArgs, 3000);
      occFailCount = 0;
      const fg = occ && occ.fg;
      // 前台应用名变化 → 推送顶栏
      const fgName = (fg && fg.e) ? path.basename(normalizeExe(fg.e)).replace(/\.exe$/i, '') : '';
      if (fgName !== lastFgAppName) {
        lastFgAppName = fgName;
        if (topbarWin && !topbarWin.isDestroyed()) {
          topbarWin.webContents.send('topbar-app', fgName);
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
      if (near !== pointerNearDock) {
        pointerNearDock = near;
        sendEnv();
      }
      // 隐藏状态机（纯决策已下沉 core/occlusion.js，可单测；此处只做 IO）：
      // 桌面 → 永远显示；真全屏 + 让位开启 + 光标不近 → 让位；
      // 普通窗口覆盖一律不让位（Dock 置顶，矩形判 covered 曾致 250ms 抽搐）。
      const dec = decideOcclusionState({
        isDesktop: isDesktopForeground(fg, DESKTOP_CLASSES),
        occFull: !!(occ && occ.full),
        occludeAway: !!settings.get('occludeAway'),
        cursorNear: pointerNearDock === true,
        prev: { onDesktopNow, fullscreenHide, coveredHideNow, dockHiddenByUs },
      });
      ({ onDesktopNow, fullscreenHide, coveredHideNow, dockHiddenByUs } = dec.next);
      if (dec.fullscreenAwayChanged !== null) {
        log('fullscreen-away', dec.fullscreenAwayChanged ? 'on' : 'off', fg && fg.t || '');
      }
      if (dec.envChanged) sendEnv();
      // 最近使用跟踪（高频，350ms 一查；仅非桌面前台，桌面前台不污染 LRU）
      if (!dec.next.onDesktopNow) {
        const base = path.basename(normalizeExe(fg.e));
        // 跳过系统壳/宿主进程，避免污染最近使用
        if (!SKIP_RECENT_HOSTS.has(base)) {
          const upd = updateRecent(settings.all.recentApps || [], {
            name: base.replace(/\.exe$/i, ''),
            exe: fg.e,
          });
          if (upd.changed) settings.set('recentApps', upd.list);
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
    if (occFailCount === 12 && dockWin && !dockWin.isDestroyed()) {
      try { sendEnv(); } catch {}
    }
  }
}

function pushState(snap) {  if (!dockWin || dockWin.isDestroyed()) return;
  const hash = stateSignature(snap);
  if (hash !== lastPayloadHash) {
    lastPayloadHash = hash;
    // env 一并随 state 推送，渲染层 onState 处理；隐藏/显示的即时反馈走 sendEnv
    dockWin.webContents.send('state', snap);
  }
}

// ---------------------------------------------------------------------------
// IPC

function registerIpc() {
  ipcMain.handle('dock:invoke', async (_ev, channel, payload) => {
    try {
      return await handleInvoke(channel, payload || {});
    } catch (e) {
      log('invoke failed', channel, e.message);
      return { ok: false, err: e.message };
    }
  });

  ipcMain.handle('dock:get-state-sync', () => {
    const snap = snapshotBuilder.build([], false);
    if (snap.extras) snap.settings.launchAtLogin = !!settings.get('launchAtLogin');
    return snap;
  });
}

// set-setting 白名单：允许渲染层通过 IPC 写入的设置项
const SETTING_KEYS = ['iconSize', 'magnification', 'autohide', 'position', 'launchAtLogin', 'appearance', 'hideTaskbar', 'showTopbar', 'multidisplay', 'occludeAway', 'minimizeEffect', 'minimizeIntoIcon', 'workareaReserve'];

// 设置项变更的副作用编排（原 handleInvoke 的 set-setting case 体，switch 里最重的两块之一）。
// 顺序敏感：hideTaskbar 的桥接往返失败时直接返回，不落后面的 applyBounds/broadcast；
// position 需要连续做 bounds/workarea/env 三件事。
async function applySettingChange(k, v) {
  if (!SETTING_KEYS.includes(k)) return { ok: true };
  settings.set(k, v);
  if (k === 'launchAtLogin') {
    applyLoginItem(v);
  }
  if (k === 'appearance') {
    nativeTheme.themeSource = v === 'system' ? 'system' : v;
  }
  if (k === 'occludeAway') {
    coveredHideNow = false;
    sendEnv();
  }
  if (k === 'showTopbar') {
    if (v) createTopbar(); else closeTopbar();
  }
  if (k === 'multidisplay') {
    applyBounds();
    createTopbar();
  }
  if (k === 'hideTaskbar') {
    try {
      const backup = settings.get('taskbarSettingsBackup') || null;
      const res = await bridge.request('taskbar-autohide', { on: !!v, backup }, 20000);
      if (res && res.ok !== false) {
        if (!!v && res.backup) settings.set('taskbarSettingsBackup', res.backup);
        settings.set('hideTaskbar', !!v);
      } else {
        return { ok: false, err: (res && res.err) || 'taskbar-toggle-failed' };
      }
    } catch (e) {
      return { ok: false, err: e.message };
    }
  }
  if (k === 'iconSize' || k === 'magnification' || k === 'position') applyBounds();
  // Dock 位置切换后立即把新的 position + edgeInset 推给渲染层，否则要等下一个
  // 1.4s 状态推送才更新布局/条矩形，侧栏贴边与遮挡判定会短暂错位。
  if (k === 'position') sendEnv();
  if (k === 'workareaReserve' || k === 'iconSize' || k === 'position') applyWorkarea();
  broadcastSettings();
  return { ok: true };
}

// 「固定应用」核心逻辑已下沉 core/pin-app.js（依赖注入、可单测，test/pin-app.test.js）。
// bridge 实例创建后不变，但用 getter 取值以规避工厂创建早于 bridge 赋值的时序问题。
const pinAppFromPath = createPinApp({
  getBridge: () => bridge,
  getSettingsAll: () => settings.all,
  setSetting: (k, v) => settings.set(k, v),
});

async function handleInvoke(channel, p) {
  switch (channel) {

    case 'ready':
      applyBounds();
      setClickThrough(true);
      return { ok: true };

    case 'set-click-through':
      setClickThrough(!!p.on);
      mouseAtBottom = !p.on;
      sendEnv();
      return { ok: true };

    case 'request-hide':   // autohide：鼠标离开后滑出
      dockHiddenByUs = true;
      mouseAtBottom = false;
      sendEnv();
      return { ok: true };

    case 'request-show':   // 底边唤醒 / 显式请求
      dockHiddenByUs = false;
      mouseAtBottom = true;
      // 唤醒即指针在 Dock 区：乐观置位，避免 350ms 陈旧的 near=false
      // 立刻把刚唤回的 Dock 重新打回穿透
      pointerNearDock = true;
      sendEnv();
      return { ok: true };

    case 'launch': {
      // p: {exe, launch?, args?[], id} —— 启动应用；.lnk 走原始快捷方式，.exe 走 ShellExecute
      const target = p.launch || p.exe;
      if (target) {
        const args = p.args !== undefined && p.args !== null ? p.args : [];
        await launchTarget(target, args);
      }
      return { ok: true };
    }

    case 'open-with': { // 把拖进来的文件交给某个 Dock 应用打开
      const args = typeof p.args === 'string'
        ? (p.args && p.args.trim() ? [p.args] : [])
        : (Array.isArray(p.args) ? p.args.slice() : []);
      if (p.filePath) args.push(p.filePath);
      const target = p.launch || p.exe;
      if (target) await launchTarget(target, args);
      return { ok: true };
    }

    case 'focus-window':
      await bridge.request('focus', { h: p.h }, 5000);
      return { ok: true };

    case 'minimize-window':
      await playGenie(p.h);
      await bridge.request('minimize', { h: p.h }, 5000);
      return { ok: true };

    case 'minimize-windows': {
      const hs = p.hs || [];
      if (hs.length) await playGenie(hs[0]);
      for (const h of p.hs || []) {
        try { await bridge.request('minimize', { h }, 3000); } catch {}
      }
      return { ok: true };
    }

    case 'close-windows': {
      for (const h of p.hs || []) {
        try { await bridge.request('close-window', { h }, 3000); } catch {}
      }
      return { ok: true };
    }

    case 'quit-app': {
      // macOS Dock「退出」= 真正退出应用。按「该应用各窗口所属进程」逐个 /PID 退出，
      // 不用 /IM 镜像名（会误杀同名进程，如多个 Chrome/python.exe）。taskkill 不带 /F 发 WM_CLOSE 优雅退出。
      const hs = p.hs || [];
      const pids = new Set();
      for (const h of hs) {
        try {
          const r = await bridge.request('window-pid', { h: String(h) }, 5000);
          if (r && r.pid) pids.add(Number(r.pid));
        } catch {}
      }
      // P1-F6：hung（无响应）应用走「强制退出」——跳过优雅等待，直接 Stop-Process -Force
      // （复用强杀路径；explorer 是 Windows 外壳，强杀会连任务栏一起拔掉，同样排除）
      if (p.force) {
        if (pids.size) {
          const idList = [...pids].join(',');
          await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-Process -Id ' + idList + ' -ErrorAction SilentlyContinue | ' +
            "Where-Object { $_.ProcessName -ne 'explorer' } | Stop-Process -Force"], () => res()));
        }
        return { ok: true };
      }
      for (const pid of pids) {
        try { await new Promise((res) => execFile('taskkill', ['/PID', String(pid)], () => res())); } catch {}
      }
      // 强杀兜底：WM_CLOSE 后仍存活（如弹了「是否保存」对话框挂住）→ ~3s 后升级 /F。
      // 用 Get-Process 按 Id 探活（进程已退出自然落空）；explorer 是 Windows 外壳，
      // 强杀会连任务栏一起拔掉，排除。
      if (pids.size) {
        const idList = [...pids].join(',');
        const t = setTimeout(() => {
          forceKillTimers.delete(t);
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-Process -Id ' + idList + ' -ErrorAction SilentlyContinue | ' +
            "Where-Object { $_.ProcessName -ne 'explorer' } | Stop-Process -Force"], () => {});
        }, 3000);
        if (typeof t.unref === 'function') t.unref();
        forceKillTimers.add(t);
      }
      return { ok: true };
    }

    case 'hide-others': {
      // macOS「隐藏其他」：最小化除当前应用外的所有窗口
      const mine = new Set((p.hs || []).map(String));
      const wins = await bridge.request('enum-windows', { excludePid: process.pid }, 8000).catch(() => []);
      for (const w of (Array.isArray(wins) ? wins : [])) {
        if (!w.m && !mine.has(String(w.h))) {
          try { await bridge.request('minimize', { h: w.h }, 3000); } catch {}
        }
      }
      return { ok: true };
    }

    case 'show-all': {
      // macOS「显示所有窗口」：还原所有最小化窗口
      const wins = await bridge.request('enum-windows', { excludePid: process.pid }, 8000).catch(() => []);
      for (const w of (Array.isArray(wins) ? wins : [])) {
        if (w.m) {
          try { await bridge.request('focus', { h: w.h }, 3000); } catch {}
        }
      }
      return { ok: true };
    }

    case 'kill-app': {
      await new Promise((res) => execFile('taskkill', ['/PID', String(p.pid), '/F'], () => res()));
      return { ok: true };
    }

    case 'reveal':
      await bridge.request('reveal', { path: p.path }, 8000);
      return { ok: true };

    case 'open-trash':
      await bridge.request('open', { target: 'shell:RecycleBinFolder' }, 8000);
      return { ok: true };

    case 'empty-trash':
      await bridge.request('empty-trash', {}, 20000);
      TrashLastCount = 0;
      return { ok: true };

    case 'recycle-files': {
      const res = await bridge.request('recycle', { paths: p.paths || [] }, 30000);
      return { ok: true, failed: res.failed || [] };
    }

    case 'move-files': {
      const res = await bridge.request('move-files', { dest: String(p.dest || ''), paths: p.paths || [] }, 60000);
      return { ok: true, failed: res.failed || [] };
    }

    case 'pin-remove': {
      const pins = (settings.all.pins || []).filter((x) => x.id !== p.id);
      settings.set('pins', pins);
      return { ok: true };
    }

    case 'pin-add': {
      const pins = settings.all.pins || [];
      if (!pins.some((x) => x.id === p.id)) {
        pins.splice(Math.max(0, pins.length), 0, { id: p.id, name: p.name, exe: p.exe });
        settings.set('pins', pins);
      }
      return { ok: true };
    }

    case 'add-app':
      return pinAppFromPath(p);

    case 'recent-remove': {
      const exe = String(p.exe || '');
      const list = (settings.all.recentApps || []).filter((x) => x.exe !== exe);
      settings.set('recentApps', list);
      return { ok: true };
    }

    case 'pick-app': {
      const res = await dialog.showOpenDialog({
        title: '添加应用到 Dock',
        properties: ['openFile'],
        filters: [{ name: '应用', extensions: ['exe', 'lnk'] }],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, err: 'cancelled' };
      return handleInvoke('add-app', { path: res.filePaths[0] });
    }

    case 'pick-folder': {
      const res = await dialog.showOpenDialog({
        title: '添加文件夹到 Dock',
        properties: ['openDirectory'],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, err: 'cancelled' };
      return handleInvoke('add-folder', { path: res.filePaths[0] });
    }

    case 'add-folder': {
      const folderPath = String(p.path || '');
      if (!folderPath) return { ok: false, err: 'no-path' };
      const pins = settings.all.pins || [];
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
        settings.set('pins', pins);
      }
      return { ok: true, id: existing.id, name: existing.name, exe: existing.exe };
    }

    case 'list-dir':
      return await bridge.request('list-dir', { path: String(p.path || '') }, 15000);

    case 'set-stack-view': {
      // 文件夹 Stack 展示方式：grid / fan / list（mac 原版 Dock 的 Stacks 视图切换）
      const path = String(p.path || '');
      const view = ['grid', 'fan', 'list'].includes(p.view) ? p.view : 'grid';
      const pins = settings.all.pins || [];
      const pin = pins.find((x) => x.kind === 'folder' && x.exe === path);
      if (pin) { pin.stackView = view; settings.set('pins', pins); }
      return { ok: true };
    }

    case 'icon-data': {
      const res = await bridge.request('icon', { path: String(p.path || '') }, 20000);
      if (res && res.png) return { ok: true, url: 'data:image/png;base64,' + res.png };
      return { ok: false, err: 'no-icon' };
    }

    case 'open-path':
      {
        const target = String(p.path || '');
        await launchTarget(target, []);
      }
      return { ok: true };

    case 'reorder': {
      // p.ids: 完整的展示顺序（pinned 与临时运行的都以 id 标识）
      const pins = settings.all.pins || [];
      const byId = new Map(pins.map((x) => [x.id, x]));
      const out = [];
      for (const id of p.ids || []) {
        if (byId.has(id)) out.push(byId.get(id));
      }
      // 兜底：漏掉的 pin 追加末尾
      for (const x of pins) if (!out.includes(x)) out.push(x);
      settings.set('pins', out);
      return { ok: true };
    }

    case 'set-setting':
      return applySettingChange(p.key, p.value);

    case 'open-settings':
      openSettingsWindow();
      return { ok: true };

    case 'set-bar-rect':
      barRectDip = {
        x: Number(p.x) || 0, y: Number(p.y) || 0,
        w: Number(p.w) || 0, h: Number(p.h) || 0,
      };
      return { ok: true };

    case 'window-thumb':
      return await bridge.request('window-thumb', { h: p.h }, 8000);

    case 'launchpad-open':
      openLaunchpad();
      return { ok: true };

    case 'launchpad-close':
      closeLaunchpad();
      return { ok: true };

    case 'expose-open':
      openExpose(String(p.appName || '').slice(0, 80), p.appIcon || '', p.windows || []);
      return { ok: true };

    case 'expose-close':
      closeExpose();
      return { ok: true };

    case 'launchpad-launch': {
      await launchTarget(p.target, p.args || '');
      closeLaunchpad();
      return { ok: true };
    }

    case 'launchpad-data': {
      const apps = await getLaunchpadApps();
      fillLaunchpadIcons().catch(() => {});
      return { ok: true, apps };
    }

    default:
      return { ok: false, err: 'unknown-channel:' + channel };
  }
}

function sendEnv() {
  if (dockWin && !dockWin.isDestroyed()) {
    const m = dockMetrics();
    dockWin.webContents.send('env', {
      dockHidden: !onDesktopNow && dockHiddenByUs && !mouseAtBottom,
      fullscreenHide: fullscreenHide && !mouseAtBottom,
      coveredHide: coveredHideNow && !mouseAtBottom,
      pointerNearDock: pointerNearDock === null ? true : pointerNearDock,
      appActive: !onDesktopNow,
      position: m.pos,
      edgeInset: m.edgeInset,
    });
  }
}

function broadcastSettings() {
  if (dockWin && !dockWin.isDestroyed()) {
    dockWin.webContents.send('settings', {
      iconSize: settings.get('iconSize'),
      magnification: settings.get('magnification'),
      autohide: settings.get('autohide'),
      appearance: settings.get('appearance'),
      hideTaskbar: settings.get('hideTaskbar'),
      showTopbar: settings.get('showTopbar'),
      multidisplay: settings.get('multidisplay'),
      occludeAway: settings.get('occludeAway'),
      position: settings.get('position'),
      minimizeEffect: settings.get('minimizeEffect'),
      minimizeIntoIcon: !!settings.get('minimizeIntoIcon'),
    });
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings', {
      iconSize: settings.get('iconSize'),
      magnification: settings.get('magnification'),
      autohide: settings.get('autohide'),
      appearance: settings.get('appearance'),
      launchAtLogin: settings.get('launchAtLogin'),
      hideTaskbar: settings.get('hideTaskbar'),
      showTopbar: settings.get('showTopbar'),
      multidisplay: settings.get('multidisplay'),
      occludeAway: settings.get('occludeAway'),
      position: settings.get('position'),
      minimizeEffect: settings.get('minimizeEffect'),
      minimizeIntoIcon: !!settings.get('minimizeIntoIcon'),
    });
  }
}

// 全局热键（等价 macOS 的 ⌥⌘D 一类快捷操作）
function registerShortcuts() {
  const bind = (accel, fn) => {
    try { globalShortcut.register(accel, () => { try { fn(); } catch {} }); } catch {}
  };
  bind('CommandOrControl+Shift+D', () => {
    const v = !settings.get('autohide');
    settings.set('autohide', v);
    broadcastSettings();
  });
  bind('CommandOrControl+Shift+M', () => {
    const v = Number(settings.get('magnification')) > 1 ? 1 : 1.8;
    settings.set('magnification', v);
    applyBounds();
    broadcastSettings();
  });
  bind('CommandOrControl+Shift+P', () => {
    const order = ['bottom', 'left', 'right'];
    const cur = dockPosition();
    const nxt = order[(order.indexOf(cur) + 1) % order.length];
    settings.set('position', nxt);
    applyBounds();
    sendEnv();
    broadcastSettings();
  });
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 380, height: 520,
    resizable: false,
    minimizable: false, maximizable: false,
    title: 'Dock 设置',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------------------------------------------------------------- launchpad

function closeLaunchpad() {
  if (!launchpadWin || launchpadWin.isDestroyed()) { launchpadWin = null; return; }
  // 先给渲染层 ~170ms 播关闭淡出（launchpad.css 的 body.lp-closing）再销毁；
  // 渲染层 requestClose 延迟 invoke 到这里，__closing 幂等不重复计时
  if (launchpadWin.__closing) return;
  launchpadWin.__closing = true;
  setTimeout(() => {
    if (launchpadWin && !launchpadWin.isDestroyed()) launchpadWin.destroy();
    launchpadWin = null;
  }, 170);
}

function openLaunchpad() {
  if (launchpadWin && !launchpadWin.isDestroyed()) {
    if (launchpadWin.__closing) {
      // 上一次关闭动画还没播完就再次打开：直接废弃旧窗重开，避免 show 一个将死的窗
      launchpadWin.destroy();
      launchpadWin = null;
    } else {
      launchpadWin.show();
      launchpadWin.focus();
      return;
    }
  }
  const wa = currentDisplay().workArea;
  launchpadWin = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    frame: false, transparent: true, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  launchpadWin.setAlwaysOnTop(true, 'screen-saver');
  launchpadWin.__createdAt = Date.now();
  launchpadWin.loadFile(path.join(__dirname, 'renderer', 'launchpad.html'));
  launchpadWin.once('ready-to-show', () => {
    launchpadWin.show();
    launchpadWin.focus();
  });
  launchpadWin.on('closed', () => { launchpadWin = null; });
  launchpadWin.on('blur', () => {
    if (launchpadWin && Date.now() - (launchpadWin.__createdAt || 0) > 600) closeLaunchpad();
  });
}

async function getLaunchpadApps() {
  if (launchpadApps) return launchpadApps;
  try {
    const res = await bridge.request('list-start-menu', {}, 30000);
    const seen = new Set();
    launchpadApps = (res.apps || [])
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
        iconPath: normalizeIconSource(a.iconLocation, a.target),
        icon: null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } catch (e) {
    log('list-start-menu failed:', e.message);
    launchpadApps = [];
  }
  return launchpadApps;
}

// 图标懒加载：首开先出字母磁贴，解析完统一推一次（之后走磁盘缓存）
async function fillLaunchpadIcons() {
  if (!launchpadApps || !launchpadApps.length) return;
  try {
    await fetchIconsFor(launchpadApps);
    if (launchpadWin && !launchpadWin.isDestroyed()) {
      launchpadWin.webContents.send('launchpad-icons',
        launchpadApps.filter((a) => a.icon).map((a) => ({ id: a.id, icon: a.icon })));
    }
  } catch {}
}

// ---------------------------------------------------------------- top bar

function topbarMetrics() {
  const b = currentDisplay().bounds;
  return { x: b.x, y: b.y, width: b.width, height: 26 };
}

function closeTopbar() {
  if (topbarWin && !topbarWin.isDestroyed()) topbarWin.destroy();
  topbarWin = null;
}

function createTopbar() {
  if (!settings.get('showTopbar')) { closeTopbar(); return; }
  if (topbarWin && !topbarWin.isDestroyed()) {
    topbarWin.setBounds(topbarMetrics());
    return;
  }
  topbarWin = new BrowserWindow({
    ...topbarMetrics(),
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  topbarWin.setAlwaysOnTop(true, 'screen-saver');
  topbarWin.loadFile(path.join(__dirname, 'renderer', 'topbar.html'));
  topbarWin.once('ready-to-show', () => {
    topbarWin.showInactive();
    if (lastFgAppName !== null) topbarWin.webContents.send('topbar-app', lastFgAppName);
  });
  // 整条点击穿透：纯信息展示，绝不遮挡最大化窗口的标题栏交互
  topbarWin.setIgnoreMouseEvents(true, { forward: true });
}

// ---------------------------------------------------------------- exposé

let exposeWin = null;

function closeExpose() {
  if (exposeWin && !exposeWin.isDestroyed()) exposeWin.destroy();
  exposeWin = null;
}

// 轻量 Exposé：中键点击 Dock 运行中图标 → 该应用窗口缩略图网格。
// 用后即毁：关闭即 destroy，不驻留渲染进程（省 ~40MB）。
function openExpose(appName, appIcon, windows) {
  const list = (Array.isArray(windows) ? windows : [])
    .filter((w) => w && w.h)
    .slice(0, 24);
  if (!list.length) return;
  if (exposeWin && !exposeWin.isDestroyed()) closeExpose();
  const wa = currentDisplay().workArea;
  exposeWin = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    frame: false, transparent: true, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  exposeWin.setAlwaysOnTop(true, 'screen-saver');
  exposeWin.__createdAt = Date.now();
  exposeWin.loadFile(path.join(__dirname, 'renderer', 'expose.html'));
  exposeWin.once('ready-to-show', () => {
    exposeWin.showInactive();
    exposeWin.webContents.send('expose-data', { appName, appIcon, windows: list });
  });
  exposeWin.on('closed', () => { exposeWin = null; });
  exposeWin.on('blur', () => {
    if (exposeWin && Date.now() - (exposeWin.__createdAt || 0) > 600) closeExpose();
  });
}

// ---------------------------------------------------------------- genie

// genie 动画窗口用后闲置 30s 销毁：省一个常驻渲染进程（约 40MB），下次最小化时重建
let genieIdleTimer = null;

function scheduleGenieDestroy() {
  if (genieIdleTimer) clearTimeout(genieIdleTimer);
  genieIdleTimer = setTimeout(() => {
    genieIdleTimer = null;
    if (genieWin && !genieWin.isDestroyed()) genieWin.destroy();
    genieWin = null;
    genieReady = null;
  }, 30000);
}

function ensureGenieWindow() {
  if (genieIdleTimer) { clearTimeout(genieIdleTimer); genieIdleTimer = null; }
  if (genieWin && !genieWin.isDestroyed()) return genieWin;
  const b = currentDisplay().bounds;
  genieWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  genieWin.setAlwaysOnTop(true, 'screen-saver');
  genieWin.setIgnoreMouseEvents(true, { forward: false });
  genieWin.loadFile(path.join(__dirname, 'renderer', 'genie.html'));
  genieReady = new Promise((resolve) => {
    genieWin.webContents.once('did-finish-load', resolve);
  });
  genieWin.on('closed', () => { genieWin = null; genieReady = null; });
  return genieWin;
}

async function getIconTargetForWindow(h) {
  if (!dockWin || dockWin.isDestroyed()) return null;
  try {
    const target = await dockWin.webContents.executeJavaScript(
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
    const shot = await bridge.request('window-shot', { h }, 8000);
    if (!shot || !shot.png) return;
    const rect = await bridge.request('window-rect', { h: String(h) }, 3000);
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return;
    const target = await getIconTargetForWindow(h);
    if (!target) return;
    const win = ensureGenieWindow();
    const b = currentDisplay().bounds;
    if (genieReady) await genieReady;
    win.webContents.send('genie:animate', {
      img: 'data:image/png;base64,' + shot.png,
      sx: rect.x - b.x, sy: rect.y - b.y, sw: rect.w, sh: rect.h,
      tx: target.x - b.x, ty: target.y - b.y, tw: target.w, th: target.h,
      mode: settings.get('minimizeEffect') || 'genie',
    });
    win.showInactive();
    setTimeout(() => {
      if (genieWin && !genieWin.isDestroyed()) genieWin.hide();
      scheduleGenieDestroy();
    }, 700);
  } catch {}
}

// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dockWin) dockWin.webContents.send('poke');
  });

  app.whenReady().then(() => {
    fs.mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true });
    settings = new Settings();
    applyLoginItem(settings.get('launchAtLogin'));
    nativeTheme.themeSource = settings.get('appearance') === 'system' ? 'system' : settings.get('appearance');

    // 清扫父进程已死的孤儿桥接（强杀 Electron 后 stdin EOF 可能未唤醒 ReadLine）
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*mac-dock*bridge.ps1*' -and " +
      "-not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ], () => {});
    bridge = new NativeBridge(log);
    // 桥接（重）启成功后重放有状态副作用：工作区预留是桥接侧 Win32 调用，
    // 桥接崩溃重启后预留会丢失，这里重放保证状态一致。
    // 注意 constructor 会同步触发首次 onReady（此时本赋值尚未执行），
    // 所以启动路径需在赋值后显式补调一次。
    bridge.onReady = () => applyWorkarea();
    applyWorkarea();
    // 'icons-v2'：图标提取管线升级 256px（shell item factory）后换目录，
    // 让旧 32px 缓存全部失效重建（老缓存文件不区分提取尺寸，无法逐个判新旧）
    icons = new IconCache(path.join(app.getPath('userData'), 'icons-v2'));

    if (settings.get('hideTaskbar')) {
      bridge.request('taskbar-autohide', { on: true, backup: settings.get('taskbarSettingsBackup') || null }, 20000)
        .then((res) => { if (res && res.backup) settings.set('taskbarSettingsBackup', res.backup); })
        .catch((e) => log('taskbar-autohide apply failed', e.message));
    }

    createDock();
    createTopbar();
    registerIpc();
    registerShortcuts();

    // workArea 变化（任务栏显隐/分辨率/DPI）后 Dock 与顶栏需要重新贴边，
    // 工作区预留也要按新的 workArea 重算
    screen.on('display-metrics-changed', () => {
      applyBounds();
      createTopbar();
      applyWorkarea();
    });

    pollTimer = setInterval(pollOnce, 1400);
    occTimer = setInterval(checkOcclusion, 250);
    setTimeout(pollOnce, 350); // 尽快出第一帧状态
  });

  app.on('window-all-closed', () => {
    // Dock 是常驻的，只有显式退出才关
  });

  app.on('before-quit', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (occTimer) clearInterval(occTimer);
    if (genieIdleTimer) { clearTimeout(genieIdleTimer); genieIdleTimer = null; }
    for (const t of forceKillTimers) clearTimeout(t);
    forceKillTimers.clear();
    // 退出前恢复工作区：fire-and-forget，命令写入桥接 stdin 缓冲后 dispose 只关流不丢已写数据
    try { applyWorkarea('restore'); } catch {}
    try { globalShortcut.unregisterAll(); } catch {}
    try { if (bridge) bridge.dispose(); } catch {}
  });
}
