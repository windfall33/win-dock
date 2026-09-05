'use strict';
/* =====================================================================
   macOS Dock for Windows — renderer
   鱼眼放大 / 指示点 / tooltip / 右键菜单 / 拖拽排序 / 文件投放 / 自动隐藏
   ===================================================================== */

const $ = (sel) => document.querySelector(sel);
const itemsEl = $('#dock-items');
const barEl = $('#dock-bar');
const rootEl = $('#dock-root');
const tooltipEl = $('#tooltip');
const menuLayerEl = $('#menu-layer');
const ghostEl = $('#drag-ghost');
const previewEl = $('#preview-panel');
const stackPanelEl = $('#stack-panel');

let STATE = null;
let slotMap = new Map();   // id -> {el, cur:{scale}, targetScale, entry}
let mouseX = -9999, mouseY = -9999;
let pointerInsideBar = false;
let lastInteractTs = 0;
let dockHiddenNow = false;
let fullscreenHideNow = false;
let coveredHideNow = false;
let appActiveNow = false;      // 前台是应用窗口（非桌面）：用于更快的智能收起
let POS = 'bottom';            // dock 位置：bottom | left | right（镜像主进程 settings.position）
const winCountPrev = new Map(); // 活动指示：记录每应用上次窗口数，检测新增窗口

let bounceSet = new Set();
let sessionOrder = null;

// ---------------------------------------------------------------- settings

let OPT = {
  iconSize: 52,
  magnification: 1.8,
  autohide: false,
};

function isVert() {
  return POS === 'left' || POS === 'right';
}

// 把当前位置写到 <html data-pos="...">，侧栏形态的 CSS 选择器据此切换；
// 底部是默认形态，不需要专门的 data-pos 规则。
function applyPosClass() {
  document.documentElement.dataset.pos = POS;
}

function syncCssVars() {
  rootEl.style.setProperty('--is', OPT.iconSize + 'px');
  // 底部条高恒定（放大时图标浮出条外）；侧栏（左/右）条竖向撑满窗口，图标竖直排布
  barEl.style.height = isVert() ? '100%' : (OPT.iconSize + 18) + 'px';
  // P1-F3：iconSize 变化同步刷新槽位基准尺寸——holder 的 baseSize 是 append 时快照，
  // 不随 rebuild 更新，拖宽/滑块调整后 layoutTick 会拿旧基准算放大，必须在此同步
  for (const [, s] of slotMap) {
    const k = s.el.dataset.kind;
    s.baseSize = (k === 'recent' || k === 'min') ? Math.round(OPT.iconSize * 0.72) : OPT.iconSize;
  }
}

window.dock.onSettings((s) => {
  Object.assign(OPT, {
    iconSize: s.iconSize,
    magnification: s.magnification,
    autohide: s.autohide,
  });
  syncCssVars();
  syncAutohideTimer();
  appearanceChanged(s.appearance);
  requestLayout();
});

