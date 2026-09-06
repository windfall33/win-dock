'use strict';
// 一次性迁移：Mac Dock 1.0.0 → Win Dock 1.1.0（用户配置与固定项）
const fs = require('fs');
const path = require('path');
const p = (d) => path.join(process.env.APPDATA, d, 'config.json');
const old = JSON.parse(fs.readFileSync(p('Mac Dock'), 'utf8'));
const nw = JSON.parse(fs.readFileSync(p('Win Dock'), 'utf8'));
const USER_KEYS = ['pins', 'recentApps', 'iconSize', 'magnification', 'position', 'appearance',
  'autohide', 'occludeAway', 'minimizeEffect', 'minimizeIntoIcon', 'multidisplay', 'showTopbar',
  'hideTaskbar', 'taskbarSettingsBackup', 'settingsVersion'];
for (const k of USER_KEYS) if (old[k] !== undefined) nw[k] = old[k];
fs.writeFileSync(p('Win Dock'), JSON.stringify(nw, null, 2));
console.log('migrated:', USER_KEYS.filter((k) => old[k] !== undefined).join(', '));
console.log('pins:', (nw.pins || []).length, '| iconSize:', nw.iconSize, '| position:', nw.position,
  '| hideTaskbar:', nw.hideTaskbar, '| oldSettingsVersion:', old.settingsVersion);
