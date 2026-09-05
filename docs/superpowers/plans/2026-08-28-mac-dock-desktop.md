# Mac Dock 桌面化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复桥接 JSON bug、补上 macOS 原版「最小化窗口」右侧分区、提供一键隐藏 Windows 任务栏开关，让现有 Electron Mac Dock 成为日常桌面主界面。

**Architecture:** 保留现有 Electron + PowerShell 桥接分层。桥接负责窗口枚举/系统操作（NDJSON over stdio），主进程轮询合成状态快照，渲染层做布局与交互。本轮在快照中新增 `minimized` 投影（纯函数、可单测），桥接新增 `taskbar-state`/`taskbar-autohide` 命令，设置新增 `hideTaskbar` 键。

**Tech Stack:** Electron 33（已装）、Windows PowerShell 5.1（`powershell.exe`，桥接解释器）、Node `node:test`（系统 Node ≥ 18，仅测试用）。

**Spec:** `docs/superpowers/specs/2026-08-28-mac-dock-desktop-design.md`（本计划逐条对应规格；执行者必须同时读规格与计划）

## Global Constraints

- 桥接脚本 `src/native/bridge.ps1` 必须保持 UTF-8 带 BOM，避免 Windows PowerShell 5.1 按 ANSI 误读中文注释。
- 任务栏修改（注册表/explorer）不做自动化测试，只做只读 `taskbar-state` 测试 + 人工验证。
- 测试运行器：`node --test test/`，系统 Node ≥ 18。
- 中文 UI 文案；代码、命令、变量名用英文。
- 每次提交前跑 `npm test`；涉及任务栏/渲染的任务额外走人工验证清单。
- 提交信息用 Conventional Commits：`fix:` / `feat:` / `test:` / `chore:`。
- 本轮不实现：最近应用列表、通知角标、位置切换、多显示器、窗口缩略图、Launchpad。

---

### Task 0: 初始化 git 仓库并提交规格

**Files:**

- Create: `.git`（git init）
- Existing: `.gitignore`（确认含 `node_modules`）、`docs/superpowers/specs/2026-08-28-mac-dock-desktop-design.md`

**Interfaces:** 无（为后续每个任务的 commit 步骤提供仓库）。

- [ ] **Step 1: 初始化仓库**

在 `D:\AI-Workspace\mac-dock` 执行：

```powershell
git init
```

- [ ] **Step 2: 确认 .gitignore**

`Get-Content .gitignore`，应包含 `node_modules`。若无则创建内容为一行 `node_modules`。

- [ ] **Step 3: 首次提交规格**

```powershell
git add .gitignore docs/superpowers/specs/2026-08-28-mac-dock-desktop-design.md
git commit -m "docs: mac dock desktop design spec"
```

- [ ] **Step 4: 验证**

```powershell
git log --oneline
```

Expected: 恰好一条提交 `docs: mac dock desktop design spec`。

---

### Task 1: 桥接 enum-windows JSON 修复 + 回归测试 + 坏 JSON 日志

**Files:**

- Create: `test/bridge.test.js`
- Modify: `src/native/bridge.ps1:194`
- Modify: `src/core/native.js`（`onData`）
- Modify: `package.json`（`scripts.test`）

**Interfaces:**

- Consumes: `src/native/bridge.ps1` 现有 NDJSON 协议（请求 `{"id","cmd","args"}`，响应 `{"id","ok","data"}`，行尾 `\n`）。
- Produces: `npm test` 可用；`NativeBridge.onData` 对坏 JSON 记日志；后续任务以此为基线。

- [ ] **Step 1: 写失败测试**

