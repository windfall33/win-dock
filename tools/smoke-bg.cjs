'use strict';
// Keep dock running with CDP for visual capture.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const userData = process.env.DOCK_USER_DATA || path.join(root, '.smoke-userdata');

const child = spawn(electron, ['.', '--dev'], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    DOCK_USER_DATA: userData,
    DOCK_DEBUG: '1',
  },
});
child.unref();
fs.writeFileSync(path.join(root, '.smoke-pid'), String(child.pid));
console.log('started', child.pid, 'userData', userData);
