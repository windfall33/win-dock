# P3 技术债清理 — 工程设计文档

- 日期：2026-09-05
- 状态：已评审通过（设计阶段）
- 上游输入：`docs/quality-review-2026-09-05.md`（质量评审）、P1/P2 设计文档
- 后续：本文档批准后由 writing-plans 产出实现计划执行

## 1. 背景与目标

三大巨型文件（main.js 1357 行 / renderer.js 1966 行 / bridge.ps1 1200 行）占 src 总量 65%，继续加功能前必须拆分；桥接阻塞式单线程处理是唯一可能造成用户可感知卡顿的架构点（慢命令阻塞 250ms 热路径请求）。

**黄金法则：拆分 = 行为零变化。** 不改任何用户可见行为，不顺手重构逻辑，只做平移 + 接线；疑似 bug 的行为原样保留并记录（不修）。

**成功标准**：三个主文件 ≤400 行；全部测试绿；手工冒烟零行为差异；dock-occluded 在慢命令执行期间不超时。

## 2. 范围与非目标

### 2.1 范围

| # | 功能 | 一句话定义 |
|---|------|-----------|
| F1 | 三大文件拆分 | main.js / renderer.js / bridge.ps1 平移拆为 ≤400 行的模块 |
| F2 | 桥接双通道 | 热命令/慢命令分走两个桥接进程，消除头阻塞 |
| F3 | 特征测试回填 | NativeBridge/IconCache/settings 行为固定，拆分安全网 |

### 2.2 非目标

- renderer 框架化（保持无框架纯 DOM，只拆 ES modules）
- core/ 纯函数层重构（已健康，不动）
- 任何行为改动（含已识别的疑似问题：execFile 静默吞错、IsFullScreen DPI 疑似误判等——记录在案，本轮不修）
- main.js 集成测试（E2E 层，另行立项）

## 3. F3 特征测试回填（第一步：安全网先行）

特征测试 = 对**现有行为**写通过的测试（行为固定，非 TDD 红绿），拆分全程必须保持绿。

| 测试文件 | 固定的行为 |
|---|---|
| test/native-bridge.test.js | 用 fake child_process（EventEmitter 桩）测：请求-响应 id 配对、超时 reject（`bridge-timeout:<cmd>`）、exit 后指数退避重启序列（1.5s→3s→…→60s 封顶）、崩溃时 failAll 清挂起请求、dispose 先 stdin.end 后 kill |
| test/icon-cache.test.js | LRU 160 上限逐出、失败路径标记不重复请求、磁盘 PNG 写入（临时目录） |
| test/settings.test.js | 默认值合并、读写往返、损坏 JSON 回退默认 |

这三个模块恰是 F1/F2 要动的核心，先固定行为再动刀。

## 4. F1c bridge.ps1 拆分（最机械，先做）

### 4.1 目标结构

`src/native/bridge.ps1` 只留主循环 + dispatch + 编码设置（~150 行），逻辑 dot-source 平移到兄弟文件（主文件用 `$PSScriptRoot` 解析路径）：

```
src/native/bridge.ps1          主循环 + dispatch（~150 行）
src/native/bridge/types.ps1    Add-Type C# 类型定义（P/Invoke、图标、窗口枚举）
src/native/bridge/windows.ps1  窗口枚举/前台/焦点/最小化/截图/hung/IsFullScreen
src/native/bridge/shell.ps1    图标提取链/快捷方式解析/开始菜单扫描/UWP 稳定键
src/native/bridge/fs.ps1       list-dir/recycle/move-files/empty-trash/trash-count
src/native/bridge/taskbar.ps1  任务栏注册表/taskbar-state/taskbar-autohide/set-workarea
```

### 4.2 兼容性说明（已核实）

- PowerShell 5.1 dot-source 共享调用作用域：脚本级变量/函数平移后全局可见，行为不变
- native.js 启动命令不变（仍 `powershell -File bridge.ps1`），无需改路径逻辑
- `asarUnpack: ["src/native/**"]` 已覆盖 bridge/ 子目录，打包路径无需调整
- 拆分纯平移：函数体一行不改，只挪位置

### 4.3 验证

`npm test`（bridge.test.js 的 14 个命令级测试全程是回归门）；`node --check` 不适用 PS，用 `powershell -File bridge.ps1` 冒烟（ping 命令往返）。

## 5. F1a main.js 拆分

main.js 瘦身为装配入口（app ready / 模块装配 / before-quit，~150 行）：

```
src/main.js                    入口：生命周期 + 装配（~150 行）
src/windows/dock-window.js     dock 窗口创建/applyBounds/层级重申/点击穿透/多屏跟随
src/windows/panel-windows.js   settings/launchpad/expose/genie/topbar 窗口管理
src/ipc-routes.js              handleInvoke 全部 case 路由
src/poll-loop.js               pollOnce/checkOcclusion/状态推送/自愈逻辑
```

