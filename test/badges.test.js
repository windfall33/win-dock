'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractBadgeCount, badgeLabel } = require('../src/core/badges.js');

test('extractBadgeCount: 微信风格尾括号计数', () => {
  assert.strictEqual(extractBadgeCount(['微信 (3)']), 3);
  assert.strictEqual(extractBadgeCount(['微信（12）']), 12);
});

test('extractBadgeCount: 方括号/书名号括号', () => {
  assert.strictEqual(extractBadgeCount(['[7] Slack - general']), 7);
  assert.strictEqual(extractBadgeCount(['【9】钉钉']), 9);
});

test('extractBadgeCount: 多窗口取最大值', () => {
  assert.strictEqual(extractBadgeCount(['微信 (2)', '微信 (9)', '微信']), 9);
});

test('extractBadgeCount: 无计数返回 0', () => {
  assert.strictEqual(extractBadgeCount(['Visual Studio Code', '']), 0);
  assert.strictEqual(extractBadgeCount([]), 0);
  assert.strictEqual(extractBadgeCount(null), 0);
});

test('extractBadgeCount: 四位及以上数字视为年份等忽略', () => {
  assert.strictEqual(extractBadgeCount(['报告 (2026)']), 0);
  assert.strictEqual(extractBadgeCount(['相册 [2025]']), 0);
});

test('extractBadgeCount: 带加号与空白', () => {
  assert.strictEqual(extractBadgeCount(['(99+) 消息']), 99);
  assert.strictEqual(extractBadgeCount(['( 5 )']), 5);
});

test('badgeLabel: 超 99 显示 99+', () => {
  assert.strictEqual(badgeLabel(3), '3');
  assert.strictEqual(badgeLabel(99), '99');
  assert.strictEqual(badgeLabel(100), '99+');
  assert.strictEqual(badgeLabel(0), '');
});