function appearanceChanged(mode) {
  const dark = mode === 'dark' ||
    ((mode === undefined || mode === 'system') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

// =====================================================================
//  图标兜底：字母磁贴 + 废纸篓矢量图标
// =====================================================================

function letterTile(name) {
  const letter = encodeURIComponent((name || '?').trim().charAt(0).toUpperCase() || '?');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#6f9ef2"/><stop offset="1" stop-color="#3f66d4"/>
      </linearGradient></defs>
      <rect width="128" height="128" rx="28" fill="url(#g)"/>
      <text x="64" y="88" font-size="70" font-family="Segoe UI,sans-serif"
        fill="#fff" text-anchor="middle">${letter}</text>
    </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function trashSvg(full) {
  const papers = full ? `
    <path d="M36 26 L48 14 L58 24 L70 18 L74 30 L52 33 Z" fill="#f5f6f7"/>
    <path d="M46 20 L62 13 L74 24 L66 31 Z" fill="#e3e5e8"/>
    <path d="M30 28 L42 22 L40 32 Z" fill="#dcdee1"/>` : '';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
      <defs>
        <linearGradient id="m1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#eceff1"/><stop offset=".45" stop-color="#aeb6bd"/>
          <stop offset="1" stop-color="#cfd4d9"/>
        </linearGradient>
        <linearGradient id="m2" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".85"/>
          <stop offset=".22" stop-color="#ffffff" stop-opacity="0"/>
          <stop offset=".78" stop-color="#000000" stop-opacity=".06"/>
          <stop offset="1" stop-color="#000000" stop-opacity=".18"/>
        </linearGradient>
      </defs>
      ${papers}
      <ellipse cx="64" cy="34" rx="36" ry="7.5" fill="#99a0a7"/>
      <path d="M28 34 C28 34 33 96 37 104 C43 112 85 112 91 104
               C95 96 100 34 100 34 C100 40 82 45 64 45 C46 45 28 40 28 34 Z"
            fill="url(#m1)"/>
      <path d="M28 34 C28 34 33 96 37 104 C43 112 85 112 91 104
               C95 96 100 34 100 34 C100 40 82 45 64 45 C46 45 28 40 28 34 Z"
            fill="url(#m2)"/>
      <g stroke="#878f97" stroke-opacity=".55" stroke-width="1.6" fill="none">
        <path d="M40 41 L45 106"/><path d="M52 43.5 L54 109.5"/>
        <path d="M64 44.5 L64 110.5"/><path d="M76 43.5 L74 109.5"/>
        <path d="M88 41 L83 106"/>
      </g>
      <g stroke="#fdfefe" stroke-opacity=".5" stroke-width="1.1" fill="none">
        <path d="M44 42 L48.5 107"/><path d="M58 43.8 L59.4 110"/>
        <path d="M70 43.8 L68.8 110"/><path d="M84 42 L79.8 107"/>
      </g>
      <path d="M28 34 C28 40 46 45 64 45 C82 45 100 40 100 34
               C100 29 84 26.5 64 26.5 C44 26.5 28 29 28 34 Z"
            fill="#b6bcc3"/>
      <path d="M28 34 C28 40 46 45 64 45 C82 45 100 40 100 34
               C100 29 84 26.5 64 26.5 C44 26.5 28 29 28 34 Z"
            fill="url(#m2)" opacity=".7"/>
      <ellipse cx="64" cy="33" rx="34" ry="6" fill="none" stroke="#7c848c" stroke-width="1.4"/>
    </svg>`);
}

function folderSvg() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
      <defs>
        <linearGradient id="f1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#8bb8f5"/>
          <stop offset="1" stop-color="#3f66d4"/>
        </linearGradient>
        <linearGradient id="f2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#79a8ef"/>
          <stop offset="1" stop-color="#4a6fd6"/>
        </linearGradient>
      </defs>
      <path d="M18 34 C18 30 22 26 27 26 L47 26 L55 36 L101 36 C106 36 110 40 110 45 L110 44 L110 96 C110 101 106 105 101 105 L27 105 C22 105 18 101 18 96 Z" fill="url(#f1)"/>
      <path d="M18 44 L110 44 L110 96 C110 101 106 105 101 105 L27 105 C22 105 18 101 18 96 Z" fill="url(#f2)"/>
      <rect x="18" y="34" width="92" height="8" rx="3" fill="#5b7fe0" opacity=".55"/>
    </svg>`);
}

// =====================================================================
//  状态接收与渲染
// =====================================================================

function applyEnv(env) {
  if (!env) return;
  dockHiddenNow = !!env.dockHidden;
  fullscreenHideNow = !!env.fullscreenHide;
  coveredHideNow = !!env.coveredHide;
  appActiveNow = !!env.appActive;
  syncAutohideTimer();   // appActive 状态变化时启停「智能收起」检测
  if (env.position && env.position !== POS) {
    POS = env.position;
    applyPosClass();
    syncCssVars();
  }
  if (env.edgeInset !== undefined) {
    rootEl.style.setProperty('--edge-inset', Math.round(env.edgeInset) + 'px');
  }
  // 自动隐藏（dockHiddenNow）：只能靠「贴到最底边」由主进程 request-show 解除，
  // 绝不能在鼠标位于屏幕下方时被 dockStayZone 撑开 —— 否则点应用底部的对话框
  // 就会误唤醒 dock、挡住正在操作的内容。
  // 让位隐藏（全屏/覆盖）：仅鼠标停留 Dock 保持区时才暂不隐藏（macOS 压边 dock 保持），
  // 鼠标真正离开 dock 区才让位；这样既不误唤醒，也不在边缘来回抽。
  const letHide = fullscreenHideNow || coveredHideNow;
  const hide = dockHiddenNow || (letHide && !dockStayZone());
  rootEl.classList.toggle('hidden-away', hide);
  // 隐藏时整窗必须穿透，探针负责唤回
  if (hide && pointerInsideBar) {
    pointerInsideBar = false;
    window.dock.invoke('set-click-through', { on: true });
  }
  // 主进程全局光标兜底：透明窗口在穿透切换瞬间可能收不到 mouseleave，
  // 渲染层会卡在放大态；光标已离开 Dock 区域即强制复位。
  // （唤醒竞态已在源头修复：request-show 时主进程会置 pointerNearDock=true，
  //   不会再用陈旧的 false 把刚唤醒的 Dock 打回穿透）
  // 菜单/预览/Stack 打开时不能收回穿透：否则点空白处关不掉弹层（弹层会永久卡住）。
  const overlayOpen = menuOpen || !!stackCurrent || !!previewState;
  if (env.pointerNearDock === false && !overlayOpen && !dockStayZone() &&
      (pointerInsideBar || mouseX > -1000)) {
    pointerInsideBar = false;
    mouseX = -9999; mouseY = -9999;
    cancelTooltip();
    hidePreview();
    window.dock.invoke('set-click-through', { on: true });
    ensureRaf();
  }
}

window.dock.onState((snap) => {
  STATE = snap;
  if (snap.settings) {
    OPT.iconSize = snap.settings.iconSize || OPT.iconSize;
    OPT.magnification = snap.settings.magnification || OPT.magnification;
    OPT.autohide = !!snap.settings.autohide;
    syncCssVars();
    syncAutohideTimer();
  }
  applyEnv(snap.env);
  reconcile();
});

window.dock.onEnv(applyEnv);

async function init() {
  await window.dock.invoke('ready');
  try {
    const snap = await window.dock.getSnapshot();
    if (snap) {
      STATE = snap;
      if (snap.settings) {
        Object.assign(OPT, {
          iconSize: snap.settings.iconSize,
          magnification: snap.settings.magnification,
          autohide: !!snap.settings.autohide,
        });
      }
    }
  } catch {}
  if (STATE && STATE.env) applyEnv(STATE.env);
  if (STATE && STATE.settings && STATE.settings.position) POS = STATE.settings.position;
  applyPosClass();
  appearanceChanged((STATE && STATE.settings && STATE.settings.appearance) || 'system');
  syncCssVars();
  reconcile();
  ensureRaf();
}
init();

function effectiveEntries() {
  if (!STATE) return [];
  let entries = STATE.entries || [];
  if (sessionOrder) {
    const idx = new Map(sessionOrder.map((id, i) => [id, i]));
    const allKnown = entries.every(e => idx.has(e.id)) && entries.length === sessionOrder.length;
    if (allKnown) {
      entries = entries.slice().sort((a, b) => idx.get(a.id) - idx.get(b.id));
    } else {
      sessionOrder = null;
    }
  }
  return entries.filter(e => e.kind === 'app' || e.kind === 'folder');
}

function reconcile() {
  const currentIds = [...itemsEl.children]
    .filter(el => el.dataset.kind)
    .map(el => el.dataset.id);
  const wantedIds = wantedSlotIds();

  const sameShape = currentIds.length === wantedIds.length &&
    wantedIds.every((id, i) => currentIds[i] === id);

  if (!sameShape) rebuildAll();
  else updateSlots();

  sendBarRect();
  ensureRaf();
}

// 条矩形上报（DIP）：遮挡判定用可见条区域，而非含预览留白的整个窗口
let lastBarRectKey = '';

function sendBarRect() {
  // hidden-away 的 translateY 位移会被 getBoundingClientRect 计入，
  // 若在隐藏态上报会把条矩形"移出屏幕"→ 遮挡判定翻转 → 出现/消失振荡；
  // 隐藏期间保持主进程里最后一次可见矩形即可
  if (rootEl.classList.contains('hidden-away')) return;
  const r = barEl.getBoundingClientRect();
  const key = Math.round(r.left) + ',' + Math.round(r.top) + ',' +
              Math.round(r.width) + ',' + Math.round(r.height);
  if (key === lastBarRectKey) return;
  lastBarRectKey = key;
  window.dock.invoke('set-bar-rect', { x: r.x, y: r.y, w: r.width, h: r.height });
}

function wantedSlotIds() {
  const ids = effectiveEntries().map((e) => e.id);
  const recents = (STATE && STATE.recent) || [];
  const mins = (STATE && STATE.minimized) || [];
  ids.push('__divider__');
  ids.push(...recents.map((r) => r.id));
  if (mins.length) {
    if (recents.length) ids.push('__divider2__');
    ids.push(...mins.map((m) => m.id));
  }
  if (recents.length || mins.length) ids.push('__divider3__');
  ids.push('__trash__');
  return ids;
}

// ---------------------------------------------------------------- build

function makeAppSlot(entry) {
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.tabIndex = 0;
  slot.dataset.kind = entry.kind || 'app';
  slot.dataset.id = entry.id;

  const wrap = document.createElement('div');
  wrap.className = 'icon-wrap';
  const img = document.createElement('img');
  img.className = 'app-icon';
  img.draggable = false;
  wrap.appendChild(img);
  const badge = document.createElement('div');
  badge.className = 'badge';
  wrap.appendChild(badge);
  const dot = document.createElement('div');
  dot.className = 'running-dot';
  wrap.appendChild(dot);
  slot.appendChild(wrap);

  return slot;
}

function makeDivider(id) {
  const s = document.createElement('div');
  // 仅主分隔线可拖宽（hover 光标提示 + 拖拽目标）
  s.className = 'divider-slot' + (id === '__divider__' ? ' divider-resizable' : '');
  s.dataset.kind = 'divider';
  s.dataset.id = id;
  s.innerHTML = '<div class="divider"></div>';
  return s;
}

function makeRecentSlot(entry) {
  const slot = document.createElement('div');
  slot.className = 'slot recent-slot';
  slot.tabIndex = 0;
  slot.dataset.kind = 'recent';
  slot.dataset.id = entry.id;
  const wrap = document.createElement('div');
  wrap.className = 'icon-wrap';
  const img = document.createElement('img');
  img.className = 'app-icon';
  img.draggable = false;
  wrap.appendChild(img);
  slot.appendChild(wrap);
  return slot;
}

// 最小化窗口方块（macOS 右侧分区）：小尺寸、无指示点、不可拖拽
function makeMinSlot(entry) {
  const slot = document.createElement('div');
  slot.className = 'slot min-slot';
  slot.tabIndex = 0;
  slot.dataset.kind = 'min';
  slot.dataset.id = entry.id;
  const wrap = document.createElement('div');
  wrap.className = 'icon-wrap';
  const img = document.createElement('img');
  img.className = 'app-icon';
  img.draggable = false;
  wrap.appendChild(img);
  slot.appendChild(wrap);
  return slot;
}

function makeTrashSlot() {
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.tabIndex = 0;
  slot.dataset.kind = 'trash';
  slot.dataset.id = '__trash__';
  const wrap = document.createElement('div');
  wrap.className = 'icon-wrap';
  const img = document.createElement('img');
  img.className = 'app-icon';
  img.draggable = false;
  wrap.appendChild(img);
  slot.appendChild(wrap);
  applyEntryToSlot(slot, { kind: 'trash' });
  return slot;
}

function applyEntryToSlot(slot, entry) {
  if (slot.dataset.kind === 'min') {
    const img = slot.querySelector('img.app-icon');
    const url = entry.icon || letterTile(entry.appName || entry.title);
    if (img.dataset.curSrc !== url.slice(-120)) {
      img.dataset.curSrc = url.slice(-120);
      img.src = url;
    }
    applyPlate(slot, entry.icon);
    slot.classList.toggle('running', false);
    slot.dataset.title = entry.title || '';
    return;
  }

  if (slot.dataset.kind === 'recent') {
    const img = slot.querySelector('img.app-icon');
    const url = entry.icon || letterTile(entry.name);
    if (img.dataset.curSrc !== url.slice(-120)) {
      img.dataset.curSrc = url.slice(-120);
      img.src = url;
    }
    applyPlate(slot, entry.icon);
    slot.classList.toggle('running', false);
    slot.dataset.name = entry.name || '';
    return;
  }

  if (slot.dataset.kind === 'trash') {
    const count = (STATE && STATE.trash && STATE.trash.count) || 0;
    const img = slot.querySelector('img.app-icon');
    const key = 'full:' + (count > 0 ? 1 : 0);
    if (img.dataset.trashKey !== key) {
      img.dataset.trashKey = key;
      img.src = trashSvg(count > 0);
    }
    slot.classList.toggle('running', false);
    return;
  }

  if (slot.dataset.kind === 'folder') {
    const img = slot.querySelector('img.app-icon');
    const url = entry.icon || folderSvg();
    if (img.dataset.curSrc !== url.slice(-120)) {
      img.dataset.curSrc = url.slice(-120);
      img.src = url;
    }
    slot.classList.toggle('running', false);
    slot.dataset.name = entry.name || '';
    slot.dataset.path = entry.folderPath || entry.exe || '';
    slot.classList.toggle('bouncing', false);
    return;
  }

  const img = slot.querySelector('img.app-icon');
  const url = entry.icon || letterTile(entry.name);
  if (img.dataset.curSrc !== url.slice(-120)) {
    img.dataset.curSrc = url.slice(-120);
    img.src = url;
  }
  applyPlate(slot, entry.icon);
  slot.classList.toggle('running',
    Array.isArray(entry.windows) && entry.windows.length > 0);
  slot.dataset.name = entry.name || '';
  slot.dataset.exe = entry.exe || '';
  slot.classList.toggle('bouncing', bounceSet.has(entry.id));
  const badgeEl = slot.querySelector('.badge');
  if (badgeEl) {
    const n = entry.badge | 0;
    badgeEl.textContent = n > 99 ? '99+' : (n > 0 ? String(n) : '');
    badgeEl.classList.toggle('on', n > 0);
  }
}

function rebuildAll() {
  const prevScales = new Map();
  for (const [id, s] of slotMap) prevScales.set(id, s.cur.scale);

  slotMap.clear();
  itemsEl.innerHTML = '';

  const append = (id, el, kind, baseSize, entry) => {
    slotMap.set(id, {
      el,
      cur: { scale: prevScales.get(id) == null ? 1 : prevScales.get(id) },
      targetScale: 1,
      baseSize,
      entry,
    });
    itemsEl.appendChild(el);
  };

  for (const entry of effectiveEntries()) {
    const el = makeAppSlot(entry);
    applyEntryToSlot(el, entry);
    append(entry.id, el, entry.kind || 'app', OPT.iconSize, entry);
  }

  const recents = (STATE && STATE.recent) || [];
  const mins = (STATE && STATE.minimized) || [];
  append('__divider__', makeDivider('__divider__'), 'divider', OPT.iconSize, null);
  for (const r of recents) {
    const el = makeRecentSlot(r);
    applyEntryToSlot(el, r);
    append(r.id, el, 'recent', Math.round(OPT.iconSize * 0.72), r);
  }
  if (mins.length) {
    if (recents.length) {
      append('__divider2__', makeDivider('__divider2__'), 'divider', OPT.iconSize, null);
    }
    for (const m of mins) {
      const el = makeMinSlot(m);
      applyEntryToSlot(el, m);
      append(m.id, el, 'min', Math.round(OPT.iconSize * 0.72), m);
    }
  }
  // 废纸篓前一条分隔线（macOS 形态）；最近/最小化区为空时避免与 divider 相邻成双线
  if (recents.length || mins.length) {
    append('__divider3__', makeDivider('__divider3__'), 'divider', OPT.iconSize, null);
  }

  const trash = makeTrashSlot();
  applyEntryToSlot(trash, { kind: 'trash' });
  append('__trash__', trash, 'trash', OPT.iconSize, { kind: 'trash' });
}

function updateSlots() {
  for (const entry of effectiveEntries()) {
    const s = slotMap.get(entry.id);
    if (!s) continue;
    s.entry = entry;
    applyEntryToSlot(s.el, entry);
    // 活动指示：某应用窗口数增加时图标短暂微光（mac 图标活动提示的近似）
    if (entry.kind === 'app') {
      const n = (entry.windows || []).length;
      const prev = winCountPrev.get(entry.id);
      if (prev !== undefined && n > prev) {
        const el = s.el;
        el.classList.add('active-glow');
        setTimeout(() => el.classList.remove('active-glow'), 700);
      }
      winCountPrev.set(entry.id, n);
    }
  }
  for (const r of (STATE && STATE.recent) || []) {
    const s = slotMap.get(r.id);
    if (!s) continue;
    s.entry = r;
    applyEntryToSlot(s.el, r);
  }
  for (const m of (STATE && STATE.minimized) || []) {
    const s = slotMap.get(m.id);
    if (!s) continue;
    s.entry = m;
    applyEntryToSlot(s.el, m);
  }
  const trash = slotMap.get('__trash__');
  if (trash) applyEntryToSlot(trash.el, { kind: 'trash' });
}

// =====================================================================
//  布局与鱼眼放大（核心）
// =====================================================================

// 鼠标是否停在 Dock 所处屏幕边缘的「保持区」内。
// 用固定的屏幕边缘距离而非 bar 的 getBoundingClientRect：后者会随 hidden-away 的
// translate 位移变化，若用它判断会与隐藏动作形成正反馈（隐藏→矩形移动→判定翻转→显示）。
// 保持区宽度刻意大于唤醒带（20px），宁可晚隐藏也不在边缘来回抽。
const DOCK_STAY_MARGIN = 160;
function dockStayZone() {
  if (mouseX < -1000 || mouseY < -1000) return false;
  return POS === 'bottom' ? mouseY >= window.innerHeight - DOCK_STAY_MARGIN
    : POS === 'left' ? mouseX <= DOCK_STAY_MARGIN
    : mouseX >= window.innerWidth - DOCK_STAY_MARGIN;
}

// 指针是否落在 Dock 条热区上（含放大余量）。底部条向上扩一个图标尺寸；
// 侧栏沿水平方向扩一个图标尺寸（横向伸进屏幕），纵向覆盖整条。
function pointOverBar(rect, mx, my) {
  if (mx < -1000 || my < -1000) return false;
  if (isVert()) {
    return my >= rect.top && my <= rect.bottom &&
      mx >= rect.left - OPT.iconSize && mx <= rect.right + OPT.iconSize;
  }
  return mx >= rect.left && mx <= rect.right &&
    my >= rect.top - OPT.iconSize && my <= rect.bottom + 4;
}

function computeTargets(mx, my) {
  const out = [];
  // P1-F3：分隔线拖宽期间冻结鱼眼放大，防止布局抖动
  if (fisheyeFrozen) {
    for (const [, s] of slotMap) {
      if (s.el.isConnected) out.push({ s, t: 1 });
    }
    return out;
  }
  const barRect = barEl.getBoundingClientRect();
  // 每帧用鼠标实时位置判断是否在 Dock 栏上，避免状态变量过期导致缩放卡死
  const overBar = !dockHiddenNow && !fullscreenHideNow && pointOverBar(barRect, mx, my);

  for (const [, s] of slotMap) {
    if (!s.el.isConnected) continue;
    if (!overBar) { out.push({ s, t: 1 }); continue; }
    const BASE = s.baseSize || OPT.iconSize;
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
      const vD = Math.max(0, (POS === 'left' ? mx - barRect.left : barRect.right - mx));
      vmod = Math.max(0.2, 1 - vD / (BASE * 2.6));
    }
    out.push({ s, t: 1 + (OPT.magnification - 1) * k * vmod });
  }
  return out;
}

function layoutTick() {
  const targets = computeTargets(mouseX, mouseY);
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
  // 拖拽结束后 shiftRelease 目标归零，弹簧自然回位，全部 settled 后清除。
  let shiftBusy = false;
  if (dragState || shiftRelease) {
    const elsD = appSlotEls();
    const shiftsD = dragState
      ? shiftAmounts(dragState.insertIndex, dragState.originIndex, elsD.length)
      : new Array(elsD.length).fill(0);
    const stepD = OPT.iconSize + gapPx();
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
    if (!dragState && allSettled) {
      shiftRelease = false;
      elsD.forEach((el) => { el.style.transform = ''; });
    }
    shiftBusy = !!dragState || !allSettled;
  }

  const vert = isVert();
  let maxSize = 0;
  for (const s of arr) {
    const base = s.baseSize || OPT.iconSize;
    const size = Math.round(base * s.cur.scale);
    if (size > maxSize) maxSize = size;
    // 槽位只沿主轴变尺寸（垂直条变高、水平条变宽），条厚保持恒定
    if (vert) s.el.style.height = size + 'px';
    else s.el.style.width = size + 'px';
    const img = s.el.querySelector('img.app-icon');
    if (img) {
      img.style.width = size + 'px';
      img.style.height = size + 'px';
    }
    // macOS 形态：放大时图标向上浮出底座，运行指示点随图标一起上移；静止时归零。
    const lift = Math.round((size - base) * 0.14);
    s.el.style.transform = lift > 0 ? `translateY(-${lift}px)` : '';
  }
  // 面板随放大增高（macOS 行为）：底边贴屏不动、顶边上移（dock-root 为
  // align-items:flex-end，改高即向上生长），放大图标不再穿出玻璃板。
  if (!vert) {
    const targetH = Math.max(OPT.iconSize + 18, maxSize + 10);
    const curH = parseFloat(barEl.style.height) || 0;
    if (Math.abs(curH - targetH) >= 1) barEl.style.height = targetH + 'px';
  }

  const settled = arr.every(s => s.cur.scale === s.targetScale);
  const active = pointerInsideBar || Date.now() - lastInteractTs < 280;
  // P2-F1b：避让弹簧未 settled 时不自停（回位动画播完才停 rAF）
  return !settled || active || shiftBusy;
}

// vsync 对齐的 rAF 驱动（setInterval 精度 ~15.6ms 且不同步 vsync，动画必抖）；
// 单帧异常只跳过该帧，循环不中断
let rafRunning = false;

function frame() {
  if (!rafRunning) return;
  let more = true;
  try { more = layoutTick(); } catch { more = true; }
  if (more) requestAnimationFrame(frame);
  else rafRunning = false;
}

function ensureRaf() {
  if (!rafRunning) {
    rafRunning = true;
    requestAnimationFrame(frame);
  }
}

function requestLayout() {
  lastInteractTs = Date.now();
  ensureRaf();
}

// =====================================================================
//  鼠标跟踪 / 点击穿透协同
// =====================================================================

let mouseProcQueued = false;

function processMousePosition() {
  mouseProcQueued = false;
  // P1-F2：鼠标移动进 Dock 即清除键盘焦点态（两套焦点视觉互不干扰）
  if (kbdNavActive && pointerInsideBar) kbdNavClear();
  const barRect = barEl.getBoundingClientRect();
  const overBar = !dockHiddenNow && !fullscreenHideNow && pointOverBar(barRect, mouseX, mouseY);

  const overlayOpen = menuOpen || !!stackCurrent || !!previewState;
  if (overBar !== pointerInsideBar && !overlayOpen) {
    pointerInsideBar = overBar;
    window.dock.invoke('set-click-through', { on: !overBar });
  }
  if (overBar && autohideHideTimer) {
    clearTimeout(autohideHideTimer);
    autohideHideTimer = null;
  }

  // 贴边唤醒：Dock 被隐藏（自动隐藏/全屏让位/覆盖让位）时，压住所在屏幕边缘 150ms 唤回。
  const atEdge = (dockHiddenNow || fullscreenHideNow || coveredHideNow) &&
    (POS === 'bottom' ? mouseY >= window.innerHeight - 10
      : POS === 'left' ? mouseX <= 10
      : mouseX >= window.innerWidth - 10);
  if (atEdge && !wakeTimer) {
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      window.dock.invoke('request-show');
    }, 150);
  } else if (!atEdge && wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
}