创建 `test/bridge.test.js`（完整内容）：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

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
```

- [ ] **Step 2: 加 test script 并确认测试红**

`package.json` 的 `scripts` 改为：

```json
"scripts": {
  "start": "electron .",
  "test": "node --test test/"
}
```

运行：

```powershell
npm test
```

Expected: `enum-windows returns a parseable array of windows` 失败（`JSON.parse` 抛错，响应含多余 `}`）。其余测试可能通过。

- [ ] **Step 3: 修复桥接 JSON**

`src/native/bridge.ps1` 第 194 行：

```diff
-                list.Append("}}");
+                list.Append("}");
```

（窗口对象 `{...}` 的收尾：`rect` 已在前面用 `list.Append("}")` 闭合，此处只需闭合窗口对象本身。）

- [ ] **Step 4: 加固坏 JSON 日志**

`src/core/native.js` 的 `onData` 中，把 `try { msg = JSON.parse(line); } catch { continue; }` 改为：

```js
let msg;
try { msg = JSON.parse(line); } catch (e) {
  this.log('bad-json: ' + line.slice(0, 160));
  continue;
}
```

- [ ] **Step 5: 确认测试绿**

```powershell
npm test
```

Expected: 全部测试通过。

- [ ] **Step 6: 提交**

```powershell
git add test/bridge.test.js src/native/bridge.ps1 src/core/native.js package.json package-lock.json
git commit -m "fix: repair enum-windows JSON and add bridge regression tests"
```

---

### Task 2: 最小化窗口投影（纯函数模块）+ 主进程快照集成

**Files:**

- Create: `src/core/minimized.js`
- Create: `test/minimized.test.js`
- Modify: `src/main.js`（`require`、`buildStateSnapshot`、`pollInner` 的 `fetchIconsFor`、`pushState` hash）

**Interfaces:**

- Consumes: `winList` 元素形状（来自桥接）：`{ h, t, c, p, e, m, f, fs, rect }`；`appEntries` 元素形状：`{ id, name, exe, windows: [{ h, t, m, f }] }`。
- Produces: `extractMinimized(winList, appEntries) → Array<{ kind:'min', id, h, title, exe, appName, icon }>`；快照新增 `minimized` 字段。

- [ ] **Step 1: 写失败测试**

创建 `test/minimized.test.js`（完整内容）：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractMinimized } = require('../src/core/minimized.js');

const win = (h, opts = {}) => ({
  h, t: opts.t || 'Window ' + h, c: 'Class', p: '1',
  e: opts.e || 'C:\\Apps\\demo.exe', m: !!opts.m, f: false,
});

test('projects only minimized windows', () => {
  const wins = [win('1', { m: true }), win('2'), win('3', { m: true })];
  const out = extractMinimized(wins, []);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'min:1');
  assert.equal(out[1].id, 'min:3');
});

test('carries title, exe and appName from app entries', () => {
  const wins = [win('1', { m: true, t: 'Untitled - Notepad', e: 'C:\\Windows\\System32\\notepad.exe' })];
  const apps = [{ id: 'notepad', name: '记事本', windows: [{ h: '1' }] }];
  const out = extractMinimized(wins, apps);
  assert.equal(out[0].title, 'Untitled - Notepad');
  assert.equal(out[0].appName, '记事本');
  assert.equal(out[0].exe, 'C:\\Windows\\System32\\notepad.exe');
});

test('falls back to empty appName when window has no app entry', () => {
  const out = extractMinimized([win('1', { m: true })], []);
  assert.equal(out[0].appName, '');
});
```

- [ ] **Step 2: 运行确认红**

```powershell
node --test test/minimized.test.js
```

Expected: FAIL，`Cannot find module '../src/core/minimized.js'`。

- [ ] **Step 3: 实现模块**

创建 `src/core/minimized.js`（完整内容）：

```js
'use strict';
// 从窗口列表投影出「最小化窗口」分区（仿 macOS Dock 右侧），纯函数便于单测。
function extractMinimized(winList, appEntries) {
  const nameByH = new Map();
  for (const app of appEntries || []) {
    for (const w of app.windows || []) nameByH.set(w.h, app.name);
  }
  const out = [];
  for (const w of winList || []) {
    if (!w.m) continue;
    out.push({
      kind: 'min',
      id: 'min:' + w.h,
      h: w.h,
      title: w.t,
      exe: w.e || '',
      appName: nameByH.get(w.h) || '',
      icon: null,
    });
  }
  return out;
}

module.exports = { extractMinimized };
```

- [ ] **Step 4: 运行确认绿**

```powershell
node --test test/minimized.test.js
```

Expected: 3 个测试全部通过。

- [ ] **Step 5: 主进程集成**

`src/main.js`：

1. 顶部 require 追加：

```js
const { extractMinimized } = require('./core/minimized.js');
```

2. `buildStateSnapshot` 返回值中，`entries` 计算之后、`return` 之前追加：

```js
const minimized = extractMinimized(winList, [...statePins, ...shownExtras]);
```

并在返回对象中加 `minimized,`（放在 `entries,` 之后）。

3. `settings` 对象（快照内）追加：

```js
hideTaskbar: !!s.hideTaskbar,
```

