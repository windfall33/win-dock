# macOS 原版 Dock 特性调研 + 与本项目对齐（2026-09-04）

## 一、macOS 原版 Dock 特性清单（按类别，附来源）

### A. 外观与尺寸
- **图标大小滑块**（Settings > Desktop & Dock）[support.apple.com/mchlp1119](https://support.apple.com/en-mz/guide/mac-help/mchlp1119/13.0/mac/13.0)
- **放大（Magnification，0–10 档/强/弱）** [support.apple.com](https://support.apple.com/en-mz/guide/mac-help/mchlp1119/13.0/mac/13.0)
- **位置：底部 / 左侧 / 右侧** [support.apple.com](https://support.apple.com/en-mz/guide/mac-help/mchlp1119/13.0/mac/13.0)
- **自动隐藏和显示 Dock**（指针移到 Dock 所在屏幕边缘即显示）[support.apple.com](https://support.apple.com/en-mz/guide/mac-help/mchlp1119/13.0/mac/13.0)
- **玻璃/毛玻璃外观**（macOS Tahoe 26 起为 Liquid Glass）[apple newsroom](https://images.apple.com/ae/newsroom/2025/06/macos-tahoe-26-makes-the-mac-more-capable-productive-and-intelligent-than-ever/)
- 深浅色外观跟随系统

### B. 布局与内容
- 固定应用 + 运行中应用指示点
- 最近使用区（右侧，recent)
- 最小化窗口区（右侧小窗格）
- 废纸篓
- 分隔线（apps | recents/minimized | trash）
- **Stack（文件夹）：Fan / Grid / List / Automatic** 展示方式，右键切换 [dummies](https://www.dummies.com/article/how-to-use-stacks-on-your-mac-197236)、[appish](https://appish.app/blog/mac-dock-folders-group-apps)
- **Dock 菜单**：secondary click 应用图标 → 列出所有当前/最近打开的窗口，可跳转 [Apple HIG dock-menus](https://developer.apple.com/design/human-interface-guidelines/dock-menus)
- 动态建议（Siri / 最近使用）—— 较新 macOS

### C. 交互
- 点击：未运行 → 启动；运行且后台 → 聚焦；**窗口全关闭后点击 → 重新打开窗口**（`applicationShouldHandleReopen`）[stackoverflow](https://stackoverflow.com/questions/79004080/macos-15-clicking-dock-icon-opens-two-windows)
- 点击已聚焦应用：聚焦应用、**不最小化**（mac 无 dock 最小化）[alt-tab issue](https://github.com/lwouis/alt-tab-macos/issues/3951)
- 拖拽排序、拖出移除（poof）、拖文件到图标用该应用打开
- 右键菜单（系统项 + 自定义项，含窗口列表）
- 悬停：**mac 原生 Dock 没有 hover 实时窗口预览**（DockView/DockDoor 是第三方增强）[appish](https://appish.app/blog/dock-customization-macos-sequoia)

### D. 动画
- 启动弹跳（Animate opening applications）[MDM Dock payload](https://developer.apple.com/documentation/devicemanagement/dock?language=objc)
- **最小化效果：Genie / Scale** 二选一 [support.apple.com deployment](https://support.apple.com/pl-pl/guide/deployment/depef1fdf19/web)
- poof（拖出移除消散）

### E. 窗口管理
- 多窗口缩略图列表（**非原生**；原生靠 Dock 菜单列出窗口，或用 Mission Control）
- Mission Control / Exposé（桌面级窗口总览）

### F. 通知与状态
- 通知角标（badge，由应用提供）
- **图标内进度/活动指示**（如下载进度，DockTile / NSProgressIndicator）

### G. 设置项 / 多显示器 / 无障碍
- Settings 项：Icon size、Magnification、Position、Automatically hide and show、Minimize effect（Genie/Scale）、Animate opening applications、**Minimize window into app icon** [MDM Dock payload](https://developer.apple.com/documentation/devicemanagement/dock?language=objc)
- 多显示器：Dock 仅一个，位于主屏/跟随焦点；全屏应用时自动隐藏
- 无障碍（Accessibility payload）、键盘导航

## 二、与当前 mac-dock 实现对齐

| macOS 特性 | 当前实现 | 差距 |
| --- | --- | --- |
| 图标大小滑块 | ✅ | – |
| 放大（Magnification） | ✅ 鱼眼 + 可调 | 接近 |
| 位置 底/左/右 | ✅ | – |
| 自动隐藏 + 边缘唤醒 | ✅ 智能收起（默认） | 更激进（应用前台即收起） |
| 最小化效果 Genie / **Scale** | ✅ Genie + Scale 可切换 | 已对齐（设置可切） |
| 启动弹跳 | ✅ | – |
| Dock 菜单（右键列窗口） | ✅ 有窗口列表 | 可补「显示在访达/退出/选项」 |
| 运行指示点 | ✅ | – |
| 最近使用区 | ✅ | – |
| 最小化窗口区 | ✅ 右侧方块 | mac 的「minimize into app」选项未做 |
| 废纸篓 | ✅ | – |
| 分隔线 | ✅ | – |
| **Stack Fan/Grid/List** | ✅ Grid / Fan / List 三视图 | 已对齐（右键可切，持久化） |
| 悬停窗口预览 | ✅（PrintWindow 快照） | mac 原生无；我们已超集 |
| 多窗口点击行为 | ✅ 已聚焦不收起 + 点击弹窗口 grid | 已对齐 |
| 通知角标 | ✅ | – |
| 图标进度/活动指示 | ◐ 新窗口活动微光近似 | 实时下载进度无 Windows 数据源 |
| 多显示器跟随 | ✅ | 接近（mac 主屏） |
| 全屏让位 | ✅ | – |
| 深浅色 | ✅ | – |
| 动态 Dock（Siri 建议） | ❌ | 未实现 |
| 无障碍/键盘导航 | ❌ | 未实现 |

## 三、建议的下一个优化（按价值排序）
1. **多窗口应用的「窗口缩略图 grid」**：点击已聚焦运行应用 → 弹出该应用所有窗口缩略图网格，点击聚焦/关闭。复用现有 `window-thumb` 预览基础；补齐 macOS Dock 菜单「列窗口」的体验，也是最常用的多窗口切换场景。
2. **Stack 展示方式（Fan / Grid / List）**：给文件夹 stack 加展示方式选项。
3. **最小化效果选项（Genie / Scale）**：设置里可切换。
4. **Dock 菜单增强**（显示在 Finder / 退出 / 选项）。
5. 图标内进度/活动指示（较复杂，后置）。
