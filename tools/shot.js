'use strict';
// node shot.js <out.png> <xRatio0-1> <widthRatio0-1> [hoverBarX]
// 对运行中的 Dock 做真机截图（3x 放大裁剪），可选合成鼠标悬停触发鱼眼。
//
// 必须绕开的两个坑（详见 tools/README.md）：
// 1) CDP Page.captureScreenshot 的 clip 参数在 Electron 33 无效 → 整窗截图后页面内 canvas 裁剪
// 2) 主进程用「真实光标」判定 pointerNearDock + 智能收起（前台应用时 240ms 收起）
//    → 谎报 bar rect 为全屏 + 持续合成 mousemove，压住两条收起链路
const http = require('http');
const fs = require('fs');
const OUT = process.argv[2], XR = parseFloat(process.argv[3]), WR = parseFloat(process.argv[4]);
const HOVER = process.argv[5] ? Math.round(parseFloat(process.argv[5])) : null;
function getJSON(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9223, path }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
(async () => {
  const targets = await getJSON('/json');
  const t = targets.find((p) => p.url.includes('index.html')) || targets[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 冻结显隐：
  // 1) hook invoke 丢弃 request-hide（智能收起在前台应用时 240ms 就会藏回 Dock，
  //    真实光标又无法移动，这是唯一能稳住显示的办法）
  // 2) 谎报 bar rect 为全屏（120ms 重发），压住主进程 pointerNearDock 的兜底复位
  const hookExpr = `(() => {
    if (!window.__origInvoke) {
      window.__origInvoke = window.dock.invoke.bind(window.dock);
      window.dock.invoke = function(cmd, args) {
        if (cmd === 'request-hide') return Promise.resolve({ ok: true });
        return window.__origInvoke(cmd, args);
      };
    }
    clearInterval(window.__shotFreeze);
    window.__shotFreeze = setInterval(() => {
      try { window.__origInvoke('set-bar-rect', { x: -600, y: -600, w: 4000, h: 2400 }); } catch {}
    }, 120);
    return 'hooked';
  })()`;
  const hk = await send('Runtime.evaluate', { expression: hookExpr, returnByValue: true });
  if (hk.result.value !== 'hooked') console.error('hook failed:', JSON.stringify(hk));
  await send('Runtime.evaluate', { expression: `document.documentElement.style.background='#3a3a40'; document.body.style.background='#3a3a40';
    window.dock.invoke('set-setting', { key: 'autohide', value: false }); window.dock.invoke('set-setting', { key: 'occludeAway', value: false }); window.__origInvoke('request-show'); 'ok'`, returnByValue: true });
  await sleep(800);
  const barStr = (await send('Runtime.evaluate', { expression: `(() => { const r = document.getElementById('dock-bar').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, ih: innerHeight }); })()`, returnByValue: true })).result.value;
  const B = JSON.parse(barStr);
  B.y = B.ih - B.h - 10; B.h = B.h + 20;
  const hx = Math.round(B.x + B.w / 2), hy = Math.round(B.y + B.h / 2);
  // 截图全程每 130ms 合成一次 mousemove：压住智能收起 + 维持鱼眼输入
  const keepAlive = setInterval(() => {
    send('Runtime.evaluate', { expression: `document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${hx}, clientY: ${hy}, bubbles: true })); 'ok'`, returnByValue: true }).catch(() => {});
  }, 130);
  if (HOVER !== null) {
    const px = Math.round(B.x + HOVER);
    for (let i = 0; i < 10; i++) {
      await send('Runtime.evaluate', { expression: `document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${px}, clientY: ${hy}, bubbles: true })); 'ok'`, returnByValue: true });
      await sleep(60);
    }
    await sleep(700); // 等 lerp 收敛到稳态
  } else {
    await sleep(500);
  }
  const full = await send('Page.captureScreenshot', { format: 'png', fromSurface: false });
  const b64 = full.data;
  clearInterval(keepAlive);
  const pad = 16;
  const cx = Math.max(0, B.x + B.w * XR - pad), cy = Math.max(0, B.y - pad);
  const cw = B.w * WR + pad * 2, ch = B.h + pad * 2, SCALE = 3;
  const cwR = Math.round(cw * SCALE), chR = Math.round(ch * SCALE);
  const expr = '(function(){ return new Promise(function(resolve){' +
    'var img = new Image();' +
    'img.onload = function(){' +
    'var c = document.createElement("canvas");' +
    'c.width = ' + cwR + '; c.height = ' + chR + ';' +
    'var g = c.getContext("2d");' +
    'g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";' +
    'g.drawImage(img, ' + cx + ', ' + cy + ', ' + cw + ', ' + ch + ', 0, 0, c.width, c.height);' +
    'resolve(c.toDataURL("image/png"));' +
    '};' +
    'img.src = "data:image/png;base64,' + b64 + '";' +
    '}); })()';
  const r2 = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const out = String(r2.result.value).replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(OUT, Buffer.from(out, 'base64'));
  console.log('saved', OUT, JSON.stringify({ cx: Math.round(cx), cy: Math.round(cy), cw: Math.round(cw), ch: Math.round(ch) }));
  // 清理：还原 invoke，清冻结 interval，恢复 autohide/occludeAway 与真实 bar rect
  await send('Runtime.evaluate', { expression: `clearInterval(window.__shotFreeze); window.__shotFreeze = null;
    if (window.__origInvoke) { window.dock.invoke = window.__origInvoke; window.__origInvoke = null; }
    window.dock.invoke('set-setting', { key: 'autohide', value: true });
    window.dock.invoke('set-setting', { key: 'occludeAway', value: true });
    const b = document.getElementById('dock-bar').getBoundingClientRect();
    window.dock.invoke('set-bar-rect', { x: b.x, y: b.y, w: b.width, h: b.height }); 'ok'`, returnByValue: true });
  ws.close(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
