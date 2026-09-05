# Mac Dock 桌面化 — 设计规格

- 日期：2026-08-28
- 范围：`D:\AI-Workspace\mac-dock`（现有 Electron 实现，保留并完善）
- 目标：修复核心功能，补齐 macOS Dock 的「最小化窗口」右侧分区，并提供「隐藏 Windows 任务栏」一键开关，让 Dock 成为用户的日常桌面主界面。

## 1. 背景与现状

现有实现已具备：鱼眼放大、固定/运行应用、指示点、tooltip、右键菜单、拖拽排序、文件拖放、废纸篓、自动隐藏、全屏让位、开机自启、深浅色外观、设置窗口。

两个已知问题：

1. **核心 bug**：`src/native/bridge.ps1` 的 `Enumerate` 方法在生成窗口列表 JSON 时，窗口对象收尾多写了一个 `}`（`list.Append("}}")`），导致整条响应非法。`src/core/native.js` 的 `onData` 对 `JSON.parse` 失败静默吞掉，因此 `enum-windows` 每次轮询都 8 秒超时，Dock 永远看不到运行中的应用。
2. **缺 macOS 原版右侧分区**：最小化窗口没有独立展示。

## 2. 本轮范围

### 做

- 修复 `enum-windows` JSON 生成 bug，并加回归测试。
- 加固 `onData`：解析失败时记录日志，不再静默。
- 右侧分区：最小化窗口以缩小方块展示在应用区与废纸篓之间（仿 macOS 原版）。
- 设置页新增「隐藏 Windows 任务栏」开关（改注册表 + 重启资源管理器，可还原）。
- 开机自启时自动应用任务栏隐藏状态。

### 不做（后续迭代）

最近应用列表、通知角标、Dock 位置切换（左/右）、多显示器、窗口实时缩略图、Launchpad。

## 3. 架构与数据流

现有分层不变：

```
PowerShell bridge (src/native/bridge.ps1)  ← NDJSON over stdio →  main (src/main.js)
main 轮询 enum-windows → buildStateSnapshot → pushState → renderer (src/renderer/renderer.js)
renderer 负责布局、鱼眼、交互；设置经 main 持久化到 userData/config.json
```

本轮新增的数据形状：快照中增加 `minimized` 数组；设置中增加 `hideTaskbar` 键；桥接新增 `taskbar-autohide` 命令。

## 4. 组件设计

### 4.1 桥接 bug 修复与回归测试

- `bridge.ps1`：`list.Append("}}")` → `list.Append("}")`。
- 新增 `test/bridge.test.js`（Node 自带 `node:test`）：
  - 起桥接进程（与主进程相同的 spawn 参数）。
  - `ping` 断言响应。
  - `enum-windows` 断言：输出整体可 `JSON.parse`、是数组、每个元素含字符串字段 `h/t/e`。
  - `foreground` 断言响应结构。
  - `icon` 断言（notepad.exe）返回 base64 PNG 或明确失败，且响应本身可解析。
  - 测试用 `--test` runner，`npm test` 运行。
- `native.js` `onData`：`JSON.parse` 失败时 `this.log('bad-json: ' + line.slice(0, 160))`。

成功标准：修复前测试红（JSON 解析失败），修复后测试绿；应用日志不再出现 `enum-windows failed`。

### 4.2 右侧最小化窗口分区

布局（`#dock-items` 内）：

```
固定/运行应用 … | 分隔线 | 最小化窗口方块 … | 分隔线 | 废纸篓
```

无最小化窗口时保持现有单分隔线布局（应用 | 分隔线 | 废纸篓）。

#### 主进程（main.js）

- `buildStateSnapshot` 增加 `minimized` 输出：
  - 遍历 `winList` 中 `m === true` 的窗口（排除已分配给 pin/extras 的重复项，即与 apps 共用同一份窗口数据，仅多一份投影）。
  - 元素形状：`{ id: 'min:' + h, h, title, exe, appName, icon }`。
  - `appName`：所属应用显示名（优先 pin 名称 / extras 组名，其次 exe 文件名）。
  - `icon`：沿用 `IconCache`，`fetchIconsFor` 同样补齐；`pushState` 的 hash 纳入 `minimized`（数量 + 图标有无 + 标题），保证增量推送正确。
- 交互通道复用现有：`focus-window`（`ForceActivate` 已含还原逻辑）、`close-window`。

#### 渲染层（renderer.js + style.css）

- 槽位模型扩展：`slotMap` 每项增加 `baseSize`；`min` 槽 `baseSize = iconSize * 0.72`。
- `layoutTick` / `computeTargets` 改用 `s.baseSize || OPT.iconSize` 作为基准尺寸，鱼眼效果自然作用于小方块。
- 新槽类型 `kind='min'`：
  - 无运行指示点、无弹跳动画；tooltip 显示窗口标题。
  - 点击 → `focus-window { h }`（还原并聚焦）。
  - 右键菜单：「还原」「关闭」（复用 `focus-window` / `close-window`）。
  - 不参与内部拖拽排序（`startInternalDrag` 对 `kind !== 'app'` 直接返回）；不参与外部文件投放目标。
