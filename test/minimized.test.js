'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractMinimized } = require('../src/core/minimized.js');

const win = (h, opts = {}) => ({
  h, t: opts.t || 'Window ' + h, c: 'Class', p: '1',
  e: opts.e || 'C:\\Apps\\demo.exe', m: !!opts.m, f: false,
});

test('projects only minimized windows, order preserved', () => {
  const wins = [win('1', { m: true }), win('2'), win('3', { m: true })];
  const out = extractMinimized(wins, []);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'min:1');
  assert.equal(out[1].id, 'min:3');
  assert.equal(out[0].kind, 'min');
  assert.equal(out[0].h, '1');
});

test('carries title, exe and appName/icon from owning app entry', () => {
  const wins = [win('1', { m: true, t: 'Untitled - Notepad', e: 'C:\\Windows\\System32\\notepad.exe' })];
  const apps = [{ id: 'notepad', name: '记事本', icon: 'data:png', windows: [{ h: '1' }] }];
  const out = extractMinimized(wins, apps);
  assert.equal(out[0].title, 'Untitled - Notepad');
  assert.equal(out[0].appName, '记事本');
  assert.equal(out[0].icon, 'data:png');
  assert.equal(out[0].exe, 'C:\\Windows\\System32\\notepad.exe');
});

test('falls back to empty appName / null icon without an app entry', () => {
  const out = extractMinimized([win('1', { m: true })], []);
  assert.equal(out[0].appName, '');
  assert.equal(out[0].icon, null);
});

test('ignores null/undefined inputs', () => {
  assert.deepEqual(extractMinimized(null, null), []);
});
