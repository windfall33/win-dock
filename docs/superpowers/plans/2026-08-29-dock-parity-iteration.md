# Dock 对标迭代 2 — 缩略图预览 / Launchpad / 顶部菜单栏 v1

- 日期：2026-08-29
- 前置：优化迭代 1（状态签名、最小化分区、z-order、探针、CSP）已交付

## 目标

按体验收益排序补齐三块：窗口缩略图预览、Launchpad 启动台、顶部菜单栏 v1。

## 1. 窗口缩略图预览（悬停运行中应用图标）

- 桥接新增 `window-thumb { h }`：`PrintWindow(PW_RENDERFULLCONTENT)` 抓窗口内容，
  等比缩到宽 ≤320 后返回 base64 PNG（控制 IPC 负载）。最小化/失败返回 ok:false。
- Dock 窗口高度加 240px 头部留白（透明、惰性区域，bar 仍贴底），
  预览面板在 DOM 内、Dock 栏上方显示，不需要额外窗口。
- 渲染层：悬停有运行窗口的应用图标 500ms → 弹出玻璃预览卡：
  - 每窗口一格：缩略图 + 截断标题 + 悬停显示「×」；
  - 点击格 → `focus-window`；点 × → `close-window`；
  - 最小化窗口无法 PrintWindow → 显示「图标 + 标题」条，点击同样还原；
  - 面板可见期间每 1.2s 重抓一次（准实时）；移出图标/面板即隐藏；
  - 抓取失败（受保护窗口）回退为图标磁贴。

## 2. Launchpad 启动台

- 桥接新增 `list-start-menu`：枚举公共/用户开始菜单 Programs 下全部 .lnk，
  经 WScript.Shell 解析 target/args/iconLocation，一次返回（过滤空 target）。
- 主进程：打开时拉取并缓存（target+name 去重、按名称排序）；图标走现有
  IconCache 懒加载（首开异步补齐推送，之后走磁盘缓存秒开）。
- 新窗口 `launchpadWin`：全屏（workArea）、无边框、半透明毛玻璃背景、
  screen-saver 级；顶部搜索框（按名称子串过滤）；网格 72px 图标 + 名称；
  点击 → `open` 启动并关闭；Esc / 点空白 / 失焦 → 关闭。
- 入口：Dock 空白处右键菜单新增「启动台」。

## 3. 顶部菜单栏 v1

- 新窗口 `topbarWin`：顶部全宽 26px 条，无焦点、skipTaskbar、screen-saver 级；
  **整条点击穿透**（不遮挡最大化窗口的标题栏按钮），仅信息展示。
- 内容：左侧前台应用名（遮挡检查已有 fg 数据，变化即推）；
  右侧 `M月d日 周X HH:mm` 时钟（渲染层本地 15s 刷新）。
- assertWindowLevels 一并重申 topbar/launchpad 的 z-order。

## 4. 不做

通知角标（平台无数据源）、文件夹 Stack、Dock 位置切换、多显示器、
Mission Control、Spotlight —— 记录为后续方向。

## 5. 测试策略

- `window-thumb`、`list-start-menu`：桥接只读测试（可解析、结构正确、
  thumb 对 notepad 允许干净失败）。
- 预览面板 / Launchpad / 顶栏：截图验收（渲染层 CDP 截图 + 全屏截图）。
