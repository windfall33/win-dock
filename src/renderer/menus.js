'use strict';
// Dock 渲染层 — tooltip/窗口预览/右键菜单/清空回收站确认（P3-F1b 拆分）
import {
  S, itemsEl, barEl, tooltipEl, menuLayerEl, previewEl, slotMap,
  isVert, letterTile, launchWithBounce, registerHooks,
} from './state.js';

registerHooks({ cancelTooltip, hidePreview });

//  tooltip
// =====================================================================

export function cancelTooltip() {
  if (S.tipTimer) { clearTimeout(S.tipTimer); S.tipTimer = null; }
  tooltipEl.classList.remove('visible');
  S.tipSlotEl = null;
}

itemsEl.addEventListener('mouseover', (ev) => {
  const slot = ev.target.closest('.slot');
  if (!slot || slot === S.tipSlotEl) return;
  cancelTooltip();
  S.tipSlotEl = slot;
  S.tipTimer = setTimeout(() => {
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
      tooltipEl.style.left = S.POS === 'left'
        ? (barRect.right + 10) + 'px'
        : (barRect.left - 10 - tw) + 'px';
    }
    tooltipEl.classList.add('visible');
  }, 420);
});
itemsEl.addEventListener('mouseout', (ev) => {
  const to = ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest('.slot');
  if (to !== S.tipSlotEl) cancelTooltip();
});
barEl.addEventListener('mouseleave', cancelTooltip);

// =====================================================================
//  窗口缩略图预览（悬停运行中应用图标 → 面板弹出）
// =====================================================================

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

export function playPoof(x, y) {
  const el = document.createElement('img');
  el.className = 'poof';
  el.src = poofSvg();
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 500);
}

export function pulseTrash() {
  const trash = slotMap.get('__trash__');
  if (!trash) return;
  trash.el.classList.remove('trash-pulse');
  void trash.el.offsetWidth;
  trash.el.classList.add('trash-pulse');
  setTimeout(() => trash.el.classList.remove('trash-pulse'), 550);
}

export function hidePreview() {
  S.previewPinned = false;
  if (S.previewHideTimer) { clearTimeout(S.previewHideTimer); S.previewHideTimer = null; }
  if (S.previewPendingTimer) { clearTimeout(S.previewPendingTimer); S.previewPendingTimer = null; }
  S.previewPendingApp = null;
  if (S.previewState) {
    clearInterval(S.previewState.refreshTimer);
    S.previewState = null;
  }
  previewEl.classList.remove('on');
  previewEl.classList.add('hidden');
  previewEl.innerHTML = '';
  if (!S.pointerInsideBar && !S.menuOpen && !S.stackCurrent) {
    window.dock.invoke('set-click-through', { on: true });
  }
}

// 点击已聚焦多窗口打开的窗口网格：点击网格外任意处关闭
document.addEventListener('mousedown', (ev) => {
  if (S.previewPinned && !previewEl.contains(ev.target)) hidePreview();
});

function schedulePreviewHide(delay) {
  if (S.previewPinned) return;   // 点击打开的窗口网格保持显示，直到点击外部/离开
  if (S.previewHideTimer) clearTimeout(S.previewHideTimer);
  S.previewHideTimer = setTimeout(() => { S.previewHideTimer = null; hidePreview(); }, delay);
}

function cancelPreviewHide() {
  if (S.previewHideTimer) { clearTimeout(S.previewHideTimer); S.previewHideTimer = null; }
}

async function captureThumb(h, img) {
  try {
    const res = await window.dock.invoke('window-thumb', { h });
    if (res && res.png) { img.src = 'data:image/png;base64,' + res.png; return true; }
  } catch {}
  return false;
}

export function showPreview(entry, anchorEl, pinned) {
  hidePreview();
  S.previewPinned = !!pinned;
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
    previewEl.style.left = S.POS === 'left'
      ? (barRect.right + 12) + 'px'
      : (barRect.left - 12 - pw) + 'px';
  }
  requestAnimationFrame(() => previewEl.classList.add('on'));

  // 可见期间定期重抓（准实时）；应用窗口列表失效则收起
  S.previewState = {
    appId: entry.id,
    refreshTimer: setInterval(() => {
      const holder = slotMap.get(S.previewState ? S.previewState.appId : '');
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
    if (S.previewState && S.previewState.appId === appId) return;
    if (S.previewState) hidePreview();
    if (S.previewPendingApp !== appId) {
      if (S.previewPendingTimer) clearTimeout(S.previewPendingTimer);
      S.previewPendingApp = appId;
      S.previewPendingTimer = setTimeout(() => {
        S.previewPendingTimer = null;
        S.previewPendingApp = null;
        const h2 = slotMap.get(appId);
        const e2 = h2 && h2.entry;
        if (e2 && (e2.windows || []).length > 0 && !S.previewState) showPreview(e2, h2.el);
      }, 500);
    }
  } else if (S.previewState || S.previewPendingTimer) {
    schedulePreviewHide(150);
  }
});

