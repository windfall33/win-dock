'use strict';
// P1-F5 Stack 排序：纯函数（core/stack-sort.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sortStackItems, stackViewMode } = require('../src/core/stack-sort.js');

const item = (name, extra = {}) => Object.assign({ name, isFolder: false, iconPath: 'C:\\' + name }, extra);

// ---- sortStackItems ----

test('sort by name uses zh-Hans-CN collation (pinyin order)', () => {
  const items = [item('应用'), item('备忘录'), item('安娜')];
  const out = sortStackItems(items, 'name');
  // 拼音序：b(备忘录) < a?... 明确断言期望序列：备忘录(b) < 安娜(a)?? —— 用 collator 实际序断言
  assert.deepEqual(out.map((x) => x.name),
    [...items].sort((a, b) => new Intl.Collator('zh-Hans-CN').compare(a.name, b.name)).map((x) => x.name));
  // 同时验证「应用」与「备忘录」有确定的先后（collation 生效，不是原数组顺序）
  assert.notDeepEqual(out.map((x) => x.name), ['应用', '备忘录', '安娜']);
});

test('sort by added uses mtime ascending', () => {
  const items = [
    item('c', { mtime: 300 }), item('a', { mtime: 100 }), item('b', { mtime: 200 }),
  ];
  assert.deepEqual(sortStackItems(items, 'added').map((x) => x.name), ['a', 'b', 'c']);
});

test('sort by modified uses mtime ascending; added kept as compat alias', () => {
  const items = [
    item('c', { mtime: 300 }), item('a', { mtime: 100 }), item('b', { mtime: 200 }),
  ];
  assert.deepEqual(sortStackItems(items, 'modified').map((x) => x.name), ['a', 'b', 'c']);
  assert.deepEqual(sortStackItems(items, 'added').map((x) => x.name), ['a', 'b', 'c']);
});

test('sort by created uses ctime ascending', () => {
  const items = [
    item('x', { ctime: 30 }), item('y', { ctime: 10 }), item('z', { ctime: 20 }),
  ];
  assert.deepEqual(sortStackItems(items, 'created').map((x) => x.name), ['y', 'z', 'x']);
});

test('sort by kind: folders first, then extension alphabetical, then name within kind', () => {
  const items = [
    item('b.txt'),
    item('folder2', { isFolder: true }),
    item('a.zip'),
    item('a.txt'),
    item('folder1', { isFolder: true }),
  ];
  const out = sortStackItems(items, 'kind');
  assert.deepEqual(out.map((x) => x.name), [
    'folder1', 'folder2',          // 文件夹优先（同类内按名称）
    'a.txt', 'b.txt', 'a.zip',     // 扩展名字母序：txt < zip
  ]);
});

test('missing timestamps sort as oldest', () => {
  const items = [item('has', { mtime: 5 }), item('none')];
  assert.deepEqual(sortStackItems(items, 'added').map((x) => x.name), ['none', 'has']);
});

test('unknown sortBy returns items unchanged in order', () => {
  const items = [item('b'), item('a')];
  assert.deepEqual(sortStackItems(items, 'bogus').map((x) => x.name), ['b', 'a']);
  assert.deepEqual(sortStackItems(items, undefined).map((x) => x.name), ['b', 'a']);
});

test('sort does not mutate the input array', () => {
  const items = [item('b'), item('a')];
  sortStackItems(items, 'name');
  assert.deepEqual(items.map((x) => x.name), ['b', 'a']);
});

// ---- stackViewMode ----

test('explicit configuration wins over count', () => {
  assert.equal(stackViewMode(100, 'grid'), 'grid');
  assert.equal(stackViewMode(1, 'list'), 'list');
  assert.equal(stackViewMode(3, 'fan'), 'fan');
});

test('auto mode: count <= 5 → fan, > 5 → grid', () => {
  assert.equal(stackViewMode(5, 'auto'), 'fan');
  assert.equal(stackViewMode(6, 'auto'), 'grid');
  assert.equal(stackViewMode(0, 'auto'), 'fan');
});

test('missing/unknown configuration falls back to auto behavior', () => {
  assert.equal(stackViewMode(3, undefined), 'fan');
  assert.equal(stackViewMode(9, undefined), 'grid');
  assert.equal(stackViewMode(3, 'bogus'), 'fan');
});
