'use strict';
// =====================================================================
// 「固定应用到 Dock」核心逻辑（从 main.js 的 pinAppFromPath 提取）
//
// 把 .exe / .lnk 固定到 Dock：.lnk 先经桥接解析真实目标（保留原始快捷方式
// 路径作为 launch 入口，避免丢失工作目录/参数/UWP 注册），图标按
// 「快捷方式自定义图标 → 目标程序 → 快捷方式本身」回退；按「目标 + 名字」
// 去重，同一程序的不同快捷方式（如豆包/豆包浏览器）可分别固定。
//
// 提取动机：这是用户高频路径且分支多（解析失败回退 / UWP 空目标 / 去重），
// 原先内联在 main.js 的 IPC switch 里无法单测。依赖显式注入后可在
// node:test 里用假 bridge / 假 settings 整段验证。
// =====================================================================

// 把快捷方式 IconLocation（"路径,索引" 或纯路径或空）规范成图标源：
// 空/仅索引 → 回退到目标程序；否则原样保留（含 ,索引）
function normalizeIconSource(iconLocation, fallbackExe) {
  const s = String(iconLocation || '').trim();
  if (!s) return fallbackExe;
  const m = s.match(/^(.*?),\s*(\d+)$/);
  if (m) {
    return m[1].trim() ? s : fallbackExe;
  }
  return s;
}

// deps:
//   getBridge()          -> NativeBridge 实例（resolve-shortcut 命令；用 getter
//                           规避工厂创建早于 main.js 给 bridge 赋值的时序问题）
//   getSettingsAll()     -> object（读 pins）
//   setSetting(k, v)     -> 写 pins
//   fsLike               -> { existsSync }，默认 node:fs（测试可替换）
function createPinApp(deps) {
  const { getBridge, getSettingsAll, setSetting, fsLike } = deps;
  const fs = fsLike || require('node:fs');

  return async function pinAppFromPath(p) {
    const filePath = String(p.path || '');
    if (!filePath) return { ok: false, err: 'no-path' };
    const path = require('node:path');
    const ext = path.extname(filePath).toLowerCase();
    let target = filePath;
    let name = path.basename(filePath, ext);
    let iconPath = null;
    let args = '';
    // .lnk 保留原始快捷方式路径作为启动目标，避免解析后丢失工作目录/参数/UWP 注册
    let launch = ext === '.lnk' ? filePath : null;
    if (ext === '.lnk') {
      try {
        const res = await getBridge().request('resolve-shortcut', { path: filePath }, 8000);
        if (res && res.target) target = res.target;
        if (res && res.name) name = res.name;
        // 图标来源：快捷方式自定义图标（IconLocation）→ 目标程序（避免快捷方式箭头）；
        // 目标是商店 UWP / 别名（无真实 exe）时回退到快捷方式本身，让 SHGetFileInfo 取系统 shell 图标
        const targetIsReal = !!target && (fs.existsSync(target) || /\.(exe|bat|cmd)$/i.test(target));
        iconPath = normalizeIconSource(res && res.iconLocation, targetIsReal ? target : filePath);
        args = (res && res.arguments) || '';
      } catch (e) {
        // 解析失败不阻断：直接用快捷方式本身启动/取图标
        launch = filePath;
        target = filePath;
        iconPath = filePath;
      }
    }
    // UWP / 无目标 exe 的快捷方式：target 会为空，此时回退为快捷方式本身作为稳定的 exe 标识
    if (!target) target = filePath;
    const pins = getSettingsAll().pins || [];
    let existing = pins.find((x) => x.exe === target && x.name === name);
    if (!existing) {
      existing = {
        id: 'app:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        name, exe: target, iconPath, args, launch,
      };
      pins.push(existing);
      setSetting('pins', pins);
    }
    return { ok: true, id: existing.id, name: existing.name, exe: existing.exe };
  };
}

module.exports = { createPinApp, normalizeIconSource };
