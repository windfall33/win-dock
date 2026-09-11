# macOS 原版 Dock 全面调研 × Win Dock 差距报告

> 调研日期：2026-09-11  
> 代码基线：`win-dock@1.3.0`  
> 方法：Apple 一手文档 + macos-defaults + HEAD 源码审计。  
> **1.3.0 已落地 P0**：static-only / scroll-to-open 默认关 / autohide 节奏 GUI / 分配到显示器 / 任务视图；  
> **P1 部分落地**：弹跳衰减、Shift 临时放大、spring-load 应用开关。

---

## 0. 结论速览

| 维度 | 还原度 | 一句话 |
| --- | --- | --- |
| 分区结构与图标行为主干 | ★★★★★ | 固定区/最近区/最小化区/废纸篓/分隔线语义正确 |
| 设置项覆盖面 | ★★★★☆ | GUI 已覆盖 macOS Dock 区 10 项中的 8 项；缺标题栏双击、static-only |
| 交互手感（鱼眼/弹跳/弹簧） | ★★★★☆ | 余弦衰减 + 弹簧 + 垂直调制已落地；弹跳是 CSS 循环非物理衰减 |
| 菜单与修饰键 | ★★★★☆ | 选项子菜单、强制退出、Alt/Ctrl 映射齐全；缺分配到显示器 |
| 系统集成深度 | ★★★☆☆ | WinEvent/工作区预留/托盘进程已做；角标与进度仍是标题启发式 |
| 窗口管理生态 | ★★☆☆☆ | 仅 App Exposé（单应用）；无全局 Mission Control 打通 |
| 视觉材质 | ★★★☆☆ | Sonoma 风格玻璃接近上限；Tahoe Liquid Glass 明确不追 |

**综合判断**：功能广度约原版 **85%**，另有 5 项超出原版（悬停缩略图网格、Launchpad 搜索、一键藏任务栏、每屏可选独立 Dock、进度环启发式）。  
**最大真差距**不在「有没有」，而在：**系统级角标/进度、Mission Control、标题栏双击语义、分配到桌面、scroll-to-open 默认策略、Launchpad 完整度**。

---

## 1. macOS 原版画像（调研蒸馏）

### 1.1 System Settings「Desktop & Dock」Dock 区 10 项 [官方 mchlp1119]

| # | 设置项 | 语义 |
| --- | --- | --- |
| 1 | Size | 连续滑条；defaults `tilesize`，默认 **48**，社区/MDM 范围约 **16–128** |
| 2 | Magnification | 开关 + 滑条（目标尺寸，同量级） |
| 3 | Position on screen | Left / Bottom / Right（**无 top**） |
| 4 | Minimized windows animation | Genie / Scale |
| 5 | 双击标题栏 | Fill / Zoom / Minimize / No Action |
| 6 | Minimize into application icon | 收进应用图标 vs 独立最小化区 |
| 7 | Automatically hide and show the Dock | 默认关；快捷键 ⌥⌘D / Fn-A |
| 8 | Animate opening applications | 启动弹跳，默认开 |
| 9 | Show indicators for open applications | 运行圆点，默认开 |
| 10 | Show suggested and recent apps | 最近/建议区，默认开 |

### 1.2 Use the Dock [官方 mh35859]

- 最多 **3** 个未固定的最近应用 + 默认 Downloads 堆栈  
- 拖文件到应用打开；拖出移除（只删别名）  
- **⌘-点击** = 在 Finder 中显示  
- **⌥-点击** = 切换到该应用并隐藏当前  
- **⌥⌘-点击** = 切换并隐藏其他  
- Control-点击快捷菜单；无响应时「强制退出」  
- 分隔线拖拽调大小；Control-点击分隔线有其他操作  
- 键盘：**Fn-Control-F3** 聚焦 Dock，方向键，Return 打开  
- 红色 badge 表示需要操作  

### 1.3 文件夹 / 堆栈 [官方 mchl231f08fb]

- 显示为 **文件夹或堆栈**  
- 排序：名称 / **日期添加** / 创建日期 / 其他  
- 视图：fan / grid / list  
- 点击展开，再点空白或图标收起  

### 1.4 快捷键 [官方 102650]

| 快捷键 | 行为 |
| --- | --- |
| ⌥⌘D | 显示/隐藏 Dock |
| Fn-A | 显示/隐藏 Dock |
| Control-Shift + 访问 Dock | 临时开关放大 |
| Fn-Control-F3 | 焦点到 Dock |
| Control-↓ | 当前应用全部窗口（App Exposé） |
| Control-↑ | Mission Control |
| Control-Shift-⌘-T | 把 Finder 选中项加入 Dock |

### 1.5 defaults 隐藏参数 [macos-defaults]

