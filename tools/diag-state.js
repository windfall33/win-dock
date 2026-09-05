'use strict';
// node diag-state.js — 读取 Dock 渲染层当前状态（root class / bar rect / slot 数），排障用
const http = require('http');
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
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  const expr = `JSON.stringify({
    rootClass: document.getElementById('dock-root').className,
    barRect: (() => { const r = document.getElementById('dock-bar').getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    slots: document.querySelectorAll('#dock-items .slot').length,
    imgsLoaded: [...document.querySelectorAll('#dock-items img.app-icon')].filter(i => i.naturalWidth > 0).length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    innerW: window.innerWidth, innerH: window.innerHeight
  })`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result.value);
  ws.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