document.addEventListener('mousemove', (ev) => {
  mouseX = ev.clientX;
  mouseY = ev.clientY;
  lastInteractTs = Date.now();
  // 高频 mousemove（可达 500Hz+）比帧率高一个量级：完整处理（读 rect + 穿透判定）
  // 去抖到每帧一次，事件流里只更新坐标；否则鼠标一动就强制 layout 空转
  if (!mouseProcQueued) {
    mouseProcQueued = true;
    requestAnimationFrame(processMousePosition);
  }
  ensureRaf();
}, { passive: true });

let wakeTimer = null;

document.addEventListener('mouseleave', () => {
  mouseX = -9999; mouseY = -9999;
  pointerInsideBar = false;
  if (!menuOpen && !stackCurrent && !previewState) {
    window.dock.invoke('set-click-through', { on: true });
  }
  cancelTooltip();
  hidePreview();
  requestLayout();
});

// =====================================================================
//  tooltip
// =====================================================================

let tipTimer = null, tipSlotEl = null;

function cancelTooltip() {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
  tooltipEl.classList.remove('visible');
  tipSlotEl = null;
}

itemsEl.addEventListener('mouseover', (ev) => {
  const slot = ev.target.closest('.slot');
  if (!slot || slot === tipSlotEl) return;
  cancelTooltip();
  tipSlotEl = slot;
  tipTimer = setTimeout(() => {
    const text = slot.dataset.kind === 'trash'
      ? '回收站'
      : slot.dataset.kind === 'min'
        ? (slot.dataset.title || '')
        : (slot.dataset.name || '');
    if (!text) return;
    tooltipEl.textContent = text;
    const r = slot.getBoundingClientRect();
    const barRect = barEl.getBoundingClientRect();
    const tw = tooltipEl.offsetWidth || 60;
    if (!isVert()) {
      let x = r.left + r.width / 2;
      x = Math.min(Math.max(x, tw / 2 + 8), window.innerWidth - tw / 2 - 8);
      tooltipEl.style.left = x + 'px';
      tooltipEl.style.top = Math.max(4, barRect.top - 36) + 'px';
    } else {
      // 侧栏：tooltip 出现在条的内侧，与槽位垂直居中
      let y = r.top + r.height / 2;
      y = Math.min(Math.max(y, 16), window.innerHeight - 16);
      tooltipEl.style.top = y + 'px';
      tooltipEl.style.left = POS === 'left'
        ? (barRect.right + 10) + 'px'
        : (barRect.left - 10 - tw) + 'px';
    }
    tooltipEl.classList.add('visible');
  }, 420);
});
itemsEl.addEventListener('mouseout', (ev) => {
  const to = ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest('.slot');
  if (to !== tipSlotEl) cancelTooltip();
});
barEl.addEventListener('mouseleave', cancelTooltip);

// =====================================================================
//  窗口缩略图预览（悬停运行中应用图标 → 面板弹出）
// =====================================================================

let previewState = null;      // { appId, refreshTimer }
let previewHideTimer = null;
let previewPendingApp = null;
let previewPendingTimer = null;
let previewPinned = false;      // 点击已聚焦多窗口时打开的窗口网格：不因 hover 计时器自动关闭

function poofSvg() {
  const dots = [[30,42,16],[62,26,20],[88,48,15],[40,76,14],[72,74,17],[57,52,22]];
  const circles = dots.map(([x, y, r]) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="#e8eaed" opacity=".9"/>`).join('');
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 110">
       <g filter="blur(1px)">${circles}</g>
       <circle cx="57" cy="55" r="26" fill="#f4f5f7" opacity=".85"/>
     </svg>`);
}

