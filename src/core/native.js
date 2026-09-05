'use strict';
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

let BRIDGE = path.join(__dirname, '..', 'native', 'bridge.ps1');
// 打包后 asar 归档内的脚本 PowerShell 读不到，重定向到 asar.unpacked 实体文件
if (BRIDGE.includes('app.asar')) BRIDGE = BRIDGE.replace('app.asar', 'app.asar.unpacked');

class NativeBridge {
  constructor(log) {
    this.log = log || (() => {});
    this.proc = null;
    this.seq = 0;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.buffer = '';
    this.restartTimer = null;
    this.start();
  }

  start() {
    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, DOCK_PARENT_PID: String(process.pid) } }
      );
    } catch (e) {
      this.log('bridge spawn failed: ' + e.message);
      this.scheduleRestart();
      return;
    }
    this.startedAt = Date.now();
    // 桥接（重）启成功通知：主进程借此重放有状态副作用（如工作区预留）
    if (typeof this.onReady === 'function') {
      try { this.onReady(); } catch (e) { this.log('onReady failed: ' + e.message); }
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) this.log('[ps] ' + s.slice(0, 400));
    });
    this.proc.on('exit', (code) => {
      // 稳定运行超过 10s 才崩溃 → 说明是偶发故障，重置退避序列
      const uptime = Date.now() - (this.startedAt || 0);
      if (uptime > 10000) this.failStreak = 0;
      this.log(`bridge exited (${code}) after ${Math.round(uptime / 1000)}s`);
      this.failAll('bridge-died');
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.restartTimer || this.stopped) return;
    // 指数退避熔断：连续快速崩溃时 1.5s → 3s → 6s → 12s → 24s → 48s（上限 60s），
    // 避免 PowerShell 桥接陷入「崩溃-重启」死循环吃满 CPU；
    // 崩溃前稳定运行超 10s 则退避序列重置（见 exit 处理）。
    this.failStreak = Math.min((this.failStreak || 0) + 1, 6);
    const delay = Math.min(1500 * Math.pow(2, this.failStreak - 1), 60000);
    this.log(`bridge restart in ${Math.round(delay / 100) / 10}s (fail-streak ${this.failStreak})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(err));
    }
    this.pending.clear();
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        this.log('bad-json: ' + line.slice(0, 160));
        continue;
      }
      const entry = this.pending.get(String(msg.id));
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(String(msg.id));
      if (msg.ok === false) entry.reject(new Error(msg.err || msg.data && msg.data.err || 'bridge-error'));
      else entry.resolve(msg.data !== undefined && msg.data !== null ? msg.data : {});
    }
  }

  request(cmd, args, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) {
        reject(new Error('bridge-not-running'));
        return;
      }
      const id = String(++this.seq);
      const payload = JSON.stringify({ id, cmd, args: args || {} }) + '\n';
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('bridge-timeout:' + cmd));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  dispose() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.failAll('disposed');
    try { if (this.proc) this.proc.stdin.end(); } catch {}
    setTimeout(() => { try { if (this.proc) this.proc.kill(); } catch {} }, 300);
  }
}

// ---- icon cache on disk ----
class IconCache {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map();
    this.failed = new Set();
    require('fs').mkdirSync(dir, { recursive: true });
  }
  key(p) {
    return crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 16);
  }
  setMem(k, v) {
    // 插入序即 LRU 序；超上限淘汰最旧，防长期运行内存膨胀
    if (this.mem.has(k)) this.mem.delete(k);
    this.mem.set(k, v);
    while (this.mem.size > 160) {
      this.mem.delete(this.mem.keys().next().value);
    }
  }
  file(p) {
    return path.join(this.dir, this.key(p) + '.png');
  }
  hasFailed(p) {
    return this.failed.has(this.key(p));
  }
  getSync(p) {
    // returns dataURL or null; disk hit populates mem
    const k = this.key(p);
    if (this.mem.has(k)) return this.mem.get(k);
    if (this.failed.has(k)) return null;
    const f = this.file(p);
    try {
      const buf = require('fs').readFileSync(f);
      const url = 'data:image/png;base64,' + buf.toString('base64');
      this.setMem(k, url);
      return url;
    } catch { return null; }
  }
  async fetch(bridge, p) {
    const k = this.key(p);
    if (this.mem.has(k)) return this.mem.get(k);
    if (this.failed.has(k)) return null;
    const cachedDisk = this.getSync(p);
    if (cachedDisk) return cachedDisk;
    try {
      const res = await bridge.request('icon', { path: p }, 20000);
      const b64 = res.png;
      if (b64) {
        require('fs').writeFileSync(this.file(p), Buffer.from(b64, 'base64'));
        const url = 'data:image/png;base64,' + b64;
        this.setMem(k, url);
        return url;
      }
    } catch (e) {
      this.logSafe(e.message);
    }
    this.failed.add(k);
    return null;
  }
  logSafe(m) { /* noop */ }
}

module.exports = { NativeBridge, IconCache };
