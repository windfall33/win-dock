'use strict';
// Dock 渲染层 — 布局/鱼眼/弹簧/rAF 循环/鼠标跟踪/分隔线拖宽（P3-F1b 拆分）
import {
  S, itemsEl, barEl, rootEl, slotMap,
  isVert, appSlotEls, shiftAmounts, gapPx, registerHooks,
} from './state.js';

registerHooks({ ensureRaf, dockStayZone });

//  布局与鱼眼放大（核心）
// =====================================================================

// 鼠标是否停在 Dock 所处屏幕边缘的「保持区」内。
// 用固定的屏幕边缘距离而非 bar 的 getBoundingClientRect：后者会随 hidden-away 的
// translate 位移变化，若用它判断会与隐藏动作形成正反馈（隐藏→矩形移动→判定翻转→显示）。
// 保持区宽度刻意大于唤醒带（20px），宁可晚隐藏也不在边缘来回抽。
const DOCK_STAY_MARGIN = 160;
function dockStayZone() {
  if (S.mouseX < -1000 || S.mouseY < -1000) return false;
  return S.POS === 'bottom' ? S.mouseY >= window.innerHeight - DOCK_STAY_MARGIN
    : S.POS === 'left' ? S.mouseX <= DOCK_STAY_MARGIN
    : S.mouseX >= window.innerWidth - DOCK_STAY_MARGIN;
}

// 指针是否落在 Dock 条热区上（含放大余量）。底部条向上扩一个图标尺寸；
// 侧栏沿水平方向扩一个图标尺寸（横向伸进屏幕），纵向覆盖整条。
function pointOverBar(rect, mx, my) {
  if (mx < -1000 || my < -1000) return false;
  if (isVert()) {
    return my >= rect.top && my <= rect.bottom &&
      mx >= rect.left - S.OPT.iconSize && mx <= rect.right + S.OPT.iconSize;
  }
  return mx >= rect.left && mx <= rect.right &&
    my >= rect.top - S.OPT.iconSize && my <= rect.bottom + 4;
}

// P2-F4 满屏自动压缩：图标基准总尺寸超出可用宽度/高度时全体等比缩小
// （macOS 行为，下限 0.5 防缩到不可用）。用基准尺寸计算（不含放大态），
// 避免与放大互馈震荡；分隔线槽按 17px（1px 线 + 两侧 8px margin）计。
function computeFitScale(vert) {
  let needed = 0;
  for (const [, s] of slotMap) {
    if (!s.el.isConnected) continue;
    needed += s.el.dataset.kind === 'divider' ? 17 : (s.baseSize || S.OPT.iconSize);
  }
  const avail = (vert ? window.innerHeight : window.innerWidth) - 30;
  return needed > avail ? Math.max(0.5, avail / needed) : 1;
}

function computeTargets(mx, my, fit) {
  const out = [];
  // P1-F3：分隔线拖宽期间冻结鱼眼放大，防止布局抖动
  if (S.fisheyeFrozen) {
    for (const [, s] of slotMap) {
      if (s.el.isConnected) out.push({ s, t: 1 });
    }
    return out;
  }
  const barRect = barEl.getBoundingClientRect();
  // 每帧用鼠标实时位置判断是否在 Dock 栏上，避免状态变量过期导致缩放卡死
  const overBar = !S.dockHiddenNow && !S.fullscreenHideNow && pointOverBar(barRect, mx, my);

  for (const [, s] of slotMap) {
    if (!s.el.isConnected) continue;
    if (!overBar) { out.push({ s, t: 1 }); continue; }
    const BASE = (s.baseSize || S.OPT.iconSize) * fit;
    // 更贴近 macOS 的连续挤压：放大半径更大、衰减更平缓，过渡更丝滑。
    // 放大作用域更大，相邻图标挤压更连续（mac 观感）
    const R = BASE * 3.2;
    const HALF = BASE * 0.5;
    const r = s.el.getBoundingClientRect();
    // 放大沿条主轴衰减：底部条看横向距离，侧栏看纵向距离
    const axis = isVert() ? (r.top + r.height / 2) : (r.left + r.width / 2);
    const cursor = isVert() ? my : mx;
    const d = Math.max(0, Math.abs(cursor - axis) - HALF);
    let k = 0;
    if (d < R) {
      const tt = d / R;
      k = Math.pow(0.5 * (1 + Math.cos(Math.PI * tt)), 1.0);
    }
    // macOS 手感：指针越贴近 Dock 底边（侧栏为侧边）放大越饱满，往上/离开时快速衰减。
    let vmod = 1;
    if (!isVert()) {
      const vD = Math.max(0, barRect.bottom - my);
      vmod = Math.max(0.2, 1 - vD / (BASE * 2.6));
    } else {
      const vD = Math.max(0, (S.POS === 'left' ? mx - barRect.left : barRect.right - mx));
      vmod = Math.max(0.2, 1 - vD / (BASE * 2.6));
    }
    out.push({ s, t: 1 + (S.OPT.magnification - 1) * k * vmod });
  }
  return out;
}