| 键 | 默认 | 语义 |
| --- | --- | --- |
| `autohide-delay` | 0.2s | 触边延迟 |
| `autohide-time-modifier` | 0.5 | 滑入/出动画时长 |
| `scroll-to-open` | **false** | 悬停滚轮 = Exposé / 展开堆栈 |
| `static-only` | false | 只显示运行中，隐藏全部固定项 |
| `show-recents` | true | 最近应用区 |
| `enable-spring-load-actions-on-all-items` | false | 悬停拖文件自动打开应用 |
| `mineffect` | genie | genie / scale / suck |

### 1.6 平台天花板（Windows 拿不到）

- NSWorkspace 应用生命周期、系统级 NSDockTile badge  
- WindowServer 合成材质（Liquid Glass）  
- 真实 Genie 窗口形变、DWM Live Thumbnail（需 native addon）  
- Spaces 模型下「每屏独立 Dock + 独立桌面」  
- 双击标题栏 Fill/Zoom 的窗口管理器语义  

---

## 2. Win Dock 现状对照（代码证据）

评级：**A** 对齐或合理取舍｜**B** 可用有感差｜**C** 明显差距｜**✗** 缺失｜**P** 平台天花板

### 2.1 设置项（macOS 10 项）

| macOS 项 | 我们 | 评级 | 证据 |
| --- | --- | --- | --- |
| Size | 24–128 滑条 + 分隔线拖宽 | A | `settings.html` / `layout.js` clamp |
| Magnification | 1–2.2 开关式滑条 | A- | 无「临时 Control-Shift 临时放大」 |
| Position | bottom/left/right | A | 全链路 |
| Minimize animation | genie | scale | A | `minimizeEffect` |
| 双击标题栏 | — | **✗** | Windows 非我们控制 |
| Minimize into icon | 有开关 | A | `minimizeIntoIcon` |
| Autohide | 有；默认 keepVisible 常驻 | A- | 默认更 mac（常驻），可关 |
| Animate opening | 弹跳到就绪/3s 封顶 | B+ | CSS 循环，非逐次衰减物理 |
| Indicators | 有开关 | A | `showIndicators` |
| Suggested & recent | 有开关 + LRU≤3 | A | `showRecents` |

**我们多出的 GUI**：每屏 Dock、工作区预留、智能收起 vs 常驻、隐藏任务栏、顶栏、深浅色、多屏跟随。

**macOS 有我们 GUI 没有**：  
- `static-only`（只显示运行中）  
- `scroll-to-open` 开关（我们**默认开启**滚动 Exposé，mac 默认关）  
- spring-load 全应用开关（我们仅文件夹）  
- autohide delay/time 暴露（我们藏在 config.json）  

### 2.2 交互与动画

| 项 | macOS | 我们 | 评级 |
| --- | --- | --- | --- |
| 鱼眼 | 余弦/高斯 + 垂直调制 | R=3.2× 余弦 + vmod + 弹簧 | A- |
| 回弹 | 弹簧轻微过冲 | `core/spring.js` 0.26/0.58 | A- |
| 满屏压缩 | 全体等比，下限 16 | `computeFitScale` 下限 0.5 | A |
| 启动弹跳 | 弹到就绪；attention bounce | 就绪/3s；无 attention | B+ |
| 弹跳物理 | 逐次衰减 + squash | CSS infinite 近似 | B |
| Genie/Scale | 系统形变 | 截图 + 关键帧近似 | B+ |
| Poof | 拖出消散 | SVG 云雾 | B+ |
| 滚轮悬停 | 默认关；开=Exposé/Stack | **默认开** | 分歧 |
| 拖拽避让 | 弹簧 | 有 | A- |

### 2.3 点击 / 修饰键

| 项 | macOS | 我们 | 评级 |
| --- | --- | --- | --- |
| 未运行点击 | 启动+弹跳 | 有 | A |
| 已前台多窗 | 列窗口/无动作 | 强制预览网格 | A（超原版） |
| ⌘-点击 | Finder 显示 | Ctrl→资源管理器 | A- |
| ⌥-点击 | 隐藏当前 | 最小化模拟 | A- |
| ⌥⌘-点击 | 隐藏其他 | 有 | A- |
| 键盘焦点 | Fn-Control-F3 | Ctrl+Alt+D | B+ |
| 强制退出 | ⌥+右键 | hung 时红字自动 | A（超原版） |

### 2.4 菜单

| 项 | 状态 | 评级 |
| --- | --- | --- |
| 窗口列表 ≤9 | 有 | A |
| 选项：在资源管理器显示 / 登录时打开 / 从 Dock 移除 | 有（顶层也有移除） | A |
| **分配到此桌面/所有桌面/无** | **无** | C |
| 隐藏其他 / 显示所有窗口 | 有 | A |
| 退出 / 强制退出 | 有 | A |
| 文件夹：显示为 / 排序 | 有；**「日期添加」实为 mtime** | B |
| 废纸篓清空确认 | 3s armed（非系统对话框） | B |

### 2.5 拖拽 / 文件

| 项 | 状态 | 评级 |
| --- | --- | --- |
| 排序 / 拖出 poof | 有 | A |
| 多文件 open-with | 有 | A |
| 拖入废纸篓 | 有 | A |
| 文件夹 spring-load | ~700ms，仅文件夹 | B+ |
| **全应用 spring-load** | **无** | ✗（mac 默认也关） |
| 分隔线拖宽 | 有 | A |

