# P1 交互补齐 — 工程设计文档

- 日期：2026-09-05
- 状态：已评审通过（设计阶段）
- 上游输入：`docs/dock-parity-gap-2026-09-04.md`（差距调研）、`docs/superpowers/research/2026-09-04-macos-dock-features.md`（原版规格）
- 后续：本文档批准后由 writing-plans 产出实现计划，按 TDD 执行

## 1. 背景与目标

与 macOS 原版 Dock 的全面对比（2026-09-04 调研）识别出 17 项差距，按成本/收益分为工程差距（6 项）、打磨差距（3 项，P2）、技术债（2 项，P3）。本设计只覆盖 **P1：6 项工程差距**，即低成本、高收益、用户可直接感知的交互补齐。

**成功标准**：6 项交互全部落地且有单元测试覆盖；`npm test` 全绿；enum-windows 单轮耗时增量 < 2ms；每项功能独立提交、可单独 revert。

## 2. 范围与非目标

### 2.1 范围

| # | 功能 | 一句话定义 |
|---|------|-----------|
| F1 | 修饰键点击 | Alt/Ctrl+点击触发隐藏当前、隐藏其他、在资源管理器中显示 |
| F2 | 键盘导航 | 全局热键聚焦 Dock，方向键移动，Enter 激活，Esc 归还焦点 |
| F3 | 分隔线拖拽调宽 | 拖动主分隔线实时调整图标尺寸（36–72px） |
| F4 | 清空废纸篓二次确认 | 菜单二次点击确认，3 秒超时还原 |
| F5 | Stack 排序 + Automatic | 每文件夹排序方式与显示模式（含自动） |
| F6 | 无响应应用区分 | hung 应用右键菜单出现「强制退出」 |

### 2.2 非目标（YAGNI 裁剪，本轮明确不做）

- 输入应用名跳转图标（键盘导航止步于方向键 + Enter）
- VoiceOver / 语义级无障碍
- Recent 槽位、废纸篓、文件夹、最小化槽位上的修饰键行为（修饰键只作用于应用槽位）
- 每屏一条 Dock、Windows 虚拟桌面感知（平台鸿沟层，另行立项）
- 拖拽避让弹性动画、指示点跟随、弹跳感知启动（P2）

## 3. 架构原则

沿用现有架构模式：**可测逻辑全部下沉 `src/core/` 纯函数模块，renderer/main 只做薄接线**。本轮新增 4 个 core 模块、2 个 bridge 响应字段、1 个 IPC 通道，不新增文件拆分（P3 处理）。

```
renderer.js (薄接线)
   │  IPC: modifier-action / set-settings(复用) / focus-dock
   ▼
main.js (编排) ──► core/modifier-actions.js  ←─ 纯决策
                ─► core/kbd-nav.js
                ─► core/confirm-arm.js
                ─► core/stack-sort.js
                ─► core/snapshot.js (hung 聚合)
                ─► core/state-hash.js (签名加 h)
   ▼
bridge.ps1: enum-windows +hung 字段；list-dir +mtime/ctime 字段
```

## 4. F1 修饰键点击

### 4.1 决策矩阵（core/modifier-actions.js）

```js
resolveModifierAction({ alt, ctrl, targetRunning, targetFocused }) →
  // 返回值: 'reveal' | 'hide-current' | 'hide-others' | 'activate'
  ctrl && !alt           → 'reveal'        // Ctrl+点击：在资源管理器中显示
  alt && !ctrl
    && targetRunning
    && targetFocused     → 'hide-current'  // 最小化当前应用全部窗口 + 焦点给上一个运行中应用
  alt && ctrl
    && targetRunning     → 'hide-others'   // 聚焦目标应用 + 最小化其他所有应用窗口
  其他（含 alt+未运行）   → 'activate'      // 修饰键忽略，走正常激活
```

规则说明：

- 判定优先级：`reveal` > `hide-current`/`hide-others` > `activate`；`ctrl+alt` 组合下目标未运行时退化为 `activate`
- `hide-current` 仅当目标应用**是当前聚焦应用**才生效；Alt+点击其他运行中应用 = 普通切换（对齐 macOS Option+click）
- UWP 条目（无真实 exe 路径）的 `reveal` 为静默 no-op

### 4.2 「上一个应用」解析

- 数据源：现有 recent LRU（`core/recent.js`）
- 定义：recent 列表中最近一个 `id ≠ 当前应用` 且**仍在运行**的应用
- 无候选时：只最小化当前应用全部窗口，焦点自然回桌面
- 解析函数 `previousRunningApp(recent, runningIds, currentId)` 放入 modifier-actions.js，纯函数可测

### 4.3 渲染层接线（renderer.js）

