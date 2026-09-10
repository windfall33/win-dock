'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractProgress } = require('../src/core/progress.js');

test('extractProgress: 下载 45% → 0.45', () => {
  assert.equal(extractProgress(['下载 45%']), 0.45);
});

test('extractProgress: 多窗口取最大可见进度', () => {
  assert.equal(extractProgress(['a 10%', 'b 80%']), 0.8);
});

test('extractProgress: 100% 视为完成不显示', () => {
  assert.equal(extractProgress(['done 100%']), null);
});

test('extractProgress: 无百分比返回 null', () => {
  assert.equal(extractProgress(['普通窗口标题']), null);
  assert.equal(extractProgress([]), null);
  assert.equal(extractProgress(null), null);
});

test('extractProgress: 非法百分比忽略', () => {
  assert.equal(extractProgress(['x 150%']), null);
  assert.equal(extractProgress(['x abc%']), null);
});