function playPoof(x, y) {
  const el = document.createElement('img');
  el.className = 'poof';
  el.src = poofSvg();
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 500);
}

function pulseTrash() {
  const trash = slotMap.get('__trash__');
  if (!trash) return;
  trash.el.classList.remove('trash-pulse');
  void trash.el.offsetWidth;
  trash.el.classList.add('trash-pulse');
  setTimeout(() => trash.el.classList.remove('trash-pulse'), 550);
}

function hidePreview() {
  previewPinned = false;
  if (previewHideTimer) { clearTimeout(previewHideTimer); previewHideTimer = null; }
  if (previewPendingTimer) { clearTimeout(previewPendingTimer); previewPendingTimer = null; }
  previewPendingApp = null;
  if (previewState) {
    clearInterval(previewState.refreshTimer);
    previewState = null;
  }
  previewEl.classList.remove('on');
  previewEl.classList.add('hidden');
  previewEl.innerHTML = '';
  if (!pointerInsideBar && !menuOpen && !stackCurrent) {
    window.dock.invoke('set-click-through', { on: true });
  }
}

// 点击已聚焦多窗口打开的窗口网格：点击网格外任意处关闭
document.addEventListener('mousedown', (ev) => {
  if (previewPinned && !previewEl.contains(ev.target)) hidePreview();
});

function schedulePreviewHide(delay) {
  if (previewPinned) return;   // 点击打开的窗口网格保持显示，直到点击外部/离开
  if (previewHideTimer) clearTimeout(previewHideTimer);
  previewHideTimer = setTimeout(() => { previewHideTimer = null; hidePreview(); }, delay);
}

function cancelPreviewHide() {
  if (previewHideTimer) { clearTimeout(previewHideTimer); previewHideTimer = null; }
}

async function captureThumb(h, img) {
  try {
    const res = await window.dock.invoke('window-thumb', { h });
    if (res && res.png) { img.src = 'data:image/png;base64,' + res.png; return true; }
  } catch {}
  return false;
}

function showPreview(entry, anchorEl, pinned) {
  hidePreview();
  previewPinned = !!pinned;
  const wins = (entry.windows || []).slice(0, 8);
  if (!wins.length) return;
  const iconUrl = entry.icon || letterTile(entry.name);

  for (const w of wins) {
    const cell = document.createElement('div');
    cell.className = 'pv-cell' + (w.m ? ' pv-min' : '');
    if (!w.m) cell.dataset.h = w.h;
    const img = document.createElement('img');
    img.className = 'pv-img';
    img.draggable = false;
    cell.appendChild(img);
    if (!w.m) {
      const close = document.createElement('div');
      close.className = 'pv-close';
      close.textContent = '×';
      cell.appendChild(close);
    }
    const title = document.createElement('div');
    title.className = 'pv-title';
    title.textContent = trunc(w.t || entry.name, 26);
    cell.appendChild(title);

    if (w.m) {
      img.src = iconUrl;   // 最小化窗口抓不到内容，显示应用图标
    } else {
      captureThumb(w.h, img).then((ok) => { if (!ok) img.src = iconUrl; });
    }

    cell.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('pv-close')) {
        window.dock.invoke('close-window', { h: w.h });
        cell.remove();
        if (!previewEl.children.length) hidePreview();
        return;
      }
      window.dock.invoke('focus-window', { h: w.h });
      hidePreview();
    });
    previewEl.appendChild(cell);
  }

  // 定位：底部位置在锚点上方水平居中；侧栏位置在条的内侧与锚点垂直居中
  previewEl.classList.remove('hidden');
  window.dock.invoke('set-click-through', { on: false });
  const r = anchorEl.getBoundingClientRect();
  const barRect = barEl.getBoundingClientRect();
  const pw = previewEl.offsetWidth;
  if (!isVert()) {
    previewEl.style.top = 'auto';
    let x = r.left + r.width / 2 - pw / 2;
    x = Math.min(Math.max(10, x), window.innerWidth - pw - 10);
    previewEl.style.left = x + 'px';
    previewEl.style.bottom = (window.innerHeight - barRect.top + 12) + 'px';
  } else {
    previewEl.style.bottom = 'auto';
    const ph = previewEl.offsetHeight;
    let y = r.top + r.height / 2 - ph / 2;
    y = Math.min(Math.max(10, y), window.innerHeight - ph - 10);
    previewEl.style.top = y + 'px';
    previewEl.style.left = POS === 'left'
      ? (barRect.right + 12) + 'px'
      : (barRect.left - 12 - pw) + 'px';
  }
  requestAnimationFrame(() => previewEl.classList.add('on'));

  // 可见期间定期重抓（准实时）；应用窗口列表失效则收起
  previewState = {
    appId: entry.id,
    refreshTimer: setInterval(() => {
      const holder = slotMap.get(previewState ? previewState.appId : '');
      const e2 = holder && holder.entry;
      if (!e2 || !(e2.windows || []).length) { hidePreview(); return; }
      previewEl.querySelectorAll('.pv-cell[data-h]').forEach((cell) => {
        captureThumb(cell.dataset.h, cell.querySelector('img.pv-img'));
      });
    }, 750),
  };
}

previewEl.addEventListener('mouseenter', cancelPreviewHide);
previewEl.addEventListener('mouseleave', () => schedulePreviewHide(150));

itemsEl.addEventListener('mouseover', (ev) => {
  const slot = ev.target.closest('.slot');
  const appId = slot && slot.dataset.kind === 'app' ? slot.dataset.id : null;
  const holder = appId ? slotMap.get(appId) : null;
  const entry = holder && holder.entry;
  const canPreview = !!(entry && (entry.windows || []).length > 0);

  if (canPreview) {
    cancelPreviewHide();
    if (previewState && previewState.appId === appId) return;
    if (previewState) hidePreview();
    if (previewPendingApp !== appId) {
      if (previewPendingTimer) clearTimeout(previewPendingTimer);
      previewPendingApp = appId;
      previewPendingTimer = setTimeout(() => {
        previewPendingTimer = null;
        previewPendingApp = null;
        const h2 = slotMap.get(appId);
        const e2 = h2 && h2.entry;
        if (e2 && (e2.windows || []).length > 0 && !previewState) showPreview(e2, h2.el);
      }, 500);
    }
  } else if (previewState || previewPendingTimer) {
    schedulePreviewHide(150);
  }
});

// =====================================================================
//  文件夹 Stack（弹层网格）
// =====================================================================

const stackIconCache = new Map();
let stackCurrent = null; // { path, title }

function closeStack() {
  stackPanelEl.classList.remove('on');
  stackPanelEl.classList.add('hidden');
  stackPanelEl.innerHTML = '';
  stackCurrent = null;
  if (!pointerInsideBar && !menuOpen && !previewState) {
    window.dock.invoke('set-click-through', { on: true });
  }
}

async function fetchStackIcon(path) {
  if (stackIconCache.has(path)) return stackIconCache.get(path);
  const res = await window.dock.invoke('icon-data', { path });
  const url = (res && res.ok && res.url) || letterTile(path.split(/[\\/]/).pop() || '?');
  // LRU 上限：长期运行防 dataURL 堆积（data: url 每条数 KB～数十 KB）
  if (stackIconCache.size > 300) stackIconCache.delete(stackIconCache.keys().next().value);
  stackIconCache.set(path, url);
  return url;
}

function switchStackView(f, view) {
  f.stackView = view;
  const path = f.folderPath || f.exe || '';
  window.dock.invoke('set-stack-view', { path, view });
  if (stackCurrent && stackCurrent.path === path) renderStack(path, view, stackCurrent.sortBy);
}

// P1-F5：切换排序方式，写回 settings 并即时刷新已打开的 Stack 面板
function switchStackSort(f, sortBy) {
  f.stackSortBy = sortBy;
  const path = f.folderPath || f.exe || '';
  window.dock.invoke('set-stack-sort', { path, sortBy });
  if (stackCurrent && stackCurrent.path === path) renderStack(path, stackCurrent.viewConf, sortBy);
}

async function openStack(folderPath, anchorEl, view) {
  if (!folderPath) return;
  closeStack();
  window.dock.invoke('set-click-through', { on: false });
  stackPanelEl.classList.remove('hidden');
  stackPanelEl.classList.add('on');
  // 先等内容渲染完成再测量定位：否则面板尺寸为 0，clamp 会把它压到屏幕边角
  await renderStack(folderPath, view);

  const r = anchorEl ? anchorEl.getBoundingClientRect() : barEl.getBoundingClientRect();
  const barRect = barEl.getBoundingClientRect();
  const pw = stackPanelEl.offsetWidth;
  if (!isVert()) {
    stackPanelEl.style.top = 'auto';
    let x = r.left + r.width / 2 - pw / 2;
    x = Math.min(Math.max(10, x), window.innerWidth - pw - 10);
    stackPanelEl.style.left = x + 'px';
    stackPanelEl.style.bottom = (window.innerHeight - barRect.top + 12) + 'px';
  } else {
    stackPanelEl.style.bottom = 'auto';
    const ph = stackPanelEl.offsetHeight;
    let y = r.top + r.height / 2 - ph / 2;
    y = Math.min(Math.max(10, y), window.innerHeight - ph - 10);
    stackPanelEl.style.top = y + 'px';
    stackPanelEl.style.left = POS === 'left'
      ? (barRect.right + 12) + 'px'
      : (barRect.left - 12 - pw) + 'px';
  }
}

