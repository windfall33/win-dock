'use strict';
// P3-F1a「纯平移」拆分回归网：launchTarget 曾在 ipc-routes.js 裸调用
// （ReferenceError，被 registerIpc 兜底吞成 ok:false），拆分后的所有打包版
// 全部启动路径静默失效，真机才暴露。这里用 mock electron + 假桥接直接驱动
// handleInvoke 的启动类通道 —— 任何未定义标识符或断链都会在这里红。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const electronPath = require.resolve('electron');
const shellCalls = [];
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: { handle() {} },
    nativeTheme: { shouldUseDarkColors: false },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async (p) => { shellCalls.push(p); return ''; } },
  },
};

const { createIpcRoutes } = require('../src/ipc-routes.js');

function makeCtx() {
  const requests = [];
  const ctx = {
    log: () => {},
    settings: { all: {}, get: () => undefined, set: () => {} },
    bridge: {
      request: async (cmd, args) => {
        requests.push({ cmd, args });
        return { ok: true, apps: [], entries: [], running: {} };
      },
    },
    dockWin: null, settingsWin: null,
    broadcastSettings: () => {},
    applyLoginItem: () => {},
    applyBounds: () => {},
    setClickThrough: () => {},
    sendEnv: () => {},
    applyWorkarea: () => {},
    openSettingsWindow: () => {},
    closeLaunchpad: () => {},
    openLaunchpad: () => {},
    getLaunchpadApps: async () => [],
    fillLaunchpadIcons: async () => {},
    playGenie: async () => {},
    dockMetrics: () => ({ pos: 'bottom', edgeInset: 0 }),
    snapshotBuilder: { build: () => ({}) },
    currentDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  };
  return { ctx, requests };
}

const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';

test('launch channel reaches the bridge via ShellExecute path', async () => {
  const { ctx, requests } = makeCtx();
  const ipc = createIpcRoutes(ctx);
  const res = await ipc.handleInvoke('launch', { exe: NOTEPAD, args: [] });
  assert.equal(res.ok, true);
  const open = requests.find((r) => r.cmd === 'open');
  assert.ok(open, 'bridge open request sent');
  assert.equal(open.args.target, NOTEPAD);
});

test('open-with forwards every dragged file as arguments', async () => {
  const { ctx, requests } = makeCtx();
  const ipc = createIpcRoutes(ctx);
  const res = await ipc.handleInvoke('open-with', {
    exe: NOTEPAD, filePaths: ['C:\\a.txt', 'C:\\b.txt'],
  });
  assert.equal(res.ok, true);
  const open = requests.find((r) => r.cmd === 'open');
  assert.deepEqual(open.args.args, ['C:\\a.txt', 'C:\\b.txt']);
});

test('open-path routes non-executable files to shell.openPath', async () => {
  const { ctx } = makeCtx();
  const ipc = createIpcRoutes(ctx);
  const res = await ipc.handleInvoke('open-path', { path: 'C:\\dir\\file.txt' });
  assert.equal(res.ok, true);
  assert.deepEqual(shellCalls, [path.join('C:\\dir', 'file.txt')]);
});

test('launchpad-launch reaches bridge and closes launchpad', async () => {
  const { ctx, requests } = makeCtx();
  let closed = false;
  ctx.closeLaunchpad = () => { closed = true; };
  const ipc = createIpcRoutes(ctx);
  const res = await ipc.handleInvoke('launchpad-launch', { target: NOTEPAD, args: '' });
  assert.equal(res.ok, true);
  assert.ok(requests.some((r) => r.cmd === 'open'), 'bridge open request sent');
  assert.equal(closed, true);
});

test('quit-app with no pids resolves without side effects', async () => {
  const { ctx, requests } = makeCtx();
  const ipc = createIpcRoutes(ctx);
  const res = await ipc.handleInvoke('quit-app', { hs: ['1'] });
  assert.equal(res.ok, true);
  assert.ok(requests.some((r) => r.cmd === 'window-pid'));
});
