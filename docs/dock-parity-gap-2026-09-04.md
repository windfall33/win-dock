# Mac Dock for Windows × macOS 原版 Dock —— 全景差距清单

> 核查日期：2026-09-04
> 核查方法：逐文件精读 `src/renderer/*`、`src/main.js`、`src/core/*`、`src/native/bridge.ps1`，
> 以**代码事实**为准，README 与 `docs/superpowers/research/*` 仅作线索（两者均已发现失真，见第 6 节）。
> 结论口径：分数为「还原度/可用度」主观评估，非自动化评分。

---

## 0. 结论速览

| 维度 | 还原度 | 一句话判断 |
| --- | --- | --- |
| 布局结构（固定区/最近区/最小化区/废纸篓/分隔线） | ★★★★★ | 该有的分区全有，且分区语义正确 |
| 交互逻辑（点击/右键/拖拽/拖文件） | ★★★★☆ | 主干行为对了，多窗口语义与 macOS 有出入 |
| 玻璃质感与静态视觉 | ★★★☆☆ | 第一眼像，盯三秒就露馅（无倒影、面板不随放大增高） |
| 动画与物理手感 | ★★☆☆☆ | **最大短板**。有动画，但缺曲线、衰减、阻尼这层「物理」 |
| 系统集成深度 | ★★☆☆☆ | 停留在「窗口枚举 + 原子操作」，未进入系统窗口管理层面 |
| 窗口管理生态（Mission Control/Exposé 一类） | ☆☆☆☆☆ | 基本空白 |
| 稳定性 / 性能 | ★★★★☆ | 空闲 0 CPU 是真的，但轮询延迟与崩溃恢复是隐患 |

**一句话**：这是一个「功能清单层面已经很接近，手感与系统融合层面还差一个代际」的实现。
差距最大的不是缺功能，而是**动画物理、视觉细节、以及 Windows 平台拿不到的那部分系统能力**。

---

## 1. 已经对齐的部分（不必再动）

| 能力 | 代码位置 | 说明 |
| --- | --- | --- |
| 固定/运行应用 + 运行指示点 | renderer.js:123-135 | 4px 圆点，位置正确 |
| 鱼眼放大（基础版） | renderer.js:585-633 | 余弦曲线 + 邻居让位 + 条高恒定 |
| 图标大小 / 放大倍率 可调 | settings.html:69-79 | 36–72px，1–2.2× |
| Dock 位置 底/左/右 | settings.html:100-105 | |
| 自动隐藏 + 边缘唤醒 | style.css:41-43 | 300ms 滑出 |
| 深浅色跟随系统 | settings.html:89-93 | |
| 启动弹跳 | style.css:167-176 | ⚠️ 实现有偏差，见 A-3 |
| 最小化 genie / scale 双效果 | genie.js:25-52、settings.html:111-114 | ⚠️ 与旧文档结论不符，见第 6 节 |
| poof 拖出消散 | renderer.js:778-792、style.css:408-421 | |
| 拖拽排序 | renderer.js:1299-1306 | |
| 拖文件到图标打开 / 拖入废纸篓 | renderer.js:1659-1697 | |
| 废纸篓计数/打开/清空 | bridge.ps1 `trash-count`/`empty-trash` | |
| 最近应用区（≤3 LRU） | core/recent.js | |
| 最小化窗口方块区 | core/minimized.js | |
| 悬停多窗口缩略图网格 | renderer.js:840-864 | ⚠️ 数据源有硬伤，见 B-3 |
| Stack 文件夹 grid/fan/list 三视图 | renderer.js:986-1027、1486-1495 | ⚠️ fan 为简化实现，见 A-8 |
| Launchpad（开始菜单扫描 + 搜索） | launchpad.js:56-82 | ⚠️ 无分页/文件夹，见 B-9 |
| 顶部菜单栏 | topbar.js | |
| 多显示器跟随鼠标 | main.js:498 | |
| 开机自启 / 隐藏 Windows 任务栏 | main.js:147、bridge `taskbar-*` | |
| 全屏应用让位 | main.js:561-566 | |

