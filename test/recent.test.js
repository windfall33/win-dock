'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { updateRecent, visibleRecent } = require('../src/core/recent.js');

test('updateRecent dedupes by exe and moves to front', () => {
  const a = { id: 'r:a', name: 'A', exe: 'C:\\A.exe' };
  const b = { id: 'r:b', name: 'B', exe: 'C:\\B.exe' };
  let { list } = updateRecent([], a);
  ({ list } = updateRecent(list, b));
  ({ list } = updateRecent(list, a));
  assert.equal(list.length, 2);
  assert.equal(list[0].exe, 'C:\\A.exe');
  assert.equal(list[1].exe, 'C:\\B.exe');
});

test('updateRecent ignores empty exe', () => {
  const { list, changed } = updateRecent([], { exe: '' });
  assert.equal(list.length, 0);
  assert.equal(changed, false);
});

test('visibleRecent returns top 3 with running flags', () => {
  const list = [
    { id: 'r:1', name: 'One', exe: 'C:\\1.exe' },
    { id: 'r:2', name: 'Two', exe: 'C:\\2.exe' },
    { id: 'r:3', name: 'Three', exe: 'C:\\3.exe' },
    { id: 'r:4', name: 'Four', exe: 'C:\\4.exe' },
  ];
  const out = visibleRecent(list, ['C:\\2.exe']);
  assert.equal(out.length, 3);
  assert.equal(out[0].exe, 'C:\\1.exe');
  assert.equal(out[1].running, true);
  assert.equal(out[0].running, false);
  for (const e of out) {
    assert.equal(e.kind, 'recent');
    assert.equal(e.icon, null);
  }
});

test('visibleRecent returns empty for empty list', () => {
  assert.deepEqual(visibleRecent([], []), []);
});
