'use strict';
// node diag-plates.js — 导出每个 Dock 图标槽的底板判定状态，排障用。
// 用途：白板「时隐时现 / 有的图标没有」时跑一下，直接看哪个槽缺板、
// 图标是真 PNG 还是 letterTile 兜底、加载是否成功。
// 前提：DOCK_DEBUG=1 启动 Dock（CDP 9223）。
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
  const expr = `JSON.stringify([...document.querySelectorAll('#dock-items .slot')].map(s => {
    const img = s.querySelector('img.app-icon');
    const src = img ? (img.getAttribute('src') || '') : '';
    const type = src.startsWith('data:image/png') ? 'png'
      : src.startsWith('data:image/svg') ? 'svg-letter'
      : src.startsWith('data:') ? src.slice(5, 20) : src.slice(0, 24);
    return {
      kind: s.dataset.kind,
      name: s.dataset.name || s.dataset.title || '',
      plate: img ? img.classList.contains('plate-on') : null,
      icon: type,
      ok: img ? img.naturalWidth > 0 : null,
      tail: src.slice(-16),
    };
  }))`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const rows = JSON.parse(r.result.value);
  const noPlate = rows.filter((x) => x.kind === 'app' && x.icon === 'png' && !x.plate);
  const broken = rows.filter((x) => x.ok === false);
  console.log(`slots=${rows.length}  png-no-plate=${noPlate.length}  broken-img=${broken.length}`);
  for (const x of rows) {
    console.log(
      `${x.plate ? '[plate]' : '[     ]'} ${String(x.kind).padEnd(7)} icon=${String(x.icon).padEnd(10)} ` +
      `ok=${x.ok === null ? '-' : (x.ok ? 'y' : 'N')} ${x.name || '(unnamed)'} #${x.tail}`
    );
  }
  ws.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