async function renderStack(folderPath, viewArg, sortByArg) {
  const res = await window.dock.invoke('list-dir', { path: folderPath });
  const rawEntries = (res && res.entries) || [];
  const name = folderPath.split(/[\\/]/).pop() || folderPath;
  // P1-F5 视图/排序解析：显式参数 > 已打开面板状态 > 默认（auto / name）。
  // auto 在 stackViewMode 里按条目数量落到 fan/grid。
  const isSame = stackCurrent && stackCurrent.path === folderPath;
  const viewConf = viewArg !== undefined ? viewArg
    : (isSame ? stackCurrent.viewConf : 'auto');
  const sortBy = sortByArg !== undefined ? sortByArg
    : (isSame ? stackCurrent.sortBy : 'name');
  const view = StackSort.stackViewMode(rawEntries.length, viewConf);
  const entries = StackSort.sortStackItems(rawEntries, sortBy);
  stackCurrent = { path: folderPath, title: name, viewConf, sortBy, view };

  stackPanelEl.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'stack-header';

  const back = document.createElement('span');
  back.className = 'st-back';
  back.textContent = '‹ 上一级';
  back.addEventListener('click', () => {
    const parent = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join('\\') || folderPath;
    if (parent && parent !== folderPath) renderStack(parent);
  });

  const title = document.createElement('span');
  title.className = 'st-title';
  title.textContent = name;

  const close = document.createElement('span');
  close.className = 'st-close';
  close.textContent = '×';
  close.addEventListener('click', closeStack);

  header.appendChild(back);
  header.appendChild(title);
  header.appendChild(close);

  const grid = document.createElement('div');
  grid.className = 'stack-grid ' + view;
  for (const ent of entries) {
    const cell = document.createElement('div');
    cell.className = 'st-cell';
    const img = document.createElement('img');
    img.draggable = false;
    cell.appendChild(img);
    const label = document.createElement('div');
    label.className = 'st-name';
    label.textContent = ent.name;
    cell.appendChild(label);
    fetchStackIcon(ent.iconPath).then((url) => { if (img.isConnected) img.src = url; });
    cell.addEventListener('click', () => {
      if (ent.isFolder) {
        renderStack(ent.iconPath);
      } else {
        window.dock.invoke('open-path', { path: ent.iconPath });
        closeStack();
      }
    });
    grid.appendChild(cell);
  }

  stackPanelEl.appendChild(header);
  stackPanelEl.appendChild(grid);
  if (view === 'fan') layoutFan(grid);
}

// Stack 的 fan 真扇形：图标沿弧线辐射、互相重叠、越靠近中心越大（mac 意象）
function layoutFan(grid) {
  const cells = [...grid.children];
  const n = cells.length;
  if (!n) return;
  const cellSize = 48;
  const span = Math.min(Math.PI * 0.9, Math.max(0.6, (n - 1) * 0.34));
  const step = n > 1 ? span / (n - 1) : 0;
  const R = 96 + (n - 1) * 6;
  const W = Math.round(2 * R + cellSize);
  const H = Math.round(R + cellSize);
  grid.style.width = W + 'px';
  grid.style.height = H + 'px';
  const cxx = W / 2;
  const cyy = H - cellSize * 0.5;      // 扇心在底部中央
  const mid = (n - 1) / 2;
  cells.forEach((c, i) => {
    const ang = (i - mid) * step;
    const px = Math.sin(ang) * R;
    const py = -Math.cos(ang) * R;      // 向上展开
    c.style.position = 'absolute';
    c.style.left = (cxx + px - cellSize / 2) + 'px';
    c.style.top = (cyy + py - cellSize / 2) + 'px';
    const dist = Math.abs(i - mid);
    const s = Math.round(cellSize * Math.max(0.7, 1 - dist * 0.06));
    c.style.width = s + 'px';
    c.style.height = s + 'px';
    c.style.transform = `rotate(${(-ang * 180 / Math.PI).toFixed(1)}deg)`;
    c.style.zIndex = String(100 - Math.round(dist * 4));
  });
}

stackPanelEl.addEventListener('mouseleave', () => {
  setTimeout(() => { if (stackCurrent) closeStack(); }, 350);
});

document.addEventListener('mousedown', (ev) => {
  if (stackCurrent && !stackPanelEl.contains(ev.target)) closeStack();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && stackCurrent) closeStack();
});

// =====================================================================
//  点击行为 + 内部拖拽（统一在一个按下流程里）
// =====================================================================

let dragState = null;
let extDragHighlight = null;

function gapPx() { return Math.max(4, Math.round(OPT.iconSize * 0.13)); }

function appSlotEls() {
  return [...itemsEl.children].filter(el => el.dataset.kind === 'app' || el.dataset.kind === 'folder');
}

function launchWithBounce(entry) {
  bounceSet.add(entry.id);
  const s = slotMap.get(entry.id);
  if (s) s.el.classList.add('bouncing');
  window.dock.invoke('launch', {
    exe: entry.exe, launch: entry.launch || null, args: entry.args || [],
  }).catch(() => {});
  setTimeout(() => {
    bounceSet.delete(entry.id);
    const ss = slotMap.get(entry.id);
    if (ss) ss.el.classList.remove('bouncing');
  }, 1500);
}

function activateEntry(entry) {
  const wins = entry.windows || [];
  if (wins.length === 0) {
    const s = slotMap.get(entry.id);
    launchWithBounce(entry);
    return;
  }
  const focusedWin = wins.find(w => w.f);
  if (focusedWin) {
    // macOS 原版：点击已聚焦应用的 dock 图标不会最小化应用（最小化靠窗口黄灯按钮）。
    // 若该应用开着多个窗口，弹出「窗口缩略图网格」供快速切换（对齐 mac Dock 菜单列窗口）；
    // 单个窗口则保持/重新前置。
    if (wins.length > 1) {
      const s = slotMap.get(entry.id);
      if (s) showPreview(entry, s.el, true);
      return;
    }
    if (!focusedWin.m) window.dock.invoke('focus-window', { h: focusedWin.h }).catch(() => {});
  } else {
    // 从最旧到最新依次前置，让最近使用的窗口落在最上面
    const ordered = wins.slice().reverse().filter(w => !w.m);
    const list = ordered.length ? ordered : wins.slice().reverse();
    (async () => {
      for (const w of list) {
        try { await window.dock.invoke('focus-window', { h: w.h }); } catch {}
      }
    })();
  }
}

