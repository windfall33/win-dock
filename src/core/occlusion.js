'use strict';
// =====================================================================
// 遮挡/让位状态机的纯决策核心（从 main.js 的 checkOcclusion 提取）
//
// checkOcclusion 每 250ms 跑一拍，但其中真正「做决定」的部分与 Electron、
// 桥接完全无关：给定前台窗口信息与当前隐藏状态，算出下一状态。
// 把这段抽出来后可以在 node:test 里整段验证，不再「改了只能真机试」。
//
// 语义基线（勿改，均有实测依据）：
// - 桌面前台：Dock 永远显示，清掉所有隐藏标志。
// - Dock 是 screen-saver 级置顶，普通窗口（含最大化）矩形相交不算遮挡 ——
//   按矩形判 covered 曾造成 ~250ms 周期的「隐藏↔唤醒」抽搐（main.log
//   occ-hide-by 反复即证据），故 nextCovered 恒为 false，仅真全屏让位。
// - 指针贴近 Dock（cursorNear）时全屏让位也不生效，避免让位与唤醒打架。
// =====================================================================

// 前台是否桌面（或拿不到前台信息时按桌面处理：宁可显示不可失联）
function isDesktopForeground(fg, desktopClasses) {
  return !fg || !fg.e || desktopClasses.has(fg.c);
}

// 全局光标是否落在可见条矩形 ±margin 内（渲染层放大态的兜底判据）。
// margin 默认 90px：覆盖放大溢出方向，同时避免条带上的透明留白误判。
function isCursorNearBar(cur, bar, margin) {
  const m = margin == null ? 90 : margin;
  return !!(cur && bar &&
    cur.x >= bar.l - m && cur.x <= bar.r + m &&
    cur.y >= bar.t - m && cur.y <= bar.b + m);
}

// 状态机一步转移。
// input:
//   isDesktop    boolean               前台是否桌面
//   occFull      boolean               前台是否真全屏（桥接 dock-occluded 的 full）
//   occludeAway  boolean               设置项「真全屏应用时让位」
//   cursorNear   boolean               全局光标贴近 Dock（pointerNearDock）
//   prev         { onDesktopNow, fullscreenHide, coveredHideNow, dockHiddenByUs }
// 返回:
//   next                    下一状态（四个标志齐全）
//   envChanged              是否需要 sendEnv()
//   fullscreenAwayChanged   让位开关变化时给新值（on/off 日志用），未变为 null
function decideOcclusionState(input) {
  const prev = input.prev || {};
  const onDesktopPrev = !!prev.onDesktopNow;
  const fullPrev = !!prev.fullscreenHide;
  const coveredPrev = !!prev.coveredHideNow;
  const hiddenByUsPrev = !!prev.dockHiddenByUs;

  if (input.isDesktop) {
    // 桌面：Dock 永远显示（忽略 autohide 与遮挡）。
    // fullscreenAwayChanged 恒为 null：桌面分支静默复位 fullscreenHide，
    // 不打 fullscreen-away 日志（与原实现一致）
    const changed = !onDesktopPrev || fullPrev || hiddenByUsPrev || coveredPrev;
    return {
      next: { onDesktopNow: true, fullscreenHide: false, coveredHideNow: false, dockHiddenByUs: false },
      envChanged: changed,
      fullscreenAwayChanged: null,
    };
  }

  // 非桌面：仅真全屏让位；普通窗口覆盖一律不让位（防抽搐，见文件头语义基线）
  const nextFull = !input.cursorNear && !!input.occludeAway && !!input.occFull;
  const nextCovered = false;
  const envChanged = nextFull !== fullPrev || nextCovered !== coveredPrev || onDesktopPrev;
  return {
    next: { onDesktopNow: false, fullscreenHide: nextFull, coveredHideNow: nextCovered, dockHiddenByUs: hiddenByUsPrev },
    envChanged,
    fullscreenAwayChanged: nextFull !== fullPrev ? nextFull : null,
  };
}

module.exports = { isDesktopForeground, isCursorNearBar, decideOcclusionState };
