'use strict';
// 轻量 Exposé：展示某个应用的全部窗口缩略图，点击聚焦。
// 数据由主进程 expose-open 时推送（expose-data）；截图复用 window-thumb 桥接命令。

const gridEl = document.getElementById('ex-grid');
const emptyEl = document.getElementById('ex-empty');
const nameEl = document.getElementById('ex-name');
const iconEl = document.getElementById('ex-icon');
const hintEl = document.getElementById('ex-hint');

let closed = false;

function close() {
  if (closed) return;
  closed = true;
  window.dock.invoke('expose-close').catch(() => {});
}

async function captureThumb(h, img) {
  try {
    const res = await window.dock.invoke('window-thumb', { h });
    if (res && res.png) { img.src = 'data:image/png;base64,' + res.png; return true; }
  } catch {}
  return false;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function build(data) {
  const wins = (data.windows || []).filter((w) => w && w.h);
  nameEl.textContent = data.appName || '应用窗口';
  if (data.appIcon) iconEl.src = data.appIcon; else iconEl.style.visibility = 'hidden';
  hintEl.textContent = wins.length > 1 ? wins.length + ' 个窗口 · Esc 关闭' : 'Esc 关闭';

  if (!wins.length) {
    emptyEl.classList.remove('hidden');
    return;
  }

  // 缩略图逐窗加载（window-thumb 一窗一截，串行限速防桥接过载）
  (async () => {
    for (const w of wins) {
      if (closed) return;
      const card = document.createElement('div');
      card.className = 'ex-card';
      card.tabIndex = 0;

      const thumb = document.createElement('div');
      thumb.className = 'ex-thumb';
      const img = document.createElement('img');
      img.draggable = false;
      const fb = document.createElement('span');
      fb.className = 'ex-fallback';
      fb.textContent = '正在截取…';
      thumb.appendChild(fb);
      thumb.appendChild(img);
      card.appendChild(thumb);

      const title = document.createElement('div');
      title.className = 'ex-title';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = truncate(w.t || data.appName || '窗口', 42);
      title.appendChild(t);
      if (w.m) {
        const tag = document.createElement('span');
        tag.className = 'min-tag';
        tag.textContent = '已最小化';
        title.appendChild(tag);
      }
      card.appendChild(title);

      card.addEventListener('click', () => {
        close();
        window.dock.invoke('focus-window', { h: w.h }).catch(() => {});
      });
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          close();
          window.dock.invoke('focus-window', { h: w.h }).catch(() => {});
        }
      });
      gridEl.appendChild(card);

      const ok = await captureThumb(w.h, img);
      if (ok) fb.remove();
      else { fb.textContent = '无法截取'; img.remove(); }
    }
    // 首张卡片获得焦点，支持 Esc/Enter 键盘操作
    const first = gridEl.firstElementChild;
    if (first) first.focus();
  })();
}

window.dock.onExposeData((data) => build(data || {}));

document.getElementById('ex-backdrop').addEventListener('mousedown', close);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { ev.preventDefault(); close(); }
});
// 焦点在网格内循环：Tab 到底回第一张
gridEl.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Tab') return;
  const cards = [...gridEl.querySelectorAll('.ex-card')];
  if (!cards.length) return;
  ev.preventDefault();
  const i = cards.indexOf(document.activeElement);
  const next = ev.shiftKey
    ? (i <= 0 ? cards.length - 1 : i - 1)
    : (i === cards.length - 1 ? 0 : i + 1);
  cards[next].focus();
});
