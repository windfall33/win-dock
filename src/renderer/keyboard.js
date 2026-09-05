'use strict';
// Dock 渲染层 — 键盘导航（Tab 循环 + Ctrl+Alt+D 焦点导航）（P3-F1b 拆分）
import { S, itemsEl, slotMap, registerHooks } from './state.js';
import { requestLayout } from './layout.js';
import { handleClick } from './dnd.js';

registerHooks({ kbdNavClear });

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

export function kbdNavClear() {
  S.kbdNavActive = false;
  itemsEl.querySelectorAll('.slot.kbd-focus').forEach((el) => el.classList.remove('kbd-focus'));
}

window.dock.onFocusDock(() => {
  S.kbdNavActive = true;
  const ids = slotIdList();
  // 默认首个可用槽位；若存在聚焦应用（前台窗口 f=true）则定位到其槽位
  let target = KbdNav.homeIndex(ids);
  const focusedEntry = (S.STATE && S.STATE.entries || []).find(
    (e) => (e.windows || []).some((w) => w.f));
  if (focusedEntry) {
    const idx = ids.indexOf(focusedEntry.id);
    if (idx >= 0 && !KbdNav.isDividerId(ids[idx])) target = idx;
  }
  kbdFocusApply(target);
});

document.addEventListener('keydown', (ev) => {
  if (!S.kbdNavActive) return;
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