function layoutTick() {
  const vert = isVert();
  S.fitScale = computeFitScale(vert);
  const targets = computeTargets(S.mouseX, S.mouseY, S.fitScale);
  for (const { s, t } of targets) s.targetScale = t;

  const arr = [...slotMap.values()].filter(s => s.el.isConnected);

  for (const s of arr) {
    const tgt = s.targetScale == null ? 1 : s.targetScale;
    if (s.vel == null) s.vel = 0;
    // 弹簧阻尼（macOS 手感）：轻微过冲后弹回，比纯 lerp 多一层「物理」。
    // P2-F1a：积分逻辑下沉 core/spring.js（半隐式欧拉），鱼眼与拖拽避让共用；
    // 参数 0.26/0.58 与硬着陆阈值不变 —— 行为零变化的纯平移。
    const st = Spring.stepSpring(s.cur.scale, s.vel, tgt, 0.26, 0.58);
    s.cur.scale = st.pos;
    s.vel = st.vel;
  }
  // P2-F1b 拖拽避让弹簧：每个 app 槽位持有 {pos, vel} 偏移状态（挂 slotMap holder，
  // rebuild 复用 DOM 时状态不丢），目标来自 shiftAmounts 的 ±1 槽位值。
  // 拖拽结束后 S.shiftRelease 目标归零，弹簧自然回位，全部 settled 后清除。
  let shiftBusy = false;
  if (S.dragState || S.shiftRelease) {
    const elsD = appSlotEls();
    const shiftsD = S.dragState
      ? shiftAmounts(S.dragState.insertIndex, S.dragState.originIndex, elsD.length)
      : new Array(elsD.length).fill(0);
    const stepD = (S.OPT.iconSize + gapPx()) * (S.fitScale || 1);
    const vertD = isVert();
    let allSettled = true;
    elsD.forEach((el, i) => {
      const holder = slotMap.get(el.dataset.id);
      if (!holder) return;
      const target = (shiftsD[i] || 0) * stepD;
      if (!holder.shift) holder.shift = { pos: 0, vel: 0 };
      const st = Spring.stepSpring(holder.shift.pos, holder.shift.vel, target, 0.22, 0.62);
      holder.shift = { pos: st.pos, vel: st.vel };
      if (Math.abs(st.pos) > 0.05) {
        el.style.transform = vertD ? `translateY(${st.pos}px)` : `translateX(${st.pos}px)`;
      } else {
        el.style.transform = '';
      }
      if (!st.settled) allSettled = false;
    });
    if (!S.dragState && allSettled) {
      S.shiftRelease = false;
      elsD.forEach((el) => { el.style.transform = ''; });
    }
    shiftBusy = !!S.dragState || !allSettled;
  }

  let maxSize = 0;
  for (const s of arr) {
    const base = (s.baseSize || S.OPT.iconSize) * S.fitScale;
    const size = Math.round(base * s.cur.scale);
    if (size > maxSize) maxSize = size;
    // 槽位主轴随缩放变化（垂直条变高、水平条变宽）。侧栏时槽宽同步增长：
    // items 交叉轴居中、玻璃板宽度自适应内容，板体随之朝屏幕内侧增宽
    // （macOS 侧栏放大行为），放大图标不再横向穿出板外
    if (vert) {
      s.el.style.height = size + 'px';
      s.el.style.width = size + 'px';
    } else {
      s.el.style.width = size + 'px';
    }
    // P2-F2 指示点锚定：lift 施加在 img（transform 不参与布局 → wrap 尺寸不变 →
    // 指示点 bottom:-4px 锚定玻璃底座不动），macOS 观感：放大图标向上浮出、点留在底座。
    // 侧栏 lift 改 X 轴，朝屏幕内侧浮出；slot 的 transform 归拖拽避让专用（互不踩踏）。
    const img = s.el.querySelector('img.app-icon');
    if (img) {
      img.style.width = size + 'px';
      img.style.height = size + 'px';
      const lift = Math.round((size - base) * 0.14);
      if (lift > 0) {
        img.style.transform = vert
          ? `translateX(${S.POS === 'left' ? lift : -lift}px)`
          : `translateY(-${lift}px)`;
      } else {
        img.style.transform = '';
      }
    }
  }
  // 面板随放大增高（macOS 行为）：底边贴屏不动、顶边上移（dock-root 为
  // align-items:flex-end，改高即向上生长），放大图标不再穿出玻璃板。
  if (!vert) {
    const targetH = Math.max(S.OPT.iconSize * (S.fitScale || 1) + 18, maxSize + 10);
    const curH = parseFloat(barEl.style.height) || 0;
    if (Math.abs(curH - targetH) >= 1) barEl.style.height = targetH + 'px';
  }

  const settled = arr.every(s => s.cur.scale === s.targetScale);
  const active = S.pointerInsideBar || Date.now() - S.lastInteractTs < 280;
  // P2-F1b：避让弹簧未 settled 时不自停（回位动画播完才停 rAF）
  return !settled || active || shiftBusy;
}

// vsync 对齐的 rAF 驱动（setInterval 精度 ~15.6ms 且不同步 vsync，动画必抖）；
// 单帧异常只跳过该帧，循环不中断

