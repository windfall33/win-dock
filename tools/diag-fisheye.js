'use strict';
// 诊断：合成 mousemove 后 slot 宽度是否变化（鱼眼是否真的在跑）
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
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await send('Runtime.evaluate', { expression: `window.dock.invoke('set-setting', { key: 'autohide', value: false }); window.dock.invoke('request-show'); 'ok'`, returnByValue: true });
  await sleep(900);

  const probe = async () => {
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const bar = document.getElementById('dock-bar');
      const rect = bar.getBoundingClientRect();
      const slots = [...document.querySelectorAll('.slot')].slice(0, 12).map(s => {
        const q = s.getBoundingClientRect();
        return Math.round(q.width);
      });
      return JSON.stringify({ bar: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }, slots });
    })()`, returnByValue: true });
    return JSON.parse(r.result.value);
  };

  const before = await probe();
  const bar = before.bar;
  const hx = Math.round(bar.x + bar.w / 2), hy = Math.round(bar.y + bar.h / 2);
  for (let i = 0; i < 10; i++) {
    await send('Runtime.evaluate', { expression: `document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${hx}, clientY: ${hy}, bubbles: true })); 'ok'`, returnByValue: true });
    await sleep(60);
  }
  await sleep(600);
  const after = await probe();
  console.log(JSON.stringify({ hover: { hx, hy }, before: before.slots, after: after.slots, barBefore: before.bar, barAfter: after.bar }, null, 1));
  await send('Runtime.evaluate', { expression: `window.dock.invoke('set-setting', { key: 'autohide', value: true }); 'ok'`, returnByValue: true });
  ws.close(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