- `reconcile` / `rebuildAll` / `updateSlots`：构建槽序列 = 应用槽 + 条件分隔线 + min 槽 + 条件分隔线 + 废纸篓；`sameShape` 判断覆盖全序列（含 divider/min）。
- 分隔线 id：`__divider__`（应用 | 右侧区）、`__divider2__`（右侧区 | 废纸篓）。

成功标准：最小化一个窗口后，其方块出现在右侧分隔线之后；点击还原；悬停显示标题；右键可还原/关闭；无最小化窗口时布局与现在一致。

### 4.3 隐藏 Windows 任务栏开关

#### 注册表操作

路径：`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3`，值 `Settings`（REG_BINARY）。

- 字节 8 为选项字节：bit0（0x01）= 任务栏置顶/锁定，bit1（0x02）= 自动隐藏。
- 开启：`byte8 |= 0x02`（保留用户原有 bit0）；关闭：`byte8 &= ~0x02`。
- 开启前把原始 `Settings` blob 以 base64 存进配置 `taskbarSettingsBackup`；关闭时若备份存在则整体还原备份 blob（比位运算更稳）。
- 修改后重启资源管理器：`Stop-Process -Name explorer -Force`（系统会自动拉起；若 3 秒后未启动则 `Start-Process explorer.exe`）。

#### 桥接命令

`taskbar-autohide`，参数 `{ on: bool }`：

- `on=true`：备份 → 改字节 → 重启 explorer → 返回 `{ ok: true }`。
- `on=false`：有备份则还原，无备份则清 bit1 → 重启 explorer → 返回 `{ ok: true, restored: true }`。
- 任一步失败：返回 `{ ok: false, err }`，不改设置状态。

#### 主进程

- 设置键 `hideTaskbar`（bool，默认 false）。
- `set-setting` 增加该键：先调桥接，成功后写配置；失败返回错误，渲染层弹提示。
- 应用启动时：若 `hideTaskbar === true`，自动调用一次开启逻辑（幂等），防止资源管理器被系统重置后任务栏复现。

#### 设置页

- 新增一行开关「隐藏 Windows 任务栏」，hint：「一键让任务栏自动隐藏，仅保留 Dock；关闭可还原」。

成功标准：开启后任务栏自动隐藏、Dock 常驻；关闭后任务栏恢复原状；重启应用后状态保持。

## 5. 错误处理

- 桥接超时/退出：沿用现有 `NativeBridge` 重启机制；`enum-windows` 失败时 Dock 仍显示固定应用（现有降级路径）。
- 坏 JSON：记录日志（本轮新增），不崩应用。
- 任务栏操作失败：不写设置、返回错误信息、UI 提示；不做静默回滚以外的破坏性操作。
- 桥接脚本编码：保持 UTF-8 带 BOM，避免 Windows PowerShell 5.1 误读中文注释。

## 6. 测试策略

- `test/bridge.test.js`：只测桥接协议（只读命令），不触碰注册表/explorer。
- 任务栏开关：不做自动化测试（涉及系统级修改），以人工验证清单为准。
- 人工验证清单（完成后执行）：
  1. `npm test` 全绿。
  2. 启动 Dock，打开/关闭若干应用，确认指示点与运行状态正确、日志无 `enum-windows failed`。
  3. 最小化记事本/资源管理器窗口 → 右侧出现小方块；点击还原；悬停标题；右键还原/关闭。
  4. 无最小化窗口时布局与改动前一致。
  5. 开启「隐藏 Windows 任务栏」→ 任务栏自动隐藏；关闭 → 恢复。
  6. 重启 Dock，设置保留。

## 7. 文件改动清单

- `src/native/bridge.ps1`：修 `}}`；新增 `taskbar-autohide` 命令。
- `src/core/native.js`：`onData` 坏 JSON 记日志。
- `src/main.js`：`buildStateSnapshot` 输出 `minimized`；`set-setting` 支持 `hideTaskbar`；启动时应用任务栏状态。
- `src/renderer/renderer.js`：min 槽渲染、点击/右键/拖拽排除、布局序列与基准尺寸。
- `src/renderer/style.css`：min 槽与分隔线样式微调。
- `src/renderer/settings.html` + `settings.js`：任务栏隐藏开关。
- `src/core/settings.js`：默认值 `hideTaskbar: false`。
- `package.json`：`test` script。
- 新增 `test/bridge.test.js`。
- 新增本文档。

## 8. 成功标准（汇总）

1. `npm test` 通过；`enum-windows` 输出可解析。
2. 运行中的应用正常显示（指示点），日志无超时错误。
3. 最小化窗口出现在右侧分区，可还原/关闭/悬停查看。
4. 任务栏可一键隐藏与还原，设置重启后保留。