- 现有 click 处理入口（约 `renderer.js:1204`）在进入激活逻辑前调用决策函数
- 拖拽阈值（6px）判定保持在修饰键判定**之前**，修饰键点击不影响拖拽排序
- 修饰键点击不触发 tooltip 消费、不触发弹跳动画（`launchWithBounce` 仅在 `activate` 路径）
- 仅应用槽位（pinned + 运行中）响应修饰键；其他槽位忽略修饰键按普通点击处理

### 4.4 主进程编排（main.js）

新增 IPC `modifier-action`，payload `{ type, appId, prevAppId? }`：

- `reveal`：复用现有 `reveal` 桥接命令
- `hide-current`：遍历该应用窗口逐个 `minimize`（复用现有命令），随后 `focus` prevAppId
- `hide-others`：先 `focus` 目标，再遍历其他运行中应用窗口逐个 `minimize`
- 最小化失败的窗口（提权进程等）跳过且不重试，单次汇总记一条日志

## 5. F2 键盘导航

现状（commit `3fc24ee`）：已有 Tab 循环 + Enter/Space 激活（`renderer.js:1313-1331`）。本功能在其上扩展，不替换现有行为。

### 5.1 焦点移动（core/kbd-nav.js）

```js
moveFocus(ids, currentIndex, delta) → newIndex
// ids: 槽位 id 数组（含 '__divider__' 等分隔线 id）
// 规则：跳过分隔线槽位；首尾环绕；空列表/无可用槽位返回 -1
homeIndex(ids) / lastIndex(ids) → 首个/末个非分隔线槽位索引
```

### 5.2 热键与焦点

- 全局热键 **Ctrl+Alt+D**（现有 Ctrl+Shift+D/M/P 无冲突；注册失败仅日志降级，不阻塞其他功能）
- 触发后 main → renderer 发 `focus-dock`，renderer 将键盘焦点设到当前聚焦应用的槽位（无聚焦应用则首个）
- ←/→ 移动（环绕）；Home/End 跳首尾；Enter/Space 激活（复用现有激活路径，等效鼠标单击）；Tab 循环保留不变；Esc 归还焦点：main 调用现有 `focus` 恢复到触发前的窗口
- 键盘焦点激活期间图标 1.15x 放大 + 圆角焦点环（CSS 类 `kbd-focus`），与鼠标鱼眼互不干扰：鼠标移动进 Dock 即清除键盘焦点态

## 6. F3 分隔线拖拽调宽

- 仅主分隔线 `__divider__`（固定应用区与最近/废纸篓之间）可拖；`__divider2__`/`__divider3__` 保持静态（对齐 macOS）
- 方向感知：底部 Dock 用垂直位移、左侧/右侧 Dock 用水平位移；朝屏幕外侧拖 = 增大
- 换算：每累计 4px 位移 = 1 级图标尺寸，实时钳制 36–72（与设置滑块同范围），写回走现有 `set-settings` 通道（iconSize 字段），设置面板数值同步更新
- 拖动期间：冻结鱼眼放大（重置到静止态）防止布局抖动；Dock 实时重排（现有布局引擎直接消费 iconSize 变化）
- 悬停主分隔线时光标变为 `ns-resize`（侧栏 `ew-resize`）
- 拖动结束（mouseup）解除鱼眼冻结

## 7. F4 清空废纸篓二次确认

### 7.1 状态机（core/confirm-arm.js）

```js
// state: { phase: 'idle' | 'armed', armedAt: number | null }
nextState(state, action, now) → state'
// action: 'request' | 'confirm' | 'cancel'
// idle  + request        → armed(armedAt=now)
// armed + confirm        → idle（返回 'execute' 信号，由调用方比较 now-armedAt ≤ 3000 判定有效性）
// armed + (now-armedAt > 3000 的任何读操作) → idle
// 任意 + cancel（菜单关闭/点击别处）→ idle
```

确认有效性判定独立为纯函数 `isConfirmValid(state, now)`（≤3000ms），便于测试时间边界。

### 7.2 渲染层接线

- 右键废纸篓菜单「清空回收站」：首点 → 条目文案变红色「确认清空」并 armed；3 秒内再点 → 执行 `empty-trash`（复用现有 IPC）并回 idle；超时或菜单关闭 → 回 idle 还原文案
- 回收站计数为 0 时：不进确认流程，点击无操作（菜单项置灰显示）
- 计时用 renderer 的 setTimeout 驱动状态查询，状态本身由 core 状态机持有（不依赖定时器测试）

## 8. F5 Stack 排序 + Automatic

### 8.1 纯函数（core/stack-sort.js）

```js
sortStackItems(items, sortBy) → items'
// sortBy: 'name' | 'added' | 'created' | 'kind'
// name/added/created: 按 Intl.Collator('zh-Hans-CN') / mtime / ctime 升序
// kind: 文件夹优先 → 按扩展名字母序 → 同类内按名称

stackViewMode(count, configured) → 'fan' | 'grid' | 'list'
// configured 显式指定时直接返回；configured='auto' 时 count ≤ 5 → 'fan'，> 5 → 'grid'
```

