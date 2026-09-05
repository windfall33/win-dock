'use strict';
const http = require('http');
const substr = process.argv[2], expr = process.argv[3];
http.get('http://127.0.0.1:9223/json', (res) => {
  let d = '';
  res.on('data', (c) => d += c);
  res.on('end', () => {
    const p = JSON.parse(d).find((p) => p.url.includes(substr));
    if (!p) { console.log('target not found:', substr); process.exit(1); }
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    let id = 0;
    ws.onopen = () => ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    let shot = null;
    if (process.argv[4]) shot = process.argv[4];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        console.log(m.result && m.result.result ? JSON.stringify(m.result.result.value ?? m.result.result.description) : JSON.stringify(m.result));
        if (!shot) { ws.close(); process.exit(0); }
        ws.send(JSON.stringify({ id: ++id, method: 'Page.captureScreenshot', params: { format: 'png' } }));
      }
      if (m.id === 2 && m.result) {
        require('fs').writeFileSync(shot, Buffer.from(m.result.data, 'base64'));
        console.log('saved', shot);
        ws.close(); process.exit(0);
      }
    };
    setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);
  });
});