**已超出原版的地方**（可以写进卖点）：
- 悬停图标弹出**多窗口实时缩略图网格** —— macOS 原生 Dock 没有，属第三方增强（DockView/DockDoor）才有的能力
- Launchpad 带**搜索** —— 原版 Launchpad 只有 Spotlight 式搜索框，扫描源不同
- 一键隐藏 Windows 任务栏（原版无对应需求）
- 最近应用区上限可配（原版固定行为）

---

## 2. A 类：还原度差距 —— 看起来 / 摸起来不像

这类不缺功能，缺的是**物理细节**。它们决定了「像不像」，也是投入产出比最高的部分。

### A-1 鱼眼放大：少了垂直维度与作用域
- 现状：倍率只看**水平**距离 `renderer.js:590-591`，垂直位置仅用于判定热区进出（:571）。作用域 `R = BASE * 2.6`（:585），约 ±2~3 个邻居。
- macOS：放大强度同时受**指针垂直位置**调制 —— 指针贴近 Dock 底边时放大最饱满，往上离开时快速衰减到 1。这个二维调制是「跟手感」的来源。
- 影响：横向扫过 Dock 时的手感接近，但**从上方斜插入 Dock** 的动作明显不对。

### A-2 回弹是 lerp 而不是弹簧
- 现状：`s.cur.scale += (tgt - cur) * 0.44`（放大）/ `0.5`（回落），纯指数逼近（renderer.js:611-613）。
- macOS：带轻微过冲的弹性收敛，且**离开 Dock 时整体有一个统一的收束节奏**，不是各图标各自 lerp。
- 影响：快速掠过后，图标是「软塌塌地缩回去」，不是「弹一下收住」。

### A-3 启动弹跳：无限循环，而不是有限次衰减
- 现状：`mac-bounce .95s infinite`（style.css:167-176），JS 挂类 3200ms 后移除（renderer.js:1108-1120）→ 约 3 个**等幅**周期。
- macOS：约 2 次弹跳，高度**逐次明显衰减**（第二跳约为第一跳的 40%），总时长约 1.2s，且图标有轻微挤压形变（squash & stretch）。
- 影响：启动时的弹跳「停不下来 / 一直在跳」，是最容易被察觉的动画失真。

### A-4 没有图标倒影
- 现状：无任何 reflection 实现。
- macOS：经典版本 Dock 底部有高度递减的倒影（Sonoma 及之前）。
- 影响：静态截图对比时，**一眼可辨**。这是视觉还原上最大的单点缺口。

### A-5 面板高度恒定，放大的图标溢出玻璃板
- 现状：`barEl.height = iconSize + 18` 恒定，放大时靠 `lift = round((size-base)*0.14)` 让图标**向上浮出条外**（renderer.js:53、:629）。
- macOS：玻璃面板**整体随最高图标增高**（顶部上移、底边贴合屏幕），放大 1.8× 时能看到面板被「顶起来」。
- 影响：1.8× 时图标顶部越出玻璃板边界，视觉上像「图标穿出容器」。

### A-6 玻璃材质是「模糊」而不是「玻璃」
- 现状：`blur(18px) saturate(1.6) brightness(1.05)` + 22px 圆角 + 1px 边框 + 一条 inset 高光（style.css:8-9, 50-53）。
- macOS Sonoma：更强模糊 + 更亮的顶部边缘高光 + 底部渐变收暗，层次更丰富。
- macOS Tahoe 26（Liquid Glass）：折射 + 镜面高光 + 随内容动态变形的边缘 —— **代际差距**，短期不建议追。

### A-7 Launchpad / Stack 开合无动画
- 现状：Launchpad 仅 backdrop blur，无 transition（launchpad.css）。Stack 弹层 `.15s` 淡入（style.css:335）。
- macOS：Launchpad 是背景模糊**扩散** + 图标缩放淡入；Stack 展开有明确的位移/缩放轨迹。

