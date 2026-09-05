'use strict';
/* =====================================================================
   Dock 渲染层 — 入口装配（P3-F1b 拆分：原 renderer.js 的模块化入口）
   各领域模块（state/layout/menus/dnd/keyboard）在此接线；
   启动流程：绑定 onSettings → init()（拉取首帧快照并 reconcile）。
   ===================================================================== */
import {
  S, barEl, applyPosClass, syncCssVars, appearanceChanged, reconcile, applyEnv,
  registerHooks, isVert,
} from './state.js';
import { requestLayout, ensureRaf } from './layout.js';
import { closeMenu } from './menus.js';
import { openStack, switchStackView, switchStackSort } from './dnd.js';
import { kbdNavClear } from './keyboard.js';

registerHooks({ syncAutohideTimer });

window.dock.onSettings((s) => {
  Object.assign(S.OPT, {
    iconSize: s.iconSize,
    magnification: s.magnification,
    autohide: s.autohide,
  });
  syncCssVars();
  syncAutohideTimer();
  appearanceChanged(s.appearance);
  requestLayout();
});

async function init() {
  await window.dock.invoke('ready');
  try {
    const snap = await window.dock.getSnapshot();
    if (snap) {
      S.STATE = snap;
      if (snap.settings) {
        Object.assign(S.OPT, {
          iconSize: snap.settings.iconSize,
          magnification: snap.settings.magnification,
          autohide: !!snap.settings.autohide,
        });
      }
    }
  } catch {}
  if (S.STATE && S.STATE.env) applyEnv(S.STATE.env);
  if (S.STATE && S.STATE.settings && S.STATE.settings.position) S.POS = S.STATE.settings.position;
  applyPosClass();
  appearanceChanged((S.STATE && S.STATE.settings && S.STATE.settings.appearance) || 'system');
  syncCssVars();
  reconcile();
  ensureRaf();
}
init();

//  自动隐藏：隐藏后由探针叫醒；这里只负责在鼠标远离时请求收起
// =====================================================================

function syncAutohideTimer() {
  // 前台是应用时也始终启用「智能收起」，无需用户开启自动隐藏；桌面再按 autohide 设置。
  const want = !!S.OPT.autohide || S.appActiveNow;
  if (want && !S.autohideInterval) {
    S.autohideInterval = setInterval(autohidePoll, 220);
  } else if (!want && S.autohideInterval) {
    clearInterval(S.autohideInterval);
    S.autohideInterval = null;
    if (S.autohideHideTimer) {
      clearTimeout(S.autohideHideTimer);
      S.autohideHideTimer = null;
    }
  }
}

function autohidePoll() {
  if (S.dockHiddenNow) return;
  if (!S.OPT.autohide && !S.appActiveNow) return;   // 桌面且未开自动隐藏：不收起
  const barRect = barEl.getBoundingClientRect();
  let nearDockZone;
  if (!isVert()) {
    nearDockZone = S.mouseX >= barRect.left - 70 && S.mouseX <= barRect.right + 70 &&
                   S.mouseY >= barRect.top - 36;
  } else if (S.POS === 'left') {
    nearDockZone = S.mouseY >= barRect.top - 70 && S.mouseY <= barRect.bottom + 70 &&
                   S.mouseX <= barRect.right + 40;
  } else {
    nearDockZone = S.mouseY >= barRect.top - 70 && S.mouseY <= barRect.bottom + 70 &&
                   S.mouseX >= barRect.left - 40;
  }
  if (S.pointerInsideBar || nearDockZone) {
    if (S.autohideHideTimer) { clearTimeout(S.autohideHideTimer); S.autohideHideTimer = null; }
    return;
  }
  if (!S.autohideHideTimer) {
    // 应用在前台（非桌面）时更快收起，避免 dock 长时间挡在应用上；桌面则放缓。
    S.autohideHideTimer = setTimeout(() => {
      S.autohideHideTimer = null;
      window.dock.invoke('request-hide');
    }, S.appActiveNow ? 240 : 480);
  }
}

window.addEventListener('blur', closeMenu);
