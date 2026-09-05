'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_OK = new Set([
  'ready', 'set-click-through', 'request-hide', 'request-show',
  'launch', 'open-with', 'focus-window', 'minimize-window', 'minimize-windows',
  'close-window', 'close-windows', 'kill-app', 'reveal', 'open-trash', 'empty-trash',
  'recycle-files', 'pin-remove', 'pin-add', 'add-app', 'pick-app', 'reorder', 'set-setting',
  'open-settings', 'recent-remove', 'pick-folder', 'add-folder', 'list-dir', 'icon-data', 'open-path',
  'move-files', 'modifier-action', 'focus-restore',
  'window-thumb', 'launchpad-open', 'launchpad-close', 'launchpad-data', 'launchpad-launch',
  'expose-open', 'expose-close',
  'set-bar-rect',
]);

contextBridge.exposeInMainWorld('dock', {
  invoke: (channel, payload) => {
    if (!INVOKE_OK.has(channel)) return Promise.resolve({ ok: false, err: 'bad-channel' });
    return ipcRenderer.invoke('dock:invoke', channel, payload);
  },
  getFilePath: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  getSnapshot: () => ipcRenderer.invoke('dock:get-state-sync'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onEnv: (cb) => ipcRenderer.on('env', (_e, s) => cb(s)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  onLaunchpadIcons: (cb) => ipcRenderer.on('launchpad-icons', (_e, s) => cb(s)),
  onExposeData: (cb) => ipcRenderer.on('expose-data', (_e, s) => cb(s)),
  onTopbarApp: (cb) => ipcRenderer.on('topbar-app', (_e, s) => cb(s)),
  onFocusDock: (cb) => ipcRenderer.on('focus-dock', () => cb()),
  onGenie: (cb) => ipcRenderer.on('genie:animate', (_e, d) => cb(d)),
});
