'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const BRIDGE = path.join(__dirname, '..', 'src', 'native', 'bridge.ps1');

function startBridge() {
  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) lines.push(line);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', () => {});
  return { proc, lines };
}

function send(s, id, cmd, args) {
  s.proc.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n');
}

function waitFor(s, id, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const idx = s.lines.findIndex((l) => {
        try { return JSON.parse(l).id === id; } catch { return false; }
      });
      if (idx >= 0) {
        clearInterval(timer);
        const [line] = s.lines.splice(idx, 1);
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout waiting for id ' + id));
      }
    }, 25);
  });
}

async function withBridge(fn) {
  const s = startBridge();
  try {
    return await fn(s);
  } finally {
    try { s.proc.kill(); } catch {}
  }
}

test('ping returns protocol version', async () => {
  await withBridge(async (s) => {
    send(s, '1', 'ping');
    const res = await waitFor(s, '1');
    assert.equal(res.ok, true);
    assert.equal(res.data.ver, 3);
  });
});

test('enum-windows returns a parseable array of windows', async () => {
  await withBridge(async (s) => {
    send(s, '2', 'enum-windows', { excludePid: process.pid });
    const res = await waitFor(s, '2');
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.data));
    for (const w of res.data) {
      assert.equal(typeof w.h, 'string');
      assert.equal(typeof w.t, 'string');
      assert.equal(typeof w.e, 'string');
      assert.equal(typeof w.m, 'boolean');
    }
  });
});

test('foreground returns a window handle', async () => {
  await withBridge(async (s) => {
    send(s, '3', 'foreground');
    const res = await waitFor(s, '3');
    assert.equal(res.ok, true);
    assert.equal(typeof res.data.h, 'string');
  });
});

test('icon extracts a PNG for notepad.exe', async () => {
  await withBridge(async (s) => {
    const exe = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'notepad.exe');
    send(s, '4', 'icon', { path: exe });
    const res = await waitFor(s, '4', 30000);
    if (res.ok === false) return; // 某些环境无图标时允许失败，但响应必须可解析
    assert.ok(Buffer.from(res.data.png, 'base64').length > 100);
  });
});

test('taskbar-state returns a parseable read-only snapshot', async () => {
  await withBridge(async (s) => {
    send(s, '5', 'taskbar-state');
    const res = await waitFor(s, '5');
    assert.equal(res.ok, true);
    assert.equal(typeof res.data.exists, 'boolean');
    assert.equal(typeof res.data.autohide, 'boolean');
  });
});

test('resolve-shortcut resolves a .lnk target', async () => {
  const lnk = path.join(os.tmpdir(), 'mac-dock-test-' + process.pid + '.lnk');
  try {
    await new Promise((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}'); $s.TargetPath='C:\\Windows\\System32\\notepad.exe'; $s.Save()`]);
      ps.on('exit', resolve);
    });
    await withBridge(async (s) => {
      send(s, '6', 'resolve-shortcut', { path: lnk });
      const res = await waitFor(s, '6');
      assert.equal(res.ok, true);
      assert.equal(res.data.target.toLowerCase(), 'c:\\windows\\system32\\notepad.exe');
      assert.equal(res.data.name, 'mac-dock-test-' + process.pid);
      assert.equal(typeof res.data.iconLocation, 'string');
      assert.equal(typeof res.data.arguments, 'string');
    });
  } finally {
    try { fs.rmSync(lnk, { force: true }); } catch {}
  }
});

test('open fails cleanly for a bogus target (no crash, parseable err)', async () => {
  await withBridge(async (s) => {
    send(s, '99', 'open', { target: 'Z:\\no-such\\definitely-missing.exe', args: ['x', 'y with space'] });
    const res = await waitFor(s, '99', 20000);
    assert.equal(res.ok, false);
    assert.equal(typeof res.err, 'string');
    assert.ok(res.err.length > 0);
  });
});

test('dock-occluded returns a boolean (never hides for an empty rect)', async () => {
  await withBridge(async (s) => {
    send(s, '7', 'dock-occluded', { hwnd: '0' });
    const res = await waitFor(s, '7');
    assert.equal(res.ok, true);
    assert.equal(typeof res.data.covered, 'boolean');
  });
});

test('dock-occluded returns cursor position and dock rect', async () => {
  await withBridge(async (s) => {
    send(s, '8', 'dock-occluded', { hwnd: '0' });
    const res = await waitFor(s, '8');
    assert.equal(res.ok, true);
    assert.equal(typeof res.data.cursor.x, 'number');
    assert.equal(typeof res.data.cursor.y, 'number');
    for (const k of ['l', 't', 'r', 'b']) {
      assert.equal(typeof res.data.dockRect[k], 'number');
    }
  });
});