### 2.6 最小化 / 预览 / Exposé

| 项 | 状态 | 评级 |
| --- | --- | --- |
| 最小化区 | 有 | B+ |
| Genie/Scale | 有 | B+ |
| 悬停缩略图 | PrintWindow 快照（超原版） | A |
| App Exposé | 中键/滚轮，≤24 窗 | B+ |
| **Mission Control 全局** | **无**（未打通任务视图） | ✗ |
| Live Thumbnail | 无 | P |

### 2.7 状态与角标

| 项 | 状态 | 评级 |
| --- | --- | --- |
| 运行判定 | 窗口 + 托盘进程 | B+ |
| 角标 | 标题正则 | C |
| 进度环 | 标题 % 启发式 | C |
| hung | IsHungAppWindow | A- |
| WinEvent 即时刷新 | 有 | A- |

### 2.8 让位 / 多屏 / 工作区

| 项 | macOS | 我们 | 评级 |
| --- | --- | --- | --- |
| 全屏让位 | 独立 Space | 有（可关） | A- |
| **最大化窗口避让** | Dock 恒占位 | 仅 `workareaReserve` 可选且**仅主屏** | B |
| 每屏一条 Dock | separate Spaces 开关 | `dockPerDisplay` | B+ |
| 跟随鼠标 | 无此模式 | `multidisplay` | 超出 |

### 2.9 生态

| 项 | 状态 | 评级 |
| --- | --- | --- |
| Launchpad | 开始菜单扫描+搜索+分页；无文件夹/抖动 | B- |
| 顶栏 | 应用名+时钟 | C（非菜单栏） |
| 隐藏任务栏 | 有 | 超出 |
| Handoff | 无 | P |

---

## 3. 关键分歧（行为不一致，用户会感知）

| # | 分歧 | macOS | Win Dock | 建议 |
| --- | --- | --- | --- | --- |
| D1 | scroll-to-open | 默认 **关** | 滚轮悬停默认触发 Exposé/Stack | 加设置项，默认改关或提示 |
| D2 | autohide 默认 | 关 + Dock 常驻 | keepVisible 默认开（已对齐） | 保持 |
| D3 | 弹跳次数 | 就绪即停 + 衰减 | CSS 三连跳 | 可选物理衰减 |
| D4 | 「日期添加」 | 真添加时间 | mtime | UI 已写「修改日期」 |
| D5 | 双击标题栏 | 系统级 | 不可达 | 文档标明 P |
| D6 | 角标 | NSDockTile | 标题猜 | 明确近似 |

---

## 4. 差距优先级（按「感知提升 ÷ 成本」）

### P0 —— 真缺口、中成本、高感知

1. **static-only 模式**（只显示运行中）— 设置一项 + snapshot 过滤，对齐 macOS 隐藏键。  
2. **scroll-to-open 设置项** — 默认与 mac 对齐（关），可选开。  
3. **autohide 节奏暴露 GUI** — delay / animation，对齐官方 0.2s / 0.5s。  
4. **分配到显示器菜单** — 此显示器 / 所有 / 无（mac 分配到桌面的 Windows 映射）。  
5. **Mission Control 打通** — 菜单/热键调起 Win 任务视图（`Win+Tab` 或 COM），成本低于自建全局缩略图。

### P1 —— 手感与质量

6. 弹跳改逐次衰减关键帧（或 spring 驱动）。  
7. Control-Shift 悬停临时放大。  
8. 全应用 spring-load 开关（默认关）。  
9. 工作区预留扩展到所有显示器。  
10. ITaskbarList3 进度（若可行）替代标题 %。

### P2 —— 生态

11. Launchpad 文件夹/拖拽（价值中低，曾明确不做）。  
12. 顶栏菜单原型（成本高）。  
13. 真 badge 逐应用适配。

### 明确不做（P）

Liquid Glass、DWM Live Thumbnail、真 Genie、系统级 badge、Handoff、每屏独立 Spaces。

---

## 5. 与历史文档关系

- `dock-benchmark-2026-09-06.md` 的 P0–P2 已在 1.2.x 落地大半。  
- 本文以 **1.2.1 HEAD** 重新审计，修正：滚动悬停默认策略、static-only 仍缺、分配到显示器仍缺、Mission Control 仍缺、workarea 仅主屏。  
- README 功能表与本文一致处以 README 为准；冲突处以本文代码证据为准。

---

## 6. 来源

- Apple Support: Desktop & Dock (mchlp1119)、Use the Dock (mh35859)、Folders in Dock (mchl231f08fb)、Keyboard Shortcuts (102650)  
- macos-defaults.com/dock/*、misc/enable-spring-load-actions-on-all-items  
- 代码：`src/core/settings.js`、`snapshot.js`、`src/renderer/*`、`src/native/bridge*`、`src/windows/dock-window.js`
