# 打磨迭代：打包 / 上浮放大 / 动画 / 顶栏开关 — 2026-08-29

## 1. 图标上浮放大（macOS 标志视觉）

- Dock 条高度恒定（iconSize + 18px），不再随放大增长
- 图标底部对齐 + 上浮：放大时图标顶部越过条上沿（窗口上部 240px 留白容纳）
- overBar 命中区上沿扩大 iconSize（悬停浮出部分不丢放大态）
- tooltip / 预览面板定位基于恒定 barTop，顺带更稳

## 2. 细节动画

- poof：拖出图标取消固定时，原位播放云雾消散（SVG + scale/opacity 关键帧，450ms）
- 废纸篓 pulse：拖文件入废纸篓、清空废纸篓时图标弹跳脉冲（scale 1→1.25→1）

## 3. 顶栏开关（原「并入 Dock 窗口」方案的替代）

- 原4方案不可行：Electron 点击穿透为整窗粒度，无法「两条交互 + 中段永远穿透」，
  强行合并 = 悬停 Dock 时整屏中段挡住其他应用（正是要避免的相互影响）
- 改为：设置新增「顶部菜单栏」开关（默认开）；关闭销毁 topbarWin，省一个渲染进程
- settings.js DEFAULTS.showTopbar；set-setting 白名单；broadcastSettings 同步；
  设置页加行（hint 注明省内存）

## 4. 打包（electron-builder）

- devDependencies + electron-builder；build 配置：NSIS（oneClick、per-user）
  + win icon；asarUnpack src/native（PowerShell 无法读 asar）
- native.js BRIDGE 路径加 app.asar → app.asar.unpacked 重写
- build/icon.ico 用 System.Drawing 生成（深色圆角方块 + 底栏图形）
- 输出 release/（gitignore）；验证 `--dir` 产物 win-unpacked/Mac Dock.exe 可正常运行
  （bridge 从 unpacked 加载、桥接枚举正常、Dock 上屏）
- 打包后 app.isPackaged=true，登录项走默认路径（需在设置里重新开关一次开机自启）

## 5. 验证

- 单测全绿；上浮放大 / poof / trash pulse 用 CDP 合成事件 + 渲染层截图验收
- 打包产物实跑：进程存在、日志无 bridge 错误、Dock 上屏截图
