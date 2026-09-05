'use strict';
// P3-F1a main.js 拆分：IPC 路由（dock:invoke 全部 case + set-setting 副作用编排）。
// 纯平移：函数体自 main.js 逐行迁移，共享状态经 ctx 读写。
const { ipcMain, nativeTheme, dialog } = require('electron');
const path = require('path');
const { createAppActions } = require('./ipc-app-actions.js');
const { createPinRoutes } = require('./ipc-pin-routes.js');
const { createPinApp } = require('./core/pin-app.js');

// set-setting 白名单：允许渲染层通过 IPC 写入的设置项
const SETTING_KEYS = ['iconSize', 'magnification', 'autohide', 'position', 'launchAtLogin', 'appearance', 'hideTaskbar', 'showTopbar', 'multidisplay', 'occludeAway', 'minimizeEffect', 'minimizeIntoIcon', 'workareaReserve'];

function createIpcRoutes(ctx) {
  const { log } = ctx;

  const appActions = createAppActions(ctx);
  const pinRoutes = createPinRoutes(ctx);

  // 设置项变更的副作用编排（原 handleInvoke 的 set-setting case 体，switch 里最重的两块之一）。
  // 顺序敏感：hideTaskbar 的桥接往返失败时直接返回，不落后面的 applyBounds/broadcast；
  // position 需要连续做 bounds/workarea/env 三件事。
  async function applySettingChange(k, v) {
    if (!SETTING_KEYS.includes(k)) return { ok: true };
    ctx.settings.set(k, v);
    if (k === 'launchAtLogin') {
      applyLoginItem(v);
    }
    if (k === 'appearance') {
      nativeTheme.themeSource = v === 'system' ? 'system' : v;
    }
    if (k === 'occludeAway') {
      ctx.coveredHideNow = false;
      ctx.sendEnv();
    }
    if (k === 'showTopbar') {
      if (v) ctx.createTopbar(); else ctx.closeTopbar();
    }
    if (k === 'multidisplay') {
      ctx.applyBounds();
      ctx.createTopbar();
    }
    if (k === 'hideTaskbar') {
      try {
        const backup = ctx.settings.get('taskbarSettingsBackup') || null;
        const res = await ctx.bridge.request('taskbar-autohide', { on: !!v, backup }, 20000);
        if (res && res.ok !== false) {
          if (!!v && res.backup) ctx.settings.set('taskbarSettingsBackup', res.backup);
          ctx.settings.set('hideTaskbar', !!v);
        } else {
          return { ok: false, err: (res && res.err) || 'taskbar-toggle-failed' };
        }
      } catch (e) {
        return { ok: false, err: e.message };
      }
    }
    if (k === 'iconSize' || k === 'magnification' || k === 'position') ctx.applyBounds();
    // Dock 位置切换后立即把新的 position + edgeInset 推给渲染层，否则要等下一个
    // 1.4s 状态推送才更新布局/条矩形，侧栏贴边与遮挡判定会短暂错位。
    if (k === 'position') ctx.sendEnv();
    if (k === 'workareaReserve' || k === 'iconSize' || k === 'position') ctx.applyWorkarea();
    ctx.broadcastSettings();
    return { ok: true };
  }

  async function handleInvoke(channel, p) {
    switch (channel) {

      case 'ready':
        ctx.applyBounds();
        ctx.setClickThrough(true);
        return { ok: true };

      case 'set-click-through':
        ctx.setClickThrough(!!p.on);
        ctx.mouseAtBottom = !p.on;
        ctx.sendEnv();
        return { ok: true };

      case 'request-hide':   // autohide：鼠标离开后滑出
        ctx.dockHiddenByUs = true;
        ctx.mouseAtBottom = false;
        ctx.sendEnv();
        return { ok: true };

      case 'request-show':   // 底边唤醒 / 显式请求
        ctx.dockHiddenByUs = false;
        ctx.mouseAtBottom = true;
        // 唤醒即指针在 Dock 区：乐观置位，避免 350ms 陈旧的 near=false
        // 立刻把刚唤回的 Dock 重新打回穿透
        ctx.pointerNearDock = true;
        ctx.sendEnv();
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
        await ctx.bridge.request('focus', { h: p.h }, 5000);
        return { ok: true };

      case 'minimize-window':
        await ctx.playGenie(p.h);
        await ctx.bridge.request('minimize', { h: p.h }, 5000);
        return { ok: true };

      case 'minimize-windows': {
        const hs = p.hs || [];
        if (hs.length) await ctx.playGenie(hs[0]);
        for (const h of p.hs || []) {
          try { await ctx.bridge.request('minimize', { h }, 3000); } catch {}
        }
        return { ok: true };
      }

      case 'close-windows': {
        for (const h of p.hs || []) {
          try { await ctx.bridge.request('close-window', { h }, 3000); } catch {}
        }
        return { ok: true };
      }

      case 'quit-app':
        return appActions.quitApp(p);


      case 'hide-others':
        return appActions.hideOthers(p);


      case 'modifier-action':
        return appActions.modifierAction(p);


      case 'show-all':
        return appActions.showAll();


      case 'focus-restore': {
        // P1-F2 键盘导航 Esc：焦点归还触发 Ctrl+Alt+D 前的前台窗口，Dock 恢复不抢焦点
        try {
          if (ctx.kbdReturnHwnd) await ctx.bridge.request('focus', { h: ctx.kbdReturnHwnd }, 3000);
        } catch {}
        try { if (ctx.dockWin && !ctx.dockWin.isDestroyed()) ctx.dockWin.setFocusable(false); } catch {}
        ctx.kbdReturnHwnd = '';
        return { ok: true };
      }

      case 'kill-app':
        return appActions.killApp(p);


      case 'reveal':
        await ctx.bridge.request('reveal', { path: p.path }, 8000);
        return { ok: true };

      case 'open-trash':
        await ctx.bridge.request('open', { target: 'shell:RecycleBinFolder' }, 8000);
        return { ok: true };

      case 'empty-trash':
        await ctx.bridge.request('empty-trash', {}, 20000);
        ctx.TrashLastCount = 0;
        return { ok: true };

      case 'recycle-files': {
        const res = await ctx.bridge.request('recycle', { paths: p.paths || [] }, 30000);
        return { ok: true, failed: res.failed || [] };
      }

      case 'move-files': {
        const res = await ctx.bridge.request('move-files', { dest: String(p.dest || ''), paths: p.paths || [] }, 60000);
        return { ok: true, failed: res.failed || [] };
      }

      case 'pin-remove':
        return pinRoutes.pinRemove(p);


      case 'pin-add':
        return pinRoutes.pinAdd(p);


      case 'add-app':
        return pinRoutes.pinAppFromPath(p);

      case 'recent-remove':
        return pinRoutes.recentRemove(p);


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

      case 'add-folder':
        return pinRoutes.addFolder(p);


      case 'list-dir':
        return await ctx.bridge.request('list-dir', { path: String(p.path || '') }, 15000);

      case 'set-stack-view':
        return pinRoutes.setStackView(p);


      case 'set-stack-sort':
        return pinRoutes.setStackSort(p);


      case 'icon-data': {
        const res = await ctx.bridge.request('icon', { path: String(p.path || '') }, 20000);
        if (res && res.png) return { ok: true, url: 'data:image/png;base64,' + res.png };
        return { ok: false, err: 'no-icon' };
      }

      case 'open-path':
        {
          const target = String(p.path || '');
          await launchTarget(target, []);
        }
        return { ok: true };

      case 'reorder':
        return pinRoutes.reorder(p);


      case 'set-setting':
        return applySettingChange(p.key, p.value);

      case 'open-settings':
        ctx.openSettingsWindow();
        return { ok: true };

      case 'set-bar-rect':
        ctx.barRectDip = {
          x: Number(p.x) || 0, y: Number(p.y) || 0,
          w: Number(p.w) || 0, h: Number(p.h) || 0,
        };
        return { ok: true };

      case 'window-thumb':
        return await ctx.bridge.request('window-thumb', { h: p.h }, 8000);

      case 'launchpad-open':
        ctx.openLaunchpad();
        return { ok: true };

      case 'launchpad-close':
        ctx.closeLaunchpad();
        return { ok: true };

      case 'expose-open':
        ctx.openExpose(String(p.appName || '').slice(0, 80), p.appIcon || '', p.windows || []);
        return { ok: true };

      case 'expose-close':
        ctx.closeExpose();
        return { ok: true };

      case 'launchpad-launch': {
        await launchTarget(p.target, p.args || '');
        ctx.closeLaunchpad();
        return { ok: true };
      }

      case 'launchpad-data': {
        const apps = await ctx.getLaunchpadApps();
        ctx.fillLaunchpadIcons().catch(() => {});
        return { ok: true, apps };
      }

      default:
        return { ok: false, err: 'unknown-channel:' + channel };
    }
  }

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
      const snap = ctx.snapshotBuilder.build([], false);
      if (snap.extras) snap.settings.launchAtLogin = !!ctx.settings.get('launchAtLogin');
      return snap;
    });
  }

  function broadcastSettings() {
    if (ctx.dockWin && !ctx.dockWin.isDestroyed()) {
      ctx.dockWin.webContents.send('settings', {
        iconSize: ctx.settings.get('iconSize'),
        magnification: ctx.settings.get('magnification'),
        autohide: ctx.settings.get('autohide'),
        appearance: ctx.settings.get('appearance'),
        hideTaskbar: ctx.settings.get('hideTaskbar'),
        showTopbar: ctx.settings.get('showTopbar'),
        multidisplay: ctx.settings.get('multidisplay'),
        occludeAway: ctx.settings.get('occludeAway'),
        position: ctx.settings.get('position'),
        minimizeEffect: ctx.settings.get('minimizeEffect'),
        minimizeIntoIcon: !!ctx.settings.get('minimizeIntoIcon'),
      });
    }
    if (ctx.settingsWin && !ctx.settingsWin.isDestroyed()) {
      ctx.settingsWin.webContents.send('settings', {
        iconSize: ctx.settings.get('iconSize'),
        magnification: ctx.settings.get('magnification'),
        autohide: ctx.settings.get('autohide'),
        appearance: ctx.settings.get('appearance'),
        launchAtLogin: ctx.settings.get('launchAtLogin'),
        hideTaskbar: ctx.settings.get('hideTaskbar'),
        showTopbar: ctx.settings.get('showTopbar'),
        multidisplay: ctx.settings.get('multidisplay'),
        occludeAway: ctx.settings.get('occludeAway'),
        position: ctx.settings.get('position'),
        minimizeEffect: ctx.settings.get('minimizeEffect'),
        minimizeIntoIcon: !!ctx.settings.get('minimizeIntoIcon'),
      });
    }
  }

  return { registerIpc, handleInvoke, applySettingChange, broadcastSettings, applyLoginItem: appActions.applyLoginItem };
}

module.exports = { createIpcRoutes };
