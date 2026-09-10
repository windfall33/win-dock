'use strict';
const { app, BrowserWindow, ipcMain, screen, nativeTheme, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { NativeBridge, IconCache } = require('./core/native.js');
const { Settings } = require('./core/settings.js');
// 状态快照合成已下沉到 core/snapshot.js（依赖注入、可单测）；
// extractMinimized / extractBadgeCount / visibleRecent 随之只在 core 内部使用。
const { createSnapshotBuilder, normalizeExe } = require('./core/snapshot.js');
const { normalizeIconSource } = require('./core/pin-app.js');
// P3-F1a 拆分：main.js 只保留生命周期与装配；dock 窗口 / 面板窗口 / 轮询 / IPC
// 路由平移到独立模块，共享状态经 ctx 上下文对象读写（与原全局变量一一对应）。
const { createDockWindow } = require('./windows/dock-window.js');
const { createPanelWindows } = require('./windows/panel-windows.js');
const { createPollLoop } = require('./poll-loop.js');
const { createIpcRoutes } = require('./ipc-routes.js');

// 调试/多实例支持：DOCK_USER_DATA 覆盖 userData 路径（独立的单实例锁与配置目录），
// 便于在常驻安装版 Dock 旁边并行启动开发版冒烟，互不抢占锁、互不污染配置
if (process.env.DOCK_USER_DATA) {
  app.setPath('userData', process.env.DOCK_USER_DATA);
}

app.commandLine.appendSwitch('disable-gpu-vsync');
// 常驻置顶透明窗口会被 Chromium 原生遮挡计算误判而节流，禁用之保动画丝滑
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 视觉回归调试：DOCK_DEBUG=1 启动时开放 CDP（9223），可用 cdp.js 抓渲染层原生截图
if (process.env.DOCK_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223');
}

// ---------------------------------------------------------------------------
// 共享上下文：原 main.js 的模块级全局变量全部集中到这里（字段一一对应）

const ctx = {
  app,
  settings: null,
  bridge: null,
  icons: null,
  snapshotBuilder: null,
  normalizeExe,
  normalizeIconSource,

  // 窗口引用
  dockWin: null,
  dockHwnd: null,
  dockBoundsDip: null,
  settingsWin: null,
  launchpadWin: null,
  topbarWin: null,
  genieWin: null,
  genieReady: null,
  exposeWin: null,
  launchpadApps: null,   // Launchpad 缓存：{ id, name, target, args, iconPath, icon }

  // 运行状态
  lastFgAppName: null,
  barRectDip: null,        // 渲染层上报的可见条矩形（DIP），遮挡判定用
  dockHiddenByUs: false,   // autohide 状态
  fullscreenHide: false,   // 前台是真全屏应用（macOS 让位行为）
  coveredHideNow: false,   // 被普通窗口覆盖让位（仅 occludeAway 开启时）
  onDesktopNow: false,     // 前台是桌面：Dock 永远显示
  mouseAtBottom: false,    // 鼠标贴底边/悬停 Dock 时临时显示
  pointerNearDock: null,   // 全局光标是否在 Dock 区（null=未知）；渲染层放大态的兜底判据
  runningProc: new Set(),  // 有进程在跑的固定应用 exe（含无窗口的托盘应用）
  curDisplayId: null,      // 当前 Dock 所在显示器 id（多显示器跟随用）
  TrashLastCount: 0,
  forceKillTimers: new Set(), // quit-app 优雅退出的强杀兜底定时器（退出时清理）
  kbdReturnHwnd: '',       // P1-F2 键盘导航：触发 Ctrl+Alt+D 时的前台窗口（Esc 归还焦点用）
  genieIdleTimer: null,
};

const log = (...a) => {
  try {
    const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'logs', 'main.log'), line);
  } catch {}
  console.log(...a);
};
ctx.log = log;

// ---------------------------------------------------------------------------
// 模块装配（跨模块函数统一挂到 ctx 上，运行时解析，规避装配顺序的循环依赖）

const dockWindow = createDockWindow(ctx);
const panels = createPanelWindows(ctx);
const pollLoop = createPollLoop(ctx);
const ipc = createIpcRoutes(ctx);

ctx.currentDisplay = dockWindow.currentDisplay;
ctx.dockPosition = dockWindow.dockPosition;
ctx.dockMetrics = dockWindow.dockMetrics;
ctx.applyWorkarea = dockWindow.applyWorkarea;
ctx.applyBounds = dockWindow.applyBounds;
ctx.createDock = dockWindow.createDock;
ctx.setClickThrough = dockWindow.setClickThrough;
ctx.assertWindowLevels = dockWindow.assertWindowLevels;
ctx.maybeFollowCursorDisplay = dockWindow.maybeFollowCursorDisplay;