4. `pollInner` 中 `await fetchIconsFor(snap.entries);` 改为：

```js
await fetchIconsFor([...snap.entries, ...(snap.minimized || [])]);
```

5. `pushState` 的 hash 数组追加最小化投影签名：

```js
const hash = JSON.stringify([snap.entries.map((e) => [e.id, e.running, e.icon ? 1 : 0, e.windows.length]),
                             (snap.minimized || []).map((m) => [m.id, m.icon ? 1 : 0, m.title]),
                             snap.trash.count, snap.settings, snap.env]);
```

- [ ] **Step 6: 验证**

```powershell
npm test
```

Expected: 全部通过（桥接 + minimized）。主进程行为由 Task 5 端到端验证。

- [ ] **Step 7: 提交**

```powershell
git add src/core/minimized.js test/minimized.test.js src/main.js
git commit -m "feat: project minimized windows into dock snapshot"
```

---

### Task 3: 渲染层最小化窗口方块

**Files:**

- Modify: `src/renderer/renderer.js`
- Modify: `src/renderer/style.css`

**Interfaces:**

- Consumes: 快照 `STATE.minimized`（Task 2 产出）：`{ kind:'min', id, h, title, exe, appName, icon }`。
- Produces: 槽序列 `[应用…, 分隔线, min…, 分隔线, 废纸篓]`（无 min 时 `[应用…, 分隔线, 废纸篓]`）；`slotMap` 项带 `baseSize`。

- [ ] **Step 1: 槽序列与重建逻辑**

`renderer.js` 中把 `reconcile`、`rebuildAll`、`updateSlots`、`makeDivider` 整体替换为：

```js
function wantedSlotIds() {
  const ids = effectiveEntries().map((e) => e.id);
  const mins = STATE.minimized || [];
  if (mins.length) {
    ids.push('__divider__', ...mins.map((m) => m.id), '__divider2__');
  } else {
    ids.push('__divider__');
  }
  ids.push('__trash__');
  return ids;
}

function reconcile() {
  const currentIds = [...itemsEl.children]
    .filter((el) => el.dataset.kind)
    .map((el) => el.dataset.id);
  const wantedIds = wantedSlotIds();
  const sameShape = currentIds.length === wantedIds.length &&
    wantedIds.every((id, i) => currentIds[i] === id);

  if (!sameShape) rebuildAll();
  else updateSlots();

  ensureRaf();
}
```

`makeDivider` 改为接收 id：

```js
function makeDivider(id) {
  const s = document.createElement('div');
  s.className = 'divider-slot';
  s.dataset.kind = 'divider';
  s.dataset.id = id;
  s.innerHTML = '<div class="divider"></div>';
  return s;
}
```

新增 `makeMinSlot`：

```js
function makeMinSlot(entry) {
  const slot = document.createElement('div');
  slot.className = 'slot min-slot';
  slot.dataset.kind = 'min';
  slot.dataset.id = entry.id;
  const wrap = document.createElement('div');
  wrap.className = 'icon-wrap';
  const img = document.createElement('img');
  img.className = 'app-icon';
  img.draggable = false;
  wrap.appendChild(img);
  slot.appendChild(wrap);
  return slot;
}
```

`rebuildAll` 改为无参、从 STATE 读数据：

```js
function rebuildAll() {
  const prevScales = new Map();
  for (const [id, s] of slotMap) prevScales.set(id, s.cur.scale);

  slotMap.clear();
  itemsEl.innerHTML = '';

  const append = (id, el, kind, baseSize, entry) => {
    slotMap.set(id, {
      el,
      cur: { scale: prevScales.get(id) == null ? 1 : prevScales.get(id) },
      targetScale: 1,
      baseSize,
      entry,
    });
    itemsEl.appendChild(el);
  };

  for (const e of effectiveEntries()) {
    const el = makeAppSlot(e);
    applyEntryToSlot(el, e);
    append(e.id, el, 'app', OPT.iconSize, e);
  }

  const mins = STATE.minimized || [];
  if (mins.length) {
    append('__divider__', makeDivider('__divider__'), 'divider', OPT.iconSize, null);
    for (const m of mins) {
      const el = makeMinSlot(m);
      applyEntryToSlot(el, m);
      append(m.id, el, 'min', Math.round(OPT.iconSize * 0.72), m);
    }
    append('__divider2__', makeDivider('__divider2__'), 'divider', OPT.iconSize, null);
  } else {
    append('__divider__', makeDivider('__divider__'), 'divider', OPT.iconSize, null);
  }

  const trash = makeTrashSlot();
  applyEntryToSlot(trash, { kind: 'trash' });
  append('__trash__', trash, 'trash', OPT.iconSize, { kind: 'trash' });
}
```

