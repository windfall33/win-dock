'use strict';
// P3-F3 特征测试：Settings 行为固定（拆分安全网）。
// Settings 依赖 electron 的 app.getPath —— 在 require 之前向 require.cache
// 注入 mock electron 模块，userData 指向临时目录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-settings-'));
const CONFIG = path.join(TMP, 'config.json');

// 注入 mock electron（必须在 require settings.js 之前）
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: (k) => (k === 'userData' ? TMP : TMP) } },
};

const { Settings } = require('../src/core/settings.js');

test('defaults are merged into an empty store', () => {
  const s = new Settings();
  assert.equal(s.get('iconSize'), 52);
  assert.equal(s.get('magnification'), 1.8);
  assert.equal(s.get('autohide'), false);
  assert.equal(s.get('position'), 'bottom');
  assert.equal(s.get('appearance'), 'system');
  assert.ok(Array.isArray(s.get('pins')) && s.get('pins').length > 0, '默认 pins 生成');
  // 文件已写出
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(disk.iconSize, 52);
});

test('set → get roundtrip persists to disk', () => {
  const s = new Settings();
  s.set('iconSize', 64);
  s.set('customKey', { a: 1 });
  assert.equal(s.get('iconSize'), 64);
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(disk.iconSize, 64);
  assert.deepEqual(disk.customKey, { a: 1 });
  // 新实例读回（读写往返）
  const s2 = new Settings();
  assert.equal(s2.get('iconSize'), 64);
  assert.deepEqual(s2.get('customKey'), { a: 1 });
});

test('corrupted JSON falls back to defaults without crashing', () => {
  fs.writeFileSync(CONFIG, '{ this is not json !!!', 'utf8');
  const s = new Settings();
  assert.equal(s.get('iconSize'), 52, '损坏后回退默认值');
  assert.ok(Array.isArray(s.get('pins')));
  // 回写后文件恢复为合法 JSON
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(disk.iconSize, 52);
});

test('v1 migration: occludeAway defaults true on legacy stores without settingsVersion', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ iconSize: 44, pins: [] }), 'utf8');
  const s = new Settings();
  assert.equal(s.get('occludeAway'), true, 'v1 迁移开启智能让位');
  assert.equal(s.get('settingsVersion'), 1);
  assert.equal(s.get('iconSize'), 44, '用户自定义值保留');
  // 已迁移的配置不再重复迁移（保留用户关闭的选择）
  s.set('occludeAway', false);
  const s2 = new Settings();
  assert.equal(s2.get('occludeAway'), false, 'settingsVersion 存在即不重跑迁移');
});

test('non-array pins are replaced by defaults (compat)', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ pins: 'bogus' }), 'utf8');
  const s = new Settings();
  assert.ok(Array.isArray(s.get('pins')) && s.get('pins').length > 0);
});

test('all getter returns the live store object', () => {
  const s = new Settings();
  assert.equal(s.all.iconSize, s.get('iconSize'));
});

// 清理：恢复 electron 真模块引用（本文件进程结束即销毁，无需恢复；仅删临时目录）
test('cleanup temp dir', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
