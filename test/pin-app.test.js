'use strict';
// 「固定应用到 Dock」的单测（原 main.js 内联逻辑，下沉 core/pin-app.js 后可测）。
// 覆盖：.exe 直接固定 / .lnk 解析成功与失败回退 / UWP 空目标回退 /
//       图标源规范 / 按「目标+名字」去重。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPinApp, normalizeIconSource } = require('../src/core/pin-app.js');

function fakeSettings(pins = []) {
  const all = { pins };
  return {
    all,
    get: (k) => all[k],
    set: (k, v) => { all[k] = v; },
  };
}

// deps 组装：bridge 行为由测试注入，settings 为内存对象
function makeDeps({ resolve, settings, existsSync } = {}) {
  const s = settings || fakeSettings();
  return {
    deps: {
      getBridge: () => ({
        request: async (cmd, args) => {
          if (cmd !== 'resolve-shortcut') throw new Error('unexpected-cmd');
          if (resolve && resolve.fail) throw new Error(resolve.fail);
          return resolve ? resolve.result : {};
        },
      }),
      getSettingsAll: () => s.all,
      setSetting: (k, v) => { s.all[k] = v; },
      fsLike: { existsSync: existsSync || (() => false) },
    },
    settings: s,
  };
}

test('normalizeIconSource keeps explicit path+index, falls back on empty or index-only', () => {
  assert.equal(normalizeIconSource('C:\\i\\a.ico,0', 'FB'), 'C:\\i\\a.ico,0');
  assert.equal(normalizeIconSource('C:\\i\\a.ico', 'FB'), 'C:\\i\\a.ico');
  assert.equal(normalizeIconSource(',0', 'FB'), 'FB', '仅索引无路径应回退');
  assert.equal(normalizeIconSource('', 'FB'), 'FB');
  assert.equal(normalizeIconSource(null, 'FB'), 'FB');
});

test('rejects empty path cleanly', async () => {
  const { deps } = makeDeps();
  const res = await createPinApp(deps)({});
  assert.deepEqual(res, { ok: false, err: 'no-path' });
});

test('plain .exe pins directly without touching the bridge', async () => {
  const { deps, settings } = makeDeps();
  const res = await createPinApp(deps)({ path: 'D:\\Tools\\foo.exe' });
  assert.equal(res.ok, true);
  assert.equal(res.exe, 'D:\\Tools\\foo.exe');
  assert.equal(res.name, 'foo');
  assert.equal(settings.all.pins.length, 1);
  const pin = settings.all.pins[0];
  assert.equal(pin.launch, null, '.exe 不需要 launch 别名');
  assert.equal(pin.iconPath, null);
});

test('.lnk resolves target/name/args and keeps the shortcut as launch entry', async () => {
  const lnk = 'D:\\Links\\豆包浏览器.lnk';
  const { deps, settings } = makeDeps({
    resolve: {
      result: {
        target: 'D:\\Doubao\\Doubao.exe',
        name: '豆包浏览器',
        iconLocation: 'C:\\icons\\db.ico,1',
        arguments: '--saman-browser-entry',
      },
    },
    existsSync: () => true,
  });
  const res = await createPinApp(deps)({ path: lnk });
  const pin = settings.all.pins[0];
  assert.equal(res.ok, true);
  assert.equal(pin.exe, 'D:\\Doubao\\Doubao.exe');
  assert.equal(pin.name, '豆包浏览器');
  assert.equal(pin.launch, lnk, 'launch 保留快捷方式路径');
  assert.equal(pin.iconPath, 'C:\\icons\\db.ico,1', '自定义图标优先');
  assert.equal(pin.args, '--saman-browser-entry');
});

test('.lnk with index-only icon falls back to the real target for the icon', async () => {
  const { deps, settings } = makeDeps({
    resolve: { result: { target: 'D:\\Doubao\\Doubao.exe', name: 'x', iconLocation: ',0' } },
  });
  await createPinApp(deps)({ path: 'D:\\Links\\x.lnk' });
  assert.equal(settings.all.pins[0].iconPath, 'D:\\Doubao\\Doubao.exe',
    '仅索引的 IconLocation 应回退到目标程序（避免快捷方式箭头）');
});

test('.lnk resolve failure falls back to the shortcut itself', async () => {
  const lnk = 'D:\\Links\\broken.lnk';
  const { deps, settings } = makeDeps({ resolve: { fail: 'bad-lnk' } });
  const res = await createPinApp(deps)({ path: lnk });
  const pin = settings.all.pins[0];
  assert.equal(res.ok, true, '解析失败不阻断固定');
  assert.equal(pin.exe, lnk, 'target 回退到快捷方式本身');
  assert.equal(pin.launch, lnk);
  assert.equal(pin.iconPath, lnk, '图标也回退到快捷方式本身');
});

test('.lnk resolving to an empty target (UWP) falls back to the shortcut path', async () => {
  const { deps, settings } = makeDeps({
    resolve: { result: { target: '', name: '商店应用' } },
  });
  const res = await createPinApp(deps)({ path: 'D:\\Links\\store.lnk' });
  assert.equal(res.exe, 'D:\\Links\\store.lnk', '空 target 回退为稳定标识');
});

test('pinning the same target+name twice returns the same id without duplicating', async () => {
  const { deps, settings } = makeDeps();
  const pin = createPinApp(deps);
  const a = await pin({ path: 'D:\\Tools\\foo.exe' });
  const b = await pin({ path: 'D:\\Tools\\foo.exe' });
  assert.equal(a.id, b.id);
  assert.equal(settings.all.pins.length, 1, '不应重复写入 pins');
});