- 共享状态（settings、bridge 实例、窗口引用）经构造参数注入——与 core/ 现有依赖注入风格一致
- 不引全局单例库；跨模块事件用现有 EventEmitter 或回调注入
- 拆分纯平移：函数体不改，只挪位置 + 显式传参

## 6. F1b renderer.js 拆分

### 6.1 目标结构

index.html 的 `<script>` 改 `type="module"`（CSP `script-src 'self'` 已允许 module，已核实 `index.html:5`）：

```
src/renderer/dock.js           入口装配（事件绑定、启动）
src/renderer/state.js          STATE/onState/reconcile/slotMap
src/renderer/layout.js         鱼眼/弹簧/条高/分隔线/指示点（P2 spring 接线在此）
src/renderer/menus.js          右键菜单/tooltip/预览面板
src/renderer/dnd.js            内部拖拽/文件投放/Stack/spring-loaded
src/renderer/keyboard.js       键盘导航（P1 F2 成果归位）
src/renderer/icon-plate.js     图标底板（已有独立文件，并入模块体系）
```

### 6.2 拆分规则

- 依赖单向无环：menus/dnd/keyboard → layout → state → dock；跨文件引用全部显式 import/export
- 模块顶层作用域隔离是主要风险：原文件靠隐式共享的顶层变量必须逐一显式导出，漏一个即 ReferenceError——靠手工冒烟 + 逐模块迁移（每迁一个模块跑一次冒烟）
- launchpad/expose/settings/genie 各自已是独立文件，不动

## 7. F2 桥接双通道

### 7.1 路由模块（TDD 核心）

**新模块 `src/core/bridge-lanes.js`**：

```js
laneFor(cmd) → 'hot' | 'slow'
// 静态命令表；未收录的新命令默认 'slow'（安全默认：宁可慢通道排队，不阻塞热通道）
```

### 7.2 通道划分

| 通道 | 命令 | 判据 |
|---|---|---|
| **hot** | ping, enum-windows, foreground, dock-occluded, trash-count, focus, minimize, close-window, window-rect, window-pid, processes-running, taskbar-state | 定时器驱动（250ms/1.4s 周期），延迟直接影响自动隐藏/让位状态机 |
| **slow** | icon, window-thumb, window-shot, list-start-menu, list-dir, resolve-shortcut, open, reveal, empty-trash, recycle, move-files, taskbar-autohide, set-workarea | 延迟容忍（预览面板等场景，单次执行可达秒级且本身开销大） |

### 7.3 装配与守护

- main 持两个 NativeBridge 实例（都跑同一 bridge.ps1，无需参数区分），`request()` 经 `laneFor` 路由
- 两桥各自独立指数退避重启、`onReady` 重放；孤儿清扫覆盖两个子进程（进程名相同，按父 PID 判定逻辑不变，天然覆盖）
- `before-quit` 两个实例都 dispose；`DOCK_PARENT_PID` 机制不变
- native.js 的 NativeBridge 类**零改动**（每实例自洽）

### 7.4 代价与收益

- 代价：+1 个 PowerShell 进程（空闲预计 +30~60MB，实测后更新 README 性能段落）
- 收益：250ms 热路径（dock-occluded/遮挡检测/自动隐藏状态机）彻底免疫秒级慢命令（Launchpad 扫描、图标提取、清空回收站）

## 8. 实现顺序与提交粒度

每步独立提交，`npm test` 全绿 + 手工冒烟后进下一步：

1. F3 特征测试（安全网）
2. F1c bridge.ps1 拆分（纯平移）
3. F1a main.js 拆分（纯平移）
4. F1b renderer.js 拆分（逐模块迁移，每模块冒烟）
5. F2 双通道（装配处已在 F1a 集中于 poll-loop/dock-window，此处只加实例与路由）

预估 2–3 天。

## 9. 边界与风险

| 场景 | 处理 |
|---|---|
| renderer 模块化漏导出顶层变量 | 逐模块迁移 + 每步冒烟；Electron 渲染层报错即显式 ReferenceError，易定位 |
| dot-source 作用域意外 | PS 变量作用域平移后一致；bridge.test.js 14 命令全跑作回归门 |
| 双桥同时写注册表（taskbar-autohide） | 该命令归 slow 单通道，无并发写 |
| 热通道命令被误归 slow | laneFor 表有单测逐命令断言；未知命令默认 slow 只影响新命令 |
| 内存超预期 | 实测记录进 README；若 >100MB 则评估热通道命令瘦身（预案，不默认做） |

## 10. 验收标准

- [ ] main.js / renderer.js / bridge.ps1 主文件 ≤400 行，拆出模块各自 ≤400 行
- [ ] `npm test` 全绿，新增：3 个特征测试文件 + bridge-lanes 测试
- [ ] 行为零变化：手工冒烟清单（启动/拖拽/最小化/genie/Launchpad/Exposé/设置/多屏/任务栏隐藏）全过
- [ ] 双通道专项：打开 Launchpad（list-start-menu 执行中）期间 dock-occluded 无超时日志
- [ ] 空闲内存增量实测并更新 README 性能段落
