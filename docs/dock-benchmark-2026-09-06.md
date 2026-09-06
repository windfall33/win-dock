# macOS 原版 Dock 全面调研 × Win Dock 逐项对标（2026-09-06）

> 方法论：
> 1. **调研**：Apple 一手来源（System Settings 帮助页 mchlp1119 / Use the Dock mh35859 /
>    MDM `com.apple.dock` payload / Apple 快捷键页 / NSDockTile / Apple Newsroom Tahoe 26）
>    + macos-defaults.com + defaults-write.com + Intego + TidBITS 等社区公认来源；
> 2. **对标**：**亲自逐文件精读当前 HEAD（e03352c）全部源码** —— main/poll-loop/ipc×3/
>    core×14/renderer×11+CSS/bridge.ps1+5 子模块，约 5,800 行；`node --check` 全量语法
>    检查；`npm test` 实跑（138/138 过）；关键调用链 grep 验证。
> 3. **与历史文档的关系**：`docs/` 下三份旧文档多处与代码失真，本文一律以代码为准；
>    README 的功能表也发现两处与代码不符（见 §4）。

---

## 0. 三个「事实级」发现（先于一切对标结论）

对标之前必须先承认：**当前仓库源码有一个致命错误和两个静默失效的功能**。
评级再高也建立在「能跑」的基础上，这三项修掉之前，下面所有 ✅ 都应打折。

### F1 · 致命：渲染层已提交的语法错误（P0）

`src/renderer/state.js:86-95` 重复声明了 `itemsEl / barEl / rootEl / tooltipEl /
menuLayerEl / ghostEl / previewEl / stackPanelEl / winCountPrev`（与 :67-76 的
`export const` 重名）。ES module 里 `const` 重声明是 SyntaxError，实测：

```
$ node --check state.js
SyntaxError: Identifier 'itemsEl' has already been declared
```

即 **当前 HEAD 构建出来的 Dock 渲染层完全无法启动**（`dist/` 里的产物构建于
该提交 a93ccfd 之前，所以已安装版还能跑，掩盖了问题）。`npm test` 138/138
全过 —— 因为测试只覆盖主进程纯函数与桥接，渲染层 ES module 零覆盖，这类
「一改就全挂」的错误 CI 抓不到。修法：删掉 ：80-96 的重复块（十几行）。

### F2 · 静默失效：托盘进程感知是死代码（P1）

`poll-loop.js:81` 每轮把 `ctx.runningProc = new Set(...)` **整体重新赋值**，
而 `snapshot.js` 的 builder 在 main.js:205 装配时捕获的是**旧 Set 的引用**
（永远为空）。所以 `runningProc.has(p.exe)`（snapshot.js:108）恒为 false，
「无窗口托盘应用也算运行中」这条 README ✅ 实际从未生效。
代码注释自己写了「疑似缺陷，原样保留不修」——它不是疑似，是确定的 bug。
修法：原地 `clear()` + `add()`，或给 builder 传 getter（一行级）。

### F3 · 静默失效：预览面板「×」与最小化方块的「关闭」从未工作过（P1）

