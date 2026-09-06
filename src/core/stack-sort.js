'use strict';
/* =====================================================================
   P1-F5 Stack 排序 — 纯函数
   sortStackItems(items, sortBy)：name（zh-Hans-CN collation）/ added（mtime）
   / created（ctime）升序；kind = 文件夹优先 → 扩展名字母序 → 同类内按名称。
   stackViewMode(count, configured)：显式 grid/fan/list 直接生效；
   'auto'（及缺省）按数量阈值 count ≤ 5 → fan，> 5 → grid。
   加载方式：CommonJS（node:test）+ 浏览器 <script> 全局 StackSort。
   ===================================================================== */

const collator = new Intl.Collator('zh-Hans-CN');

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

function sortStackItems(items, sortBy) {
  const arr = (Array.isArray(items) ? items : []).slice();
  if (sortBy === 'name') {
    arr.sort((a, b) => collator.compare(a.name, b.name));
  } else if (sortBy === 'added' || sortBy === 'modified') {
    // 'added' 为历史键名保留兼容：桥接只能廉价拿到 mtime（修改时间），
    // 无真正的「日期添加」shell 属性 —— UI 层展示为「修改日期」（macOS 项）
    arr.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
  } else if (sortBy === 'created') {
    arr.sort((a, b) => (a.ctime || 0) - (b.ctime || 0));
  } else if (sortBy === 'kind') {
    arr.sort((a, b) => {
      if (!!a.isFolder !== !!b.isFolder) return a.isFolder ? -1 : 1;
      const ea = extOf(a.name);
      const eb = extOf(b.name);
      if (ea !== eb) return ea < eb ? -1 : 1;
      return collator.compare(a.name, b.name);
    });
  }
  // 未知 sortBy：保持原顺序（items 浅拷贝返回，调用方可安全排序后复用）
  return arr;
}

function stackViewMode(count, configured) {
  if (configured === 'grid' || configured === 'fan' || configured === 'list') return configured;
  // 'auto' / 缺省 / 未知值：按数量阈值
  return (count | 0) <= 5 ? 'fan' : 'grid';
}

const stackSortApi = { sortStackItems, stackViewMode };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = stackSortApi;
} else {
  window.StackSort = stackSortApi;
}
