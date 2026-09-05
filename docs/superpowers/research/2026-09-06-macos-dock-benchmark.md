# macOS 原版 Dock 对标基准（2026-09-06）

> 用途：作为 windows 版克隆 `win-dock` 的对标基准。
> 范围：macOS Sequoia（15.x）与 macOS Tahoe（26.x）的系统级 Dock。
> 方法：以 Apple 官方一手来源为准（Apple 支持指南、MDM 文档、Human Interface
> Guidelines）。凡 Apple 文档**明确写明**的标 [第一手]；凡 Apple 文档未写、
> 仅能在系统里观察到、或需第三方佐证的，标 [观察行为/待核实]。

## 来源缩略

- [DS] Change Desktop & Dock settings on Mac（Mac User Guide，mchlp1119）
  https://support.apple.com/en-us/guide/mac-help/mchlp1119/mac
- [MDM] Dock device management payload settings for Apple devices
  https://support.apple.com/en-us/guide/deployment/depef1fdf19/web
- [HIG-dockmenus] HIG「Dock menus」（页面需 JS，正文未抓到，据 Apple 文档定调）
  https://developer.apple.com/design/human-interface-guidelines/components/menus-and-actions/dock-menus
- [HIG-dock] HIG「Dock」
  https://developer.apple.com/design/human-interface-guidelines/dock
- [Tahoe] Apple Newsroom：macOS Tahoe 26 引入 Liquid Glass 全新设计
  https://www.apple.com/newsroom/2025/06/macos-tahoe-26-makes-the-mac-more-capable-productive-and-intelligent-than-ever/

---

## 1. 调研范围与版本说明

- 以 macOS Tahoe（26.x）为最新基准，Sequoia（15.x）为上一代主要对照。
  两者在“功能/设置项”上高度一致，差异集中在**视觉材质**（Tahoe 为 Liquid Glass，
  Sequoia 及之前为经典半透明玻璃）[Tahoe][DS]。
- 本文只记录**系统内置 Dock 的固有行为**。第三方增强（DockView / DockDoor 的
  悬停实时缩略图、多窗口展开图等等）不计入“原版”，只在第 6 节作为“超出原版”
  提示。
- 以下“待核实”项指：Apple 文档未写明、需在实体 Mac 上验证的行为。

---

## 2. 视觉设计

### 2.1 材质与外观
- Dock 面板为半透明玻璃/毛玻璃质感；Sequoia 及之前为保留经典的半透明模糊，
  Tahoe 26 起改用 Liquid Glass（折射 + 镜面高光 + 可变形边缘）[Tahoe]。
- Dock 无独立“边框”视觉，背景是模糊的桌面/窗口层，并随主题（明/暗）变化。
- 图标下方有垂直递减的**倒影**（经典版本即 Sequoia 前默认；Tahoe 是
  [观察行为/待核实]——材质变化后倒影是否存在需在真机确认）。

### 2.2 尺寸与放大
- **Dock 大小**：设置滑块，从 1 到 10 档，直接控制图标基础尺寸 [DS][MDM]。
- **放大（Magnification）**：指针划过图标时放大；级别从“无”到 10 档，
  可拖动滑块控制放大后大小 [DS][MDM]。
- 放大的作用域与强度受**指针到 Dock 底边的距离**调制（指针贴近底边最饱满，
  向上离开时快速衰减到 1）[观察行为/待核实]。
- 放大时**玻璃面板整体顶部上移**，贴合最高被放大图标，底边仍贴屏幕边缘
  [观察行为/待核实]。

### 2.3 运行指示
- “Show indicators for open applications”为一个独立开关；打开后，运行中的应用
  图标下方显示**一个小圆点** [DS][MDM]。
- 圆点带细白描边，且随放大图标同步下移，保持与图标底部的相对距离
  [观察行为/待核实]。

### 2.4 分区与分隔
- Dock 从左到右：应用区 →（可选）最近应用/建议区 → 最小化窗口区 → 废纸篓，
  区与区之间有**分隔线**（分隔线是否可见取决于是否启用“显示最近应用”）
  [观察行为/待核实]。
- 废纸篓恒在最右，收起/打开与回收站语义对应。

### 2.5 标签与 tooltip
- 鼠标悬停在图标上短暂显示**应用名 tooltip**；已打开多窗口的应用可看到
  窗口列表 [HIG-dockmenus]。

---

## 3. 交互与动画

### 3.1 点击
- 点击未运行图标 → 启动应用 [DS]（“Animate opening applications”控制是否
  播放弹跳动画）。