渲染层两处调用 `close-window`（单数）：`menus.js:166`（悬停预览缩略图的
关闭按钮）、`menus.js:450`(最小化方块右键「关闭」）；preload 白名单放行；
但主进程只有 `case 'close-windows'`（复数，ipc-routes.js:132）→ 返回
`unknown-channel`。追到拆分前的 main.js（f4c7052~1:688）也只有复数 ——
**这两个入口自功能诞生起就无效**，不是拆分引入的回归。修法：主进程补一个
`case 'close-window'` 或渲染层改调 `close-windows`（两行级）。

> ✅ **P0 执行落账（2026-09-06）**：F1 已修（state.js 删除重复声明块，恢复
> ESM 解析）；F2 已修（poll-loop.js:78-88 改为原地 clear+add，托盘感知复活，
> 全仓不再有 runningProc 重赋值）；F3 已修（ipc-routes.js:132 补
> `case 'close-window'`，容错语义与批量路径一致）；F1 回归网已建
> （test/renderer-syntax.test.js：renderer 11 个 ES module 按 ESM + src/core/windows
> 24 个 CJS 全量 `node --check`，两条冒烟用例）。验证：`npm test` 140/140 过
> （138→140）；三项修复均经 grep/语法检查交叉确认。改动未提交（state.js /
> poll-loop.js / ipc-routes.js / 新增 test），待随下一批 P1 一并入库。

> ✅ **P1 执行落账（2026-09-06）**：六项全部落地。
> 1. 弹跳改「弹到就绪」（state.js launchWithBounce 轮询 180ms：本条目或同 exe
>    条目出现窗口即停，封顶 3s；CSS 改等高三连跳 infinite，侧栏横跳同步）；
> 2. 侧栏放大增高（layout.js vert 分支槽宽同步增长，玻璃板朝屏幕内侧增宽）；
> 3. 菜单「登录时打开」（bridge 新增 startup-shortcut[-state] 命令写/删
>    shell:startup 的 .lnk，ipc get/set-login-open，preload 放行，选项子菜单
>    带 ✓ 态；PS 真机往返 create→state→remove 实测通过）；
> 4. keepVisible「Dock 常驻」开关（settings DEFAULTS → SETTING_KEYS →
>    broadcast → snapshot → renderer OPT → dock.js 收起门控 → 设置面板 UI 全
>    链路；默认 false 保持现行为，README 同步改写「智能收起 + 常驻开关」）；
> 5. 多文件投放（open-with 接受 filePaths 数组一次启动全量传参）；
> 6. Launchpad 缓存 60s TTL + 过期后台重扫（stale-while-revalidate，失败也计时防
>    每次打开撞 30s 超时）。
>
> **重大新发现 F1b（已修）**：真机冒烟发现 HEAD 渲染层是「双重死亡」—— 除 F1
> 外，state.js 的 `applyEnv` 缺 `export`，dock.js 具名导入在模块**链接期**失败
> （`node --check` 与语法冒烟均抓不到，只有实例化模块图才爆）。已补 export；
> 并把冒烟测试升级为 vm.SourceTextModule.link 链接期检查（npm test 加
> --experimental-vm-modules），此类错误从此必有回归网。最终验证：
> `npm test` 141/141 过；隔离 userData 真机启动，渲染层槽位/废纸篓/顶栏时钟
> 全部正常出画，main.log 出现 dock-bounds（ready 链路打通）。

> ✅ **P2 执行落账（2026-09-06）**：五项全部落地。
> 1. 滚轮悬停（scroll-to-open 对齐）：滚轮悬停运行中应用 → Exposé（1.2s 节流），
>    悬停文件夹 → 展开 Stack（dnd.js wheel 监听）；
> 2. 「运行指示点」开关（showIndicators，默认开对齐 macOS；设置面板 + no-indicators
>    根类 + CSS 整体不渲染）；
> 3. Stack 排序补「修改日期」（core/stack-sort.js 'modified'；'added' 保留为兼容
>    别名 —— 桥接只能廉价拿 mtime，无真正「日期添加」shell 属性，UI 文案如实改为
>    修改日期；setStackSort 白名单同步）；
> 4. Stack 拖出文件：拖 Stack 单元到废纸篓=回收 / 应用=打开 / 文件夹=移入，
>    拖到面板内子文件夹=移入并刷新（复用 slotHitTest/targeted 高亮/ghost，6px
>    阈值区分点击，click 抑制窗 0ms）；
> 5. 满屏自动压缩（computeFitScale：基准总宽超屏宽时全体等比缩，下限 0.5，
>    用基准尺寸算避免与放大互馈；拖拽避让步距、面板最小高度同步乘系数）；
>    autohide 节奏参数（showDelayMs 150 / hideDelayMs 360，GUI 不暴露、
>    config.json 可调 —— macOS 该两项本就是终端级 defaults，做法一致）。
>
> 验证：`npm test` 142/142 过（+modified 排序用例）；隔离实例真机启动 ——
> 槽位渲染、fitScale=1 时 52px 基准宽、no-indicators 类缺省态全部正确，
> ready 链路 dock-bounds 落日志。本日 P0+P1+P2 全部完成，建议打包实测一轮
> 动画手感（弹跳循环节奏 / 侧栏放大板宽 / 满屏压缩）后提交版本。

---

## 1. macOS 原版 Dock 画像（调研蒸馏）

### 1.1 System Settings「Desktop & Dock」Dock 区全部 10 项 [官方]

| 设置项 | 语义 / 取值 |
| --- | --- |
| Size | 连续滑块；**官方范围 16–128px，默认 48** |
| Magnification | 开关 + 滑块（放大目标尺寸，同 16–128） |
| Position on screen | Left / Bottom / Right（**没有 top**） |
| Minimized windows animation | Genie / Scale（隐藏键还有第三种 `suck`） |
| 双击标题栏行为 | Fill / Zoom / Minimize / No Action |
| Minimize windows into application icon | 收进应用图标 vs 独立最小化区 |
| Automatically hide and show the Dock | 默认关；快捷键 ⌥⌘D / Fn-A |
| Animate opening applications | 启动弹跳，默认开 |
| Show indicators for open applications | 运行圆点，默认开 |
| Show suggested and recent apps in Dock | 最近/建议应用区，默认开 |

### 1.2 数值与行为规则（对标时可直接引用的「硬参数」）

| 行为 | macOS 事实 | 来源 |
| --- | --- | --- |
| 分隔线拖拽调大小 | 拖应用区与右侧区之间的分隔线实时改 tilesize | [官方 mh35859] |
| 图标满时的压缩 | 全体 tile 等比压缩塞满屏宽，下限 16px，到底后拒绝再大 | [官方下限+社区观察] |
| 最近应用区 | **最多 3 个**、只显示**未固定**的应用、位于分隔线与废纸篓之间；Stage Manager 开启时整区消失 | [官方 mh35859 + TidBITS] |
| 自动隐藏节奏 | 触边延迟默认 **0.2s**（`autohide-delay`）、滑入/出动画 **0.5s**（`autohide-time-modifier`） | [macos-defaults] |
| 启动弹跳 | **弹到应用进入事件循环为止**（不是固定次数）；应用卡死会一直弹；另有应用主动请求的 attention bounce（可无限弹） | [Reddit/Apple SE 多源] |
| 隐藏应用的显示 | `showhidden`：被 ⌘H 隐藏的应用图标**半透明**显示 | [Intego] |
| 单应用模式 | `single-app`：切换应用时自动隐藏其他全部窗口 | [Intego，单源] |
| 滚轮悬停 | `scroll-to-open`：在图标上滚轮 = 触发该应用 Exposé / 展开堆栈 | [macos-defaults] |
| 只显示运行中 | `static-only`：隐藏全部固定项，Dock 变纯运行区 | [官方 payload + 社区] |
| 角标与进度 | NSDockTile `badgeLabel`（系统级，托盘应用也有）；Downloads 堆栈下方有**系统级下载进度条**；应用可自绘 dock tile 加进度环（DockProgress 库流行） | [Apple 开发者文档] |
| 废纸篓 | 满空两态图标；清空弹**确认对话框**（可勾选「不再警告」）；可选 30 天自动清空 | [官方+观察] |
| 多显示器 | Displays have separate Spaces **开**=每块屏各有一条 Dock；**关**=仅主屏 | [官方 mchlp1119] |
| 应用卡死 | Dock 菜单里「退出」变「强制退出」（⌥+右键也可强制） | [社区一致] |
| Dock 菜单·固定应用 | 窗口列表（运行时）+「选项」子菜单：**在 Finder 中显示 / 登录时打开 / 分配到：此桌面·所有桌面·无** / 从 Dock 中移除 | [Apple 社区+TidBITS] |
| 修饰键点击 | ⌘+点击=在 Finder 中显示；⌥+点击=隐藏该应用；⌥⌘+点击=隐藏其他 | [社区一致] |
| Tahoe 26 | Liquid Glass：实体 bar 消失、玻璃随壁纸折射；放大保留（部分 26.0 用户遇冻结 bug）；倒影形态改变 | [Apple Newsroom+社区] |

### 1.3 明确的平台天花板（Windows 拿不到，对标时豁免）

NSWorkspace 级应用生命周期、系统级通知角标、WindowServer 合成器材质、
Genie 的窗口真实形变（DWM 无对应接口）、每屏一条 Dock 的 Spaces 模型、
双击标题栏 Fill/Zoom（窗口管理器语义）。

---

## 2. 逐项对标总表（功能 × 质量分级）

评级口径（评的是**实现质量**，不只看有没有）：
**A** 对齐或超出原版（含正确的平台取舍）｜**B** 可用、有可感差距｜
**C** 明显差距或部分失效｜**D** 入口在但实际无效｜**✗** 缺失｜
**P** 平台天花板，明确不做。

### 2.1 布局与静态视觉

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 分区结构 | 应用区｜分隔线｜最近区｜最小化区｜废纸篓 | state.js:318-331 `wantedSlotIds` 完整复刻，空区自动去双分隔线 | **A** | 语义与边界情况（空区）都对 |
| 2 | 玻璃材质 | Sequoia 半透玻璃（顶部锐高光/底缘收暗） | style.css:6-27 四层 box-shadow + blur(18px)，实拍调参有证据链 | **B+** | 无合成器前提下接近上限；Tahoe Liquid Glass 明确不追（P） |
| 3 | 图标底板 | 全员 squircle 容器 | style.css:105-116 全员加板、废纸篓排除、内缩 padding | **A-** | 决策演进有实拍依据；「板中板」是图标源固有限制 |
| 4 | 倒影 | 经典版有，Tahoe 形态改变 | `-webkit-box-reflect`（仅 bottom 位），0.32 透明度实测调参 | **B** | 侧栏无倒影（macOS 侧栏本来也没有，正确） |
| 5 | 运行指示点 | 5px 圆点+细白描边，锚定 Dock 底缘 | style.css:186-200，5.5px+白描边；P2-F2 把 lift 移到 img、点锚定 wrap | **A** | 「点留底座」与 macOS 一致；缺「显示/隐藏圆点」开关（macOS 有该设置项） |
| 6 | 角标样式 | 红底白字，系统级 | style.css:202-221 + badge 99+ 封顶 | **B-** | 样式对齐；数据源是标题正则（见 2.7-3） |
| 7 | tooltip | 悬停出应用名 | menus.js:19-56，420ms 延迟、定位含边界 clamp、侧栏内侧弹出 | **A-** | 多窗口时 macOS 会列窗口，我们只有标题（预览面板补位） |
| 8 | 图标尺寸范围 | 16–128px 满时自动压缩 | 36–72px；**满时无压缩**，超出屏宽会溢出 | **C** | 范围窄一半；「满屏自动压缩」整条缺失（macOS 图标多时全体变小） |
| 9 | 分隔线拖宽 | 拖分隔线实时改尺寸（16-128） | layout.js:263-294 方向感知+冻结鱼眼+写回设置，4px/级 | **B+** | 机制好；范围仍是 36–72 |

### 2.2 放大与动画

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 鱼眼曲线 | 余弦/高斯衰减+二维调制 | layout.js:56-77 R=3.2×BASE 余弦衰减 + 垂直调制 vmod(下限 0.2) | **A-** | 9-04 的 A-1 已修；调制下限/半径参数与真机手感仍需逐帧对比 |
| 2 | 回弹物理 | 弹簧带轻微过冲 | core/spring.js 半隐式欧拉 0.26/0.58，鱼眼与拖拽避让共用 | **A-** | 积分器下沉可单测，终态精确归位、rAF 自停 |
| 3 | 面板随放大增高 | 玻璃板顶边随最高图标上移 | layout.js:160-164 **仅 bottom 位**；侧栏宽度不随放大长，图标横向溢出玻璃板 | **C** | A-5 只修了一半：左右位置时放大图标会穿出条外（实测 CSS `.slot{width:var(--is)}` 固定） |
| 4 | 启动弹跳 | **弹到应用就绪为止**+衰减+挤压；attention bounce | state.js:585-597 固定 1500ms 两跳衰减+scaleY 挤压（style.css:223-234） | **B** | 衰减形态对了；语义不同：应用 300ms 就绪时我们还在弹，10s 才就绪时弹停了。且无「请求注意」弹跳 |
| 5 | Genie/Scale | 真实窗口形变 | panel-windows.js:272-295 截图+genie.js 三段关键帧（弓形弧线+旋转+底缘原点），560/380ms；30s 闲置销毁窗口 | **B+** | Electron 架构下的高水准近似；GPU/UWP 窗口截图空白时**静默无动画**（catch{}），窗口凭空消失感 |
| 6 | 最小化进应用图标 | 设置项 | snapshot.js:169 + 设置开关 | **A** | |
| 7 | Poof 消散 | 拖出移除消散 | menus.js:62-81 云雾 SVG+缩放旋转消散 | **B+** | |
| 8 | 拖拽邻居让位 | 弹簧式避让 | P2-F1b shift 弹簧（0.22/0.62）由 layoutTick 统一积分 | **A-** | 与鱼眼共用积分器，无双驱动 |
| 9 | 滚轮悬停切窗 | `scroll-to-open` 隐藏特性 | 无 | **✗** | 低成本可补：滚轮事件→ expose-open |

### 2.3 点击与激活语义

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 点击未运行 | 启动+弹跳 | dnd.js:196-199 launchWithBounce | **A** | |
| 2 | 点击已前台多窗口 | macOS 无动作（单窗）/列窗口 | dnd.js:202-210：多窗→pinned 预览网格，单窗→re-front | **B+** | 比原版更进一步（预览网格是超出原版的增强）；单窗已前台时重发 focus 冗余 |
| 3 | 点击未聚焦运行应用 | 全部窗口带到前台 | dnd.js:212-221 从旧到新逐窗 focus | **A-** | 与 macOS「应用整体前置」语义一致；逐窗循环在窗口多时可感知慢 |
| 4 | 无窗口后台应用 | 重开新窗口 | wins.length===0 → launch | **B** | Windows 语义下等价于再启动一次（单实例应用回到原实例） |
| 5 | 修饰键点击 | ⌘=Finder 中显示；⌥=隐藏；⌥⌘=隐藏其他 | core/modifier-actions.js 决策矩阵 + ipc-app-actions.js:116-149 编排 | **A-** | ⌘→Ctrl 是正确的 Windows 映射；「隐藏」用最小化模拟（无 Cmd+H 等价物，正确取舍但 genie 连发观感重） |
| 6 | 键盘激活 | Ctrl+F3 聚焦 Dock+方向键 | Ctrl+Alt+D + 方向/Home/End + Tab/Enter（keyboard.js + core/kbd-nav.js） | **B+** | 双体系（Tab 与方向键）并存；Esc 归还焦点链路完整 |

### 2.4 右键菜单

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 运行应用菜单 | 窗口列表+选项+退出 | menus.js:511-580：窗口列表≤9+「其他 N 个」、隐藏其他、显示所有窗口、退出 | **B+** | hung 时自动变红色「强制退出」（macOS 需 ⌥+右键，我们更聪明） |
| 2 | 选项子菜单 | 在 Finder 中显示/登录时打开/分配到桌面 | menus.js:533-554：在资源管理器中显示（仅 pinned）/移除/固定 | **C** | 缺「登录时打开」「分配到显示器」两整项 |
| 3 | 文件夹菜单 | 打开/显示为/排序方式/在 Finder 中显示 | menus.js:465-505：显示为 auto/grid/fan/list ✓、排序 name/added/created/kind ✓ | **B+** | 缺 macOS 的「按修改日期」排序；缺「显示为文件夹/堆栈」 |
| 4 | 最小化方块菜单 | 还原/选项/关闭 | menus.js:443-453 还原+关闭 | **D** | 「关闭」调用的 `close-window` 通道失配（F3），从未生效 |
| 5 | 废纸篓菜单 | 打开/清空（确认对话框） | menus.js:427-441：打开+清空（3s armed 二次确认，core/confirm-arm.js 状态机） | **B** | armed 确认是自创模式（macOS 是对话框）；无「不再警告」选项；空回收站禁用逻辑 ✓ |
| 6 | 空白区菜单 | Dock 设置等 | menus.js:582-594：启动台/添加应用/文件夹/设置/自动隐藏 | **B+** | |
| 7 | 菜单视觉 | 系统蓝高亮/半透 | style.css:253-284 仿 macOS 菜单+图标列+子菜单▸ | **A-** | |

### 2.5 拖拽

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 拖拽排序 | 主轴重排+避让 | dnd.js:357-482 + 弹簧避让 | **A-** | 拖拽期 rebuild 的存活节点重解析（dnd.js:389-396）处理得很细 |
| 2 | 拖出移除 | pinned 拖出+poof | dnd.js:401-427 三方向出界判定（贴边侧 46/内侧 90px 不对称 ✓） | **A-** | 运行中非 pinned 拖动会被判定不可移除——macOS 语义一致 |
| 3 | 拖文件到应用 | 用该应用打开（全部文件） | dnd.js:602-609 **只取 paths[0]** | **B-** | 多文件投放丢失其余文件，macOS 会全开 |
| 4 | 拖文件入废纸篓 | 回收 | pulse+recycle-files ✓ | **A-** | |
| 5 | 拖到文件夹 | spring-loaded 展开+归置 | dnd.js:558-569 700ms 阈值 + drop 落展开面板=移入（:582-585） | **A-** | macOS 阈值约 1s 且可在设置调（Spring-loading delay），我们固定 700ms |
| 6 | 拖 exe/lnk 固定 | 拖应用入 Dock 固定 | dnd.js:612-616 add-app | **A** | |

### 2.6 最小化体系

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | Genie/Scale 双效果 | 设置项 | settings ✓ + genie.js 双关键帧 | **B+** | |
| 2 | 最小化窗口区 | 独立缩略方块区 | core/minimized.js 投影 + 0.72× 小方块 | **B+** | |
| 3 | 方块还原 | 点击还原 | handleClick min → focus-window ✓ | **A** | |
| 4 | 方块关闭 | 菜单关闭 | **D**（F3 失效） | **D** | |
| 5 | 最小化进图标 | 设置项 | ✓ | **A** | |

### 2.7 状态感知

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 运行判定 | NSWorkspace 应用生命周期 | 有窗口即运行 + processes-running 托盘补充（**已失效**，F2） | **C** | 修 F2 前=「有窗口才亮」，托盘应用显示未运行，点击可能拉起第二实例 |
| 2 | 运行指示点 | 开关+圆点 | ✓（见 2.1-5） | **A** | |
| 3 | 通知角标 | 系统级 badge | 标题正则（core/badges.js），多窗取最大，99+ 封顶 | **C** | 平台无统一接口，尽力近似；托盘应用失效+「窗口编号」误报是固有伤 |
| 4 | 进度指示 | NSDockTile 进度环/下载条 | 无（active-glow 泛蓝光近似「新窗口」提示） | **✗** | 下载类应用无法表达进度 |
| 5 | 应用卡死 | 菜单强制退出 | enum 级 IsHungAppWindow（types.ps1:461）→ 菜单红字强杀（只手动，绝不自动） | **A-** | 判定链路和克制的产品决策都对 |
| 6 | 新窗口提示 | 无（macOS 无此提示） | active-glow 泛光 | **A** | 超出原版的轻量增强 |

### 2.8 自动隐藏 / 让位 / 位置

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 自动隐藏 | 触边 0.2s 延迟+0.5s 动画；**默认关** | 渲染层 dock.js:58-99 智能收起轮询 + 150ms 贴边唤醒 + 160px 保持区 | **B（机制）/分歧（默认值）** | 见下方「重要分歧」 |
| 2 | 全屏让位 | 全屏=独立 Space，Dock 让位 | IsZoomed 过滤最大化误判（types.ps1:115-128）+ occlusion 状态机（core/occlusion.js 可单测） | **A-** | cursorNear 时抑制让位防打架，语义基线注释完整 |
| 3 | 位置切换 | 左/下/右 | bottom/left/right 全链路（镜像布局/侧栏鱼眼/弹跳方向/拖拽判定都有分支） | **A-** | 侧栏分支覆盖度高；侧栏放大溢出是唯一漏洞（2.2-3） |
| 4 | 多显示器 | 每屏一条 Dock / 仅主屏 | 跟随鼠标单 Dock 跳屏（dock-window.js:182-190） | **C** | 模型不同：跳屏瞬间 Dock 消失重现；顶栏跟随 ✓ |
| 5 | 工作区预留 | Dock 恒占位（窗口不压 Dock） | SPI_SETWORKAREA 可选开关（默认关，仅主屏），桥接重启重放+退出恢复 | **B+** | macOS 是恒定行为，我们做成 opt-in 是对 Windows 习惯的尊重 |

> **重要分歧（必须写进 README 或做成设置）**：`dock.js:60` 的
> `want = !!autohide || appActiveNow` —— **只要前台不是桌面，无论是否开自动隐藏，
> Dock 都会在 240-480ms 后收起**。即出厂行为≈「永远自动隐藏」，与 macOS 默认
> （Dock 常驻、窗口从下方绕过）和本项目 README「Dock 恒浮于窗口之上；仅全屏
> 应用时让位」的表述都矛盾。9-05 评审把 occludeAway 语义挪进了渲染层，
> 但没同步文档与设置面板 —— 这是第三次「文档与代码失真」。

### 2.9 窗口预览 / Exposé

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 悬停缩略图 | 原版**没有**（第三方增强） | PrintWindow 周期快照+黑屏降级+750ms 刷新+×关闭（F3 失效） | **A（超原版）** | 快照非实时是明确取舍；×按钮失效拖后腿 |
| 2 | App Exposé | 点击按住/Ctrl+↓ | 中键→expose 窗口（≤24 窗，串行截图防过载，键盘导航，Esc/失焦关） | **B+** | 触发方式自创（中键）；最小化窗显示图标而非截图 |
| 3 | Mission Control | 全局窗口总览 | 无 | **✗** | Windows 任务视图存在但未打通 |
| 4 | 点击已前台多窗 | （原版无预览） | pinned 缩略图网格 | **A** | 超出原版 |

### 2.10 最近应用 / Stack / 废纸篓 / Launchpad / 顶栏

| # | 项 | macOS | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 最近应用区 | **最多 3 个**、仅未固定、SM 开启时消失 | core/recent.js LRU≤20 可见 3、运行中标注、点击聚焦/启动 | **B+** | 数量语义对齐；未过滤「已固定」由快照层处理 ✓；缺「从 Dock 移除后仍保持最近」的 macOS 细节 |
| 2 | 最近区开关 | show-recents 设置项 | 无独立开关（有 recent-remove 右键） | **C** | macOS 有 GUI 开关 |
| 3 | Stack 三视图 | fan/grid/list/自动 | auto=≤5 fan 否则 grid（core/stack-sort.js）+ 真扇形布局（dnd.js:150-179 弧线辐射+旋转+中心最大） | **A-** | fan 是真扇形了；缺拖拽从堆栈取出文件 |
| 4 | 废纸篓 | 满空图标/打开/清空确认 | trashSvg 两态+计数来源+armed 确认+脉冲 | **B** | 无「30 天自动清空」等价物（Storage Sense 打通可做） |
| 5 | Launchpad | 全屏网格/文件夹/搜索框 | 开始菜单扫描+搜索+分页(60/页)+stagger 入场+懒加载图标+blur 即关+缓存 | **B-** | 缺文件夹/重排（已明确不做）；**应用列表缓存永不刷新**（panel-windows.js:89 装新应用要重启 Dock） |
| 6 | 顶部菜单栏 | macOS 菜单栏（完整） | 前台应用名+时钟，纯穿透可关 | **B-** | 装饰性存在；托盘/控制中心无对应（平台天花板） |

### 2.11 系统集成与工程

| # | 项 | 我们（证据） | 评级 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 启动链路 | ShellExecute/lnk/UWP 别名/wt.exe 特判/工作目录保留（ipc-app-actions.js:28-72） | **A-** | 边界处理（参数原类保留、别名 PowerShell & 调用）非常扎实 |
| 2 | 退出应用 | per-PID WM_CLOSE + 3s 探活升级强杀 + explorer 保护（ipc-app-actions.js:74-114） | **A-** | hung 直接强杀路径独立 ✓ |
| 3 | UWP 归组 | CoreWindow pid → AUMID → 标题前缀三级回退 + hwnd 缓存（types.ps1:357-391） | **A-** | 三级回退和性能缓存都做了 |
| 4 | 图标管线 | PrivateExtractIcons 256 → IShellItemImageFactory 256（预乘还原）→ SHGetFileInfo → ExtractAssociatedIcon 四级回退（types.ps1:534-602） | **A-** | JUMBO 路线失败的复盘注释在案；IconCache.logSafe 仍是 noop 桩（失败静默） |
| 5 | 桥接守护 | NDJSON+超时+指数退避熔断+孤儿清扫+父进程存活自检（native.js + bridge.ps1 主循环） | **A** | 工程质量最高的部分 |
| 6 | 状态推送 | 1.4s 轮询+状态签名增量推送+前台变化即时触发 poll（poll-loop.js:146-151） | **B** | 焦点切换已近似事件驱动；应用启动/关闭仍最长 1.4s+连续两帧过滤（新应用图标 ~3-4s 才出现，macOS 即时） |
| 7 | 测试 | 138/138 过；core 层 14 个模块全覆盖 | **B+** | 但渲染层 ES module 与编排层 pollOnce/handleInvoke 零覆盖 —— F1 语法错误就是从这漏掉的 |
| 8 | 安全 | CSP+contextIsolation+IPC 白名单+reveal 剥引号+UTF8 强制 | **A-** | |

---

## 3. 质量结论（对比 9-05 评审的更新）

**提升为实的**：UWP 归组、图标 256px 管线、spring 积分器下沉、键盘导航、
修饰键语义、stack 排序/视图、主进程拆分（262 行装配层+领域模块，依赖方向
干净）—— 这些我逐行读过，属实。

**9-05 评审未发现、本次新发现的问题**：
1. F1 渲染层语法错误（致命，已提交）；
2. F2 runningProc 死引用（托盘感知失效）；
3. F3 close-window 通道失配（两处功能从未生效）；
4. 侧栏（左/右位置）放大时面板不增高、图标穿出玻璃板（A-5 只修了 bottom）；
5. 出厂默认行为≈永远自动隐藏（appActiveNow 智能收起），与 README 矛盾；
6. Launchpad 应用列表缓存永不刷新；
7. 多文件投放只取第一个文件。

**仍然成立的老问题**：状态延迟（1.4s 轮询兜底）、角标数据源（正则）、
Live Thumbnail 缺失（明确不做）、编排层测试零覆盖。

**综合**：功能广度 ≈ macOS 原版的 85%（另有 5 项超出原版）；
单点实现质量两极 —— 桥接/启动/拖拽/状态机这些「硬骨头」是 A 级，
而「默认行为一致性」「菜单完整性」「侧栏形态」「缓存失效策略」这些
「面子活收尾」大量停在 B/C，外加三个从没工作过的入口。
宏观判断不变：**不缺功能，缺收尾。**

---

## 4. 文档失真清单（README 需同步）

| # | README 表述 | 代码事实 |
| --- | --- | --- |
| 1 | 「后台进程感知（托盘应用也算运行中）」✅ | F2 死引用，从未生效 |
| 2 | 「右键菜单：窗口列表、固定/移除、退出」✅ | 最小化方块「关闭」、预览「×」无效（F3）；选项子菜单缺 2 项 |
| 3 | 「Dock 恒浮于窗口之上；仅全屏应用时让位（可关）」 | 前台有应用即 240-480ms 收起（appActiveNow），恒浮不成立 |
| 4 | 「最小化窗口方块（右侧分区，还原/关闭）✅」 | 关闭无效（F3） |
| 5 | 9-05 评审「编排层 0 覆盖→新增 11 用例」 | occlusion 纯函数有测试，pollOnce/handleInvoke 仍零覆盖（表述过宽） |

---

## 5. 迭代建议（按 ROI 排序）

### P0 —— 修「坏的」（全部 ≤ 1 小时，先做）
1. **删 state.js:80-96 重复声明块**（F1，致命）；
2. **poll-loop.js:81 改原地清空+填充**（或 builder 收 getter）（F2）；
3. **ipc-routes.js 补 `case 'close-window'`**（或渲染层改调复数）（F3）;
4. 渲染层加最低限度的语法冒烟：`node --check` 扫 `src/renderer/*.js` 挂进 npm test（防 F1 复发，10 行脚本）。

### P1 —— 补「假的」（把 ✅ 做成真的）
5. 弹跳改「弹到状态就绪」（launch 后轮询 entry.running/windows 出现即停，封顶 3s）；
6. 侧栏放大增高（layout.js 给 vert 分支加 barEl 宽度跟随，与 bottom 对称）；
7. Dock 菜单选项子菜单补「登录时打开」（setLoginItemSettings 已有基建）；
8. README/设置面板对齐「智能收起」默认行为（加「Dock 常驻」模式开关，恢复 macOS 式恒浮选项）；
9. 多文件投放循环 open-with；
10. Launchpad 缓存加失效（设置变更/定期/打开时可选刷新）。

### P2 —— 追「好的」（低成本高感知的对齐）
11. 滚轮悬停触发该应用 Exposé（scroll-to-open 对齐）；
12. 「显示运行指示点」设置开关（macOS 有此项）；
13. Stack 排序补「修改日期」；fan 堆栈支持拖出文件；
14. 图标满屏自动压缩（超出屏宽时全体降 tile，下限 24px）；
15. autohide 节奏参数暴露（唤醒延迟/动画时长，对齐 autohide-delay 0.2s/0.5s 语义）。

### 不变（明确不追）
Liquid Glass 材质、DWM Live Thumbnail、每屏一条 Dock、系统级角标、Siri 区。

---

## 附：本次调研主要来源

- Apple 支持：《Change Desktop & Dock settings on Mac》(mchlp1119)、《Use the Dock on Mac》(mh35859)、Mac 键盘快捷键 (102650)
- Apple Developer：DeviceManagement Dock payload（tilesize/mineffect 等键与 16–128 范围）、NSDockTile
- Apple Newsroom：macOS Tahoe 26 Liquid Glass
- macos-defaults.com（autohide-delay 0.2s / autohide-time-modifier 0.5s / scroll-to-open / static-only 等）、defaults-write.com、Intego、TidBITS（Stage Manager 与 recents 互斥）
- 社区行为佐证：Apple Discussions / MacRumors / Reddit（弹跳语义、强制退出、多显示器）