`updateSlots` 改为无参并同步 min 槽：

```js
function updateSlots() {
  for (const e of effectiveEntries()) {
    const s = slotMap.get(e.id);
    if (!s) continue;
    s.entry = e;
    applyEntryToSlot(s.el, e);
  }
  for (const m of STATE.minimized || []) {
    const s = slotMap.get(m.id);
    if (!s) continue;
    s.entry = m;
    applyEntryToSlot(s.el, m);
  }
  const trash = slotMap.get('__trash__');
  if (trash) applyEntryToSlot(trash.el, { kind: 'trash' });
}
```

- [ ] **Step 2: min 槽内容与 tooltip**

`applyEntryToSlot` 函数开头（`trash` 分支之前）插入：

```js
if (slot.dataset.kind === 'min') {
  const img = slot.querySelector('img.app-icon');
  const url = entry.icon || letterTile(entry.appName || entry.title);
  if (img.dataset.curSrc !== url.slice(-120)) {
    img.dataset.curSrc = url.slice(-120);
    img.src = url;
  }
  slot.classList.toggle('running', false);
  slot.dataset.title = entry.title || '';
  return;
}
```

tooltip 的 `mouseover` 处理器中文字取值改为：

```js
const text = slot.dataset.kind === 'trash'
  ? '废纸篓'
  : slot.dataset.kind === 'min'
    ? (slot.dataset.title || '')
    : (slot.dataset.name || '');
```

- [ ] **Step 3: 点击、拖拽、右键、投放守卫**

`mousedown` 的 `onMove` 中把废纸篓守卫行替换为（min 同样不可拖）：

```js
if (id === '__trash__' || slot.dataset.kind === 'min') { finish(false); return; }
```

`handleClick` 替换为：

```js
function handleClick(id, entryAtPress) {
  if (id === '__trash__') {
    window.dock.invoke('open-trash');
    return;
  }
  const fresh = (slotMap.get(id) || {}).entry || entryAtPress;
  if (fresh.kind === 'min') {
    window.dock.invoke('focus-window', { h: fresh.h });
    return;
  }
  if (fresh.kind !== 'app') return;
  activateEntry(fresh);
}
```

`document.addEventListener('contextmenu', ...)` 中，`trash` 分支之后插入：

```js
if (slotEl.dataset.kind === 'min') {
  const holder = slotMap.get(slotEl.dataset.id);
  if (!holder || !holder.entry) return;
  const m = holder.entry;
  showMenu(ev.clientX, ev.clientY, [
    { label: '还原', action: () => window.dock.invoke('focus-window', { h: m.h }) },
    { sep: true },
    { label: '关闭', action: () => window.dock.invoke('close-window', { h: m.h }) },
  ]);
  return;
}
```

`dragover` 和 `hitAnySlot` 的槽位循环里都跳过 min/divider（两处加同一守卫）：

```js
if (s.el.dataset.kind === 'min' || s.el.dataset.kind === 'divider') continue;
```

- [ ] **Step 4: 基准尺寸（鱼眼作用于小方块）**

`computeTargets` 中 `const BASE = OPT.iconSize;` 替换为：

```js
const BASE = s.baseSize || OPT.iconSize;
```

`layoutTick` 中 `const size = Math.round(OPT.iconSize * s.cur.scale);` 替换为：

```js
const size = Math.round((s.baseSize || OPT.iconSize) * s.cur.scale);
```

- [ ] **Step 5: 样式**

`style.css` 的 `.slot img.app-icon,` 规则附近追加：

```css
.slot.min-slot img.app-icon { border-radius: 13%; }
```

- [ ] **Step 6: 验证（人工）**

```powershell
npm test
```

再启动应用：

```powershell
.\node_modules\electron\dist\electron.exe D:\AI-Workspace\mac-dock
```

检查清单：

