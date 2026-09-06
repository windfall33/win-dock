'use strict';
// 渲染层语法冒烟（P0-F1 回归网）：渲染层 ES module 不被任何 node:test 用例加载，
// 一处 const 重声明（a93ccfd 曾把这类错误提交进主干而测试全绿）就能让 Dock
// 渲染层整层起不来。这里把 renderer/*.js 按 ESM（.mjs 临时副本）、src 顶层与
// core/windows 按 CJS 全量 --check 一遍，语法失守时测试立刻红。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '..');

const listJs = (dir) => fs.readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(dir, f));

function firstLines(e) {
  return String(e.stderr || e.message).split('\n').map((s) => s.trim())
    .filter(Boolean).slice(0, 4).join(' | ');
}

async function checkAll(files, asModule) {
  const jobs = files.map(async (srcPath) => {
    let target = srcPath;
    let tmp = null;
    if (asModule) {
      // node --check 按扩展名定模块格式：renderer 是 ES module，借 .mjs 副本校验
      tmp = path.join(os.tmpdir(), 'wd-syntax-' + path.basename(srcPath) + '.mjs');
      fs.writeFileSync(tmp, fs.readFileSync(srcPath));
      target = tmp;
    }
    try {
      await run(process.execPath, ['--check', target]);
    } catch (e) {
      return path.relative(ROOT, srcPath) + ': ' + firstLines(e);
    } finally {
      if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
    }
    return null;
  });
  const failures = (await Promise.all(jobs)).filter(Boolean);
  assert.deepEqual(failures, []);
}

test('renderer ES modules parse cleanly (syntax smoke)', async () => {
  const files = listJs(path.join(ROOT, 'src', 'renderer'));
  assert.ok(files.length >= 10, 'renderer files found: ' + files.length);
  await checkAll(files, true);
});

// 链接期冒烟：--check 抓不到「导入的名字没被导出」这类绑定错误（a93ccfd 实际
// 上同时埋了 const 重声明与 applyEnv 缺 export 两个雷，前者语法层、后者只有
// 实例化模块图才爆）。用 vm.SourceTextModule.link 只建绑定、不执行代码。
test('renderer module graph links (import/export binding smoke)', async () => {
  const { SourceTextModule } = require('node:vm');
  if (typeof SourceTextModule !== 'function') return; // 未开 --experimental-vm-modules 时降级跳过
  const dir = path.join(ROOT, 'src', 'renderer');
  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file)) {
      cache.set(file, new SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file }));
    }
    return cache.get(file);
  };
  const entry = load(path.join(dir, 'dock.js'));
  await entry.link(async (spec, referencing) => {
    assert.ok(spec.endsWith('.js'), 'unexpected specifier: ' + spec);
    return load(path.resolve(path.dirname(referencing.identifier), spec));
  });
  assert.ok(cache.size >= 6, 'linked module count: ' + cache.size);
});

test('main-process CJS modules parse cleanly (syntax smoke)', async () => {
  const files = [
    ...listJs(path.join(ROOT, 'src')),
    ...listJs(path.join(ROOT, 'src', 'core')),
    ...listJs(path.join(ROOT, 'src', 'windows')),
  ];
  assert.ok(files.length >= 20, 'main-process files found: ' + files.length);
  await checkAll(files, false);
});
