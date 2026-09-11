'use strict';
/* =====================================================================
   Dock 渲染层 — 共享状态与槽位渲染（P3-F1b 拆分自 renderer.js）
   - S：全部会被重新赋值的可变状态（原顶层 let 变量一一对应）
   - 元素引用 / 容器（slotMap 等）：const 直接导出
   - 跨模块逆流调用（state → 上层模块）经 hooks 总线，由 dock.js 装配注册
   ===================================================================== */

export const S = {
  STATE: null,
  OPT: { iconSize: 52, magnification: 1.8, autohide: false, keepVisible: true, showIndicators: true, showRecents: true, staticOnly: false, scrollToOpen: false, springLoadApps: false, showDelayMs: 150, hideDelayMs: 360 },
  POS: 'bottom',            // dock 位置：bottom | left | right（镜像主进程 settings.position）
  mouseX: -9999, mouseY: -9999,
  pointerInsideBar: false,
  lastInteractTs: 0,
  dockHiddenNow: false,
  fullscreenHideNow: false,
  coveredHideNow: false,
  appActiveNow: false,      // 前台是应用窗口（非桌面）：用于更快的智能收起
  sessionOrder: null,
  menuOpen: false,
  stackCurrent: null,
  previewState: null,
  previewHideTimer: null,
  previewPendingApp: null,
  previewPendingTimer: null,
  previewPinned: false,
  dragState: null,
  extDragHighlight: null,
  externalDragActive: false,
  extDragDepth: 0,
  springTimer: null,
  kbdNavActive: false,
  fisheyeFrozen: false,
  shiftMagBoost: false,   // 按住 Shift 临时强制放大（macOS Control-Shift 访问 Dock 近似）
  fitScale: 1,              // P2-F4 满屏压缩系数（基准尺寸超出屏宽时 <1）
  shiftRelease: false,
  rafRunning: false,
  mouseProcQueued: false,
  wakeTimer: null,
  tipTimer: null, tipSlotEl: null,
  lastBarRectKey: '',
  trashConfirm: ConfirmArm.IDLE,
  trashConfirmTimer: null,
  openSubmenu: null,
  autohideHideTimer: null,
  autohideInterval: null,
};

// 跨模块逆流调用总线：applyEnv/applySnapshot/mouseleave 等需要调用上层模块
// （layout/menus/dnd/keyboard/dock）的行为，这里只存占位，dock.js 装配时注册
export const hooks = {
  cancelTooltip: () => {},
  hidePreview: () => {},
  ensureRaf: () => {},
  syncAutohideTimer: () => {},
  kbdNavClear: () => {},
  dockStayZone: () => false,
  openStack: () => {},
  switchStackView: () => {},
  switchStackSort: () => {},
};

export function registerHooks(partial) {
  Object.assign(hooks, partial);
}

export const $ = (sel) => document.querySelector(sel);
export const itemsEl = $('#dock-items');
export const barEl = $('#dock-bar');
export const rootEl = $('#dock-root');
export const tooltipEl = $('#tooltip');
export const menuLayerEl = $('#menu-layer');
export const ghostEl = $('#drag-ghost');
export const previewEl = $('#preview-panel');
export const stackPanelEl = $('#stack-panel');
export const slotMap = new Map();   // id -> {el, cur:{scale}, targetScale, entry}
export const winCountPrev = new Map(); // 活动指示：记录每应用上次窗口数，检测新增窗口
export const bounceSet = new Set();

// ---------------------------------------------------------------- settings
// 位置/尺寸/外观等设置项的应用与槽位基准尺寸同步

export function isVert() {
  return S.POS === 'left' || S.POS === 'right';
}

// 把当前位置写到 <html data-pos="...">，侧栏形态的 CSS 选择器据此切换；
// 底部是默认形态，不需要专门的 data-pos 规则。
export function applyPosClass() {
  document.documentElement.dataset.pos = S.POS;
}

