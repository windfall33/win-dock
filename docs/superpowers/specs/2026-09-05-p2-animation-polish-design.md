# P2 动画打磨 — 工程设计文档

- 日期：2026-09-05
- 状态：已评审通过（设计阶段）
- 上游输入：`docs/dock-parity-gap-2026-09-04.md`（差距调研）、P1 设计（`2026-09-05-p1-interaction-parity-design.md`）
- 后续：本文档批准后由 writing-plans 产出实现计划，按 TDD 执行

## 1. 背景与目标

与 macOS 原版 Dock 对比识别出的「打磨差距」层，原定 3 项，用户决策裁掉「弹跳感知启动」（本轮不做），剩余 2 项全部为渲染层动画质感问题。

**成功标准**：拖拽避让有弹簧物理感（过冲后回弹）；放大悬停时指示点锚定玻璃底座不动；鱼眼行为零回归；全部现有测试不回归。

## 2. 范围与非目标

### 2.1 范围

| # | 功能 | 一句话定义 |
|---|------|-----------|
| F1 | 拖拽避让弹性 | 拖拽经过时其他图标以弹簧物理避让/回位，替代线性 CSS transition |
| F2 | 指示点锚定 | 运行指示点锚定玻璃底座，不随放大图标上浮 |

### 2.2 非目标（明确不做）

- 弹跳感知启动完成（用户决策裁掉；现状固定 1.2s CSS 弹跳保持不变）
- 合成器级 Genie 像素扭曲、DWM 实时缩略图（Windows 平台限制）
- 鱼眼放大算法本身的调整（现参数已对齐 macOS 观感，只抽共用积分器）

## 3. F1 拖拽避让弹性

### 3.1 现状（已核实）

- `renderer.js:1418-1425`：拖拽时 `shiftAmounts()`（`renderer.js:1428-1436`）算出 ±1 槽位线性位移，直接写 `el.style.transform` + `transition: transform .16s ease`
- 效果：图标「滑」开而非「弹」开，无过冲、无物理感
- 鱼眼已有一套内联弹簧积分（`renderer.js:628-635`，半隐式欧拉，stiff=0.26/damp=0.58），仅用于缩放值逼近

### 3.2 方案

**新模块 `src/core/spring.js`**（纯函数，TDD 核心）：

```js
stepSpring(pos, vel, target, stiff, damp) → { pos, vel, settled }
// 半隐式欧拉：vel = (vel + (target - pos) * stiff) * damp; pos += vel
// settled：|target - pos| < 0.0015 && |vel| < 0.0015 时硬着陆（对齐现有 layoutTick 阈值）
```

- 鱼眼缩放路径改为调用 spring.js，参数不变（0.26/0.58），行为零变化
- 拖拽避让复用同一积分器，参数更弹：初值 stiff=0.22/damp=0.62，实现时实机微调至「明显过冲一次后回位」的手感
- 拖拽期间每个槽位持有偏移量状态 `{pos, vel}`，目标来自 `shiftAmounts` 的 ±1 槽位值；在现有 rAF 循环（`renderer.js:669-686`）里积分逼近——拖拽时 rAF 本来就在跑（插入点每帧重算），无额外循环开销
- 拖拽结束（mouseup）：目标归零，弹簧自然回位，全部槽位 settled 后 rAF 循环自停（复用现有 more 机制）
- 弹簧状态挂 slotMap holder 上：reconcile 复用 DOM 元素时状态不丢
- **移除**拖拽位移的 CSS transition（`renderer.js:1421`），避免与弹簧双驱动冲突

### 3.3 测试

`test/spring.test.js`：

- 收敛性：任意初值最终 settled 于 target
- 过冲回弹：阻尼 <1 时存在过冲（验证「弹」的手感来源）
- settled 判定：阈值边界（0.0015 内/外）
- 鱼眼参数回归：0.26/0.58 下 30 步内收敛（锁定现有手感）

`shiftAmounts` 逻辑不变，不新增测试（行为由现有拖拽冒烟覆盖）。

## 4. F2 指示点锚定底座

### 4.1 现状（已核实）

- DOM 结构：`.slot > .icon-wrap > (.app-icon img, .badge, .running-dot)`（`renderer.js:311-332`）
- 指示点 CSS：`position:absolute; left:50%; bottom:-4px`，相对 `.icon-wrap` 定位（`style.css:159-171`）
- 放大时 lift 施加在**整个 slot**：`s.el.style.transform = translateY(-lift)`（`renderer.js:653-654`）→ 指示点随图标一起上浮
- macOS 行为：指示点锚定玻璃底座，放大图标向上浮出、指示点留在底座
- 附带缺陷：slot 的 transform 被拖拽位移复用（`renderer.js:1422` 直接赋值覆盖）→ 拖拽中 lift 被清掉，lift 与拖拽位移互相踩踏

### 4.2 方案

- lift 从 slot 移到 **img**：`img.style.transform = translateY(-lift)`
  - img 在 wrap 内 flex-end 对齐；transform 不参与布局 → wrap 尺寸不变 → 指示点 `bottom:-4px` 自然锚定底座
  - 侧栏（左/右 Dock）模式：lift 方向改 X 轴（`translateX`），指示点贴内侧边不动（现有 `style.css:531-535` 侧栏定位规则保留）
- transform 冲突顺带消除：lift 归 img、拖拽位移归 slot，各归其位
- 拖拽避让（F1）实施后，拖拽位移也走弹簧，同样作用于 slot，与 img lift 无冲突

### 4.3 测试

无新增纯函数；手工验收清单：

- [ ] 悬停放大时指示点钉在底座不动，图标上浮
- [ ] 拖拽排序过程中被拖图标的上浮量不丢
- [ ] 左/右 Dock 侧栏模式下指示点贴内侧边、放大时不动
- [ ] 深浅色两主题下指示点可见性不回退

## 5. 边界与风险

| 场景 | 处理 |
|---|---|
| 弹簧参数过弹导致图标碰撞 | 参数实测微调；settled 阈值保证终态精确归位 |
| rAF 自停时仍有未 settled 的避让弹簧 | settled 判定纳入 more 返回值，未 settled 不自停 |
| img transform 与图标弹跳动画（mac-bounce）冲突 | 弹跳动画作用在 img 的 CSS animation（独立属性），transform 归 lift；若实测冲突，bounce 关键帧改作用在 wrap |
| reconcile 重建 slot 丢失弹簧状态 | 状态挂 slotMap holder（id 键），DOM 复用即状态复用；被移除槽位状态随 holder 一并回收 |

## 6. 实现顺序与提交粒度

1. F1 spring.js 抽取 + 鱼眼接线（行为零变化，纯平移）——独立提交
2. F1 拖拽避让接入弹簧 + 移除 CSS transition——独立提交
3. F2 指示点锚定（lift 移到 img + 侧栏适配）——独立提交

预估 1 天。任一提交可独立 revert。

## 7. 验收标准

- [ ] 拖拽经过时图标有可感知的弹性避让与回位（对比录屏确认过冲存在）
- [ ] 悬停放大时指示点锚定底座（verify 截图确认）
- [ ] 鱼眼手感零回归（实机对比：放大曲线、上浮量、回弹）
- [ ] `npm test` 全绿，spring.test.js 新增 ≥4 用例
- [ ] 全部现有测试不回归