### 8.2 数据与设置

- bridge `list-dir` 响应每项新增 `mtime`（添加时间）、`ctime`（创建时间），Unix 毫秒
- 每文件夹设置存于现有 pins 条目：`{ sortBy: 'name', view: 'auto' }` 为默认值，缺省字段按默认处理（兼容旧数据，无迁移脚本）
- 右键文件夹菜单（现有「显示为」处）：「显示为」子菜单增加「自动」选项；新增「排序方式」子菜单（名称 / 添加日期 / 创建日期 / 种类）
- 修改即写回 settings 并即时刷新已打开的 Stack 面板

## 9. F6 无响应应用检测

### 9.1 桥接层（bridge.ps1）

- `enum-windows` 每窗口输出新增 `hung` 布尔：P/Invoke `IsHungAppWindow(hwnd)`
- 仅对可见应用主窗口调用（工具窗口、不可见窗口跳过），控制调用量
- `IsHungAppWindow` 为纯内部状态查询（不发消息），对阻塞式桥接主循环安全；验收时实测单轮枚举耗时增量 < 2ms

### 9.2 聚合与签名

- `core/snapshot.js`：`entry.hung = windows.some(w => w.hung)`
- `core/state-hash.js`：entries 签名字段加入 `h`（hung 变化触发推送，菜单实时刷新）

### 9.3 渲染层

- `entry.hung === true` 时，右键菜单「退出」替换为红色「强制退出」
- 动作走现有 quit-app IPC，新增 `{ force: true }` 标志：main 跳过 taskkill 优雅等待，直接 `Stop-Process -Force`（复用现有强杀路径代码）
- 只标记、只提供手动强杀入口，**绝不自动强杀**（慢启动应用防误伤）
- 指示点外观本轮不变（hung 状态仅体现在菜单）

## 10. 测试策略（TDD）

严格红-绿循环：每个 core 模块先写失败测试再实现。renderer 薄接线不写自动化测试，配手工验收清单。

| 测试文件 | 核心用例 |
|---|---|
| test/modifier-actions.test.js | 决策矩阵全组合（alt/ctrl × 运行/聚焦/未运行，~10 例）；previousRunningApp 的 LRU 顺序、排除自身、排除未运行、无候选 |
| test/kbd-nav.test.js | 环绕移动、跳过分隔线、Home/End、空列表返回 -1 |
| test/confirm-arm.test.js | idle→armed→execute；3s 边界（2999ms 有效 / 3001ms 失效）；cancel 任意态回 idle |
| test/stack-sort.test.js | 4 种排序正确性；中文 collation（「应用」vs「备忘录」）；auto 阈值（5→fan / 6→grid）；显式配置优先 |
| test/bridge.test.js | enum-windows 响应含 hung 字段；list-dir 响应含 mtime/ctime |
| test/snapshot.test.js | hung 窗口聚合到应用级；无 hung 窗口时 false |
| test/state-hash.test.js | hung 变化改变签名；hung 不变不重复推送 |

手工验收清单（实现计划中展开）：修饰键 4 动作实机验证、拖拽与修饰键互不干扰、左/右 Dock 拖宽方向、Esc 归还焦点、hung 应用菜单实机复现（用挂起的进程模拟）。

## 11. 错误处理与边界汇总

| 场景 | 处理 |
|---|---|
| 最小化提权/拒绝窗口 | 跳过不重试，日志汇总 |
| Ctrl+Alt+D 注册失败 | 日志降级，功能不可用但不崩溃 |
| 拖宽时鱼眼抖动 | 拖动期间冻结放大 |
| hung 误报（应用忙） | 仅影响菜单文案，用户手动决策 |
| 旧 pins 数据无 sortBy/view | 缺省即默认值，无迁移 |
| 分隔线拖到极值 | 钳制 36/72，不越界 |
| Alt+点击未运行应用 | 退化为普通启动 |

## 12. 实现顺序与提交粒度

每项功能一个独立提交（含测试），顺序按风险/价值：

1. F4 清空确认（最小 + 数据安全优先）
2. F6 无响应检测（安全相关）
3. F1 修饰键
4. F2 键盘导航
5. F3 分隔线拖宽
6. F5 Stack 排序

预估 2–3 天。任一提交可独立 revert。

## 13. 验收标准

- [ ] 6 项功能全部可用，行为符合本文档第 4–9 节
- [ ] `npm test` 全绿，测试改动覆盖 7 个文件（4 个新增测试文件 + 3 个现有测试文件扩展）
- [ ] enum-windows 单轮耗时增量实测 < 2ms
- [ ] 全部现有 36 个测试不回归
- [ ] 设置面板与拖拽调宽的 iconSize 双向同步
