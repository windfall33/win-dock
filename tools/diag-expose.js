'use strict';
// node diag-expose.js — 合成中键点击第一个有窗口的应用图标，验证 Exposé 打开/关闭
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
  const dock = targets.find((p) => p.url.includes('index.html'));
  const ws = new WebSocket(dock.webSocketDebuggerUrl);
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 找第一个有窗口的应用 slot，hook expose-open 记录调用，并真实触发
  const r = await send('Runtime.evaluate', { expression: `(() => {
    const result = { found: null };
    for (const [, s] of slotMap) {
      const e = s.entry;
      if (e && e.kind === 'app' && (e.windows || []).length > 0) {
        result.found = { id: e.id, name: e.name, wins: e.windows.length };
        result.rect = s.el.getBoundingClientRect().toJSON();
        break;
      }
    }
    if (result.found) {
      window.__exposeCalls = [];
      if (!window.__origInvoke2) {
        window.__origInvoke2 = window.dock.invoke.bind(window.dock);
        window.dock.invoke = function(cmd, args) {
          if (cmd === 'expose-open') window.__exposeCalls.push(args);
          if (cmd === 'request-hide') return Promise.resolve({ ok: true });
          return window.__origInvoke2(cmd, args);
        };
      }
      const el = itemsEl.querySelector('.slot[data-id="' + result.found.id + '"]');
      if (el) {
        const rc = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, button: 1,
          clientX: rc.x + rc.width / 2, clientY: rc.y + rc.height / 2,
        }));
      }
    }
    return JSON.stringify(result);
  })()`, returnByValue: true });
  console.log('target:', r.result.value);
  await sleep(1500);

  // 查 expose 窗口是否出现（主进程会开新 CDP target）
  const after = await getJSON('/json');
  const exposePage = after.find((p) => p.url.includes('expose.html'));
  console.log('expose window:', exposePage ? 'OPEN ✓' : 'NOT FOUND ✗',
    '| invoke calls:', r.result.value !== '{"found":null}' ? 'see-below' : 'none');

  if (exposePage) {
    // 连到 expose 页面确认缩略图加载
    const ws2 = new WebSocket(exposePage.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
    let id2 = 0; const p2 = new Map();
    ws2.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && p2.has(m.id)) { const q = p2.get(m.id); p2.delete(m.id); q.res(m.result); }
    };
    const send2 = (method, params) => new Promise((res) => {
      const myId = ++id2; p2.set(myId, { res });
      ws2.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
    const st = await send2('Runtime.evaluate', { expression: `(() => {
      const cards = document.querySelectorAll('.ex-card').length;
      const name = document.getElementById('ex-name').textContent;
      const imgsOk = [...document.querySelectorAll('.ex-thumb img')].filter(i => i.naturalWidth > 0).length;
      return JSON.stringify({ cards, name, imgsOk });
    })()`, returnByValue: true });
    console.log('expose state:', st.result.value);
    // Esc 关闭验证
    await send2('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc-sent'`, returnByValue: true });
    ws2.close();
    await sleep(800);
    const final = await getJSON('/json');
    console.log('after Esc:', final.find((p) => p.url.includes('expose.html')) ? 'STILL OPEN ✗' : 'CLOSED ✓');
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
