'use strict';
// P3-F3 特征测试：NativeBridge 行为固定（拆分安全网）。
// 用 fake child_process（EventEmitter 桩）替代真实 PowerShell —— 必须在
// require native.js **之前**替换 child_process 模块对象的 spawn 属性
// （native.js 在模块加载时解构 const { spawn } = require('child_process')）。
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const cp = require('node:child_process');

// ---- fake bridge 进程 ----

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr.setEncoding = () => {};
  proc.stdin = {
    writes: [],
    ended: false,
    killed: false,
    write(payload) { this.writes.push(payload); return true; },
    end() { this.ended = true; },
  };
  proc.pid = 4242;
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = function () { this.killed = true; };
  return proc;
}

let spawnQueue = [];   // 每次 spawn 依次弹出的 fake proc
const spawnCalls = [];
const fakeSpawn = function fakeSpawnImpl(cmd, args, opts) {
  spawnCalls.push({ cmd, args, opts });
  const p = spawnQueue.shift() || makeFakeProc();
  // 保存最近实例供测试驱动 stdout/exit
  fakeSpawn.last = p;
  return p;
};
cp.spawn = fakeSpawn;

// 替换之后才加载被测模块（解构发生在模块加载时）
const { NativeBridge, IconCache } = require('../src/core/native.js');

function newBridge(extraQueue = []) {
  spawnQueue = extraQueue;
  spawnCalls.length = 0;
  const logs = [];
  const b = new NativeBridge((...m) => logs.push(m.join(' ')));
  b.__logs = logs;
  return b;
}

// 发送响应到当前 fake 进程
function respond(proc, obj) {
  proc.stdout.emit('data', JSON.stringify(obj) + '\n');
}

test('request/response pairs by id and resolves payload', async () => {
  const b = newBridge();
  const p1 = b.request('ping', {});
  // seq 从 1 开始：检查 stdin 写出的 payload id 与 cmd
  const sent = JSON.parse(fakeSpawn.last.stdin.writes[0]);
  assert.equal(sent.id, '1');
  assert.equal(sent.cmd, 'ping');
  respond(fakeSpawn.last, { id: '1', ok: true, data: { ver: 3 } });
  assert.deepEqual(await p1, { ver: 3 });
  b.dispose();
});

test('timeout rejects with bridge-timeout:<cmd>', async () => {
  const b = newBridge();
  const p = b.request('slow-cmd', {}, 20);
  await assert.rejects(p, /bridge-timeout:slow-cmd/);
  b.dispose();
});

test('crash fails all pending requests with bridge-died', async () => {
  const b = newBridge();
  const p = b.request('ping', {});
  const p2 = b.request('trash-count', {});
  fakeSpawn.last.emit('exit', 1);
  await assert.rejects(p, /bridge-died/);
  await assert.rejects(p2, /bridge-died/);
  b.dispose();
});

test('restart backoff sequence: 1.5s → 3s → 6s → 12s → 24s → 48s (streak cap fixes 48s)', async () => {
  spawnCalls.length = 0;
  const logs = [];
  const b = new NativeBridge((...m) => logs.push(m.join(' ')));
  const t = mock.timers;
  t.enable({ apis: ['setTimeout'] });

  try {
    // 特征行为（原样固定，不修）：设计文档描述封顶 60s，但实现是 failStreak 先封顶 6，
    // delay = min(1500*2^(streak-1), 60000) → 实际序列停在 48s 并保持。
    // 第 7+ 次连续崩溃不再加长退避（48s 循环）——疑似与规格不符，记录在案（P3 不修）。
    for (let i = 1; i <= 7; i++) {
      fakeSpawn.last.emit('exit', 1);
      const expectMs = Math.min(1500 * Math.pow(2, i - 1), 48000);
      t.tick(expectMs - 1);
      const before = spawnCalls.length;
      t.tick(1);
      assert.equal(spawnCalls.length, before + 1,
        `第 ${i} 次崩溃应在 ${expectMs}ms 后重启`);
    }
    // 第 8 次仍是 48s（封顶保持）
    fakeSpawn.last.emit('exit', 1);
    t.tick(47999);
    const before = spawnCalls.length;
    t.tick(1);
    assert.equal(spawnCalls.length, before + 1, '封顶后保持 48s 重启间隔');
  } finally {
    t.reset();
    b.dispose();
  }
});