itemsEl.addEventListener('mousedown', (ev) => {
  // 中键 = Exposé：查看该应用的全部窗口（macOS App Exposé 习惯）
  if (ev.button === 1) {
    const slotMid = ev.target.closest('.slot');
    if (slotMid && slotMid.dataset.kind === 'app') {
      const holderMid = slotMap.get(slotMid.dataset.id);
      const entryMid = holderMid && holderMid.entry;
      if (entryMid && (entryMid.windows || []).length > 0) {
        ev.preventDefault();
        window.dock.invoke('expose-open', {
          appName: entryMid.name || '',
          appIcon: entryMid.icon || '',
          windows: entryMid.windows.slice(0, 24),
        }).catch(() => {});
      }
    }
    return;
  }
  if (ev.button !== 0) return;
  const slot = ev.target.closest('.slot');
  if (!slot) return;
  // P1-F3 分隔线拖宽：仅主分隔线（固定应用区 | 最近区）可拖，其余分隔线保持静态
  if (slot.dataset.kind === 'divider') {
    if (slot.dataset.id === '__divider__') startDividerResize(ev);
    return;
  }
  if (menuOpen) closeMenu();

  const startX = ev.clientX, startY = ev.clientY;
  const id = slot.dataset.kind === 'trash' ? '__trash__' : slot.dataset.id;
  const holder = slotMap.get(id);
  const entryAtDown = holder ? holder.entry : { kind: 'trash' };
  // F1 修饰键状态取按下时刻（mouseup 时修饰键可能已释放）
  const modsAtDown = { alt: ev.altKey, ctrl: ev.ctrlKey };
  let dragging = false;

  const onMove = (mev) => {
    if (mev.buttons !== 1) { finish(true); return; }
    if (!dragging) {
      // 拖拽阈值判定保持在修饰键判定之前：修饰键点击不影响拖拽排序
      if (Math.abs(mev.clientX - startX) + Math.abs(mev.clientY - startY) < 6) return;
      if (id === '__trash__' || (slot.dataset.kind !== 'app' && slot.dataset.kind !== 'folder')) { finish(false); return; }
      dragging = true;
      startInternalDrag(id, slot, mev);
    } else {
      moveInternalDrag(mev);
    }
  };
  const finish = (cancelled) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (dragging) endInternalDrag(ev, cancelled);
    else if (!cancelled) handleClick(id, entryAtDown, modsAtDown);
  };
  const onUp = () => finish(false);

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

function handleClick(id, entryAtPress, mods) {
  if (id === '__trash__') {
    window.dock.invoke('open-trash');
    return;
  }
  // 用最新 entry（启动瞬间后状态可能已刷新）
  const fresh = (slotMap.get(id) || {}).entry || entryAtPress;
  if (fresh.kind === 'min') {
    window.dock.invoke('focus-window', { h: fresh.h });
    return;
  }
  if (fresh.kind === 'recent') {
    if (fresh.running) {
      const runEntry = (STATE.entries || []).find(
        (e) => String(e.exe || '').toLowerCase() === String(fresh.exe || '').toLowerCase() &&
               (e.windows || []).length > 0
      );
      if (runEntry) {
        activateEntry(runEntry);
        return;
      }
    }
    launchWithBounce(fresh);
    return;
  }
  if (fresh.kind === 'folder') {
    openStack(fresh.folderPath || fresh.exe || '',
      slotMap.get(id) && slotMap.get(id).el, fresh.stackView);
    return;
  }
  if (fresh.kind !== 'app') return;
  // F1 修饰键点击：仅应用槽位响应；reveal/hide 路径不走弹跳与 tooltip 消费
  if (mods && (mods.alt || mods.ctrl)) {
    const wins = fresh.windows || [];
    const action = ModifierActions.resolveModifierAction({
      alt: !!mods.alt, ctrl: !!mods.ctrl,
      targetRunning: wins.length > 0,
      targetFocused: wins.some((w) => w.f),
    });
    if (action === 'reveal') {
      // UWP 条目（无真实 exe 路径）静默 no-op
      if (fresh.exe) window.dock.invoke('reveal', { path: fresh.exe });
      return;
    }
    if (action === 'hide-current') {
      // 焦点交给「上一个运行中的应用」（recent LRU 中最近一个仍在运行的），无候选自然回桌面
      const runningExes = (STATE.entries || [])
        .filter((e) => (e.windows || []).length > 0 && e.id !== fresh.id)
        .map((e) => e.exe);
      const prev = ModifierActions.previousRunningApp(STATE.recent || [], runningExes, fresh.exe);
      const prevEntry = prev
        ? (STATE.entries || []).find((e) => String(e.exe || '').toLowerCase() === String(prev.exe || '').toLowerCase() &&
            (e.windows || []).length > 0)
        : null;
      window.dock.invoke('modifier-action', {
        type: 'hide-current',
        hs: wins.map((w) => w.h),
        prevHs: prevEntry ? prevEntry.windows.map((w) => w.h) : [],
      });
      return;
    }
    if (action === 'hide-others') {
      window.dock.invoke('modifier-action', {
        type: 'hide-others',
        hs: wins.map((w) => w.h),
      });
      return;
    }
    // activate：落到底下走普通激活
  }
  activateEntry(fresh);
}

// 键盘导航（无障碍）：Tab 循环 Dock 图标，Enter/Space 激活
document.addEventListener('keydown', (ev) => {
  const slots = [...itemsEl.querySelectorAll('.slot')].filter((s) => s.tabIndex === 0);
  if (ev.key === 'Tab') {
    if (!slots.length) return;
    ev.preventDefault();
    const idx = slots.indexOf(document.activeElement);
    const next = ev.shiftKey ? (idx - 1 + slots.length) % slots.length : (idx + 1) % slots.length;
    slots[next].focus();
  } else if (ev.key === 'Enter' || ev.key === ' ') {
    const s = document.activeElement;
    if (!s || s.tabIndex !== 0 || !s.classList.contains('slot')) return;
    ev.preventDefault();
    const id = s.dataset.kind === 'trash' ? '__trash__' : s.dataset.id;
    const holder = slotMap.get(id);
    const entry = holder ? holder.entry : { kind: s.dataset.kind };
    handleClick(id, entry);
  }
});

// ---------------------------------------------------------------- 键盘导航（P1-F2）

// Ctrl+Alt+D 触发的键盘导航态：方向键/Home/End 移动，Enter/Space 激活（复用上面
// 的 keydown 激活路径），Esc 归还焦点。与 Tab 循环并存；鼠标进 Dock 即退出本态。
let kbdNavActive = false;

function slotIdList() {
  return [...itemsEl.children]
    .filter((el) => el.dataset.kind)
    .map((el) => el.dataset.id);
}

function kbdFocusApply(index) {
  const els = [...itemsEl.children].filter((el) => el.dataset.kind);
  els.forEach((el, i) => el.classList.toggle('kbd-focus', i === index));
  if (index >= 0 && els[index]) {
    els[index].focus();
    requestLayout();
  }
}

function kbdNavClear() {
  kbdNavActive = false;
  itemsEl.querySelectorAll('.slot.kbd-focus').forEach((el) => el.classList.remove('kbd-focus'));
}

window.dock.onFocusDock(() => {
  kbdNavActive = true;
  const ids = slotIdList();
  // 默认首个可用槽位；若存在聚焦应用（前台窗口 f=true）则定位到其槽位
  let target = KbdNav.homeIndex(ids);
  const focusedEntry = (STATE && STATE.entries || []).find(
    (e) => (e.windows || []).some((w) => w.f));
  if (focusedEntry) {
    const idx = ids.indexOf(focusedEntry.id);
    if (idx >= 0 && !KbdNav.isDividerId(ids[idx])) target = idx;
  }
  kbdFocusApply(target);
});

document.addEventListener('keydown', (ev) => {
  if (!kbdNavActive) return;
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ||
      ev.key === 'Home' || ev.key === 'End') {
    ev.preventDefault();
    const ids = slotIdList();
    const ae = document.activeElement;
    const curIdx = ae && ae.dataset && ae.dataset.kind ? ids.indexOf(ae.dataset.kind === 'trash' ? '__trash__' : ae.dataset.id) : -1;
    let next;
    if (ev.key === 'Home') next = KbdNav.homeIndex(ids);
    else if (ev.key === 'End') next = KbdNav.lastIndex(ids);
    else {
      const delta = (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') ? +1 : -1;
      next = KbdNav.moveFocus(ids, curIdx, delta);
    }
    if (next >= 0) kbdFocusApply(next);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    kbdNavClear();
    window.dock.invoke('focus-restore');
  }
});

// ---------------------------------------------------------------- 内部拖拽

// ---------------------------------------------------------------- 分隔线拖宽（P1-F3）

// 主分隔线拖拽调整图标尺寸：36–72px 与设置滑块同范围，写回走 set-setting（iconSize），
// 设置面板数值经 broadcastSettings 双向同步。
// 拖动期间冻结鱼眼（computeTargets 全部回静止态）防止布局抖动；mouseup 解除。
let fisheyeFrozen = false;

function startDividerResize(ev) {
  cancelTooltip();
  // 方向感知：底部 Dock 用垂直位移、侧栏用水平位移；朝屏幕外侧拖 = 增大
  const origin = isVert() ? ev.clientX : ev.clientY;
  const startSize = OPT.iconSize;
  fisheyeFrozen = true;
  mouseX = -9999; mouseY = -9999;   // 立即回静止态
  ensureRaf();

  const onMove = (mev) => {
    if (mev.buttons !== 1) { finishDividerResize(); return; }
    let raw;
    if (POS === 'bottom') raw = mev.clientY - origin;               // 向下（屏幕外）= 增大
    else if (POS === 'left') raw = origin - mev.clientX;            // 向左（屏幕外）= 增大
    else raw = mev.clientX - origin;                                // 向右（屏幕外）= 增大
    // 每累计 4px 位移 = 1 级图标尺寸
    const next = Math.min(72, Math.max(36, startSize + Math.round(raw / 4)));
    if (next !== OPT.iconSize) {
      window.dock.invoke('set-setting', { key: 'iconSize', value: next });
    }
  };
  const finishDividerResize = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    fisheyeFrozen = false;
    mouseX = -9999; mouseY = -9999;   // 松手瞬间不保留陈旧放大目标
    ensureRaf();
  };
  const onUp = () => finishDividerResize();
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startInternalDrag(id, slot, ev) {
  cancelTooltip();
  mouseX = -9999;
  const imgEl = slot.querySelector('img.app-icon');

  const g = document.createElement('img');
  g.src = imgEl.src;
  g.style.width = OPT.iconSize + 'px';
  g.style.height = OPT.iconSize + 'px';
  ghostEl.innerHTML = '';
  ghostEl.appendChild(g);
  ghostEl.classList.remove('hidden');
  ghostEl.style.opacity = '.92';

  const els0 = appSlotEls();
  const originIdx = els0.indexOf(slot);
  dragState = {
    id, ghost: g,
    originIndex: originIdx < 0 ? 0 : originIdx,
    insertIndex: originIdx < 0 ? 0 : originIdx,
    removalPending: false,
  };
  slot.style.opacity = '.35';
  ensureRaf();
  moveInternalDrag(ev);
}

function moveInternalDrag(ev) {
  if (!dragState) return;
  dragState.ghost.style.left = (ev.clientX - OPT.iconSize / 2) + 'px';
  dragState.ghost.style.top = (ev.clientY - OPT.iconSize / 2) + 'px';

  // 实时解析存活 slot：拖拽期间状态推送可能触发 rebuildAll 重建节点，
  // 任何快照列表都会游离失效（getBoundingClientRect 全 0），必须每帧重新解析
  const els = appSlotEls();
  const originIdx = els.findIndex(el => el.dataset.id === dragState.id);
  if (originIdx >= 0) {
    dragState.originIndex = originIdx;
    els[originIdx].style.opacity = '.35'; // rebuild 后节点被重建，补回拖拽置灰
  }

  const barRect = barEl.getBoundingClientRect();
  const vert = isVert();
  const mp = vert ? ev.clientY : ev.clientX;
  // 拖出判定：主轴两侧 50px，贴边侧 46px，朝屏幕内侧 90px
  let draggedOut;
  if (!vert) {
    draggedOut =
      ev.clientY > barRect.bottom + 46 || ev.clientY < barRect.top - 90 ||
      ev.clientX < barRect.left - 50 || ev.clientX > barRect.right + 50;
  } else if (POS === 'left') {
    draggedOut =
      ev.clientX > barRect.right + 90 || ev.clientX < barRect.left - 46 ||
      ev.clientY < barRect.top - 50 || ev.clientY > barRect.bottom + 50;
  } else {
    draggedOut =
      ev.clientX < barRect.left - 90 || ev.clientX > barRect.right + 46 ||
      ev.clientY < barRect.top - 50 || ev.clientY > barRect.bottom + 50;
  }

  const entry = (slotMap.get(dragState.id) || {}).entry;
  const removable = entry && entry.pinned;

  if (draggedOut && removable) {
    if (!dragState.removalPending) {
      dragState.removalPending = true;
      dragState.ghost.style.opacity = '.25';
    }
  } else if (dragState.removalPending) {
    dragState.removalPending = false;
    dragState.ghost.style.opacity = '.92';
  }

  let best = 0, bestDist = Infinity;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const r = el.getBoundingClientRect();
    const c = vert ? r.top + r.height / 2 : r.left + r.width / 2;
    const d = Math.abs(mp - c);
    if (d < bestDist) { bestDist = d; best = mp > c ? i + 1 : i; }
  }
  dragState.insertIndex = draggedOut ? -1 : best;

  // P2-F1b：避让位移交给 layoutTick 的弹簧积分（每帧逼近目标），这里只更新
  // 插入点/起点索引；不再直接写 transform，更不移除 CSS transition ——
  // 双驱动会互相踩踏，位移变换由弹簧唯一驱动。
}

function shiftAmounts(insertAt, fromIndex, n) {
  const shifts = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === fromIndex) continue;
    if (fromIndex < insertAt && i > fromIndex && i < insertAt) shifts[i] = -1;
    else if (fromIndex > insertAt && i >= insertAt && i < fromIndex) shifts[i] = 1;
  }
  return shifts;
}

// P2-F1b：拖拽结束后的回位中标志——目标归零由弹簧自然逼近，播完自清
let shiftRelease = false;

function endInternalDrag(_ev, cancelled) {
  const st = dragState;
  dragState = null;
  if (!st) return;
  ghostEl.classList.add('hidden');
  // P2-F1b：不清 transform（弹簧回位中），只清理置灰；回位 settled 后统一清除
  shiftRelease = true;
  itemsEl.querySelectorAll('.slot').forEach(el => { el.style.opacity = ''; });
  mouseX = _ev ? _ev.clientX : -9999;
  ensureRaf();

  if (cancelled) return;

  const holder = slotMap.get(st.id);
  const entry = (holder || {}).entry;

  if (st.removalPending) {
    if (entry && entry.pinned && holder && holder.el) {
      const r = holder.el.getBoundingClientRect();
      playPoof(r.left + r.width / 2, r.top + r.height / 2);
      window.dock.invoke('pin-remove', { id: entry.id });
      return;
    }
  }
  if (st.insertIndex < 0 || !holder) return;

  const els = appSlotEls();
  const movingIdx = els.findIndex(el => el.dataset.id === st.id);
  if (movingIdx < 0) return; // 拖拽目标已在拖拽期间被移除，放弃重排
  const [moving] = els.splice(movingIdx, 1);
  const at = Math.max(0, Math.min(st.insertIndex, els.length));
  els.splice(at, 0, moving);
  const ids = els.map(el => el.dataset.id);
  sessionOrder = ids.slice();
  window.dock.invoke('reorder', { ids });
}

// =====================================================================
//  右键菜单（document 级一次路由）
// =====================================================================

let menuOpen = false;

// ---- F4 清空回收站二次确认（状态机 core/confirm-arm.js，UI 接线在此）----
// idle → 首点 armed（菜单项变红「确认清空」）→ 3s 内再点执行；超时/关菜单还原。
// 状态机本身不依赖定时器；这里的 setTimeout 只驱动菜单项文案还原。
let trashConfirm = ConfirmArm.IDLE;
let trashConfirmTimer = null;

