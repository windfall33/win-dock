'use strict';
// P3-F1a main.js 拆分：IPC 应用动作（启动/退出/窗口编排类重 case 的实现）。
// 纯平移：函数体自 main.js 逐行迁移，共享状态经 ctx 读写。
const { execFile, spawn } = require('child_process');
const path = require('path');
const { shell } = require('electron');

function createAppActions(ctx) {
  const { log } = ctx;

  // 开机自启：未打包的 Electron 必须显式传 path（electron.exe）与 args（应用目录），
  // 否则注册表只写 exe 路径、不带应用参数，开机后起不来 Dock。
  function applyLoginItem(open) {
    try {
      const opts = { openAtLogin: !!open };
      if (!ctx.app.isPackaged) {
        opts.path = process.execPath;
        opts.args = [ctx.app.getAppPath()];
      }
      ctx.app.setLoginItemSettings(opts);
    } catch (e) {
      log('setLoginItemSettings failed', e.message);
    }
  }

  // 统一启动入口：尽可能交给 Windows 系统 ShellExecute（Start-Process / Electron shell），
  // 完整保留工作目录、快捷方式参数、图标、UWP 注册、单实例语义；不再对 .exe 用 spawn 裸奔。
  async function launchTarget(target, args) {
    if (!target) return;
    const ext = path.extname(target).toLowerCase();
    const argArr = Array.isArray(args)
      ? args.map(String)
      : (typeof args === 'string' && args.trim() ? [args] : []);

    // Windows Terminal 的应用执行别名：CreateProcess/start 都会把参数整串当成可执行名（0x80070002）。
    // 唯一稳的是用 PowerShell 的 & 调用，参数才会被正确拆分。
    if (/wt\.exe$/i.test(target)) {
      const quoted = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const psCmd = '& ' + [target, ...argArr].map(quoted).join(' ');
      try {
        const child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd,
        ], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch { /* 交给兜底 */ }
      return;
    }

    // shell 命名空间（回收站 / AppsFolder 等）→ explorer
    if (target.startsWith('shell:')) {
      await ctx.bridge.request('open', { target }, 15000).catch(() => {});
      return;
    }

    // .lnk：原始快捷方式直接交给系统 ShellExecute，Windows 自行解析工作目录/参数/图标/UWP 注册
    if (ext === '.lnk') {
      await ctx.bridge.request('open', { target }, 15000).catch(() => {});
      return;
    }

    // .exe/.bat/.cmd 或带参数的目标 → bridge Start-Process（等同 ShellExecute，保留工作目录/提权/DDE 语义）
    if (['.exe', '.bat', '.cmd'].includes(ext) || argArr.length) {
      // 保留参数原类：字符串（快捷方式 Arguments/Launchpad）原样交桥接 Start-Process 解析，
      // 数组则逐元素加引号（含空格的文件路径等）。避免把 `--flag "path"` 当单个参数拆分错。
      const preserveArgs = typeof args === 'string' ? args : argArr;
      await ctx.bridge.request('open', { target, args: preserveArgs }, 15000).catch(() => {});
      return;
    }

    // 其余类型（文件/目录/协议）→ Electron shell
    shell.openPath(target);
  }

  async function quitApp(p) {
    // macOS Dock「退出」= 真正退出应用。按「该应用各窗口所属进程」逐个 /PID 退出，
    // 不用 /IM 镜像名（会误杀同名进程，如多个 Chrome/python.exe）。taskkill 不带 /F 发 WM_CLOSE 优雅退出。
    const hs = p.hs || [];
    const pids = new Set();
    for (const h of hs) {
      try {
        const r = await ctx.bridge.request('window-pid', { h: String(h) }, 5000);
        if (r && r.pid) pids.add(Number(r.pid));
      } catch {}
    }
    // P1-F6：hung（无响应）应用走「强制退出」——跳过优雅等待，直接 Stop-Process -Force
    // （复用强杀路径；explorer 是 Windows 外壳，强杀会连任务栏一起拔掉，同样排除）
    if (p.force) {
      if (pids.size) {
        const idList = [...pids].join(',');
        await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Get-Process -Id ' + idList + ' -ErrorAction SilentlyContinue | ' +
          "Where-Object { $_.ProcessName -ne 'explorer' } | Stop-Process -Force"], () => res()));
      }
      return { ok: true };
    }
    for (const pid of pids) {
      try { await new Promise((res) => execFile('taskkill', ['/PID', String(pid)], () => res())); } catch {}
    }
    // 强杀兜底：WM_CLOSE 后仍存活（如弹了「是否保存」对话框挂住）→ ~3s 后升级 /F。
    // 用 Get-Process 按 Id 探活（进程已退出自然落空）；explorer 是 Windows 外壳，
    // 强杀会连任务栏一起拔掉，排除。
    if (pids.size) {
      const idList = [...pids].join(',');
      const t = setTimeout(() => {
        ctx.forceKillTimers.delete(t);
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Get-Process -Id ' + idList + ' -ErrorAction SilentlyContinue | ' +
          "Where-Object { $_.ProcessName -ne 'explorer' } | Stop-Process -Force"], () => {});
      }, 3000);
      if (typeof t.unref === 'function') t.unref();
      ctx.forceKillTimers.add(t);
    }
    return { ok: true };
  }

  async function modifierAction(p) {
    // P1-F1 修饰键点击编排（决策在 core/modifier-actions.js / renderer，这里只做 IO）。
    // 最小化失败的窗口（提权进程等）跳过且不重试，单次汇总记一条日志。
    const failures = [];
    if (p.type === 'hide-current') {
      // 最小化当前应用全部窗口 + 焦点给上一个运行中应用（无候选则焦点自然回桌面）
      for (const h of p.hs || []) {
        try { await ctx.bridge.request('minimize', { h }, 3000); } catch { failures.push(String(h)); }
      }
      const prevHs = p.prevHs || [];
      if (prevHs.length) {
        try { await ctx.bridge.request('focus', { h: prevHs[prevHs.length - 1] }, 3000); }
        catch { failures.push('focus-prev'); }
      }
    } else if (p.type === 'hide-others') {
      // 先聚焦目标，再最小化其他所有应用窗口
      const focusH = (p.hs || [])[0];
      if (focusH) {
        try { await ctx.bridge.request('focus', { h: focusH }, 3000); }
        catch { failures.push('focus-target'); }
      }
      const mine = new Set((p.hs || []).map(String));
      const wins = await ctx.bridge.request('enum-windows', { excludePid: process.pid }, 8000).catch(() => []);
      for (const w of (Array.isArray(wins) ? wins : [])) {
        if (!w.m && !mine.has(String(w.h))) {
          try { await ctx.bridge.request('minimize', { h: w.h }, 3000); } catch { failures.push(String(w.h)); }
        }
      }
    } else {
      return { ok: false, err: 'unknown-modifier-action:' + String(p.type || '') };
    }
    if (failures.length) log('modifier-action: skipped', failures.length, 'window(s) (no retry)');
    return { ok: true, failed: failures.length };
  }

  async function hideOthers(p) {
    // macOS「隐藏其他」：最小化除当前应用外的所有窗口
    const mine = new Set((p.hs || []).map(String));
    const wins = await ctx.bridge.request('enum-windows', { excludePid: process.pid }, 8000).catch(() => []);
    for (const w of (Array.isArray(wins) ? wins : [])) {
      if (!w.m && !mine.has(String(w.h))) {
        try { await ctx.bridge.request('minimize', { h: w.h }, 3000); } catch {}
      }
    }
    return { ok: true };
  }

  async function showAll() {
    // macOS「显示所有窗口」：还原所有最小化窗口
    const wins = await ctx.bridge.request('enum-windows', { excludePid: process.pid }, 8000).catch(() => []);
    for (const w of (Array.isArray(wins) ? wins : [])) {
      if (w.m) {
        try { await ctx.bridge.request('focus', { h: w.h }, 3000); } catch {}
      }
    }
    return { ok: true };
  }

  async function killApp(p) {
    await new Promise((res) => execFile('taskkill', ['/PID', String(p.pid), '/F'], () => res()));
    return { ok: true };
  }

  return { applyLoginItem, launchTarget, quitApp, modifierAction, hideOthers, showAll, killApp };
}

module.exports = { createAppActions };
