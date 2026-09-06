'use strict';
// 端到端验证桥接 open 通道真的能拉起应用（绕开 shell 转义地狱）
const { spawn } = require('child_process');
const path = require('path');
const BRIDGE = path.join(__dirname, '..', 'src', 'native', 'bridge.ps1');
const proc = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE,
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DOCK_PARENT_PID: '' } });
let buf = '';
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (l) { console.log('RESP:', l.slice(0, 160)); proc.kill(); process.exit(0); }
  }
});
proc.stderr.on('data', (d) => console.error('[ps]', String(d).trim().slice(0, 200)));
proc.stdin.write(JSON.stringify({
  id: 'o1', cmd: 'open', args: { target: 'C:\\Windows\\System32\\notepad.exe' },
}) + '\n');
setTimeout(() => proc.stdin.write(JSON.stringify({
  id: 'o2', cmd: 'open', args: { target: 'C:\\Windows\\System32\\notepad.exe', args: [] },
}) + '\n'), 2500);
setTimeout(() => { console.log('TIMEOUT no response'); proc.kill(); process.exit(1); }, 20000);
