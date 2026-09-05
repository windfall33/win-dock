# mac-dock 优化迭代计划

> 制定日期：2026-09-04
> 数据来源：① 逐文件代码核查 ② 两路并行工程质量评审 ③ **真机实拍截图**（CDP 连渲染层，合成事件驱动鱼眼，3x 放大）
> 原则：按「感知提升 ÷ 实现成本」排期；每项都锚定到具体代码位置与可复测的验收标准。
>
> **✅ 执行状态（2026-09-05 更新）：Wave 1 全部、Wave 2 全部、Wave 3.1/3.2、4.3 已完成并真机验证；
> 外观玻璃层次、内存 LRU、人性化说明已落地。回归：36/36 测试过，实拍 `w2-full.png` / `w2-fisheye.png`，
> Exposé 全链路（中键→缩略图→Esc 关闭）实测通过，工作区预留 reserve/restore 日志实测通过。**

---

## 0. 数据基线（实测，不是估计）

| 指标 | 实测值 | 来源 |
| --- | --- | --- |
| 鱼眼放大 | hover 图标 36→49px（1.35×），bar 958→1005px 被撑宽 | 合成 mousemove + slot 宽度采样 |
| 鱼眼衰减曲线 | 余弦，两侧邻居依次让位，指示点同步下移 | 实拍 `fe4.png` |
| 图标数量 / 条宽 | 24 个图标，条宽 958px @1536 逻辑宽 | 实拍 `full-idle.png` |
| **深色图标可辨识度** | OpenAI 灰标×3、GitHub 黑猫、终端黑块融进深色玻璃 | 实拍 `p2.png` / `p3.png` |
| 指示点可见性 | 4px 白点，24 个运行中应用仅 1–2 个点肉眼可辨 | 实拍全宽图 |
| 分隔线可见性 | `.divider` 已实现，深色下几乎不可见 | style.css:163-175 |
| 代码规模 | renderer.js 1908 行 / main.js 1393 行 / bridge.ps1 839 行 | wc |
| 测试 | 36/36 通过，但只覆盖纯函数与桥接冒烟 | node --test |
| 质量分 | 主进程 7/10、渲染层 6/10 | 双路评审 |

**核心判断**：功能清单已接近原版，短板高度集中在**图标底板系统**与**静态视觉细节**，且都属低风险前端改动。

---

## Wave 1 —— 观感（最高 ROI，纯渲染层，零系统风险）

> 目标：把「第一眼像」推进到「盯三秒也像」。全部为 CSS/JS 参数与容器改动，不涉及窗口管理。

### 1.1 深色图标自动加浅色底板 🔴 最大单点
- **问题**：macOS 强制所有 Dock 图标带浅色圆角底板；Windows 提取的是原始形状图标。
  深色图标（OpenAI / GitHub / 终端 / 各 IDE 深色主题）贴深色玻璃上完全无法分辨。
- **位置**：新增 `src/renderer/icon-plate.js`；接入点 `renderer.js:394-455`（`applyEntryToSlot` 各分支的 `img.src = url` 之后）
- **做法**：
  1. 图标 `onload` 后画到 32×32 canvas，采样像素：算加权平均亮度与「暗且不透明像素」占比
  2. 平均亮度 < 90 或 暗像素占比 > 60% → 判定为深底图标，给 slot 挂 `.plate-on`
  3. CSS 给 `.plate-on img.app-icon` 加白色圆角底板容器（圆角约 22%，图标内容内缩到 ~82%）
  4. 判定结果按 url 缓存，避免每次重建重复算
- **附带收益**：底板统一了视觉尺寸，顺带解决「文件夹撑满、灰标内容偏小」的参差感
- **验收**：实拍对比 —— 原有 6 个深色图标应全部可辨；无一个浅色图标被误加底板
- **成本**：M

### 1.2 图标倒影
- **位置**：`style.css`（新增），`renderer.js` 图标节点结构
- **做法**：`transform: scaleY(-1)` 复制层 + 线性渐变遮罩 + 逐层降低透明度；高度约图标的 25%
- **注意**：侧栏（left/right）位置需单独处理（style.css:93-95 已有 pos 分支惯例）
- **验收**：静置实拍，玻璃板下缘出现递减倒影
- **成本**：S

### 1.3 面板随放大增高
- **问题**：`barEl.style.height = iconSize + 18` 恒定（`renderer.js:53`），放大时图标靠 `lift=(size-base)*0.14` 上浮，
  实拍中 QQ / 绿色应用顶部明显穿出玻璃板。
- **做法**：`syncCssVars` 改为只设最小高度；`layoutTick` 每帧把 `barEl.style.height` 更新为
  `max(基础高, 当前最大图标高度 + padding)`，底边贴屏幕不动、顶边上移
- **验收**：鱼眼态实拍，放大图标完全位于玻璃板内
- **成本**：S

