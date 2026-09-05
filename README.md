# Mac Dock for Windows

对标 macOS 原版 Dock 的 Windows 桌面替代品（Electron 33 + PowerShell 原生桥接）。
玻璃质感底栏、鱼眼放大、运行指示点、最近应用区、最小化窗口方块、废纸篓、
一键隐藏 Windows 任务栏 —— 让 Dock 成为日常桌面的主入口。

## 功能对照（macOS Dock）

| 功能 | 状态 |
| --- | --- |
| 固定 / 运行应用、运行指示点 | ✅ |
| 鱼眼放大（指针跟随，图标上浮、条高恒定） | ✅ |
| 启动弹跳动画 | ✅ |
| 点击切换窗口 / 还原（对齐 macOS，已聚焦时不收起窗口） | ✅ |
| 右键菜单：窗口列表、固定/移除、退出 | ✅ |
| 拖拽排序 / 拖出取消固定（poof 消散动画） | ✅ |
| 最近应用区（≤3，LRU） | ✅ |
| 最小化窗口方块（右侧分区，还原/关闭） | ✅ |
| 悬停运行图标 → 窗口缩略图预览（`PrintWindow` **周期快照**，非实时；GPU/UWP/DRM 窗口黑屏时自动降级为占位） | ✅ 快照 |
| Launchpad 启动台（开始菜单扫描 + 搜索，Dock 右键打开） | ✅ |
| 顶部菜单栏（前台应用名 + 时钟，纯穿透；可在设置关闭省内存） | ✅ |
| 文件拖到图标用该应用打开 / 拖入废纸篓回收 | ✅ |
| 废纸篓：计数角标、打开、清空、拖入/清空脉冲动画 | ✅ |
| tooltip（应用名 / 窗口标题） | ✅ |
| 自动隐藏 + 底部边缘唤醒 | ✅ |
| 全屏应用自动让位 | ✅ |
| Dock 恒浮于窗口之上；仅全屏应用时让位（可关） | ✅ |
| ShellExecute 式启动（.exe/.lnk/商店 UWP/别名，保留工作目录与参数） | ✅ |
| 一键隐藏/还原 Windows 任务栏（重启保留） | ✅ |
| 开机自启、深浅色外观、设置窗口 | ✅ |
| 通知角标（解析窗口标题括号计数，如「微信 (3)」「[7] …」） | ✅ |
| Dock 位置切换（底部 / 左侧 / 右侧） | ✅ |
| 多显示器跟随（鼠标移到哪屏，Dock 与顶栏跟到哪屏） | ✅ |
| 最小化 genie 动画（窗口吸入 Dock，可中断/重放） | ✅ |
| 文件夹 Stack（固定文件夹、点击展开、拖文件入栈） | ✅ |
| DWM 级实时缩略图（Live Thumbnail，随窗口内容动态刷新） | ❌ 平台限制 |

## 快速开始

```powershell
npm install
npm start          # 开发运行
npm test           # node:test（桥接协议 + 纯函数单测）
npm run dist       # 打包（NSIS 安装器 + win-unpacked）
```

要求：Windows 10/11、Node ≥ 18（仅构建/测试需要）、PowerShell 5.1（系统自带）。

### 打包说明

- 产物在 `release/`：`Mac Dock Setup.exe`（安装器）与 `win-unpacked/`（免安装目录）。
- 打包后 `app.isPackaged = true`，开机自启注册到 `Mac Dock.exe` 本体；
  从开发版切换到打包版后，请在设置里把「开机自动启动」关一次再开一次，
  让注册表指向新路径。
- 桥接脚本 `bridge.ps1` 通过 `asarUnpack` 落在实体目录（asar 内文件 PowerShell
  读不到），路径在 `src/core/native.js` 中自动重写。

## 架构

```
src/native/bridge.ps1   常驻 PowerShell 进程，NDJSON over stdio
                        窗口枚举/前台/图标提取/焦点/最小化/回收站/任务栏注册表
src/core/native.js      NativeBridge（请求-响应 + 超时 + 自动重启）、IconCache（磁盘缓存）
src/core/               纯函数模块：state-hash（增量推送签名）、minimized（投影）、recent（LRU）、settings
src/main.js             轮询合成状态快照 → 增量推送渲染层；IPC；探针窗口；设置窗口
src/renderer/           布局、鱼眼、交互（无框架，原生 DOM）
```

数据流：`enum-windows`（1.4s 轮询，单次往返，前台标志随枚举写入）→
`buildStateSnapshot` → `stateSignature` 变更才推送 → 渲染层 reconcile。
遮挡检测独立 250ms 一查（全屏让位 + 最近使用跟踪）。

## 性能与后台占用（实测）

- **空闲 CPU ≈ 0**：全部相关进程静置 5 秒 CPU 增量为 0ms；轮询为单行 JSON 的
  轻量 IPC（1.4s 状态轮询 + 250ms 遮挡检测）。
- 进程结构：Electron 主进程 + GPU + 网络工具 + 2 个渲染层（Dock/顶栏）
  + 1 个常驻 PowerShell 桥接 ≈ 340MB 私有内存（实测）。毛玻璃已把 blur 降到 18px、
  去掉常驻 will-change 合成层，GPU 进程约 140MB 私有；若需进一步压缩，
  可在设置里关闭「顶部菜单栏」（省一个渲染层约 40MB）。
- 动画由 vsync 对齐的 rAF 驱动，静止时循环自停；禁用 Chromium 原生遮挡计算
  防止常驻置顶窗被误判节流；Launchpad 关闭即销毁渲染层；图标提取走磁盘缓存。
- 桥接守护带父进程存活自检 + 启动孤儿清扫，无残留累积。
- 底边唤醒不依赖独立探针窗口：Dock 窗口贴屏幕底边，点击穿透模式下鼠标移动
  事件经 forward 转发进渲染层自行判定，少养一个渲染进程。

## Windows 适配说明

- DPI：窗口/布局用 Electron DIP，遮挡比较全走 Win32 物理坐标，规避换算误差。
- UWP 商店应用（applicationframehost 宿主）按标题分组展示；无 exe 的条目不提供固定。
- 中文路径：桥接 stdin/stdout 强制 UTF-8。
- 最大化的窗口与真全屏用 `IsZoomed` 区分，任务栏隐藏后不会误判让位。

## 已知限制

- 窗口缩略图预览为 `PrintWindow` 周期快照，非 DWM 级实时缩略图（Live Thumbnail）。
  GPU 加速窗口、UWP、DRM 保护内容抓不到画面（返回全黑/全白），已内置「黑屏检测 →
  降级为占位图」，不会把黑窗直接呈现给用户。
- 多显示器仅支持「跟随鼠标所在屏」，未实现每个屏幕各放一条 Dock。
- 「隐藏 Windows 任务栏」通过注册表 StuckRects3 + 重启资源管理器实现，
  关闭时还原备份 blob。