// =====================================================================
//  右键菜单（document 级一次路由）
// =====================================================================

// ---- F4 清空回收站二次确认（状态机 core/confirm-arm.js，UI 接线在此）----
// idle → 首点 armed（菜单项变红「确认清空」）→ 3s 内再点执行；超时/关菜单还原。
// 状态机本身不依赖定时器；这里的 setTimeout 只驱动菜单项文案还原。

function trashArmClear() {
  S.trashConfirm = ConfirmArm.IDLE;
  if (S.trashConfirmTimer) { clearTimeout(S.trashConfirmTimer); S.trashConfirmTimer = null; }
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
  const prev = S.trashConfirm;
  const res = ConfirmArm.nextState(prev, 'confirm', now);
  if (res.execute && ConfirmArm.isConfirmValid(prev, now)) {
    S.trashConfirm = ConfirmArm.IDLE;
    if (S.trashConfirmTimer) { clearTimeout(S.trashConfirmTimer); S.trashConfirmTimer = null; }
    closeMenu();
    pulseTrash();
    window.dock.invoke('empty-trash');
    return;
  }
  // 非执行击（首击或已超窗）：（重）新武装
  S.trashConfirm = ConfirmArm.nextState(ConfirmArm.IDLE, 'request', now).state;
  if (mi) {
    const sp = mi.querySelector('span');
    if (sp) sp.textContent = '确认清空';
    mi.classList.add('danger');
  }
  if (S.trashConfirmTimer) clearTimeout(S.trashConfirmTimer);
  S.trashConfirmTimer = setTimeout(() => {
    S.trashConfirmTimer = null;
    S.trashConfirm = ConfirmArm.IDLE;
    // 超时还原：菜单仍开着则把文案复原为「清空回收站」
    const cur = menuLayerEl.querySelector('.mac-menu .mi.danger');
    if (cur) {
      cur.classList.remove('danger');
      const sp = cur.querySelector('span');
      if (sp) sp.textContent = '清空回收站';
    }
  }, ConfirmArm.CONFIRM_WINDOW_MS);
}

export function closeMenu() {
  menuLayerEl.classList.add('hidden');
  menuLayerEl.innerHTML = '';
  S.menuOpen = false;
  // F4：菜单关闭即 cancel（含 armed 撤销与超时定时器清理）
  if (S.trashConfirm.phase === 'armed' || S.trashConfirmTimer) trashArmClear();
  if (!S.pointerInsideBar && !S.stackCurrent && !S.previewState) {
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
  S.menuOpen = true;
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
    mx = S.POS === 'left' ? barRect.right + 8 : barRect.left - mw - 8;
    my = Math.min(Math.max(8, y - 24), window.innerHeight - mh - 8);
  }
  menu.style.left = mx + 'px';
  menu.style.top = my + 'px';
}

// 二级子菜单（mac「选项」）：点击父项在其右侧展开
function closeSubMenu() {
  if (S.openSubmenu) { S.openSubmenu.remove(); S.openSubmenu = null; }
}
function toggleSubMenu(defs, parentMi) {
  if (S.openSubmenu && menuLayerEl.contains(S.openSubmenu)) { closeSubMenu(); return; }
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
  S.openSubmenu = sub;
}

