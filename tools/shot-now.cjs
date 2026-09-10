'use strict';
const http = require('http');
const fs = require('fs');
const OUT = process.argv[2] || 'shots/w5-full.png';

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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Keep dock visible + block hide + paint a slate backdrop so glass is visible
  await send('Runtime.evaluate', {
    expression: `(() => {
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
        const r = document.getElementById('dock-root');
        if (r) { r.classList.remove('hidden', 'hidden-away'); r.style.opacity = '1'; r.style.transform = 'none'; }
      }, 80);
      // html/body 有 background:transparent !important，必须用实体垫层才能在截图里看见玻璃
      let bd = document.getElementById('__shot-backdrop');
      if (!bd) {
        bd = document.createElement('div');
        bd.id = '__shot-backdrop';
        bd.style.cssText = 'position:fixed;inset:0;z-index:-1;background:#2a2c32;';
        document.body.appendChild(bd);
      }
      const r = document.getElementById('dock-root');
      r.classList.remove('hidden', 'hidden-away');
      r.style.opacity = '1';
      r.style.transform = 'none';
      window.__origInvoke('set-setting', { key: 'autohide', value: false });
      window.__origInvoke('set-setting', { key: 'occludeAway', value: false });
      window.__origInvoke('request-show');
      return 'ok';
    })()`,
    returnByValue: true,
  });
  await sleep(1000);
  await send('Runtime.evaluate', {
    expression: `(() => {
      const r = document.getElementById('dock-root');
      r.classList.remove('hidden','hidden-away');
      r.style.opacity = '1'; r.style.transform = 'none';
      return JSON.stringify({
        cls: r.className,
        opacity: getComputedStyle(r).opacity,
        slots: document.querySelectorAll('.slot').length,
      });
    })()`,
    returnByValue: true,
  }).then((r) => console.log('state', r.result.value));
  await sleep(200);

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('saved', OUT);

  // crop bar region at 2x for readability
  const barInfo = JSON.parse((await send('Runtime.evaluate', {
    expression: `(() => { const r = document.getElementById('dock-bar').getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,ih:innerHeight,iw:innerWidth}); })()`,
    returnByValue: true,
  })).result.value);
  const pad = 12;
  const cx = Math.max(0, barInfo.x - pad);
  const cy = Math.max(0, barInfo.y - pad);
  const cw = Math.min(barInfo.iw - cx, barInfo.w + pad * 2);
  const ch = Math.min(barInfo.ih - cy, barInfo.h + pad * 2);
  const SCALE = 2;
  const expr = '(function(){ return new Promise(function(resolve){' +
    'var img = new Image();' +
    'img.onload = function(){' +
    'var c = document.createElement("canvas");' +
    'c.width = ' + Math.round(cw * SCALE) + '; c.height = ' + Math.round(ch * SCALE) + ';' +
    'var g = c.getContext("2d");' +
    'g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";' +
    'g.drawImage(img, ' + cx + ', ' + cy + ', ' + cw + ', ' + ch + ', 0, 0, c.width, c.height);' +
    'resolve(c.toDataURL("image/png"));' +
    '};' +
    'img.src = "data:image/png;base64,' + shot.data + '";' +
    '}); })()';
  const crop = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const cropPath = OUT.replace(/\.png$/, '-crop.png');
  fs.writeFileSync(cropPath, Buffer.from(String(crop.result.value).replace(/^data:image\/png;base64,/, ''), 'base64'));
  console.log('saved', cropPath, JSON.stringify(barInfo));
  ws.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