- 点击运行中应用图标 → 聚焦该应用（把其窗口带到前台）；若该应用已是最前台，
  再次点击通常**什么都不做**（macOS 不会像 Windows 那样“点一下最小化”）
  [观察行为/待核实 + HIG-dockmenus 的“聚焦”语义]。
- 应用无窗口但未退出时点击 → 重新打开一个窗口（macOS 语义）
  [观察行为/待核实]。

### 3.2 右键（contextual）Dock 菜单
- 右键/长按应用图标弹出 **Dock 菜单**：列出应用当前打开的窗口、常用动作
  （“选项”子菜单、退出等）。HIG 强调 Dock 菜单应**简短、聚焦**于运行中应用
  最常用的动作 [HIG-dockmenus]。

### 3.3 拖拽
- 拖拽图标 → 在 Dock 内重新排序。
- 拖出 Dock（拖到桌面）→ 从 Dock 移除，带“poof”消散动画 [观察行为/待核实]。
- 拖文件到应用图标 → 用该应用打开；拖到废纸篓 → 移入废纸篓
  [观察行为/待核实]。
- 拖文件悬停在文件夹/stacks 上 → “spring-loaded”自动展开
  [观察行为/待核实]。

### 3.4 最小化
- **Minimized windows animation**：二选一，**Genie effect** 或 **Scale effect**
  [DS][MDM]。
- **Minimize windows into application icon**：开启时缩到对应**应用图标**；
  关闭时缩到 Dock 里一个单独的**最小化窗口区** [DS][MDM]。

### 3.5 启动弹跳
- “Animate opening applications”：打开应用时图标**弹跳** [DS][MDM]。
- 约 2 次、逐次明显衰减（第二跳约为首跳 40%）、总时长约 1.2s，带轻微挤压
  (squash & stretch) [观察行为/待核实]。

### 3.6 滚动 / 预览
- 指针在 Dock 上**滚动滚轮**：在（某些）open 应用中一次性显示/隐藏其窗口
  （macOS 部分版本行为，与“打开/隐藏应用窗口”手势相关）[观察行为/待核实]。
- 悬停运行图标**不**显示实时缩略图（原生无；那是 DockView/DockDoor 第三方增强）
  [HIG-dockmenus 佐证 + 观察行为]。

---

## 4. 行为规则

### 4.1 自动隐藏
- “Automatically hide and show the Dock”：指针移到 Dock 所在**屏幕边缘**才显示；
  移开即隐藏 [DS]。

### 4.2 位置
- “Dock position on screen”：左侧 / 底部 / 右侧 [DS][MDM]。

### 4.3 最近应用 / 动态区
- “Show suggested and recent apps in Dock”：在 Dock 一侧显示**建议与最近打开**
  的应用（若尚未固定）[DS][MDM]。

### 4.4 状态与角标
- 应用可通过 NSDockTile / 通知提供**角标（badge）**与**图标内进度/活动指示**
  [MDM 相关的应用侧能力 / 观察行为]。
- 应用卡死时图标显示“未响应”指示 [观察行为/待核实]。

### 4.5 多显示器
- Mission Control 设置里的 **“Displays have separate Spaces”**：
  - 开启 → Dock 在**所有显示器**上都可用；
  - 关闭 → Dock 只出现在**主显示器** [DS]。
- 全屏应用时 Dock 默认隐藏/让位（全屏应用通常占据整屏）[观察行为/待核实]。

### 4.6 固定语义
- 应用“Keep in Dock”/“Remove from Dock”：固定项常驻；运行中但未固定的应用
  只在运行期间出现在 Dock [观察行为/待核实，结合 MDM 的 Dock apps]。

---

## 5. 系统设置条目对应（System Settings > Desktop & Dock）

下表每项均来自 [DS]（用户界面）与 [MDM]（MDM 键名，便于对照程序化开关）：

| 系统设置项（DS 原文） | MDM 键 / 取值 | win-dock 对应 |
| --- | --- | --- |
| Size | Dock size 1–10 | ✅ iconSize 36–72px（数值映射不同） |
| Magnification | Magnification 无–10 | ✅ 鱼眼放大，可调倍率 |
| Dock position on screen | Position 左/底/右 | ✅ bottom/left/right |
| Minimized windows animation | Minimize effect Genie/Scale | ✅ genie/scale 可切换 |
| Minimize windows into application icon | Minimize window into app icon | ◐ 仅最小化到右分区，无“进图标”开关 |
| Automatically hide and show the Dock | Automatically hide and show the Dock | ✅ 自动隐藏+边缘唤醒（默认更激进） |
| Animate opening applications | Animate opening apps | ✅ 启动弹跳 |
| Show indicators for open applications | Show indicator lights for open apps | ✅ 运行指示点 |
| Show suggested and recent apps in Dock | Show recent apps | ◐ 最近应用区（≤3，非“建议”区） |
| （多显示器）Displays have separate Spaces | —（Mission Control） | ◐ 多显示器跟随鼠标，非“所有屏都有” |