### A-8 Stack 的 fan 是「缩小的 grid」
- 现状：fan 视图用 flex 居中 + 缩小图标（renderer.js:986-1027），没有真扇形辐射与层叠重叠。
- macOS Fan：图标沿弧线辐射排布、互相重叠、首项在最前且最大。

### A-9 运行指示点的细节
- 现状：4px 圆点，`bottom: -3px` 固定（style.css:123-135）。
- macOS：圆点带极细白色描边；图标放大时圆点**随图标同步下移并保持与图标底部的相对距离**，不是固定像素偏移。

---

## 3. B 类：能力缺口 —— macOS 有，我们没有

| # | 缺口 | 严重度 | 说明 / 代码证据 |
| --- | --- | --- | --- |
| B-1 | **Mission Control / Exposé / 应用窗口总览** | 🔴 高 | 完全缺失。macOS Dock 生态的一半靠它（三指上滑 / 长按图标）。当前只有右键窗口列表（≤9 条） |
| B-2 | **AppBar 边缘预留**（最大化窗口避让 Dock） | 🔴 高 | 未用 `SHAppBarMessage`，已明确放弃（main.js:561-566 注释）。代价：最大化窗口底部约 70px 内容被 Dock 永久遮住 |
| B-3 | **DWM 级实时缩略图** | 🔴 高 | 只有 `PrintWindow(PW_RENDERFULLCONTENT)` 快照（bridge.ps1）。GPU 加速窗口、UWP、DRM 保护内容**直接黑屏/空白**。README 表格标 ✅ 但已知限制里又标 ❌，自相矛盾 |
| B-4 | **真实通知角标** | 🟠 中高 | 靠正则解析窗口标题括号数字（core/badges.js:6）。局限：托盘类应用（微信最小化后无窗口）**完全拿不到**；「未读数」与「窗口编号」无法区分 |
| B-5 | **进程状态判定不准** | 🟠 中高 | 「运行中」靠「有可见窗口」反推（main.js:339）。后台/托盘进程对 `EnumWindows` 不可见 → 显示为未运行 → 点击可能拉起第二个实例 |
| B-6 | **退出应用的实现有风险** | 🟠 中高 | `quit-app` = `taskkill /IM <name>`（main.js:672-710）。按镜像名杀进程，会**误杀同名进程**（多版本 Chrome、多个 python.exe、svchost 类通用名） |
| B-7 | **UWP 归组脆弱** | 🟠 中 | 靠 `applicationframehost.exe` + 标题前 40 字符分组（main.js:364）。标题一变就分组错乱、出现重复图标 |
| B-8 | **Dock 菜单缺「选项」子菜单** | 🟡 中低 | 缺失：在资源管理器中显示（仅 pinned 有）/ 登录时打开 / 分配到桌面（此显示器·所有显示器·无）。另缺「隐藏其他」「显示所有窗口」 |
| B-9 | **Launchpad 不完整** | 🟡 中低 | 无分页（仅滚动 grid）、无文件夹、无拖拽排序、无长按卸载 |
| B-10 | **最小化进应用图标**开关 | 🟡 中低 | macOS 设置项 `Minimize window into app icon`，我们只有固定的「最小化到右分区」 |
| B-11 | **图标内进度环 / 活动指示** | 🟡 中低 | 下载进度那种环形指示完全没有。当前用 `active-glow` 蓝光近似（renderer.js:518 自注「近似」） |
| B-12 | **废纸篓的弹簧文件夹** | 🟡 中低 | 拖文件悬停在 Dock 图标上自动打开（spring-loaded）—— 未实现。清空无确认动画、无只读锁定提示 |
| B-13 | **键盘导航 / 无障碍** | 🟡 中低 | 完全无。macOS 有 VoiceOver + 键盘操作 Dock |
| B-14 | **热键**（⌥⌘D 切换自动隐藏一类） | 🟢 低 | 未实现 |
| B-15 | **Siri / 动态建议区** | 🟢 低 | macOS 较新版本特性，Windows 无对应数据源 |
| B-16 | **窗口震颤定位**（shake to locate） | 🟢 低 | 无 |