function trashArmClear() {
  trashConfirm = ConfirmArm.IDLE;
  if (trashConfirmTimer) { clearTimeout(trashConfirmTimer); trashConfirmTimer = null; }
  // 菜单仍开着则还原菜单项文案与配色
  const cur = menuLayerEl.querySelector('.mac-menu .mi.danger');
  if (cur) {
    cur.classList.remove('danger');
    const sp = cur.querySelector('span');
    if (sp) sp.textContent = '清空回收站';
  }
}

// 菜单项点击编排：首击武装，窗口内再击执行 empty-trash
function trashConfirmClick(mi) {
  const now = Date.now();
  const prev = trashConfirm;
  const res = ConfirmArm.nextState(prev, 'confirm', now);
  if (res.execute && ConfirmArm.isConfirmValid(prev, now)) {
    trashConfirm = ConfirmArm.IDLE;
    if (trashConfirmTimer) { clearTimeout(trashConfirmTimer); trashConfirmTimer = null; }
    closeMenu();
    pulseTrash();
    window.dock.invoke('empty-trash');
    return;
  }
  // 非执行击（首击或已超窗）：（重）新武装
  trashConfirm = ConfirmArm.nextState(ConfirmArm.IDLE, 'request', now).state;
  if (mi) {
    const sp = mi.querySelector('span');
    if (sp) sp.textContent = '确认清空';
    mi.classList.add('danger');
  }
  if (trashConfirmTimer) clearTimeout(trashConfirmTimer);
  trashConfirmTimer = setTimeout(() => {
    trashConfirmTimer = null;
    trashConfirm = ConfirmArm.IDLE;
    // 超时还原：菜单仍开着则把文案复原为「清空回收站」
    const cur = menuLayerEl.querySelector('.mac-menu .mi.danger');
    if (cur) {
      cur.classList.remove('danger');
      const sp = cur.querySelector('span');
      if (sp) sp.textContent = '清空回收站';
    }
  }, ConfirmArm.CONFIRM_WINDOW_MS);
}

function closeMenu() {
  menuLayerEl.classList.add('hidden');
  menuLayerEl.innerHTML = '';
  menuOpen = false;
  // F4：菜单关闭即 cancel（含 armed 撤销与超时定时器清理）
  if (trashConfirm.phase === 'armed' || trashConfirmTimer) trashArmClear();
  if (!pointerInsideBar && !stackCurrent && !previewState) {
    window.dock.invoke('set-click-through', { on: true });
  }
}

menuLayerEl.addEventListener('mousedown', (ev) => {
  if (ev.target === menuLayerEl) closeMenu();
});

function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function showMenu(x, y, defs) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'mac-menu';

  for (const def of defs) {
    if (def.sep) {
      const sp = document.createElement('div');
      sp.className = 'sep';
      menu.appendChild(sp);
      continue;
    }
    const mi = document.createElement('div');
    mi.className = 'mi' + (def.disabled ? ' disabled' : '') + (def.danger ? ' danger' : '');
    if (def.iconUrl) {
      const im = document.createElement('img');
      im.className = 'mi-icon';
      im.src = def.iconUrl;
      mi.appendChild(im);
    }
    const span = document.createElement('span');
    span.textContent = def.label;
    mi.appendChild(span);
    if (def.children) {
      const arrow = document.createElement('span');
      arrow.className = 'shortcut';
      arrow.textContent = '▸';
      mi.appendChild(arrow);
      mi.addEventListener('click', () => toggleSubMenu(def.children, mi));
    } else if (def.action && !def.disabled) {
      mi.addEventListener('click', () => {
        // keepOpen：二次确认类条目点击不关菜单（armed 文案就地变化）
        if (def.keepOpen) { def.action(mi); return; }
        closeMenu(); def.action();
      });
    }
    menu.appendChild(mi);
  }

  menuLayerEl.appendChild(menu);
  menuLayerEl.classList.remove('hidden');
  menuOpen = true;
  window.dock.invoke('set-click-through', { on: false });

  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let mx, my;
  if (!isVert()) {
    mx = x; my = y - mh - 4;
    mx = Math.min(Math.max(8, mx), window.innerWidth - mw - 8);
    my = Math.min(Math.max(8, my), window.innerHeight - mh - 8);
  } else {
    // 侧栏：菜单出现在条的内侧，与点击位置垂直对齐
    const barRect = barEl.getBoundingClientRect();
    mx = POS === 'left' ? barRect.right + 8 : barRect.left - mw - 8;
    my = Math.min(Math.max(8, y - 24), window.innerHeight - mh - 8);
  }
  menu.style.left = mx + 'px';
  menu.style.top = my + 'px';
}

// 二级子菜单（mac「选项」）：点击父项在其右侧展开
let openSubmenu = null;
function closeSubMenu() {
  if (openSubmenu) { openSubmenu.remove(); openSubmenu = null; }
}
function toggleSubMenu(defs, parentMi) {
  if (openSubmenu && menuLayerEl.contains(openSubmenu)) { closeSubMenu(); return; }
  closeSubMenu();
  const sub = document.createElement('div');
  sub.className = 'mac-menu submenu';
  for (const def of defs) {
    if (def.sep) {
      const sp = document.createElement('div');
      sp.className = 'sep';
      sub.appendChild(sp);
      continue;
    }
    const mi = document.createElement('div');
    mi.className = 'mi' + (def.disabled ? ' disabled' : '');
    const span = document.createElement('span');
    span.textContent = def.label;
    mi.appendChild(span);
    if (def.action && !def.disabled) {
      mi.addEventListener('click', () => { closeMenu(); def.action(); });
    }
    sub.appendChild(mi);
  }
  menuLayerEl.appendChild(sub);
  const pr = parentMi.getBoundingClientRect();
  const sw = sub.offsetWidth;
  const sh = sub.offsetHeight;
  sub.style.left = Math.min(Math.max(8, pr.right + 4), window.innerWidth - sw - 8) + 'px';
  sub.style.top = Math.min(Math.max(8, pr.top - 2), window.innerHeight - sh - 8) + 'px';
  openSubmenu = sub;
}

document.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (dragState) return;
  const barRect = barEl.getBoundingClientRect();
  const inside = ev.clientY >= barRect.top && ev.clientY <= barRect.bottom &&
                 ev.clientX >= barRect.left && ev.clientX <= barRect.right;
  if (!inside) return;

  const slotEl = ev.target.closest('.slot');
  if (!slotEl) {
    showDockMenu(ev.clientX, ev.clientY);
    return;
  }
  if (slotEl.dataset.kind === 'trash') {
    const count = (STATE && STATE.trash && STATE.trash.count) || 0;
    // F4 二次确认：首点 armed（变红「确认清空」），3s 内再点执行；
    // 超时由 trashConfirmTimer 还原，菜单关闭由 closeMenu cancel。
    showMenu(ev.clientX, ev.clientY, [
      { label: '打开回收站', action: () => window.dock.invoke('open-trash') },
      { sep: true },
      {
        label: '清空回收站',
        disabled: count === 0,
        keepOpen: true,
        action: trashConfirmClick,
      },
    ]);
    return;
  }
  if (slotEl.dataset.kind === 'min') {
    const holder = slotMap.get(slotEl.dataset.id);
    if (!holder || !holder.entry) return;
    const m = holder.entry;
    showMenu(ev.clientX, ev.clientY, [
      { label: '还原', iconUrl: m.icon || letterTile(m.appName || m.title), action: () => window.dock.invoke('focus-window', { h: m.h }) },
      { sep: true },
      { label: '关闭', action: () => window.dock.invoke('close-window', { h: m.h }) },
    ]);
    return;
  }
  if (slotEl.dataset.kind === 'recent') {
    const holder = slotMap.get(slotEl.dataset.id);
    if (!holder || !holder.entry) return;
    const r = holder.entry;
    showMenu(ev.clientX, ev.clientY, [
      { label: '打开', iconUrl: r.icon || letterTile(r.name), action: () => launchWithBounce(r) },
      { sep: true },
      { label: '从最近移除', action: () => window.dock.invoke('recent-remove', { exe: r.exe }) },
    ]);
    return;
  }
  if (slotEl.dataset.kind === 'folder') {
    const holder = slotMap.get(slotEl.dataset.id);
    if (!holder || !holder.entry) return;
    const f = holder.entry;
    const vp = f.folderPath || f.exe || '';
    const viewNow = f.stackView || 'auto';
    const sortNow = f.stackSortBy || 'name';
    showMenu(ev.clientX, ev.clientY, [
      {
        label: '打开',
        iconUrl: f.icon || folderSvg(),
        action: () => openStack(vp, holder.el, f.stackView),
      },
      { sep: true },
      {
        label: '显示为',
        children: [
          { label: '自动' + (viewNow === 'auto' ? '  ✓' : ''), action: () => switchStackView(f, 'auto') },
          { label: '网格' + (viewNow === 'grid' ? '  ✓' : ''), action: () => switchStackView(f, 'grid') },
          { label: '扇形' + (viewNow === 'fan' ? '  ✓' : ''), action: () => switchStackView(f, 'fan') },
          { label: '列表' + (viewNow === 'list' ? '  ✓' : ''), action: () => switchStackView(f, 'list') },
        ],
      },
      {
        label: '排序方式',
        children: [
          { label: '名称' + (sortNow === 'name' ? '  ✓' : ''), action: () => switchStackSort(f, 'name') },
          { label: '添加日期' + (sortNow === 'added' ? '  ✓' : ''), action: () => switchStackSort(f, 'added') },
          { label: '创建日期' + (sortNow === 'created' ? '  ✓' : ''), action: () => switchStackSort(f, 'created') },
          { label: '种类' + (sortNow === 'kind' ? '  ✓' : ''), action: () => switchStackSort(f, 'kind') },
        ],
      },
      { sep: true },
      {
        label: '在文件资源管理器中显示',
        action: () => window.dock.invoke('reveal', { path: vp }),
      },
      { label: '从 Dock 中移除', action: () => window.dock.invoke('pin-remove', { id: f.id }) },
    ]);
    return;
  }
  const holder = slotMap.get(slotEl.dataset.id);
  if (!holder || !holder.entry) return;
  showAppMenu(ev.clientX, ev.clientY, holder.entry);
});