- 无最小化窗口时，布局与改动前一致（应用 | 分隔线 | 废纸篓）。
- 最小化一个窗口（如记事本）后，右侧分隔线后出现缩小方块，悬停显示窗口标题。
- 点击方块还原窗口；右键菜单可「还原/关闭」。
- 小方块随鼠标鱼眼放大。
- 拖拽应用图标排序不受影响；文件拖到小方块上不产生投放高亮。

- [ ] **Step 7: 提交**

```powershell
git add src/renderer/renderer.js src/renderer/style.css
git commit -m "feat: render minimized windows on the right side of the dock"
```

---

### Task 4: 一键隐藏/还原 Windows 任务栏

**Files:**

- Modify: `src/native/bridge.ps1`（新增 `taskbar-state`、`taskbar-autohide` 命令与辅助函数）
- Modify: `test/bridge.test.js`（追加只读 `taskbar-state` 测试）
- Modify: `src/main.js`（`set-setting`、启动应用、`broadcastSettings`）
- Modify: `src/core/settings.js`（`DEFAULTS.hideTaskbar`）
- Modify: `src/renderer/settings.html`
- Modify: `src/renderer/settings.js`

**Interfaces:**

- Consumes: 设置键 `hideTaskbar`（bool）、`taskbarSettingsBackup`（base64 字符串或 null）。
- Produces: 桥接命令 `taskbar-state`（只读）→ `{ exists: bool, autohide: bool }`；`taskbar-autohide`（`{ on: bool, backup: string|null }`）→ `{ ok, backup? | restored? }`。

- [ ] **Step 1: 桥接只读命令 + 测试**

`bridge.ps1` 的 `while` 循环前追加辅助函数（放在 `function TrashCount` 之后）：

```powershell
function Get-TaskbarSettingsBlob {
    try {
        $v = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3' -Name Settings -ErrorAction Stop
        return [byte[]]$v.Settings
    } catch { return $null }
}

function Restart-Explorer {
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
        Start-Process explorer.exe | Out-Null
    }
}
```

`switch` 内追加（`'trash-count'` 分支之前）：

```powershell
'taskbar-state' {
    $blob = Get-TaskbarSettingsBlob
    if ($null -eq $blob) { Emit $cid $true @{ exists = $false; autohide = $false } }
    else { Emit $cid $true @{ exists = $true; autohide = (($blob[8] -band 0x02) -ne 0) } }
}
```

`test/bridge.test.js` 末尾追加测试：

```js
test('taskbar-state returns a parseable read-only snapshot', async () => {
  await withBridge(async (s) => {
    send(s, '5', 'taskbar-state');
    const res = await waitFor(s, '5');
    assert.equal(res.ok, true);
    assert.equal(typeof res.data.exists, 'boolean');
    assert.equal(typeof res.data.autohide, 'boolean');
  });
});
```

- [ ] **Step 2: 运行确认绿**

```powershell
npm test
```

Expected: 全部通过（含新增 `taskbar-state`）。

- [ ] **Step 3: 桥接写入命令**

`switch` 内追加 `taskbar-autohide` 分支：

```powershell
'taskbar-autohide' {
    try {
        $on = [bool]$argsObj.on
        $backup = [string]$argsObj.backup
        $path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3'
        $blob = Get-TaskbarSettingsBlob
        if ($null -eq $blob) { throw 'taskbar settings blob not found' }
        if ($on) {
            $original = [Convert]::ToBase64String($blob)
            $blob[8] = $blob[8] -bor 0x02
            New-ItemProperty -Path $path -Name Settings -Value $blob -PropertyType Binary -Force | Out-Null
            Restart-Explorer
            Emit $cid $true @{ backup = $original }
        } else {
            if (-not [string]::IsNullOrEmpty($backup)) {
                $restored = [Convert]::FromBase64String($backup)
                New-ItemProperty -Path $path -Name Settings -Value $restored -PropertyType Binary -Force | Out-Null
            } else {
                $blob[8] = $blob[8] -band (-bnot 0x02)
                New-ItemProperty -Path $path -Name Settings -Value $blob -PropertyType Binary -Force | Out-Null
            }
            Restart-Explorer
            Emit $cid $true @{ restored = $true }
        }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}
```

- [ ] **Step 4: 主进程设置接入**

`src/core/settings.js` 的 `DEFAULTS` 追加：

```js
hideTaskbar: false,
```

`src/main.js`：

1. `set-setting` 的允许键列表改为：

```js
if (['iconSize', 'magnification', 'autohide', 'launchAtLogin', 'appearance', 'hideTaskbar'].includes(k)) {
```