---

## 4. C 类：平台天花板 —— Windows 上拿不到

这一类是**结构性的**，不是努力就能补平的，需要明确取舍而不是硬追。

| 缺口 | 为什么拿不到 | 可行的替代路径 |
| --- | --- | --- |
| 应用级「运行中」状态 | Windows 没有 `NSWorkspace.runningApplications` 那种应用生命周期概念 | `EnumWindows` + `OpenProcess` 枚举**全部进程**（不只是有窗口的）做 PID↔exe 匹配，可覆盖托盘应用，代价是开销上升 |
| 应用的真实 badge 数 | 无系统级统一通知接口；跳转列表/任务栏扩展是私有数据 | 针对高频应用（微信、QQ、邮件）做**逐个适配**；或放弃通用 badge，改为「只在拿得到时显示」 |
| 系统级窗口事件 | 未用 `SetWinEventHook` / `RegisterShellHookWindow`，纯轮询 | 引入 `SetWinEventHook(EVENT_OBJECT_CREATE/DESTROY/FOCUS)` 做事件驱动，轮询降为兜底 → 延迟从 1.4s 降到 ~50ms |
| 系统级合成器支持 | macOS Dock 由 WindowServer 合成；我们是普通无边框窗口 | 无法对等。只能规避：与开始菜单/任务视图/输入法的 Z 序与焦点冲突需逐个 case 处理 |
| 完全接管任务栏生态位 | 系统托盘、输入法指示器、通知中心、时钟仍栖于任务栏 | 顶栏已做「前台应用名 + 时钟」，可继续把托盘图标、通知并入顶栏，做成真正的「Windows 菜单栏替代品」 |
| Liquid Glass 材质 | 依赖系统级材质引擎 | 放弃追平，改追 Sonoma 复古风格，或做「本地近似玻璃」（多层模糊 + 噪声 + 边缘折射贴图） |

---

## 5. D 类：架构与性能风险

| 风险 | 现状 | 影响 |
| --- | --- | --- |
| 状态延迟 | 主轮询 `setInterval(pollOnce, 1400)`（main.js:1283）；遮挡检测 250ms（:1284） | 应用启动/关闭/切窗口，**最长 1.4s 后 Dock 才反应**。macOS 是事件驱动、瞬时 |
| 枚举开销 | 每次 `enum-windows` 对**每个窗口** `OpenProcess` + `QueryFullProcessImageName`（bridge.ps1:185） | 窗口数 100+ 时单次枚举成本显著；叠加 1.4s 频率 |
| 崩溃恢复 | 桥接有 watchdog（1500ms 重启）+ 父进程存活自检；**主进程无崩溃自恢复** | 主进程挂了 Dock 就没了，不会自拉起 |
| 内存 | 约 340MB 私有（Electron 主 + GPU + 网络 + 2 渲染层 + PS 桥） | 对常驻桌面组件偏高；关顶栏省约 40-50MB |
| 多 DPI 缩放 | bridge DPI-unaware（main.js:518 注释），未 `SetProcessDpiAwareness` | 多屏不同缩放比时，遮挡判定与坐标可能错位 |
| Z 序 / 焦点冲突 | 常驻置顶窗口 + 禁用 Chromium 遮挡计算 | 与开始菜单、任务视图、UAC 弹窗、全屏游戏的层级冲突属长尾问题 |

---

## 6. ⚠️ 文档与代码的事实偏差（必须修正）

核查中发现三处「文档说的和代码做的不一致」，会误导后续决策：

