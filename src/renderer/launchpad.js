'use strict';

const gridEl = document.getElementById('lp-grid');
const searchEl = document.getElementById('lp-search');
const emptyEl = document.getElementById('lp-empty');

let APPS = [];
let query = '';
let page = 0;
const PER_PAGE = 60;

function letterTile(name) {
  const letter = encodeURIComponent((name || '?').trim().charAt(0).toUpperCase() || '?');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#6f9ef2"/><stop offset="1" stop-color="#3f66d4"/>
      </linearGradient></defs>
      <rect width="128" height="128" rx="28" fill="url(#g)"/>
      <text x="64" y="88" font-size="70" font-family="Segoe UI,sans-serif"
        fill="#fff" text-anchor="middle">${letter}</text>
    </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function appendCell(a) {
  const cell = document.createElement('div');
  cell.className = 'lp-cell';
  cell.title = a.name;
  // 打开动画的 stagger 延迟序号（封顶 24，避免大页尾部长时间等待）
  cell.style.setProperty('--i', String(Math.min(gridEl.children.length, 24)));
  const img = document.createElement('img');
  img.src = a.icon || letterTile(a.name);
  img.draggable = false;
  const name = document.createElement('div');
  name.className = 'lp-name';
  name.textContent = a.name;
  cell.appendChild(img);
  cell.appendChild(name);
  cell.addEventListener('click', () => {
    requestClose(); // 先播关闭淡出，启动不受影响
    window.dock.invoke('launchpad-launch', { target: a.target, args: a.args || '' });
  });
  gridEl.appendChild(cell);
}

function navBtn(txt) {
  const s = document.createElement('span');
  s.textContent = txt;
  return s;
}

function renderPages(total) {
  const pagesEl = document.getElementById('lp-pages');
  const show = total > 1;
  pagesEl.classList.toggle('hidden', !show);
  if (!show) return;
  pagesEl.innerHTML = '';
  const prev = navBtn('‹');
  prev.addEventListener('click', () => { page = Math.max(0, page - 1); render(); });
  const next = navBtn('›');
  next.addEventListener('click', () => { page = Math.min(total - 1, page + 1); render(); });
  const label = navBtn((page + 1) + ' / ' + total);
  label.className = 'lp-pages-label';
  pagesEl.appendChild(prev);
  pagesEl.appendChild(label);
  pagesEl.appendChild(next);
}

function render() {
  const q = query.trim().toLowerCase();
  const list = APPS.filter((a) => !q || a.name.toLowerCase().includes(q));
  gridEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', list.length > 0);
  if (q) {
    for (const a of list) appendCell(a);
    renderPages(1);
    return;
  }
  const total = Math.max(1, Math.ceil(list.length / PER_PAGE));
  if (page >= total) page = total - 1;
  for (const a of list.slice(page * PER_PAGE, (page + 1) * PER_PAGE)) appendCell(a);
  renderPages(total);
}

window.dock.onLaunchpadIcons((updates) => {
  const byId = new Map(updates.map((u) => [u.id, u.icon]));
  for (const a of APPS) {
    if (byId.has(a.id)) a.icon = byId.get(a.id);
  }
  render();
});

window.dock.invoke('launchpad-data').then((res) => {
  if (res && res.ok && Array.isArray(res.apps)) APPS = res.apps;
  render();
  searchEl.focus();
}).catch(() => render());

searchEl.addEventListener('input', () => {
  query = searchEl.value;
  render();
});
// 关闭统一入口：先播 ~170ms 关闭淡出（body.lp-closing），再交给主进程销毁。
// 窗口失焦（blur）与主进程的 blur 关闭共用同一段动画，无需新增 IPC 通道。
function requestClose() {
  if (document.body.classList.contains('lp-closing')) return;
  document.body.classList.add('lp-closing');
  setTimeout(() => { window.dock.invoke('launchpad-close').catch(() => {}); }, 170);
}

searchEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    const q = query.trim().toLowerCase();
    const first = APPS.find((a) => !q || a.name.toLowerCase().includes(q));
    if (first) {
      requestClose();
      window.dock.invoke('launchpad-launch', { target: first.target, args: first.args || '' });
    }
  }
  if (ev.key === 'Escape') requestClose();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') requestClose();
});
document.getElementById('lp-backdrop').addEventListener('mousedown', requestClose);

// 失焦即关闭（与主进程 blur 判定同参数 600ms 防抖）：渲染层同步播关闭淡出
const lpOpenedAt = Date.now();
window.addEventListener('blur', () => {
  if (Date.now() - lpOpenedAt > 600) requestClose();
});

// 深浅色跟随系统
function syncTheme() {
  document.documentElement.classList.toggle('light',
    !window.matchMedia('(prefers-color-scheme: dark)').matches);
}
syncTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
