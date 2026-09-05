# docky 如何“隐藏系统任务栏/Dock”

> 调研对象：<https://github.com/josejuanqm/docky>
> 检视版本：`5fc1973573702ca306546ba069ddb181230ffc31`（2026-08-28，`feat(dock): add toggle to dim idle app icons when hidden or windowless (#72)`）
> 调研日期：2026-09-05

## 关键结论（先说最容易被误解的一点）

**docky 是一个纯 macOS 应用（Swift + AppKit + Xcode 工程），它在 Windows 上无法运行，因此它根本没有、也不可能有“隐藏 Windows 任务栏”的能力。**

仓库中所有出现 `taskbar` / `windows` 字样的地方，全部与“外观主题”相关——即把它自己的 Dock **做成 Windows 任务栏的样子**（`BundledThemes/windows/theme.json`、`Theme.swift` 中的 `continuous taskbar` 圆角选项等），与任务栏显隐无关。

它真正会“隐藏”的系统对象是 **macOS 的 Dock**（macOS 中等价于任务栏的常驻停靠栏）。机制请见下文。

## 仓库性质

- 平台：macOS（`Docky.xcodeproj`、`.xib`、`MainMenu.xib`、`MediaRemoteAdapter.framework` 等只有 macOS 才有）。
- 工程目录：`Docky/`（主程序）、`DockyDockWatchdog/`（辅助看门狗 App）、`Frameworks/MediaRemoteAdapter.framework`。
- 语言：Swift，依赖 AppKit / SkyLight(CGS 私有 API) / ScreenCaptureKit / 辅助功能(Accessibility)。

## “隐藏系统 Dock”的核心机制

核心实现在 `Docky/Services/SystemDockVisibilityService.swift`，入口偏好是 `DockyPreferences.hidesSystemDock`。

整体不是“把窗口藏掉”，而是**改写 macOS Dock 的偏好并重启 Dock 进程，让它进入“自动隐藏且点击立即消失”的状态**，从而腾出屏幕空间给 docky 自己的 Dock。拆解如下：

### 1. 用户偏好快照（先存档，确保可回滚）

- `managedKeys`（该文件第 26 行）：管理的键为 `orientation`、`autohide`、`autohide-delay`、`autohide-time-modifier`、`no-bouncing`、`launchanim`。
- `captureSnapshot()`（第 105 行）：逐键读取 `com.apple.dock` 域当前值（读不到的记 `__docky_null__` 标记），存进 `UserDefaults` 的 `docky.systemDockVisibilitySnapshot` 键。

### 2. 写入“隐藏”偏好

- `hiddenValues`（第 35 行）：
  - `autohide = true`（开启自动隐藏）
  - `autohide-delay = 1000.0`（鼠标移开 1 秒后才藏起）
  - `autohide-time-modifier = 0.0`（藏起动画时长为 0，等于瞬时）
  - `no-bouncing = true`、`launchanim = false`（关闭弹跳/启动动画）
- `applyHiddenValues()`（第 119 行）：用 `CFPreferencesSetAppValue` 写回 `com.apple.dock` 域并 `CFPreferencesAppSynchronize`。

### 3. 重启 Dock 让设置生效

- `restartDock()`（第 140 行）：通过 `NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").forEach { $0.forceTerminate() }` 强制结束 Dock 进程，启动系统会依新偏好重建 Dock。

### 4. 可靠性兜底：状态文件 + 独立看门狗 App

- `writeActiveState(snapshot:)`（第 154 行）：把 `active / ownerPID / sessionID / snapshot` 写进 `~/Library/Application Support/Docky/SystemDockVisibilityState.plist`。
- `startWatchdogIfNeeded()`（第 217 行）：从 Docky.app 的 `Contents/Library/LoginItems/` 启动附带的 `DockyDockWatchdog.app`，把状态文件路径、Docky 的 PID、sessionID、bundleIdentifier 作为启动参数传入。
- 看门狗 `DockyDockWatchdog/main.swift`（第 34 行）：循环轮询——只要 `stateMatches()` 且 Docky 进程还活着就继续等；一旦 Docky 退出（崩溃/被杀），就 `restoreSnapshot()`（第 78 行）回滚偏好、清掉快照、`killall Dock` 重启 Dock，并删除状态文件。这样即使主程序崩了，用户的 Dock 也不会一直被藏住。

### 5. 恢复正常状态的路径

- `restore()`（第 87 行）→ `restore(using:)`：把快照逐个写回（含 `__docky_null__` 标记则删除该键），清掉快照，再重启 Dock 并清 active 状态。
- 触发点：
  - 用户关闭 `hidesSystemDock` 时（`DockyPreferences.swift` 第 4084 行 `applySystemDockVisibilityPreference()`）。
  - docky 退出时（`AppDelegate.swift` 第 314 行检查 `hasSnapshot` 然后 `restore()`）。
  - 启动时若发现“上次没恢复干净”的残留快照（`AppDelegate.swift` 第 35 行 `recoverStaleSnapshotIfNeeded()`）。

### 6. Dock 方向联动

- `setOrientation(_:)`（第 81 行）：把 docky 的屏幕位置（`windowPosition`：left/right/bottom）同步写进 `com.apple.dock` 的 `orientation`，并重启 Dock，确保隐藏后系统 Dock 仍在对应方向占位、与 docky 自身 Dock 位置一致。

## 用户开关与设置层

- `DockyPreferences.hidesSystemDock`（第 1883 行，默认 `true`）：`didSet` 里调用 `applySystemDockVisibilityPreference()`。
- `DockyPreferences.autohidesWindow`（第 1702 行）：是**另一个概念**——指 docky 自己的主窗口“贴边自动隐藏”，与系统 Dock 无关，不要混淆。

## 实验性方案（未接入运行时）

`Docky/Private/SkyLightSpaceReservationProbe.swift` 是一个 `#if DEBUG` 的探针：

- 思路：让系统 Dock 继续占位（保留 `NSScreen.visibleFrame` 的预留带），但用 SkyLight/CGS 私有 API `CGSSetWindowAlpha(..., 0.0)` 把 Dock 的所有窗口 alpha 置 0，做到“占位但不显示像素”。
- 文件头明确写着“Not wired into Docky's runtime”，仅供 lldb / 手动调试采集数据，不属于正式机制。

## 对 mac-dock（Electron + Windows）的启示

- docky 的做法**无法照搬**到 Windows：它改写的是 macOS 私有偏好域 `com.apple.dock`，并依赖 AppKit/SkyLight/`killall Dock` 等 macOS 专属设施。
- Windows 上没有“偏好+重启进程”体系，隐藏任务栏通常走 Win32：`FindWindow("Shell_TrayWnd")` + `ShowWindow(..., SW_HIDE)`，或者用 `SHAppBarMessage(ABM_SETSTATE, ABS_AUTOHIDE)` 让它自动隐藏，或 `SetWindowLong` + `SetWindowPos` 把它移出屏幕/置底。若要在 Electron 里做，一般通过原生模块（`ffi`/`node-ffi-napi`、`koffi` 或一段 C++/Rust/native addon 调用 user32.dll）实现。
- docky 真正值得参考的是它的**工程化兜底**：快照原偏好、写状态文件、崩溃后由独立看门狗回滚。这套“改了系统状态就一定要保证能恢复”的防御式设计，对任何会动用户系统设置的桌面应用都有借鉴意义。

## 来源

- 源码（上述文件均来自检视版本 `5fc1973`，本地克隆 `https://github.com/josejuanqm/docky`）。
- 无外部二手资料；所有结论均直接读源码得出。