ctx.openSettingsWindow = panels.openSettingsWindow;
ctx.closeLaunchpad = panels.closeLaunchpad;
ctx.openLaunchpad = panels.openLaunchpad;
ctx.getLaunchpadApps = panels.getLaunchpadApps;
ctx.fillLaunchpadIcons = panels.fillLaunchpadIcons;
ctx.topbarMetrics = panels.topbarMetrics;
ctx.closeTopbar = panels.closeTopbar;
ctx.createTopbar = panels.createTopbar;
ctx.closeExpose = panels.closeExpose;
ctx.openExpose = panels.openExpose;
ctx.playGenie = panels.playGenie;

ctx.pollOnce = pollLoop.pollOnce;
ctx.checkOcclusion = pollLoop.checkOcclusion;
ctx.pushState = pollLoop.pushState;
ctx.sendEnv = pollLoop.sendEnv;
ctx.fetchIconsFor = pollLoop.fetchIconsFor;

ctx.registerIpc = ipc.registerIpc;
ctx.broadcastSettings = ipc.broadcastSettings;
ctx.applyLoginItem = ipc.applyLoginItem;

// 全局热键（等价 macOS 的 ⌥⌘D 一类快捷操作）
function registerShortcuts() {
  const bind = (accel, fn) => {
    try { globalShortcut.register(accel, () => { try { fn(); } catch {} }); } catch {}
  };
  bind('CommandOrControl+Shift+D', () => {
    const v = !ctx.settings.get('autohide');
    ctx.settings.set('autohide', v);
    ctx.broadcastSettings();
  });
  bind('CommandOrControl+Shift+M', () => {
    const v = Number(ctx.settings.get('magnification')) > 1 ? 1 : 1.8;
    ctx.settings.set('magnification', v);
    ctx.applyBounds();
    ctx.broadcastSettings();
  });
  bind('CommandOrControl+Shift+P', () => {
    const order = ['bottom', 'left', 'right'];
    const cur = ctx.dockPosition();
    const nxt = order[(order.indexOf(cur) + 1) % order.length];
    ctx.settings.set('position', nxt);
    ctx.applyBounds();
    ctx.sendEnv();
    ctx.broadcastSettings();
  });
  // P1-F2 键盘导航：聚焦 Dock（对齐 macOS ⌥⌘D 一类直达快捷键）。
  // 注册失败仅日志降级，不阻塞其他热键。
  bind('CommandOrControl+Alt+D', async () => {
    if (!ctx.dockWin || ctx.dockWin.isDestroyed()) return;
    try {
      const fg = await ctx.bridge.request('foreground', {}, 3000);
      ctx.kbdReturnHwnd = fg && fg.h ? String(fg.h) : '';
    } catch { ctx.kbdReturnHwnd = ''; }
    try {
      // dock 窗口 focusable:false（不抢焦点），键盘导航期间临时可聚焦
      ctx.dockWin.setFocusable(true);
      ctx.dockWin.focus();
    } catch (e) { log('dock focus failed', e.message); }
    ctx.dockWin.webContents.send('focus-dock');
  });
}

// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 主进程崩溃自拉起：未捕获异常 / 未处理拒绝 记日志后 relaunch。
  // 不能只 console —— Dock 是常驻组件，主进程挂了桌面入口就没了。
  let fatal = false;
  function crashRecover(kind, err) {
    if (fatal) return;
    fatal = true;
    try { log(kind, (err && (err.stack || err.message)) || String(err)); } catch {}
    try { if (ctx.bridge) ctx.bridge.dispose(); } catch {}
    try { app.relaunch(); } catch {}
    try { app.exit(1); } catch {}
  }
  process.on('uncaughtException', (e) => crashRecover('uncaughtException', e));
  process.on('unhandledRejection', (e) => crashRecover('unhandledRejection', e));

  app.on('second-instance', () => {
    if (ctx.dockWin) ctx.dockWin.webContents.send('poke');
  });

  app.whenReady().then(() => {
    fs.mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true });
    ctx.settings = new Settings();
    ctx.applyLoginItem(ctx.settings.get('launchAtLogin'));
    nativeTheme.themeSource = ctx.settings.get('appearance') === 'system' ? 'system' : ctx.settings.get('appearance');

    // 清扫父进程已死的孤儿桥接（强杀 Electron 后 stdin EOF 可能未唤醒 ReadLine）
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'mac-dock|win-dock' -and $_.CommandLine -like '*bridge.ps1*' -and " +
      "-not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ], () => {});
    ctx.bridge = new NativeBridge(log);
    // 桥接（重）启成功后重放有状态副作用：工作区预留是桥接侧 Win32 调用，
    // 桥接崩溃重启后预留会丢失，这里重放保证状态一致。
    // 注意 constructor 会同步触发首次 onReady（此时本赋值尚未执行），
    // 所以启动路径需在赋值后显式补调一次。
    ctx.bridge.onReady = () => ctx.applyWorkarea();
    // WinEvent（窗口创建/销毁/前台）→ 立即 poll，把应用启停延迟从 ~1.4s 压到 ~50ms
    let winEventCoolUntil = 0;
    ctx.bridge.onWinEvent = (ev) => {
      const now = Date.now();
      if (now < winEventCoolUntil) return;
      winEventCoolUntil = now + 200; // 合并短时间风暴
      try { ctx.pollOnce(); } catch {}
    };
    ctx.applyWorkarea();
    // 'icons-v2'：图标提取管线升级 256px（shell item factory）后换目录，
    // 让旧 32px 缓存全部失效重建（老缓存文件不区分提取尺寸，无法逐个判新旧）
    ctx.icons = new IconCache(path.join(app.getPath('userData'), 'icons-v2'));

    // 状态快照合成器：依赖注入（icons/bridge 就绪后创建，getEnv 引用 dockMetrics 等 ctx 函数）
    ctx.snapshotBuilder = createSnapshotBuilder({
      getSettingsAll: () => ctx.settings.all,
      getSetting: (k) => ctx.settings.get(k),
      iconsGetSync: (p) => ctx.icons.getSync(p),
      runningProc: ctx.runningProc,
      getEnv: () => {
        const m = ctx.dockMetrics();
        return {
          dockHidden: !ctx.onDesktopNow && ctx.dockHiddenByUs && !ctx.mouseAtBottom,
          fullscreenHide: ctx.fullscreenHide && !ctx.mouseAtBottom,
          coveredHide: ctx.coveredHideNow && !ctx.mouseAtBottom,
          pointerNearDock: ctx.pointerNearDock === null ? true : ctx.pointerNearDock,
          appActive: !ctx.onDesktopNow,
          position: m.pos,
          edgeInset: m.edgeInset,
        };
      },
      getTrashCount: () => ctx.TrashLastCount,
    });

    if (ctx.settings.get('hideTaskbar')) {
      ctx.bridge.request('taskbar-autohide', { on: true, backup: ctx.settings.get('taskbarSettingsBackup') || null }, 20000)
        .then((res) => { if (res && res.backup) ctx.settings.set('taskbarSettingsBackup', res.backup); })
        .catch((e) => log('taskbar-autohide apply failed', e.message));
    }

    ctx.createDock();
    ctx.createTopbar();
    ctx.registerIpc();
    registerShortcuts();

    // workArea 变化（任务栏显隐/分辨率/DPI）后 Dock 与顶栏需要重新贴边，
    // 工作区预留也要按新的 workArea 重算
    screen.on('display-metrics-changed', () => {
      ctx.applyBounds();
      ctx.createTopbar();
      ctx.applyWorkarea();
    });

    let pollTimer = null;
    let occTimer = null;
    // 自适应轮询：近 2.5s 内有状态变化 → 快档（应用启动/关闭尽快可见）；
    // 稳定空闲 → 慢档（省桥接往返与 CPU）。焦点切换仍走 checkOcclusion 即时触发。
    const pollFast = () => Number(ctx.settings.get('pollFastMs')) || 450;
    const pollIdle = () => Number(ctx.settings.get('pollIdleMs')) || 1600;
    function schedulePoll(delay) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => {
        try { await ctx.pollOnce(); } catch {}
        const recent = ctx.lastStateChangeTs && (Date.now() - ctx.lastStateChangeTs) < 2500;
        schedulePoll(recent ? pollFast() : pollIdle());
      }, delay);
    }
    schedulePoll(pollIdle());
    occTimer = setInterval(ctx.checkOcclusion, 250);
    setTimeout(() => { try { ctx.pollOnce(); } catch {} }, 350); // 尽快出第一帧状态

    app.on('before-quit', () => {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (occTimer) clearInterval(occTimer);
      if (ctx.genieIdleTimer) { clearTimeout(ctx.genieIdleTimer); ctx.genieIdleTimer = null; }
      for (const t of ctx.forceKillTimers) clearTimeout(t);
      ctx.forceKillTimers.clear();
      // 退出前恢复工作区：fire-and-forget，命令写入桥接 stdin 缓冲后 dispose 只关流不丢已写数据
      try { ctx.applyWorkarea('restore'); } catch {}
      try { globalShortcut.unregisterAll(); } catch {}
      try { if (ctx.bridge) ctx.bridge.dispose(); } catch {}
    });
  });

  app.on('window-all-closed', () => {
    // Dock 是常驻的，只有显式退出才关
  });
}
