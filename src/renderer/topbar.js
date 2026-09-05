'use strict';

const appEl = document.getElementById('tb-app');
const clockEl = document.getElementById('tb-clock');

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function tick() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  clockEl.textContent =
    d.getMonth() + 1 + '月' + d.getDate() + '日 周' + WEEK[d.getDay()] +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
tick();
setInterval(tick, 15 * 1000);

window.dock.onTopbarApp((name) => {
  appEl.textContent = String(name || '');
  appEl.style.display = name ? '' : 'none';
});