1. **README 表格自相矛盾**：第 19 行「悬停运行图标 → 窗口实时缩略图预览」标 ✅，第 36 行又标「❌ 已知限制：非 DWM 级实时缩略图」。
   → 真相：**有预览，但数据源是 PrintWindow 周期快照**，应统一为「✅（快照，非实时）」。

2. **research 文档已过时**：`docs/superpowers/research/2026-09-04-macos-dock-features.md` 中标注
   「❌ 无 Scale 选项」「❌ 无 Fan/List 切换」「Stack 仅 Grid」。
   → 真相：**均已实现**（genie.js:25-52 的 scale 模式；settings.html:111-114 的效果切换；renderer.js:1486-1495 的三视图菜单）。该文档的结论不能作为排期依据。

3. **research 文档漏记的实现**：poof 消散、拖文件到图标打开、拖入废纸篓均已落地，文档未反映。

> 建议：以本清单替换 `docs/superpowers/research/2026-09-04-macos-dock-features.md` 的第二节对齐表，并同步修正 README 表格。

---

## 7. 补齐优先级建议

按「感知提升 ÷ 实现成本」排序。前四项都是**动画与视觉参数调整**，成本低、体感提升最大。

### P0 —— 高感知、低成本（建议先做）
1. **弹跳改有限次衰减**：2 跳、逐次衰减、总时长 ~1.2s（改 style.css:167-176 + renderer.js:1108-1120 的计时）
2. **鱼眼加入垂直调制**：把指针到 Dock 底边的距离纳入倍率计算，作用域从 2.6 提到 ~3.2
3. **加图标倒影**：静态 CSS `transform: scaleY(-1)` + 渐变遮罩 + 透明度，成本极低
4. **面板随放大增高**：把 `barEl.height` 从常量改为跟随当前最大图标高度（renderer.js:53）

### P1 —— 结构性体验提升
5. **事件驱动改造**：`SetWinEventHook` 接管窗口创建/销毁/焦点，轮询降为兜底 → 延迟 1.4s → ~50ms
6. **多窗口应用点击行为**：点击已聚焦的应用 → 弹出该应用所有窗口的缩略图网格（复用现有 `window-thumb` 基础）。这是 macOS Dock 菜单「列窗口」的正解，也是最高频的多窗口场景
7. **退出应用改为按 PID 组**：`taskkill` 改为对归组后的 PID 集合逐个 `/PID`，避免误杀同名进程
8. **后台进程感知**：枚举时补充无窗口进程，修正托盘应用的「运行中」判定

### P2 —— 能力补齐
9. 应用窗口总览（Exposé）：把 B-1 做成 Dock 长按/中键触发
10. AppBar 边缘预留：与「隐藏任务栏」做二选一开关，让最大化窗口真正避让
11. Stack fan 真扇形；Launchpad 分页与文件夹
12. Dock 菜单「选项」子菜单、隐藏其他/显示所有窗口

### P3 —— 暂不建议
13. Liquid Glass 追平（代际差距，投入产出比低）
14. Siri 建议区（无数据源）
15. 实时 DWM 缩略图（需要 DwmRegisterThumbnail 原生模块，工程量与 Electron 架构冲突较大；若要做建议单独评估 native addon 方案）

---

## 附：核查覆盖的文件

```
src/renderer/renderer.js   61KB   布局 / 鱼眼 / 交互 / 菜单 / Stack / 预览
src/renderer/style.css     15KB   玻璃 / 弹跳 / poof / 预览 / Stack 样式
src/renderer/genie.js              genie + scale 最小化动画
src/renderer/launchpad.js          Launchpad
src/renderer/settings.html/.js     设置面板
src/renderer/topbar.js/.css        顶部菜单栏
src/main.js                47KB   状态合成 / IPC / 轮询 / 窗口操作 / 多屏
src/core/native.js                 NativeBridge + IconCache
src/core/badges.js                 角标正则
src/core/minimized.js / recent.js / state-hash.js / settings.js
src/native/bridge.ps1      38KB   22 条 NDJSON 命令（Win32 封装）
```
