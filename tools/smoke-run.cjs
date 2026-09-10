'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const userData = path.join(root, '.smoke-userdata');
try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
fs.mkdirSync(userData, { recursive: true });

const logFile = path.join(root, 'smoke-run.log');
fs.writeFileSync(logFile, `start ${new Date().toISOString()}\n`);

const child = spawn(electron, ['.', '--dev'], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    DOCK_USER_DATA: userData,
    DOCK_DEBUG: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (d) => fs.appendFileSync(logFile, '[out] ' + d));
child.stderr.on('data', (d) => fs.appendFileSync(logFile, '[err] ' + d));
child.on('exit', (code, sig) => {
  fs.appendFileSync(logFile, `exit code=${code} sig=${sig}\n`);
});

setTimeout(() => {
  const alive = !child.killed;
  let mainLog = '';
  try {
    mainLog = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  } catch {}
  try { child.kill(); } catch {}
  fs.appendFileSync(logFile, `killed aliveBefore=${alive}\n`);
  console.log(logFile);
  console.log('--- smoke-run.log ---');
  console.log(fs.readFileSync(logFile, 'utf8').slice(-3000));
  console.log('--- main.log ---');
  console.log(mainLog.slice(-2500) || '(empty)');
  process.exit(0);
}, 8000);
