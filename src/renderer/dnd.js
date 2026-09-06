'use strict';
// Dock 渲染层 — Stack/点击激活/内部拖拽/外部文件投放（P3-F1b 拆分）
import {
  S, itemsEl, barEl, ghostEl, stackPanelEl, slotMap,
  isVert, letterTile, launchWithBounce, gapPx, appSlotEls,
} from './state.js';
import { ensureRaf, requestLayout, startDividerResize } from './layout.js';
import { showPreview, closeMenu, pulseTrash, cancelTooltip, playPoof } from './menus.js';

//  文件夹 Stack（弹层网格）
// =====================================================================

const stackIconCache = new Map();
let stackCellClickSuppressed = false;   // P2-F5：拖出结束后的 click 抑制

function closeStack() {
  stackPanelEl.classList.remove('on');
  stackPanelEl.classList.add('hidden');
  stackPanelEl.innerHTML = '';
  S.stackCurrent = null;
  if (!S.pointerInsideBar && !S.menuOpen && !S.previewState) {
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

export function switchStackView(f, view) {
  f.stackView = view;
  const path = f.folderPath || f.exe || '';
  window.dock.invoke('set-stack-view', { path, view });
  if (S.stackCurrent && S.stackCurrent.path === path) renderStack(path, view, S.stackCurrent.sortBy);
}

// P1-F5：切换排序方式，写回 settings 并即时刷新已打开的 Stack 面板
export function switchStackSort(f, sortBy) {
  f.stackSortBy = sortBy;
  const path = f.folderPath || f.exe || '';
  window.dock.invoke('set-stack-sort', { path, sortBy });
  if (S.stackCurrent && S.stackCurrent.path === path) renderStack(path, S.stackCurrent.viewConf, sortBy);
}

export async function openStack(folderPath, anchorEl, view) {
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
    stackPanelEl.style.left = S.POS === 'left'
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
  const isSame = S.stackCurrent && S.stackCurrent.path === folderPath;
  const viewConf = viewArg !== undefined ? viewArg
    : (isSame ? S.stackCurrent.viewConf : 'auto');
  const sortBy = sortByArg !== undefined ? sortByArg
    : (isSame ? S.stackCurrent.sortBy : 'name');
  const view = StackSort.stackViewMode(rawEntries.length, viewConf);
  const entries = StackSort.sortStackItems(rawEntries, sortBy);
  S.stackCurrent = { path: folderPath, title: name, viewConf, sortBy, view, entries };

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
    cell.__entry = ent;   // P2-F5 Stack 拖出：cell 携带条目身份（含 iconPath/isFolder）
    const img = document.createElement('img');
    img.draggable = false;
    cell.appendChild(img);
    const label = document.createElement('div');
    label.className = 'st-name';
    label.textContent = ent.name;
    cell.appendChild(label);
    fetchStackIcon(ent.iconPath).then((url) => { if (img.isConnected) img.src = url; });
    cell.addEventListener('click', () => {
      if (stackCellClickSuppressed) return;
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
  setTimeout(() => { if (S.stackCurrent) closeStack(); }, 350);
});

document.addEventListener('mousedown', (ev) => {
  if (S.stackCurrent && !stackPanelEl.contains(ev.target)) closeStack();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && S.stackCurrent) closeStack();
});

// =====================================================================
//  P2-F5 Stack 拖出（macOS 堆栈可拖出文件）：拖 Stack 单元到 Dock 槽位 —
//  废纸篓=回收，应用=用该应用打开，文件夹=移入；拖到面板内子文件夹=移入
// =====================================================================

stackPanelEl.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  const cell = ev.target.closest('.st-cell');
  if (!cell || !cell.__entry) return;
  const entry = cell.__entry;
  const startX = ev.clientX, startY = ev.clientY;
  let dragging = false;

  const highlightSlot = (hit) => {
    if (S.extDragHighlight !== hit) {
      clearExtHighlight();
      S.extDragHighlight = hit;
      if (hit) hit.classList.add('targeted');
    }
  };

  const onMove = (mev) => {
    if (!dragging) {
      if (mev.buttons !== 1) { cleanup(); return; }
      if (Math.abs(mev.clientX - startX) + Math.abs(mev.clientY - startY) < 6) return;
      dragging = true;
      const g = document.createElement('img');
      g.src = (cell.querySelector('img') || {}).src || '';
      g.style.width = '42px';
      g.style.height = '42px';
      ghostEl.innerHTML = '';
      ghostEl.appendChild(g);
      ghostEl.classList.remove('hidden');
      ghostEl.style.opacity = '.92';
      cell.style.opacity = '.35';
    }
    ghostEl.style.left = (mev.clientX - 21) + 'px';
    ghostEl.style.top = (mev.clientY - 21) + 'px';
    const inZone = pointInDropZone(barEl.getBoundingClientRect(), mev.clientX, mev.clientY);
    highlightSlot(inZone ? hitAnySlot(mev.clientX, mev.clientY) : null);
  };

  const cleanup = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    ghostEl.classList.add('hidden');
    cell.style.opacity = '';
    clearExtHighlight();
  };

  const onUp = (mev) => {
    const wasDragging = dragging;
    cleanup();
    if (!wasDragging) return;   // 未达拖拽阈值：按普通点击走 cell click
    stackCellClickSuppressed = true;
    setTimeout(() => { stackCellClickSuppressed = false; }, 0);

    const slot = hitAnySlot(mev.clientX, mev.clientY);
    if (slot) {
      if (slot.dataset.kind === 'trash') {
        pulseTrash();
        window.dock.invoke('recycle-files', { paths: [entry.iconPath] });
        return;
      }
      if (slot.dataset.kind === 'folder') {
        const h = slotMap.get(slot.dataset.id);
        const dest = h && h.entry && (h.entry.folderPath || h.entry.exe);
        if (dest) window.dock.invoke('move-files', { dest, paths: [entry.iconPath] });
        return;
      }
      const h = slotMap.get(slot.dataset.id);
      if (h && h.entry && h.entry.exe) {
        window.dock.invoke('open-with', {
          exe: h.entry.exe, launch: h.entry.launch || null,
          filePaths: [entry.iconPath], args: h.entry.args || [],
        });
      }
      return;
    }
    // 拖到面板内的子文件夹单元 → 移入并刷新；面板背景/其他位置 → 不动作
    const under = document.elementFromPoint(mev.clientX, mev.clientY);
    const cellHit = under && under.closest ? under.closest('.st-cell') : null;
    if (cellHit && cellHit.__entry && cellHit.__entry.isFolder && stackPanelEl.contains(cellHit)) {
      window.dock.invoke('move-files', { dest: cellHit.__entry.iconPath, paths: [entry.iconPath] });
      if (S.stackCurrent) renderStack(S.stackCurrent.path, S.stackCurrent.viewConf, S.stackCurrent.sortBy);
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// =====================================================================
//  滚轮悬停（macOS scroll-to-open 的对齐）：
//  滚轮悬停运行中应用图标 → Exposé 窗口总览；悬停文件夹 → 展开 Stack
// =====================================================================

let wheelExposeAt = 0;
itemsEl.addEventListener('wheel', (ev) => {
  const slot = ev.target.closest('.slot');
  if (!slot) return;
  const holder = slotMap.get(slot.dataset.id);
  const entry = holder && holder.entry;
  if (slot.dataset.kind === 'folder' && entry) {
    ev.preventDefault();
    openStack(entry.folderPath || entry.exe || '', holder.el, entry.stackView);
    return;
  }
  if (slot.dataset.kind === 'app' && entry && (entry.windows || []).length > 0) {
    // 滚轮事件流一秒可达数十次：一次手势只触发一次 Exposé
    if (Date.now() - wheelExposeAt < 1200) return;
    wheelExposeAt = Date.now();
    ev.preventDefault();
    window.dock.invoke('expose-open', {
      appName: entry.name || '',
      appIcon: entry.icon || '',
      windows: entry.windows.slice(0, 24),
    }).catch(() => {});
  }
}, { passive: false });

// =====================================================================
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
  if (S.menuOpen) closeMenu();

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

export function handleClick(id, entryAtPress, mods) {
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
      const runEntry = (S.STATE.entries || []).find(
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
      const runningExes = (S.STATE.entries || [])
        .filter((e) => (e.windows || []).length > 0 && e.id !== fresh.id)
        .map((e) => e.exe);
      const prev = ModifierActions.previousRunningApp(S.STATE.recent || [], runningExes, fresh.exe);
      const prevEntry = prev
        ? (S.STATE.entries || []).find((e) => String(e.exe || '').toLowerCase() === String(prev.exe || '').toLowerCase() &&
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

function startInternalDrag(id, slot, ev) {
  cancelTooltip();
  S.mouseX = -9999;
  const imgEl = slot.querySelector('img.app-icon');

  const g = document.createElement('img');
  g.src = imgEl.src;
  g.style.width = S.OPT.iconSize + 'px';
  g.style.height = S.OPT.iconSize + 'px';
  ghostEl.innerHTML = '';
  ghostEl.appendChild(g);
  ghostEl.classList.remove('hidden');
  ghostEl.style.opacity = '.92';

  const els0 = appSlotEls();
  const originIdx = els0.indexOf(slot);
  S.dragState = {
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
  if (!S.dragState) return;
  S.dragState.ghost.style.left = (ev.clientX - S.OPT.iconSize / 2) + 'px';
  S.dragState.ghost.style.top = (ev.clientY - S.OPT.iconSize / 2) + 'px';

  // 实时解析存活 slot：拖拽期间状态推送可能触发 rebuildAll 重建节点，
  // 任何快照列表都会游离失效（getBoundingClientRect 全 0），必须每帧重新解析
  const els = appSlotEls();
  const originIdx = els.findIndex(el => el.dataset.id === S.dragState.id);
  if (originIdx >= 0) {
    S.dragState.originIndex = originIdx;
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
  } else if (S.POS === 'left') {
    draggedOut =
      ev.clientX > barRect.right + 90 || ev.clientX < barRect.left - 46 ||
      ev.clientY < barRect.top - 50 || ev.clientY > barRect.bottom + 50;
  } else {
    draggedOut =
      ev.clientX < barRect.left - 90 || ev.clientX > barRect.right + 46 ||
      ev.clientY < barRect.top - 50 || ev.clientY > barRect.bottom + 50;
  }

  const entry = (slotMap.get(S.dragState.id) || {}).entry;
  const removable = entry && entry.pinned;

  if (draggedOut && removable) {
    if (!S.dragState.removalPending) {
      S.dragState.removalPending = true;
      S.dragState.ghost.style.opacity = '.25';
    }
  } else if (S.dragState.removalPending) {
    S.dragState.removalPending = false;
    S.dragState.ghost.style.opacity = '.92';
  }

  let best = 0, bestDist = Infinity;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const r = el.getBoundingClientRect();
    const c = vert ? r.top + r.height / 2 : r.left + r.width / 2;
    const d = Math.abs(mp - c);
    if (d < bestDist) { bestDist = d; best = mp > c ? i + 1 : i; }
  }
  S.dragState.insertIndex = draggedOut ? -1 : best;

  // P2-F1b：避让位移交给 layoutTick 的弹簧积分（每帧逼近目标），这里只更新
  // 插入点/起点索引；不再直接写 transform，更不移除 CSS transition ——
  // 双驱动会互相踩踏，位移变换由弹簧唯一驱动。
}

// P2-F1b：拖拽结束后的回位中标志——目标归零由弹簧自然逼近，播完自清

function endInternalDrag(_ev, cancelled) {
  const st = S.dragState;
  S.dragState = null;
  if (!st) return;
  ghostEl.classList.add('hidden');
  // P2-F1b：不清 transform（弹簧回位中），只清理置灰；回位 settled 后统一清除
  S.shiftRelease = true;
  itemsEl.querySelectorAll('.slot').forEach(el => { el.style.opacity = ''; });
  S.mouseX = _ev ? _ev.clientX : -9999;
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
  S.sessionOrder = ids.slice();
  window.dock.invoke('reorder', { ids });
}

// =====================================================================
//  外部文件拖放：交给应用打开 / 投入废纸篓
// =====================================================================

function clearExtHighlight() {
  for (const [, s] of slotMap) s.el.classList.remove('targeted');
  S.extDragHighlight = null;
}

document.addEventListener('dragenter', (ev) => {
  const types = [...(ev.dataTransfer.types || [])];
  if (!types.includes('Files')) return;
  S.externalDragActive = true;
  S.extDragDepth++;
  S.mouseX = -9999;
  ensureRaf();
});

document.addEventListener('dragleave', () => {
  S.extDragDepth = Math.max(0, S.extDragDepth - 1);
  if (S.extDragDepth === 0) {
    S.externalDragActive = false;
    clearExtHighlight();
  }
});

// 投放热区：条矩形沿主轴 ±10、朝屏幕内侧 +24、贴边侧 +30
function pointInDropZone(b, x, y) {
  if (!isVert()) {
    return y >= b.top - 24 && y <= b.bottom + 30 && x >= b.left - 10 && x <= b.right + 10;
  }
  const inX = S.POS === 'left'
    ? (x >= b.left - 30 && x <= b.right + 24)
    : (x >= b.left - 24 && x <= b.right + 30);
  return inX && y >= b.top - 10 && y <= b.bottom + 10;
}

// 槽位命中：主轴 ±3，朝屏幕内侧（放大溢出方向）+26，贴边侧 +16
function slotHitTest(r, x, y) {
  if (!isVert()) {
    return x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 26 && y <= r.bottom + 16;
  }
  const inX = S.POS === 'left'
    ? (x >= r.left - 16 && x <= r.right + 26)
    : (x >= r.left - 26 && x <= r.right + 16);
  return inX && y >= r.top - 3 && y <= r.bottom + 3;
}

document.addEventListener('dragover', (ev) => {
  if (!S.externalDragActive || S.dragState) return;
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
  if (S.extDragHighlight !== slot) {
    clearExtHighlight();
    S.extDragHighlight = slot;
    if (slot) {
      slot.classList.add('targeted');
      const sc = slotMap.get(slot.dataset.id || '__trash__');
      if (sc) sc.targetScale = Math.max(sc.targetScale || 1, S.OPT.magnification * 0.72);
      ensureRaf();
    }
  }
  // spring-loaded：拖文件悬停文件夹图标 ~700ms 自动展开其 Stack 面板
  if (S.springTimer) { clearTimeout(S.springTimer); S.springTimer = null; }
  if (slot && slot.dataset.kind === 'folder') {
    const sc = slotMap.get(slot.dataset.id);
    const fp = sc && sc.entry && (sc.entry.folderPath || sc.entry.exe);
    if (fp) {
      S.springTimer = setTimeout(() => {
        S.springTimer = null;
        if (S.externalDragActive && S.extDragHighlight === slot) openStack(fp, slot);
      }, 700);
    }
  }
});

document.addEventListener('drop', (ev) => {
  ev.preventDefault();
  const paths = collectFilePaths(ev.dataTransfer);
  S.externalDragActive = false;
  S.extDragDepth = 0;
  if (S.springTimer) { clearTimeout(S.springTimer); S.springTimer = null; }
  clearExtHighlight();
  if (!paths.length) return;

  // 拖放落在 spring-loaded 展开的 Stack 面板内：把文件移入该文件夹
  if (S.stackCurrent && stackPanelEl.contains(ev.target)) {
    window.dock.invoke('move-files', { dest: S.stackCurrent.path, paths });
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
        filePaths: paths, args: holder.entry.args || [],
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
