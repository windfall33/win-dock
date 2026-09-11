'use strict';
const { spawn } = require('child_process');
const path = require('path');
const br = path.join(__dirname, '..', 'src', 'native', 'bridge.ps1');
const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', br], {
  windowsHide: true,
  env: { ...process.env, DOCK_PARENT_PID: String(process.pid) },
});
let buf = '';
p.stdout.on('data', (d) => { buf += d; process.stdout.write('[out] ' + d); });
p.stderr.on('data', (d) => process.stdout.write('[err] ' + d));
p.on('exit', (c) => { console.log('exit', c); process.exit(0); });
setTimeout(() => {
  console.log('sending ping');
  p.stdin.write(JSON.stringify({ id: '1', cmd: 'ping', args: {} }) + '\n');
}, 2500);
setTimeout(() => {
  console.log('timeout, killing. buf=', JSON.stringify(buf.slice(0, 500)));
  p.kill();
  process.exit(1);
}, 8000);