export function syncCssVars() {
  const isz = S.OPT.iconSize;
  rootEl.style.setProperty('--is', isz + 'px');
  // 大图标（>72）时条内边距等比放大，避免 128px 图标挤在固定 padding 里显得局促
  const padH = Math.round(Math.max(12, isz * 0.22));
  const padV = Math.round(Math.max(6, isz * 0.10));
  barEl.style.setProperty('--bar-pad-x', padH + 'px');
  barEl.style.setProperty('--bar-pad-y', padV + 'px');
  barEl.style.borderRadius = Math.round(Math.max(18, isz * 0.42)) + 'px';
  // 运行指示点开关（macOS「Show indicators for open applications」）：关=不渲染圆点
  document.documentElement.classList.toggle('no-indicators', S.OPT.showIndicators === false);
  // 底部条高恒定（放大时图标浮出条外）；侧栏（左/右）条竖向撑满窗口，图标竖直排布
  barEl.style.height = isVert() ? '100%' : (isz + 18) + 'px';
  // P1-F3：iconSize 变化同步刷新槽位基准尺寸——holder 的 baseSize 是 append 时快照，
  // 不随 rebuild 更新，拖宽/滑块调整后 layoutTick 会拿旧基准算放大，必须在此同步
  for (const [, s] of slotMap) {
    const k = s.el.dataset.kind;
    s.baseSize = (k === 'recent' || k === 'min') ? Math.round(isz * 0.72) : isz;
  }
}