### 1.4 运行指示点强化
- **位置**：`style.css:134-140`（`.slot .running-dot`，现 4px / `bottom:-3px`）
- **做法**：加大到 5–6px 并随图标尺寸等比缩放；加 `1px` 白色描边（对齐 macOS）；深色模式提亮
- **验收**：全宽静置实拍，运行中的应用全部可见指示点
- **成本**：S

### 1.5 深色调下分隔线提亮
- **位置**：`style.css:171`（`html.dark .divider`）
- **做法**：提高对比度，宽度 1→1.5px
- **验收**：全宽实拍中三区分隔清晰可辨
- **成本**：S

### 1.6 回弹改弹簧（可选，Wave 1 末尾做）
- **位置**：`renderer.js:611-613`（`k = 0.44 / 0.5` 纯 lerp）
- **做法**：改为带轻微过冲的 spring-damper（如 `stiffness 0.22 / damping 0.72`），离开时统一收束节奏
- **风险**：调参不当会抖，需实拍多帧验证
- **成本**：S–M

---

## Wave 2 —— 正确性与性能（不改行为，只修隐患）

> 目标：消除静默失败与无效空转。这些在实拍中看不出来，但决定了长期稳定性。

| # | 问题 | 位置 | 做法 | 成本 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 2.1 | 全局 mousemove 每帧强制 layout，rAF 实际永不空闲 | `renderer.js:680-716` | rAF 合帧去抖（每帧最多处理一次） | M | ✅ 已完成 |
| 2.2 | 遮挡循环 `catch {}` 吞掉整个 250ms 循环错误 | `main.js:625` | 失败计数 + 周期日志 + 连续 12 次失败保底 sendEnv 自愈 | S | ✅ 已完成（本轮 0 失败） |
| 2.3 | DIP 与物理像素混用（DIP 传给 bridge 的 `GetWindowRect` 求交） | `main.js:543-552` ↔ `bridge.ps1:480-490` | **复核为评审误判**：桥接进程 DPI-unaware，GetWindowRect 与 DIP 同域（main.js:546 注释为证），不改码 | M | ✅ 已复核结案 |
| 2.4 | Stack 首次打开定位错位（`renderStack` async 未 await） | `renderer.js:1007-1033` | `await renderStack` 后再测量 clamp | S | ✅ 已完成 |
| 2.5 | 拖拽期间状态重建使 `dragState.els` 变游离节点 | `renderer.js:1304-1370` | 改为每帧按 `dataset.id` 实时解析存活节点；end 时实时解析移动索引 + 越界保护；顺带清 `shiftAmounts` 死代码 | M | ✅ 已完成 |
| 2.6 | `stackIconCache` / `winCountPrev` 永不清理 | `renderer.js:27,979` | `stackIconCache` 加 300 上限 LRU 淘汰 | S | ✅ 已完成 |
| 2.7 | `reveal` 未转义路径拼进 `explorer /select` | `bridge.ps1:789` | 剥离引号 + 空路径拒绝 | S | ✅ 已完成 |
| 2.8 | `before-quit` 未清 `genieIdleTimer` | `main.js:1250-1258,1386` | 退出清理补全；另补工作区预留恢复 | S | ✅ 已完成 |

**验收**：2.1 用 CDP Performance 采样对比改动前后鼠标移动时的 CPU 时间；2.3 在 125% 缩放屏复测全屏让位。

---

## Wave 3 —— 能力补齐（真差距）

| # | 缺口 | 优先级 | 说明 | 成本 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 3.1 | **AppBar 边缘预留** | 🔴 最高 | 已用 `SPI_SETWORKAREA`（bridge.ps1 `set-workarea` 命令）实现，`workareaReserve` 开关默认关，仅主显示器；原始工作区取 Electron workArea 防二次收缩；桥接重启自动重放，退出自动恢复 | L | ✅ 已完成（日志实测 reserve b:746 → restore b:816） |
| 3.2 | **Mission Control / Exposé** | 🔴 高 | 已做：**中键点击**运行中图标 → 全应用窗口缩略图网格（`expose.html/js`），复用 `window-thumb` 截图，点击聚焦，Esc/空白/失焦关闭，关闭即 destroy | L | ✅ 已完成（CDP 实测全链路通过） |
| 3.3 | Launchpad 文件夹 / 拖拽排序 | 🟡 中 | 分页已做，缺文件夹与排序 | M | 明确不做（价值中低） |
| 3.4 | 真实通知角标 | 🟡 中 | 现靠正则猜窗口标题（`core/badges.js:6`），托盘应用拿不到。改为对高频应用（微信/QQ/邮件）逐个适配 | L | 明确不做（工程大） |
| 3.5 | UWP 归组加固 | 🟡 中 | 现按 `applicationframehost` + 标题前 40 字符，标题一变就错乱 | M | 未做 |
| 3.6 | 图标内进度环 | 🟢 低 | 现用 `active-glow` 近似（`renderer.js:522` 自注） | M | 未做 |