function frame() {
  if (!S.rafRunning) return;
  let more = true;
  try { more = layoutTick(); } catch { more = true; }
  if (more) requestAnimationFrame(frame);
  else S.rafRunning = false;
}

export function ensureRaf() {
  if (!S.rafRunning) {
    S.rafRunning = true;
    requestAnimationFrame(frame);
  }
}

export function requestLayout() {
  S.lastInteractTs = Date.now();
  ensureRaf();
}

// =====================================================================
//  鼠标跟踪 / 点击穿透协同
// =====================================================================

function processMousePosition() {
  S.mouseProcQueued = false;
  // P1-F2：鼠标移动进 Dock 即清除键盘焦点态（两套焦点视觉互不干扰）
  if (S.kbdNavActive && S.pointerInsideBar) hooks.kbdNavClear();
  const barRect = barEl.getBoundingClientRect();
  const overBar = !S.dockHiddenNow && !S.fullscreenHideNow && pointOverBar(barRect, S.mouseX, S.mouseY);

  const overlayOpen = S.menuOpen || !!S.stackCurrent || !!S.previewState;
  if (overBar !== S.pointerInsideBar && !overlayOpen) {
    S.pointerInsideBar = overBar;
    window.dock.invoke('set-click-through', { on: !overBar });
  }
  if (overBar && S.autohideHideTimer) {
    clearTimeout(S.autohideHideTimer);
    S.autohideHideTimer = null;
  }

  // 贴边唤醒：Dock 被隐藏（自动隐藏/全屏让位/覆盖让位）时，压住所在屏幕边缘 150ms 唤回。
  const atEdge = (S.dockHiddenNow || S.fullscreenHideNow || S.coveredHideNow) &&
    (S.POS === 'bottom' ? S.mouseY >= window.innerHeight - 10
      : S.POS === 'left' ? S.mouseX <= 10
      : S.mouseX >= window.innerWidth - 10);
  if (atEdge && !S.wakeTimer) {
    S.wakeTimer = setTimeout(() => {
      S.wakeTimer = null;
      window.dock.invoke('request-show');
    }, Math.max(0, Number(S.OPT.showDelayMs) || 150));   // 对齐 macOS autohide-delay 语义，config.json 可调
  } else if (!atEdge && S.wakeTimer) {
    clearTimeout(S.wakeTimer);
    S.wakeTimer = null;
  }
}

document.addEventListener('mousemove', (ev) => {
  S.mouseX = ev.clientX;
  S.mouseY = ev.clientY;
  S.lastInteractTs = Date.now();
  // 高频 mousemove（可达 500Hz+）比帧率高一个量级：完整处理（读 rect + 穿透判定）
  // 去抖到每帧一次，事件流里只更新坐标；否则鼠标一动就强制 layout 空转
  if (!S.mouseProcQueued) {
    S.mouseProcQueued = true;
    requestAnimationFrame(processMousePosition);
  }
  ensureRaf();
}, { passive: true });

document.addEventListener('mouseleave', () => {
  S.mouseX = -9999; S.mouseY = -9999;
  S.pointerInsideBar = false;
  if (!S.menuOpen && !S.stackCurrent && !S.previewState) {
    window.dock.invoke('set-click-through', { on: true });
  }
  hooks.cancelTooltip();
  hooks.hidePreview();
  requestLayout();
});

// =====================================================================
// ---------------------------------------------------------------- 分隔线拖宽（P1-F3）

// 主分隔线拖拽调整图标尺寸：36–72px 与设置滑块同范围，写回走 set-setting（iconSize），
// 设置面板数值经 broadcastSettings 双向同步。
// 拖动期间冻结鱼眼（computeTargets 全部回静止态）防止布局抖动；mouseup 解除。

export function startDividerResize(ev) {
  hooks.cancelTooltip();
  // 方向感知：底部 Dock 用垂直位移、侧栏用水平位移；朝屏幕外侧拖 = 增大
  const origin = isVert() ? ev.clientX : ev.clientY;
  const startSize = S.OPT.iconSize;
  S.fisheyeFrozen = true;
  S.mouseX = -9999; S.mouseY = -9999;   // 立即回静止态
  ensureRaf();

  const onMove = (mev) => {
    if (mev.buttons !== 1) { finishDividerResize(); return; }
    let raw;
    if (S.POS === 'bottom') raw = mev.clientY - origin;               // 向下（屏幕外）= 增大
    else if (S.POS === 'left') raw = origin - mev.clientX;            // 向左（屏幕外）= 增大
    else raw = mev.clientX - origin;                                // 向右（屏幕外）= 增大
    // 每累计 4px 位移 = 1 级图标尺寸
    const next = Math.min(72, Math.max(36, startSize + Math.round(raw / 4)));
    if (next !== S.OPT.iconSize) {
      window.dock.invoke('set-setting', { key: 'iconSize', value: next });
    }
  };
  const finishDividerResize = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    S.fisheyeFrozen = false;
    S.mouseX = -9999; S.mouseY = -9999;   // 松手瞬间不保留陈旧放大目标
    ensureRaf();
  };
  const onUp = () => finishDividerResize();
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