test('long stable uptime (>10s) resets the backoff streak', async () => {
  const b = newBridge();
  const t = mock.timers;
  t.enable({ apis: ['setTimeout', 'Date'] });

  try {
    // 第一次崩溃（启动即刻）→ 1.5s 重启
    fakeSpawn.last.emit('exit', 1);
    t.tick(1500);
    assert.equal(spawnCalls.length, 2);
    // 稳定运行 10s+ 后再崩 → 序列重置，仍是 1.5s
    t.tick(11000);   // 推进 Date.now（startedAt 判定）
    fakeSpawn.last.emit('exit', 1);
    t.tick(1500);
    assert.equal(spawnCalls.length, 3, '稳定 10s+ 后退避重置为 1.5s');
  } finally {
    t.reset();
    b.dispose();
  }
});

test('dispose: stdin.end() first, then kill after 300ms; pending rejected as disposed', async () => {
  const b = newBridge();
  const p = b.request('ping', {});
  const proc = fakeSpawn.last;
  const t = mock.timers;
  t.enable({ apis: ['setTimeout'] });
  try {
    b.dispose();
    assert.equal(proc.stdin.ended, true, 'dispose 应先 stdin.end');
    assert.equal(proc.killed, false, 'end 后未到延迟不立即 kill');
    await assert.rejects(p, /disposed/);
    t.tick(300);
    assert.equal(proc.killed, true, '300ms 后 kill');
  } finally {
    t.reset();
  }
});

test('malformed json line is skipped without breaking the stream', async () => {
  const b = newBridge();
  const p = b.request('ping', {});
  const proc = fakeSpawn.last;
  proc.stdout.emit('data', 'not-json\n');
  respond(proc, { id: '1', ok: true, data: { fine: 1 } });
  assert.deepEqual(await p, { fine: 1 });
  b.dispose();
});

test('error response (ok:false) rejects with bridge error message', async () => {
  const b = newBridge();
  const p = b.request('icon', { path: 'C:\\x.exe' });
  respond(fakeSpawn.last, { id: '1', ok: false, err: 'no-icon' });
  await assert.rejects(p, /no-icon/);
  b.dispose();
});

// ---- IconCache 特征 ----

test('IconCache LRU evicts beyond 160 entries', () => {
  const os = require('node:os');
  const dir = require('node:fs').mkdtempSync(require('node:path').join(os.tmpdir(), 'dock-ic-'));
  const c = new IconCache(dir);
  for (let i = 0; i < 160; i++) c.setMem('k' + i, 'url-' + i);
  assert.equal(c.mem.has('k0'), true);
  c.setMem('k160', 'url-160');
  assert.equal(c.mem.has('k0'), false, '第 161 条插入应逐出最旧的 k0');
  assert.equal(c.mem.has('k160'), true);
  // re-insert refreshes recency
  for (let i = 1; i <= 160; i++) c.setMem('k' + i, 'url-' + i);
  c.setMem('k1', 'url-1-new');
  assert.equal(c.mem.has('k1'), true);
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});

test('IconCache failed path marks and does not re-request', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-ic2-'));
  const c = new IconCache(dir);
  let calls = 0;
  const fakeBridge = {
    request: async () => { calls++; throw new Error('no-icon'); },
  };
  const r1 = await c.fetch(fakeBridge, 'C:\\does\\not\\exist.exe');
  assert.equal(r1, null);
  assert.equal(calls, 1);
  const r2 = await c.fetch(fakeBridge, 'C:\\does\\not\\exist.exe');
  assert.equal(r2, null);
  assert.equal(calls, 1, '失败标记后不应重复请求');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IconCache writes fetched PNG to disk and serves from cache', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-ic3-'));
  const c = new IconCache(dir);
  const pngB64 = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  let calls = 0;
  const fakeBridge = {
    request: async () => { calls++; return { png: pngB64 }; },
  };
  const url1 = await c.fetch(fakeBridge, 'C:\\app.exe');
  assert.match(url1, /^data:image\/png;base64,/);
  assert.equal(calls, 1);
  // 磁盘文件已写入
  const f = c.file('C:\\app.exe');
  assert.equal(fs.existsSync(f), true);
  assert.equal(fs.readFileSync(f).length, Buffer.from(pngB64, 'base64').length);
  // 新的 cache 实例（同目录）应从磁盘命中（无需再次请求）
  const c2 = new IconCache(dir);
  const url2 = await c2.fetch({ request: async () => { calls++; return {}; } }, 'C:\\app.exe');
  assert.equal(calls, 1, '磁盘命中不应再发请求');
  assert.equal(url2, url1);
  fs.rmSync(dir, { recursive: true, force: true });
});