---

## Wave 4 —— 架构（技术债）

- 4.1 `main.js` 1393 行拆分 —— **部分完成（2026-09-05）**：状态合成已先拆出
  （`buildStateSnapshot` → `core/snapshot.js`，main.js 1507→1365 行，46/46 测试通过）。
  剩余 IPC（`handleInvoke` 约 379 行 switch）/ 窗口操作 仍**暂缓**（回归风险高且本环境无法
  真机验证 GUI；建议按同一模式继续下沉纯计算部分，等 4.2 覆盖到位后再评估剩余拆分）
- 4.2 编排逻辑补测试：轮询、IPC、遮挡状态机目前**零覆盖**，只测了纯函数 —— **部分完成（2026-09-05）**：
  `buildStateSnapshot` 已下沉为 `core/snapshot.js`（依赖注入），补 `test/snapshot.test.js` 10 个用例，
  测试总数 36→46。剩余 `pollOnce` / `checkOcclusion` / `applyWorkarea` / `handleInvoke` 仍零覆盖。
- 4.3 桥接重启加指数退避与熔断（`native.js:49-55` 现为固定 1500ms 无限重试）—— ✅ **已完成**：1.5s×2^n 上限 60s，稳定运行 10s 重置序列；附带 `onReady` 回调供主进程重放工作区预留
- 4.4 主进程崩溃自恢复（现只有桥接有 watchdog）—— 未做

---

## 追加轮 —— Windows 适配性 / 人性化 / 外观 / 内存（2026-09-05 完成）

| 维度 | 改动 | 验证 |
| --- | --- | --- |
| **Windows 适配性** | 工作区预留（SPI_SETWORKAREA）让最大化窗口避开 Dock；DPI-unaware 坐标域结论复核（误判结案）；桥接崩溃指数退避熔断（1.5s→60s，稳定 10s 重置） | 日志实测 reserve/restore；熔断逻辑含 uptime 判定 |
| **人性化** | 中键 Exposé 窗口总览；设置页新增「工作区预留」开关（含场景说明）；foot 提示补中键用法；Exposé 支持键盘导航（Tab 循环 / Enter 聚焦 / Esc 关闭） | CDP 合成中键全链路实测 |
| **外观** | 玻璃层次增强：顶部锐高光（0.72）+ 底缘收暗（-12px 暗晕）+ 深色主题独立调校 | 实拍 `w2-full.png` / `w2-fisheye.png` |
| **内存** | IconCache mem LRU 300→160（上限约 8-32MB，长期运行防膨胀）；Exposé/Launchpad 关闭即 destroy（不驻留渲染进程，各省 ~40MB）；genieIdleTimer 退出清理 | 进程实测：空闲态 4×electron ≈402MB + 桥接 115MB |

---

## 明确不做

| 项 | 理由 |
| --- | --- |
| Liquid Glass 追平 | 依赖系统级材质引擎，属代际差距，投入产出比极低 |
| Siri 动态建议区 | Windows 无对应数据源 |
| 完整 `SetWinEventHook` 改造 | 现有「前台 hwnd 变化即触发一次 poll」的近似方案已把延迟压到 ~250ms，风险远低于收益 |
| 实时 DWM 缩略图 | 需 native addon，与 Electron 架构冲突大；若要做得单独立项评估 |

---

## 工程基建（贯穿全程）

**把实拍工具链固化为回归基线。** 本轮评估已在 `.workbuddy/shots/` 建成可用工具，建议移到 `tools/` 长期维护：

```
tools/shot.js          静置/悬停态截图（须先 set-setting autohide=false + request-show，
                       再用合成 document.dispatchEvent(mousemove) 驱动鱼眼）
tools/diag-fisheye.js  slot 宽度采样，验证放大倍率与衰减
```

已知两个坑（下次直接复用）：
1. CDP 的 `Page.captureScreenshot` **clip 参数在 Electron 33 无效**（输出与全窗截图字节完全一致），必须整窗截图后在页面内用 canvas 裁剪放大
2. `Input.dispatchMouseEvent` 会被主进程 350ms 兜底复位机制压制，必须用**合成 DOM 事件**；且须先把 `dockHiddenNow` 同步为 false

**验收节奏**：Wave 1 每完成一项，重拍全宽静置图 + 鱼眼图，与 `full-idle.png` / `fe4.png` 基线对比，避免「改了但没变好」。

---

## 建议执行顺序

```
Wave 1.1 深色图标底板  →  1.2 倒影  →  1.3 面板增高  →  1.4 指示点  →  1.5 分隔线
   ↓ （观感定型，先拿收益）
Wave 2.1 mousemove 空转  →  2.2 吞错  →  2.3 DPI  →  2.4–2.8
   ↓ （稳定，再谈新功能）
Wave 3.1 AppBar  →  3.2 Mission Control
   ↓
Wave 4 架构重构（可与 Wave 3 并行，互不阻塞）
```