test('window-thumb captures a PNG or fails cleanly', async () => {
  await withBridge(async (s) => {
    // 用桥接自身枚举找可见窗口来抓；前几个候选里任一抓出有效 PNG 即算通过
    //（单个候选可能是近空内容的 UWP 壳，PrintWindow 成功但图极小）
    send(s, '9', 'enum-windows', { excludePid: 0 });
    const enumRes = await waitFor(s, '9');
    const candidates = (enumRes.data || []).filter((w) => !w.m).slice(0, 3);
    if (!candidates.length) return; // 无可见窗口的环境下跳过
    for (const [i, target] of candidates.entries()) {
      send(s, '10', 'window-thumb', { h: target.h });
      const res = await waitFor(s, '10', 30000);
      if (res.ok === false) continue; // 受保护窗口允许干净失败
      assert.ok(res.data.w > 0 && res.data.h > 0);
      if (Buffer.from(res.data.png, 'base64').length > 500) return;
    }
  });
});

test('window-thumb fails cleanly for a bogus handle', async () => {
  await withBridge(async (s) => {
    send(s, '11', 'window-thumb', { h: '12345' });
    const res = await waitFor(s, '11', 15000);
    assert.equal(res.ok, false);
    assert.equal(typeof res.err, 'string');
  });
});

test('window-shot captures a larger PNG or fails cleanly', async () => {
  await withBridge(async (s) => {
    send(s, '11b', 'enum-windows', { excludePid: 0 });
    const enumRes = await waitFor(s, '11b');
    const candidates = (enumRes.data || []).filter((w) => !w.m).slice(0, 3);
    if (!candidates.length) return;
    for (const target of candidates) {
      send(s, '11c', 'window-shot', { h: target.h });
      const res = await waitFor(s, '11c', 30000);
      if (res.ok === false) continue;
      assert.ok(res.data.w > 0 && res.data.h > 0);
      if (Buffer.from(res.data.png, 'base64').length > 500) return;
    }
  });
});

test('list-start-menu returns parseable shortcut entries', async () => {
  await withBridge(async (s) => {
    send(s, '12', 'list-start-menu', {});
    const res = await waitFor(s, '12', 60000);
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.data.apps));
    assert.ok(res.data.apps.length > 3); // 正常系统至少有几个快捷方式
    for (const a of res.data.apps) {
      assert.equal(typeof a.name, 'string');
      assert.ok(a.name.length > 0);
      assert.equal(typeof a.target, 'string');
      assert.ok(a.target.length > 0);
      assert.equal(typeof a.args, 'string');
    }
  });
});

test('list-dir lists folder entries with icon paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-dock-dir-'));
  try {
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello');
    fs.mkdirSync(path.join(dir, 'sub'));
    await withBridge(async (s) => {
      send(s, '13', 'list-dir', { path: dir });
      const res = await waitFor(s, '13', 15000);
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data.entries));
      const names = res.data.entries.map((e) => e.name).sort();
      assert.ok(names.includes('hello.txt'));
      assert.ok(names.includes('sub'));
      for (const e of res.data.entries) {
        assert.equal(typeof e.name, 'string');
        assert.equal(typeof e.isFolder, 'boolean');
        assert.equal(typeof e.iconPath, 'string');
        assert.ok(e.iconPath.length > 0);
      }
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ---- P1-F6 / P1-F5 桥接字段扩展 ----

test('enum-windows entries carry the hung boolean', async () => {
  await withBridge(async (s) => {
    send(s, 'h1', 'enum-windows', { excludePid: process.pid });
    const res = await waitFor(s, 'h1');
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.data));
    if (res.data.length > 0) {
      // 至少宿主环境常有可见窗口；有窗口时字段必须存在且为布尔
      assert.equal(typeof res.data[0].hung, 'boolean', '每窗口应带 hung 布尔');
    }
  });
});

test('list-dir entries carry mtime/ctime unix milliseconds (P1-F5)', async () => {
  // 临时目录 + 一个文件，验证时间字段为合理整数毫秒
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-ls-'));
  try {
    fs.writeFileSync(path.join(tmp, 'probe.txt'), 'x');
    await withBridge(async (s) => {
      send(s, 'ld1', 'list-dir', { path: tmp });
      const res = await waitFor(s, 'ld1');
      assert.equal(res.ok, true);
      const ent = res.data.entries.find((e) => e.name === 'probe.txt');
      assert.ok(ent, '临时文件应被枚举');
      assert.equal(typeof ent.mtime, 'number');
      assert.equal(typeof ent.ctime, 'number');
      const now = Date.now();
      assert.ok(ent.mtime > now - 60_000 && ent.mtime <= now, 'mtime 应为刚写入时刻附近');
      assert.ok(ent.ctime > now - 60_000 && ent.ctime <= now, 'ctime 应为刚创建时刻附近');
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
