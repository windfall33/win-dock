'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stateSignature } = require('../src/core/state-hash.js');

const snap = (over = {}) => ({
  entries: [{
    id: 'a', running: true, icon: 'data:x',
    windows: [{ h: '1', t: 'T1', m: false, f: true }],
  }],
  recent: [],
  minimized: [],
  trash: { count: 0 },
  settings: {},
  env: {},
  ...over,
});

test('identical snapshots yield the same signature', () => {
  assert.equal(stateSignature(snap()), stateSignature(snap()));
});

test('signature changes when a window is minimized', () => {
  const a = stateSignature(snap());
  const b = stateSignature(snap({
    entries: [{ id: 'a', running: true, icon: 'data:x', windows: [{ h: '1', t: 'T1', m: true, f: false }] }],
  }));
  assert.notEqual(a, b);
});

test('signature changes when the focused window changes', () => {
  const a = stateSignature(snap());
  const b = stateSignature(snap({
    entries: [{ id: 'a', running: true, icon: 'data:x', windows: [{ h: '1', t: 'T1', m: false, f: false }] }],
  }));
  assert.notEqual(a, b);
});

test('signature changes when a window title changes', () => {
  const a = stateSignature(snap());
  const b = stateSignature(snap({
    entries: [{ id: 'a', running: true, icon: 'data:x', windows: [{ h: '1', t: 'T2', m: false, f: true }] }],
  }));
  assert.notEqual(a, b);
});

test('signature changes when minimized tiles change', () => {
  const a = stateSignature(snap());
  const b = stateSignature(snap({
    minimized: [{ id: 'min:9', icon: null, title: 'X' }],
  }));
  assert.notEqual(a, b);
});

test('missing minimized key equals empty list', () => {
  const s = snap();
  delete s.minimized;
  assert.equal(stateSignature(s), stateSignature(snap({ minimized: [] })));
});

test('unrelated entry fields (exe) do not force a push', () => {
  const a = snap();
  const b = snap({ entries: [{ id: 'a', running: true, icon: 'data:x', exe: 'C:\\other.exe', windows: [{ h: '1', t: 'T1', m: false, f: true }] }] });
  assert.equal(stateSignature(a), stateSignature(b));
});
