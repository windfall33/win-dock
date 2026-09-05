'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  iconSize: 52,          // 静止时图标大小 px（macOS 默认约 48-56）
  magnification: 1.8,    // 最大放大倍率
  autohide: false,       // 自动隐藏
  position: 'bottom',    // Dock 位置：bottom | left | right
  launchAtLogin: false,  // 开机自启
  appearance: 'system',  // light | dark | system
  hideTaskbar: false,    // 隐藏 Windows 任务栏
  showTopbar: true,      // 顶部菜单栏（关闭可省一个渲染进程约 50MB）
  multidisplay: false,   // 多显示器：跟随鼠标所在屏幕
  occludeAway: true,     // 被窗口覆盖时自动让位（智能隐藏：最大化/铺满也收起；桌面与底边悬停常驻显示）
  workareaReserve: false, // 工作区预留（SPI_SETWORKAREA 扣除 Dock 条，最大化窗口不压 Dock；仅主显示器）
  minimizeEffect: 'genie', // 最小化效果：genie | scale（macOS 两种效果）
  minimizeIntoIcon: false, // 最小化窗口收进对应应用图标（mac 的 Minimize window into app icon）
  recentApps: [],        // 最近打开应用 LRU
};

const APP_KEYS = {
  explorer: { name: '文件资源管理器', exe: 'C:\\Windows\\explorer.exe' },
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  ],
  firefox: [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  ],
  notepad: ['C:\\Windows\\System32\\notepad.exe', 'C:\\Windows\\notepad.exe'],
  terminal: [process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\wt.exe'],
  powershell: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  vsCode: [process.env.LOCALAPPDATA + '\\Programs\\Microsoft VS Code\\Code.exe',
           'C:\\Program Files\\Microsoft VS Code\\Code.exe'],
  weChat: ['C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
           'D:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe'],
  qq: ['C:\\Program Files\\Tencent\\QQNT\\QQ.exe'],
  neteaseMusic: [process.env.LOCALAPPDATA + '\\NetEase\\CloudMusic\\cloudmusic.exe',
                 'C:\\Program Files (x86)\\NetEase\\CloudMusic\\cloudmusic.exe'],
  steam: ['C:\\Program Files (x86)\\Steam\\steam.exe', 'D:\\Steam\\steam.exe'],
};

function firstExisting(candidates) {
  for (const c of candidates || []) {
    if (!c) continue;
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

function defaultPins() {
  const pins = [];
  const push = (id, name, exe) => { if (exe) pins.push({ id, name, exe }); };

  // 仿 macOS：Finder 在最左 —— 这里用「文件资源管理器」
  push('explorer', APP_KEYS.explorer.name, firstExisting([APP_KEYS.explorer.exe]));
  push('edge', 'Microsoft Edge', firstExisting(APP_KEYS.edge));
  if (!pins.some(p => p.id === 'edge')) push('chrome', 'Google Chrome', firstExisting(APP_KEYS.chrome));
  push('terminal', '终端', firstExisting(APP_KEYS.terminal));
  if (!pins.some(p => p.id === 'terminal')) push('powershell', 'PowerShell', firstExisting(APP_KEYS.powershell));
  push('vsCode', 'Visual Studio Code', firstExisting(APP_KEYS.vsCode));
  push('weChat', '微信', firstExisting(APP_KEYS.weChat));
  push('neteaseMusic', '网易云音乐', firstExisting(APP_KEYS.neteaseMusic));

  return pins;
}

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = null;
    this.load();
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    if (!Array.isArray(this.data.pins)) {
      this.data.pins = defaultPins();
    }
    // v1 迁移：occludeAway 从「默认关闭(始终浮顶)」改为「默认开启(覆盖即智能让位)」，
    // 让升级前的用户也直接享受智能隐藏；后续用户手动切换仍可覆盖。
    if (this.data.settingsVersion === undefined) {
      this.data.occludeAway = true;
      this.data.settingsVersion = 1;
    }
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (this.data[k] === undefined) this.data[k] = v;
    }
    this.save();
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('[settings] save failed:', e.message);
    }
  }

  get all() { return this.data; }
}

module.exports = { Settings };
