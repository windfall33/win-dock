# Mac Dock 优化迭代 — 2026-08-29

- 范围：`D:\AI-Workspace\mac-dock`
- 输入：全量代码审查 + 对标 macOS 原版 Dock 功能清单 + Windows 适配性 + 后台占用评估

## 1. 现状结论

已有：鱼眼放大、固定/运行应用 + 指示点、tooltip、右键菜单、拖拽排序、文件投放、
废纸篓（计数/清空/拖放回收）、自动隐藏 + 底边唤醒、全屏让位、最近应用区（≤3）、
一键隐藏任务栏、开机自启、深浅色、设置窗口。`npm test` 11 项全绿。

## 2. 本轮修复（bug）

### 2.1 状态推送丢失（严重）
`main.js pushState` 的增量 hash 只含 `windows.length`，不含窗口级 `m`(最小化)/
`f`(前台)/`t`(标题)。后果：最小化窗口、切换前台后渲染层永远收不到更新 ——
「点击已聚焦应用图标 → 最小化」失效（死点击）、右键窗口列表陈旧。

修复：抽出纯函数 `src/core/state-hash.js` `stateSignature(snap)`，签名纳入
每个窗口的 `[h, m, f, t]` 与 `minimized` 投影；`pushState` 改用之。TDD。

### 2.2 拖拽残影不消失
`endInternalDrag` 加 `hidden` 类，但 CSS 只有 `#menu-layer.hidden` 规则，
拖拽结束后图标克隆残留在屏幕上。补 `#drag-ghost.hidden { display:none }`。

### 2.3 最近应用点击聚焦的 exe 匹配区分大小写
前台进程路径与 pin/extras 路径大小写可能不同（`C:\WINDOWS\...` vs `C:\Windows\...`），
导致命中失败退化为重新启动。改为大小写不敏感比较。

### 2.4 UWP 应用可被固定成死图标
UWP（applicationframehost 宿主）组 `exe` 为空，「固定到 Dock」会生成无效 pin。
无 exe 时隐藏该菜单项。

## 3. 本轮功能（macOS 对标）

### 3.1 恢复「最小化窗口」右侧分区
对齐 macOS：`应用 … | 分隔线 | 最近应用 … | 分隔线 | 最小化窗口方块 … | 废纸篓`。
仅最近应用时保持现有布局；仅最小化窗口时为 `应用 | 分隔线 | 方块 … | 废纸篓`。

- 纯函数 `src/core/minimized.js` `extractMinimized(winList, appEntries)` →
  `{ kind:'min', id:'min:'+h, h, title, exe, appName, icon }`（appName/icon 取自所属
  应用条目，exe 兜底）。TDD。
- 渲染层 `min` 槽：`baseSize = iconSize * 0.72`，鱼眼自然生效；无指示点、不弹跳、
  不可拖拽、不接收文件投放；点击 → `focus-window`（还原并聚焦）；右键 → 还原/关闭；
  tooltip 显示窗口标题。

## 4. 本轮性能 / Windows 适配

### 4.1 轮询省一次往返
`enum-windows` 枚举时已按 `GetForegroundWindow` 写入 `f` 标志，`pollInner` 不再每轮
追加 `foreground` 请求（桥接命令保留，测试继续覆盖）。

### 4.2 唤醒探针按需拦截
探针窗口常驻 `setIgnoreMouseEvents(false)`，即使 Dock 可见也吞掉屏幕底部 8px 的
点击（任务栏可见时其底部 8px 不可点）。改为：Dock 隐藏（自动隐藏/全屏让位）时才
启用拦截，可见时穿透 —— 统一在 `sendEnv` 切换。

### 4.3 CSP 安全头
`index.html` / `settings.html` / 探针 data: URL 增加 Content-Security-Policy，
消除 Electron 不安全 CSP 告警。

## 5. 不做（记录为已知限制）

通知角标、Dock 位置切换（左/右）、多显示器、窗口实时缩略图（LiveView）、Launchpad、
窗口最小化动画（genie 效果）。

## 6. 测试与验证

- 新增 `test/state-hash.test.js`、`test/minimized.test.js`（先红后绿）。
- `npm test` 全绿。
- 人工/冒烟：启动 Dock → 最小化记事本 → 右侧出现方块；点击还原；右键还原/关闭；
  拖拽图标后无残影；日志无新增错误。