export function appearanceChanged(mode) {
  const dark = mode === 'dark' ||
    ((mode === undefined || mode === 'system') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** dockTheme: glass（默认签名）| classic（旧朴素）| obsidian（深色高定） */
export function applyDockTheme(theme) {
  const t = theme === 'classic' || theme === 'obsidian' ? theme : 'glass';
  document.documentElement.classList.toggle('theme-classic', t === 'classic');
  document.documentElement.classList.toggle('theme-obsidian', t === 'obsidian');
}

// =====================================================================
//  图标兜底：字母磁贴 + 废纸篓矢量图标
// =====================================================================

export function letterTile(name) {
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

export function trashSvg(full) {
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

export function folderSvg() {
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
export function applyEnv(env) {
  if (!env) return;
  S.dockHiddenNow = !!env.dockHidden;
  S.fullscreenHideNow = !!env.fullscreenHide;
  S.coveredHideNow = !!env.coveredHide;
  S.appActiveNow = !!env.appActive;
  hooks.syncAutohideTimer();   // appActive 状态变化时启停「智能收起」检测
  if (env.position && env.position !== S.POS) {
    S.POS = env.position;
    applyPosClass();
    syncCssVars();
  }
  if (env.edgeInset !== undefined) {
    rootEl.style.setProperty('--edge-inset', Math.round(env.edgeInset) + 'px');
  }
  // 自动隐藏（S.dockHiddenNow）：只能靠「贴到最底边」由主进程 request-show 解除，
  // 绝不能在鼠标位于屏幕下方时被 dockStayZone 撑开 —— 否则点应用底部的对话框
  // 就会误唤醒 dock、挡住正在操作的内容。
  // 让位隐藏（全屏/覆盖）：仅鼠标停留 Dock 保持区时才暂不隐藏（macOS 压边 dock 保持），
  // 鼠标真正离开 dock 区才让位；这样既不误唤醒，也不在边缘来回抽。
  const letHide = S.fullscreenHideNow || S.coveredHideNow;
  const hide = S.dockHiddenNow || (letHide && !hooks.dockStayZone());
  rootEl.classList.toggle('hidden-away', hide);
  // 隐藏时整窗必须穿透：无论 pointerInsideBar 当时是什么，否则透明条带
  // 会吃掉下方应用点击（「点了没反应，要再唤一次才好」的根因）
  if (hide) {
    S.pointerInsideBar = false;
    window.dock.invoke('set-click-through', { on: true });
  }
  // 主进程全局光标兜底：透明窗口在穿透切换瞬间可能收不到 mouseleave，
  // 渲染层会卡在放大态；光标已离开 Dock 区域即强制复位。
  // （唤醒竞态已在源头修复：request-show 时主进程会置 pointerNearDock=true，
  //   不会再用陈旧的 false 把刚唤醒的 Dock 打回穿透）
  // 菜单/预览/Stack 打开时不能收回穿透：否则点空白处关不掉弹层（弹层会永久卡住）。
  const overlayOpen = S.menuOpen || !!S.stackCurrent || !!S.previewState;
  if (env.pointerNearDock === false && !overlayOpen && !hooks.dockStayZone() &&
      (S.pointerInsideBar || S.mouseX > -1000)) {
    S.pointerInsideBar = false;
    S.mouseX = -9999; S.mouseY = -9999;
    hooks.cancelTooltip();
    hooks.hidePreview();
    window.dock.invoke('set-click-through', { on: true });
    hooks.ensureRaf();
  }
}

window.dock.onState((snap) => {
  S.STATE = snap;
  if (snap.settings) {
    S.OPT.iconSize = snap.settings.iconSize || S.OPT.iconSize;
    S.OPT.magnification = snap.settings.magnification || S.OPT.magnification;
    S.OPT.autohide = !!snap.settings.autohide;
    S.OPT.keepVisible = !!snap.settings.keepVisible;
    S.OPT.showIndicators = snap.settings.showIndicators !== false;
    S.OPT.showRecents = snap.settings.showRecents !== false;
    S.OPT.staticOnly = !!snap.settings.staticOnly;
    S.OPT.scrollToOpen = !!snap.settings.scrollToOpen;
    S.OPT.springLoadApps = !!snap.settings.springLoadApps;
    S.OPT.showDelayMs = Number(snap.settings.showDelayMs) || 150;
    S.OPT.hideDelayMs = Number(snap.settings.hideDelayMs) || 360;
    syncCssVars();
    hooks.syncAutohideTimer();
  }
  applyEnv(snap.env);
  reconcile();
});

window.dock.onEnv(applyEnv);

function effectiveEntries() {
  if (!S.STATE) return [];
  let entries = S.STATE.entries || [];
  if (S.sessionOrder) {
    const idx = new Map(S.sessionOrder.map((id, i) => [id, i]));
    const allKnown = entries.every(e => idx.has(e.id)) && entries.length === S.sessionOrder.length;
    if (allKnown) {
      entries = entries.slice().sort((a, b) => idx.get(a.id) - idx.get(b.id));
    } else {
      S.sessionOrder = null;
    }
  }
  return entries.filter(e => e.kind === 'app' || e.kind === 'folder');
}

export function reconcile() {
  const currentIds = [...itemsEl.children]
    .filter(el => el.dataset.kind)
    .map(el => el.dataset.id);
  const wantedIds = wantedSlotIds();

  const sameShape = currentIds.length === wantedIds.length &&
    wantedIds.every((id, i) => currentIds[i] === id);

  if (!sameShape) rebuildAll();
  else updateSlots();

  sendBarRect();
  hooks.ensureRaf();
}

// 条矩形上报（DIP）：遮挡判定用可见条区域，而非含预览留白的整个窗口

function sendBarRect() {
  // hidden-away 的 translateY 位移会被 getBoundingClientRect 计入，
  // 若在隐藏态上报会把条矩形"移出屏幕"→ 遮挡判定翻转 → 出现/消失振荡；
  // 隐藏期间保持主进程里最后一次可见矩形即可
  if (rootEl.classList.contains('hidden-away')) return;
  const r = barEl.getBoundingClientRect();
  const key = Math.round(r.left) + ',' + Math.round(r.top) + ',' +
              Math.round(r.width) + ',' + Math.round(r.height);
  if (key === S.lastBarRectKey) return;
  S.lastBarRectKey = key;
  window.dock.invoke('set-bar-rect', { x: r.x, y: r.y, w: r.width, h: r.height });
}

function wantedSlotIds() {
  const ids = effectiveEntries().map((e) => e.id);
  const recents = (S.STATE && S.STATE.recent) || [];
  const mins = (S.STATE && S.STATE.minimized) || [];
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
  // 下载/传输进度环（NSDockTile progress 对等近似；无数据时隐藏）
  const ring = document.createElement('div');
  ring.className = 'progress-ring';
  wrap.appendChild(ring);
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
    const count = (S.STATE && S.STATE.trash && S.STATE.trash.count) || 0;
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
  const ringEl = slot.querySelector('.progress-ring');
  if (ringEl) {
    const p = entry.progress;
    if (typeof p === 'number' && p > 0 && p < 1) {
      const deg = Math.round(p * 360);
      ringEl.style.setProperty('--deg', deg + 'deg');
      ringEl.classList.add('on');
    } else {
      ringEl.classList.remove('on');
    }
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
    append(entry.id, el, entry.kind || 'app', S.OPT.iconSize, entry);
  }

  const recents = (S.STATE && S.STATE.recent) || [];
  const mins = (S.STATE && S.STATE.minimized) || [];
  append('__divider__', makeDivider('__divider__'), 'divider', S.OPT.iconSize, null);
  for (const r of recents) {
    const el = makeRecentSlot(r);
    applyEntryToSlot(el, r);
    append(r.id, el, 'recent', Math.round(S.OPT.iconSize * 0.72), r);
  }
  if (mins.length) {
    if (recents.length) {
      append('__divider2__', makeDivider('__divider2__'), 'divider', S.OPT.iconSize, null);
    }
    for (const m of mins) {
      const el = makeMinSlot(m);
      applyEntryToSlot(el, m);
      append(m.id, el, 'min', Math.round(S.OPT.iconSize * 0.72), m);
    }
  }
  // 废纸篓前一条分隔线（macOS 形态）；最近/最小化区为空时避免与 divider 相邻成双线
  if (recents.length || mins.length) {
    append('__divider3__', makeDivider('__divider3__'), 'divider', S.OPT.iconSize, null);
  }

  const trash = makeTrashSlot();
  applyEntryToSlot(trash, { kind: 'trash' });
  append('__trash__', trash, 'trash', S.OPT.iconSize, { kind: 'trash' });
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
  for (const r of (S.STATE && S.STATE.recent) || []) {
    const s = slotMap.get(r.id);
    if (!s) continue;
    s.entry = r;
    applyEntryToSlot(s.el, r);
  }
  for (const m of (S.STATE && S.STATE.minimized) || []) {
    const s = slotMap.get(m.id);
    if (!s) continue;
    s.entry = m;
    applyEntryToSlot(s.el, m);
  }
  const trash = slotMap.get('__trash__');
  if (trash) applyEntryToSlot(trash.el, { kind: 'trash' });
}

// =====================================================================
export function gapPx() { return Math.max(4, Math.round(S.OPT.iconSize * 0.13)); }

export function appSlotEls() {
  return [...itemsEl.children].filter(el => el.dataset.kind === 'app' || el.dataset.kind === 'folder');
}

// 启动弹跳（macOS 语义：弹到应用就绪为止）。就绪判据：本条目或同 exe 的任意
// 运行条目出现窗口（覆盖「最近区」点击与 alias→真实 exe 改名的情形）；
// 封顶 3s：应用始终未出窗（启动器/无窗口进程）时停弹，避免无限弹跳。
export function launchWithBounce(entry) {
  bounceSet.add(entry.id);
  const s = slotMap.get(entry.id);
  if (s) s.el.classList.add('bouncing');
  window.dock.invoke('launch', {
    exe: entry.exe, launch: entry.launch || null, args: entry.args || [],
  }).catch(() => {});
  const t0 = Date.now();
  const exeL = String(entry.exe || '').toLowerCase();
  const timer = setInterval(() => {
    const cur = (slotMap.get(entry.id) || {}).entry;
    const ready = (S.STATE.entries || []).some((e) => (e.windows || []).length > 0 &&
      (e.id === entry.id ||
       (exeL && String(e.exe || '').toLowerCase() === exeL) ||
       (cur && cur.exe && String(e.exe || '').toLowerCase() === String(cur.exe).toLowerCase())));
    if (ready || Date.now() - t0 >= 3000) {
      clearInterval(timer);
      bounceSet.delete(entry.id);
      const ss = slotMap.get(entry.id);
      if (ss) ss.el.classList.remove('bouncing');
    }
  }, 180);
}

export function shiftAmounts(insertAt, fromIndex, n) {
  const shifts = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === fromIndex) continue;
    if (fromIndex < insertAt && i > fromIndex && i < insertAt) shifts[i] = -1;
    else if (fromIndex > insertAt && i >= insertAt && i < fromIndex) shifts[i] = 1;
  }
  return shifts;
}

// 图标底板（icon-plate.js 并入）：给 img 挂 plate-on 标记（P3-F1b）
function applyPlate(slot) {
  const img = slot.querySelector('img.app-icon');
  if (img && img.isConnected) img.classList.add('plate-on');
}