2. `set-setting` 内、`if (k === 'appearance')` 分支之后追加：

```js
if (k === 'hideTaskbar') {
  try {
    const backup = settings.get('taskbarSettingsBackup') || null;
    const res = await bridge.request('taskbar-autohide', { on: !!v, backup }, 20000);
    if (res && res.ok !== false) {
      if (!!v && res.backup) settings.set('taskbarSettingsBackup', res.backup);
      settings.set('hideTaskbar', !!v);
    } else {
      return { ok: false, err: (res && res.err) || 'taskbar-toggle-failed' };
    }
  } catch (e) {
    return { ok: false, err: e.message };
  }
}
```

3. `app.whenReady()` 中 `bridge = new NativeBridge(log);` 之后追加（启动时幂等应用）：

```js
if (settings.get('hideTaskbar')) {
  bridge.request('taskbar-autohide', { on: true, backup: settings.get('taskbarSettingsBackup') || null }, 20000)
    .then((res) => { if (res && res.backup) settings.set('taskbarSettingsBackup', res.backup); })
    .catch((e) => log('taskbar-autohide apply failed', e.message));
}
```

4. `broadcastSettings` 两个 send 对象都追加 `hideTaskbar: settings.get('hideTaskbar'),`。

- [ ] **Step 5: 设置页 UI**

`settings.html` 的 `autologin` 行之后追加：

```html
<div class="row">
  <div>
    <div class="label">隐藏 Windows 任务栏</div>
    <div class="hint">一键自动隐藏任务栏，仅保留 Dock；关闭可还原</div>
  </div>
  <div class="toggle" id="hideTaskbar"></div>
</div>
```

`settings.js`：

1. `render(s)` 中 `$('#autologin')` 行之后追加：

```js
$('#hideTaskbar').classList.toggle('on', !!s.hideTaskbar);
```

2. `$('#autologin')` 的 click 监听之后追加：

```js
$('#hideTaskbar').addEventListener('click', async () => {
  const next = !$('#hideTaskbar').classList.contains('on');
  const res = await window.dock.invoke('set-setting', { key: 'hideTaskbar', value: next });
  if (res && res.ok === false) {
    alert('隐藏任务栏设置失败：' + (res.err || '未知错误'));
    return;
  }
  $('#hideTaskbar').classList.toggle('on', next);
});
```

- [ ] **Step 6: 验证**

```powershell
npm test
```

人工验证（注意：会重启资源管理器，文件资源管理器窗口会被关闭）：

- 启动 Dock，打开设置 → 开启「隐藏 Windows 任务栏」→ 任务栏自动隐藏，Dock 常驻。
- 关闭开关 → 任务栏恢复原状。
- 重启 Dock，开关状态与任务栏状态保持一致。

- [ ] **Step 7: 提交**

```powershell
git add src/native/bridge.ps1 test/bridge.test.js src/main.js src/core/settings.js src/renderer/settings.html src/renderer/settings.js
git commit -m "feat: one-click auto-hide and restore for the Windows taskbar"
```

---

### Task 5: 端到端人工验收

**Files:** 无（验证 + 按需修复）

- [ ] **Step 1: 完整回归**

```powershell
npm test
```

Expected: 全部通过。

- [ ] **Step 2: 端到端清单**

启动应用并逐项确认（规格第 6 节清单）：

1. 启动 Dock：固定应用显示，指示点正确；日志目录（`%APPDATA%\Mac Dock\logs\main.log`）无 `enum-windows failed`。
2. 打开并最小化 2-3 个窗口：右侧分区出现对应小方块，顺序稳定；点击还原；悬停显示标题；右键可还原/关闭。
3. 无最小化窗口时布局与改动前一致。
4. 鱼眼放大、拖拽排序、文件拖放、废纸篓、自动隐藏、全屏让位均正常。
5. 设置页：图标大小、放大倍率、自动隐藏、外观、开机自启、隐藏任务栏均生效且重启后保留。
6. 开启/关闭「隐藏 Windows 任务栏」，确认任务栏隐藏与还原。

- [ ] **Step 3: 收尾提交**

若验证中发现并修复了问题，单独提交（`fix: ...`）；无问题则无需提交。

- [ ] **Step 4: 汇报**

在最终答复中报告：测试结果、已交付功能、人工验证清单逐项结果、已知限制（小方块为图标+标题，非窗口实时缩略图）。