---

## 6. 边界与常见怪癖

- **图标很多**：Dock 出现更多图标时图标尺寸压缩；固定项过多会导致放不下，
  放大作用域互相挤压 [DS Size / 观察行为]。
- **全屏 / Spaces**：全屏应用或单独 Space 时 Dock 让位；不同 Space 的活动窗口
  只在前台对应。
- **Stage Manager**：开启后桌面整理模式，Dock 行为加入“最近应用在 Stage
  Manager 中”规则 [DS]。
- **Cmd + Option + 点击**：隐藏其他应用（不适用于 Dock 图标本身，属通用手势）
  [观察行为/待核实]。
- **Cmd + Tab**：应用切换器与 Dock 并存，Dock 主要承担“常驻入口”角色。
- **无障碍**：macOS Dock 支持 VoiceOver 与键盘导航（Dock 可 Tab 聚焦、方向键
  移动）[观察行为/待核实]。

---

## 7. 抽象行为清单（核心对标表）

| # | 行为 | macOS 默认行为 | 规则 / 设置 | 来源 |
| --- | --- | --- | --- | --- |
| 1 | 点击启动 | 未运行→启动 | Animate opening apps 控制是否弹跳 | [DS][MDM] |
| 2 | 点击已运行 | 聚焦该应用 | 已是前台则无动作（不最小化） | 观察行为/[HIG-dockmenus] |
| 3 | 点击已退出但无窗口 | 重新打开窗口 | macOS 语义 | 观察行为 |
| 4 | 右键应用 | 弹出 Dock 菜单（窗口列表+常用动作） | 简短聚焦 | [HIG-dockmenus] |
| 5 | 拖拽排序 | 重新排序 | — | 观察行为 |
| 6 | 拖出移除 | 移除并 poof 消散 | — | 观察行为 |
| 7 | 拖文件到图标 | 用该应用打开 / 移入废纸篓 | — | 观察行为 |
| 8 | 拖到 folder 悬停 | spring-loaded 展开 | — | 观察行为 |
| 9 | 最小化 | Genie / Scale 二选一 | Minimized windows animation | [DS][MDM] |
| 10 | 最小化位置 | 进应用图标 或 最小化区 | Minimize windows into app icon | [DS][MDM] |
| 11 | 启动弹跳 | 2 次衰减，~1.2s | Animate opening apps | [DS][MDM]+观察行为 |
| 12 | 运行指示 | 小圆点 | Show indicator lights | [DS][MDM] |
| 13 | 自动隐藏 | 移到屏幕边缘显示 | Automatically hide and show | [DS] |
| 14 | 位置 | 左/下/右 | Dock position | [DS][MDM] |
| 15 | 最近/建议区 | 端部显示最近+建议 | Show recent / suggested apps | [DS][MDM] |
| 16 | 角标/活动进度 | 应用提供（NSDockTile） | 应用侧能力 | 观察行为 |
| 17 | 多显示器 | 全部屏(sep Spaces on) / 仅主屏 | Mission Control 设置 | [DS] |
| 18 | 全屏让位 | 全屏时隐藏 | — | 观察行为 |
| 19 | 固定语义 | Keep in Dock / Remove | Dock apps | [MDM] |
| 20 | 悬停缩略图 | 原生无 | 第三方增强 | 观察行为 |

---

## 8. 未能从一手来源确认 / 待真机核实

- 放大强度受指针**垂直距离**调制的精确曲线。
- 放大时面板顶部是否整段上移、以及幅度。
- 点击已前台应用再次点击是否完全无动作（不同 macOS 版本略有差异）。
- 图标倒影在 Tahoe（Liquid Glass）下是否保留。
- 启动弹跳的精确次数与衰减比例。
- Dock 图标在图标很多时的具体压缩规则与最小尺寸。
- 滚动滚轮在 Dock 上的具体行为（部分版本）。
- 应用未响应指示的判定细节。

> 结论：Apple 官方文档覆盖了**设置项与开关语义**（本文件第 5、7 节是可编程依据），
> 但**动画手感、视觉材质细节、以及多版本差异**大多属于“真机观察”，本清单已明确
> 标注，作为下一步迭代排期时的“目标手感”参考；如条件允许，建议拿真机逐项核对。
