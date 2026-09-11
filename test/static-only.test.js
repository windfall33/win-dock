'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotBuilder } = require('../src/core/snapshot.js');

function makeBuilder(over = {}) {
  const s = Object.assign({
    pins: [
      { id: 'p1', kind: 'app', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe' },
      { id: 'p2', kind: 'app', name: 'Chrome', exe: 'C:\\chrome.exe' },
    ],
    recentApps: [],
    iconSize: 52,
    staticOnly: false,
  }, over.settings || {});
  return createSnapshotBuilder({
    getSettingsAll: () => s,
    getSetting: (k) => s[k],
    iconsGetSync: (p) => (p ? 'icon:' + p : null),
    runningProc: over.runningProc || new Set(),
    getEnv: () => ({ position: 'bottom' }),
    getTrashCount: () => 0,
  });
}

const win = (h, t, e) => ({ h, t, e, m: false, f: false });

test('staticOnly=false keeps non-running pinned apps', () => {
  const snap = makeBuilder().build([win('1', 'a', 'C:\\Windows\\notepad.exe')], false);
  assert.equal(snap.entries.length, 2);
});

test('staticOnly=true hides non-running pinned apps and folders', () => {
  const snap = makeBuilder({
    settings: {
      staticOnly: true,
      pins: [
        { id: 'p1', kind: 'app', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe' },
        { id: 'p2', kind: 'app', name: 'Chrome', exe: 'C:\\chrome.exe' },
        { id: 'f1', kind: 'folder', name: 'DL', exe: 'C:\\Downloads' },
      ],
    },
  }).build([win('1', 'a', 'C:\\Windows\\notepad.exe')], false);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].id, 'p1');
  assert.equal(snap.settings.staticOnly, true);
});