document.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (S.dragState) return;
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
    const count = (S.STATE && S.STATE.trash && S.STATE.trash.count) || 0;
    // F4 二次确认：首点 armed（变红「确认清空」），3s 内再点执行；
    // 超时由 S.trashConfirmTimer 还原，菜单关闭由 closeMenu cancel。
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
        action: () => hooks.openStack(vp, holder.el, f.stackView),
      },
      { sep: true },
      {
        label: '显示为',
        children: [
          { label: '自动' + (viewNow === 'auto' ? '  ✓' : ''), action: () => hooks.switchStackView(f, 'auto') },
          { label: '网格' + (viewNow === 'grid' ? '  ✓' : ''), action: () => hooks.switchStackView(f, 'grid') },
          { label: '扇形' + (viewNow === 'fan' ? '  ✓' : ''), action: () => hooks.switchStackView(f, 'fan') },
          { label: '列表' + (viewNow === 'list' ? '  ✓' : ''), action: () => hooks.switchStackView(f, 'list') },
        ],
      },
      {
        label: '排序方式',
        children: [
          { label: '名称' + (sortNow === 'name' ? '  ✓' : ''), action: () => hooks.switchStackSort(f, 'name') },
          { label: '修改日期' + ((sortNow === 'modified' || sortNow === 'added') ? '  ✓' : ''), action: () => hooks.switchStackSort(f, 'modified') },
          { label: '创建日期' + (sortNow === 'created' ? '  ✓' : ''), action: () => hooks.switchStackSort(f, 'created') },
          { label: '种类' + (sortNow === 'kind' ? '  ✓' : ''), action: () => hooks.switchStackSort(f, 'kind') },
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
  showAppMenu(ev.clientX, ev.clientY, holder.entry).catch(() => {});
});

async function showAppMenu(x, y, entry) {
  const defs = [];
  const wins = entry.windows || [];
  const iconUrl = entry.icon || letterTile(entry.name);
  // 「登录时打开」当前态（macOS 选项子菜单项）：取不到按未开启显示，点击仍可切换
  let loginOn = false;
  if (entry.exe) {
    try {
      const st = await window.dock.invoke('get-login-open', { exe: entry.exe });
      loginOn = !!(st && st.on);
    } catch {}
  }
  let displays = [];
  if (wins.length > 0) {
    try {
      const dr = await window.dock.invoke('list-displays');
      displays = (dr && dr.displays) || [];
    } catch {}
  }

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

  // 「选项」二级子菜单（mac 对齐）：在资源管理器中显示 / 登录时打开 / 移除或固定
  const options = [];
  if (entry.pinned && entry.exe) {
    options.push({
      label: '在资源管理器中显示',
      action: () => window.dock.invoke('reveal', { path: entry.exe }),
    });
  }
  if (entry.exe) {
    options.push({
      label: '登录时打开' + (loginOn ? '  ✓' : ''),
      action: () => window.dock.invoke('set-login-open', {
        exe: entry.exe, target: entry.launch || entry.exe,
        args: entry.args || '', on: !loginOn,
      }),
    });
  }
  if (entry.pinned) {
    options.push({
      label: '从 Dock 中移除',
      action: () => window.dock.invoke('pin-remove', { id: entry.id }),
    });
    defs.push({
      label: '从 Dock 中移除',
      action: () => window.dock.invoke('pin-remove', { id: entry.id }),
    });
  } else if (entry.exe) {
    options.push({
      label: '固定到 Dock',
      action: () =>
        window.dock.invoke('pin-add', { id: entry.id, name: entry.name, exe: entry.exe }),
    });
  }
  // 分配到显示器（macOS「分配到桌面」的 Windows 映射）
  if (displays.length >= 2) {
    options.push({
      label: '分配到显示器',
      children: displays.map((d) => ({
        label: (d.primary ? '主显示器' : d.label || `显示器`) + `（${d.index}）`,
        action: () => window.dock.invoke('move-app-to-display', {
          displayId: d.id,
          hs: wins.map((w) => w.h),
        }),
      })),
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
      disabled: !(S.STATE && S.STATE.minimized && S.STATE.minimized.length),
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
    { label: '窗口总览（任务视图）', action: () => window.dock.invoke('mission-control') },
    { label: '添加应用…', action: () => window.dock.invoke('pick-app') },
    { label: '添加文件夹…', action: () => window.dock.invoke('pick-folder') },
    { label: 'Dock 设置…', action: () => window.dock.invoke('open-settings') },
    { sep: true },
    {
      label: S.OPT.autohide ? '关闭自动隐藏' : '打开自动隐藏',
      action: () => window.dock.invoke('set-setting', { key: 'autohide', value: !S.OPT.autohide }),
    },
    {
      label: (S.OPT.staticOnly ? '关闭' : '打开') + '只显示运行中',
      action: () => window.dock.invoke('set-setting', { key: 'staticOnly', value: !S.OPT.staticOnly }),
    },
  ]);
}

// =====================================================================