function showAppMenu(x, y, entry) {
  const defs = [];
  const wins = entry.windows || [];
  const iconUrl = entry.icon || letterTile(entry.name);

  if (wins.length > 0) {
    for (const w of wins.slice(0, 9)) {
      defs.push({
        label: trunc(w.t, 44),
        iconUrl,
        action: () => window.dock.invoke('focus-window', { h: w.h }),
      });
    }
    if (wins.length > 9) {
      defs.push({ label: `其他 ${wins.length - 9} 个窗口…`, disabled: true });
    }
    defs.push({ sep: true });
  } else {
    defs.push({ label: '打开', iconUrl, action: () => launchWithBounce(entry) });
    defs.push({ sep: true });
  }

  // 「选项」二级子菜单（mac 对齐）：在资源管理器中显示 / 移除或固定
  const options = [];
  if (entry.pinned && entry.exe) {
    options.push({
      label: '在资源管理器中显示',
      action: () => window.dock.invoke('reveal', { path: entry.exe }),
    });
  }
  if (entry.pinned) {
    options.push({
      label: '从 Dock 中移除',
      action: () => window.dock.invoke('pin-remove', { id: entry.id }),
    });
  } else if (entry.exe) {
    // UWP 宿主等无 exe 的条目固定后无法启动，不提供固定
    options.push({
      label: '固定到 Dock',
      action: () =>
        window.dock.invoke('pin-add', { id: entry.id, name: entry.name, exe: entry.exe }),
    });
  }
  if (options.length) defs.push({ label: '选项', children: options });

  if (wins.length > 0) {
    defs.push({ sep: true });
    defs.push({
      label: '隐藏其他',
      action: () => window.dock.invoke('hide-others', { hs: wins.map(w => w.h) }),
    });
    defs.push({
      label: '显示所有窗口',
      disabled: !(STATE && STATE.minimized && STATE.minimized.length),
      action: () => window.dock.invoke('show-all'),
    });
    defs.push({ sep: true });
    // P1-F6：无响应（hung）应用 → 红色「强制退出」（跳过优雅等待，直接 Stop-Process）；
    // 只提供手动入口，绝不自动强杀（慢启动应用防误伤）
    defs.push(entry.hung === true
      ? {
          label: '强制退出',
          danger: true,
          action: () => window.dock.invoke('quit-app', { hs: wins.map(w => w.h), force: true }),
        }
      : { label: '退出', action: () => window.dock.invoke('quit-app', { hs: wins.map(w => w.h) }) });
  }

  showMenu(x, y, defs);
}

function showDockMenu(x, y) {
  showMenu(x, y, [
    { label: '启动台', action: () => window.dock.invoke('launchpad-open') },
    { label: '添加应用…', action: () => window.dock.invoke('pick-app') },
    { label: '添加文件夹…', action: () => window.dock.invoke('pick-folder') },
    { label: 'Dock 设置…', action: () => window.dock.invoke('open-settings') },
    { sep: true },
    {
      label: OPT.autohide ? '关闭自动隐藏' : '打开自动隐藏',
      action: () => window.dock.invoke('set-setting', { key: 'autohide', value: !OPT.autohide }),
    },
  ]);
}

// =====================================================================
//  外部文件拖放：交给应用打开 / 投入废纸篓
// =====================================================================

let externalDragActive = false;
let extDragDepth = 0;
let springTimer = null;   // spring-loaded：拖文件悬停文件夹图标自动展开

function clearExtHighlight() {
  for (const [, s] of slotMap) s.el.classList.remove('targeted');
  extDragHighlight = null;
}

document.addEventListener('dragenter', (ev) => {
  const types = [...(ev.dataTransfer.types || [])];
  if (!types.includes('Files')) return;
  externalDragActive = true;
  extDragDepth++;
  mouseX = -9999;
  ensureRaf();
});

document.addEventListener('dragleave', () => {
  extDragDepth = Math.max(0, extDragDepth - 1);
  if (extDragDepth === 0) {
    externalDragActive = false;
    clearExtHighlight();
  }
});

// 投放热区：条矩形沿主轴 ±10、朝屏幕内侧 +24、贴边侧 +30
function pointInDropZone(b, x, y) {
  if (!isVert()) {
    return y >= b.top - 24 && y <= b.bottom + 30 && x >= b.left - 10 && x <= b.right + 10;
  }
  const inX = POS === 'left'
    ? (x >= b.left - 30 && x <= b.right + 24)
    : (x >= b.left - 24 && x <= b.right + 30);
  return inX && y >= b.top - 10 && y <= b.bottom + 10;
}

// 槽位命中：主轴 ±3，朝屏幕内侧（放大溢出方向）+26，贴边侧 +16
function slotHitTest(r, x, y) {
  if (!isVert()) {
    return x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 26 && y <= r.bottom + 16;
  }
  const inX = POS === 'left'
    ? (x >= r.left - 16 && x <= r.right + 26)
    : (x >= r.left - 26 && x <= r.right + 16);
  return inX && y >= r.top - 3 && y <= r.bottom + 3;
}

document.addEventListener('dragover', (ev) => {
  if (!externalDragActive || dragState) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'copy';

  const barRect = barEl.getBoundingClientRect();
  const inside = pointInDropZone(barRect, ev.clientX, ev.clientY);
  let slot = null;
  if (inside) {
    for (const [, s] of slotMap) {
      const k = s.el.dataset.kind;
      if (k !== 'app' && k !== 'trash' && k !== 'folder') continue;
      const r = s.el.getBoundingClientRect();
      if (slotHitTest(r, ev.clientX, ev.clientY)) { slot = s.el; break; }
    }
  }
  if (extDragHighlight !== slot) {
    clearExtHighlight();
    extDragHighlight = slot;
    if (slot) {
      slot.classList.add('targeted');
      const sc = slotMap.get(slot.dataset.id || '__trash__');
      if (sc) sc.targetScale = Math.max(sc.targetScale || 1, OPT.magnification * 0.72);
      ensureRaf();
    }
  }
  // spring-loaded：拖文件悬停文件夹图标 ~700ms 自动展开其 Stack 面板
  if (springTimer) { clearTimeout(springTimer); springTimer = null; }
  if (slot && slot.dataset.kind === 'folder') {
    const sc = slotMap.get(slot.dataset.id);
    const fp = sc && sc.entry && (sc.entry.folderPath || sc.entry.exe);
    if (fp) {
      springTimer = setTimeout(() => {
        springTimer = null;
        if (externalDragActive && extDragHighlight === slot) openStack(fp, slot);
      }, 700);
    }
  }
});

document.addEventListener('drop', (ev) => {
  ev.preventDefault();
  const paths = collectFilePaths(ev.dataTransfer);
  externalDragActive = false;
  extDragDepth = 0;
  if (springTimer) { clearTimeout(springTimer); springTimer = null; }
  clearExtHighlight();
  if (!paths.length) return;

  // 拖放落在 spring-loaded 展开的 Stack 面板内：把文件移入该文件夹
  if (stackCurrent && stackPanelEl.contains(ev.target)) {
    window.dock.invoke('move-files', { dest: stackCurrent.path, paths });
    return;
  }

  // 命中槽位优先：废纸篓回收 > 文件夹归置 > 用该应用打开；
  // 未命中槽位时 .exe/.lnk 落到 Dock 上才视为固定请求
  const slot = hitAnySlot(ev.clientX, ev.clientY);
  if (slot) {
    if (slot.dataset.kind === 'trash') {
      pulseTrash();
      window.dock.invoke('recycle-files', { paths });
      return;
    }
    if (slot.dataset.kind === 'folder') {
      const holder = slotMap.get(slot.dataset.id);
      const dest = holder && holder.entry && (holder.entry.folderPath || holder.entry.exe);
      if (dest) window.dock.invoke('move-files', { dest, paths });
      return;
    }
    const holder = slotMap.get(slot.dataset.id);
    if (holder && holder.entry && holder.entry.exe) {
      window.dock.invoke('open-with', {
        exe: holder.entry.exe, launch: holder.entry.launch || null,
        filePath: paths[0], args: holder.entry.args || [],
      });
    }
    return;
  }

  // 桌面快捷方式 / 可执行文件拖到 Dock → 固定为应用
  const appPaths = paths.filter((p) => /\.(exe|lnk)$/i.test(p));
  if (appPaths.length) {
    for (const p of appPaths) window.dock.invoke('add-app', { path: p });
  }
});

function collectFilePaths(dt) {
  const files = dt.files || [];
  const out = [];
  for (const f of files) {
    let p = '';
    try { p = window.dock.getFilePath(f); } catch {}
    if (!p && f.path) p = f.path;
    if (p) out.push(p);
  }
  return out;
}

function hitAnySlot(x, y) {
  for (const [, s] of slotMap) {
    const k = s.el.dataset.kind;
    if (k !== 'app' && k !== 'trash' && k !== 'folder') continue;
    const r = s.el.getBoundingClientRect();
    if (slotHitTest(r, x, y)) return s.el;
  }
  return null;
}

// =====================================================================
//  自动隐藏：隐藏后由探针叫醒；这里只负责在鼠标远离时请求收起
// =====================================================================

let autohideHideTimer = null;
let autohideInterval = null;

function syncAutohideTimer() {
  // 前台是应用时也始终启用「智能收起」，无需用户开启自动隐藏；桌面再按 autohide 设置。
  const want = !!OPT.autohide || appActiveNow;
  if (want && !autohideInterval) {
    autohideInterval = setInterval(autohidePoll, 220);
  } else if (!want && autohideInterval) {
    clearInterval(autohideInterval);
    autohideInterval = null;
    if (autohideHideTimer) {
      clearTimeout(autohideHideTimer);
      autohideHideTimer = null;
    }
  }
}

function autohidePoll() {
  if (dockHiddenNow) return;
  if (!OPT.autohide && !appActiveNow) return;   // 桌面且未开自动隐藏：不收起
  const barRect = barEl.getBoundingClientRect();
  let nearDockZone;
  if (!isVert()) {
    nearDockZone = mouseX >= barRect.left - 70 && mouseX <= barRect.right + 70 &&
                   mouseY >= barRect.top - 36;
  } else if (POS === 'left') {
    nearDockZone = mouseY >= barRect.top - 70 && mouseY <= barRect.bottom + 70 &&
                   mouseX <= barRect.right + 40;
  } else {
    nearDockZone = mouseY >= barRect.top - 70 && mouseY <= barRect.bottom + 70 &&
                   mouseX >= barRect.left - 40;
  }
  if (pointerInsideBar || nearDockZone) {
    if (autohideHideTimer) { clearTimeout(autohideHideTimer); autohideHideTimer = null; }
    return;
  }
  if (!autohideHideTimer) {
    // 应用在前台（非桌面）时更快收起，避免 dock 长时间挡在应用上；桌面则放缓。
    autohideHideTimer = setTimeout(() => {
      autohideHideTimer = null;
      window.dock.invoke('request-hide');
    }, appActiveNow ? 240 : 480);
  }
}

window.addEventListener('blur', closeMenu);
