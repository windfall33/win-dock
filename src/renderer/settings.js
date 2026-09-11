'use strict';

const $ = (s) => document.querySelector(s);
let applying = false;

function render(s) {
  applying = true;
  if (s.iconSize !== undefined) {
    $('#size').value = s.iconSize;
    $('#sizeVal').textContent = Math.round(s.iconSize) + '';
  }
  if (s.magnification !== undefined) {
    $('#mag').value = s.magnification;
    $('#magVal').textContent = Number(s.magnification).toFixed(2).replace(/\.?0+$/, '') + '×';
  }
  $('#autohide').classList.toggle('on', !!s.autohide);
  $('#keepVisible').classList.toggle('on', !!s.keepVisible);
  $('#dockPerDisplay').classList.toggle('on', !!s.dockPerDisplay);
  $('#showIndicators').classList.toggle('on', s.showIndicators !== false);
  $('#showRecents').classList.toggle('on', s.showRecents !== false);
  $('#staticOnly').classList.toggle('on', !!s.staticOnly);
  $('#scrollToOpen').classList.toggle('on', !!s.scrollToOpen);
  $('#springLoadApps').classList.toggle('on', !!s.springLoadApps);
  if (s.showDelayMs !== undefined) {
    $('#showDelay').value = s.showDelayMs;
    $('#showDelayVal').textContent = Math.round(s.showDelayMs) + 'ms';
  }
  if (s.hideDelayMs !== undefined) {
    $('#hideDelay').value = s.hideDelayMs;
    $('#hideDelayVal').textContent = Math.round(s.hideDelayMs) + 'ms';
  }
  $('#autologin').classList.toggle('on', !!s.launchAtLogin);
  $('#hideTaskbar').classList.toggle('on', !!s.hideTaskbar);
  $('#topbar').classList.toggle('on', s.showTopbar !== false);
  $('#multidisplay').classList.toggle('on', !!s.multidisplay);
  $('#occludeAway').classList.toggle('on', !!s.occludeAway);
  $('#workareaReserve').classList.toggle('on', !!s.workareaReserve);
  $('#minimizeIntoIcon').classList.toggle('on', !!s.minimizeIntoIcon);
  $('#appearance').value = s.appearance || 'system';
  $('#position').value = s.position || 'bottom';
  $('#minimizeEffect').value = s.minimizeEffect || 'genie';
  document.documentElement.classList.toggle('dark',
    (s.appearance === 'dark') ||
    ((s.appearance === undefined || s.appearance === 'system') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches));
  applying = false;
}

window.dock.onSettings(render);

window.dock.getSnapshot().then((snap) => {
  if (!snap || !snap.settings) return;
  render({
    ...snap.settings,
    launchAtLogin: (snap.extras && snap.extras.launchAtLogin) || false,
  });
}).catch(() => {});

$('#size').addEventListener('input', (e) => {
  if (applying) return;
  const v = parseInt(e.target.value, 10);
  $('#sizeVal').textContent = v + '';
  window.dock.invoke('set-setting', { key: 'iconSize', value: v });
});
$('#mag').addEventListener('input', (e) => {
  if (applying) return;
  const v = parseFloat(e.target.value);
  $('#magVal').textContent = v.toFixed(2).replace(/\.?0+$/, '') + '×';
  window.dock.invoke('set-setting', { key: 'magnification', value: v });
});
$('#autohide').addEventListener('click', () => {
  const next = !$('#autohide').classList.contains('on');
  $('#autohide').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'autohide', value: next });
});
$('#keepVisible').addEventListener('click', () => {
  const next = !$('#keepVisible').classList.contains('on');
  $('#keepVisible').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'keepVisible', value: next });
});
$('#dockPerDisplay').addEventListener('click', () => {
  const next = !$('#dockPerDisplay').classList.contains('on');
  $('#dockPerDisplay').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'dockPerDisplay', value: next });
});
$('#showIndicators').addEventListener('click', () => {
  const next = !$('#showIndicators').classList.contains('on');
  $('#showIndicators').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'showIndicators', value: next });
});
$('#showRecents').addEventListener('click', () => {
  const next = !$('#showRecents').classList.contains('on');
  $('#showRecents').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'showRecents', value: next });
});
$('#staticOnly').addEventListener('click', () => {
  const next = !$('#staticOnly').classList.contains('on');
  $('#staticOnly').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'staticOnly', value: next });
});
$('#scrollToOpen').addEventListener('click', () => {
  const next = !$('#scrollToOpen').classList.contains('on');
  $('#scrollToOpen').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'scrollToOpen', value: next });
});
$('#springLoadApps').addEventListener('click', () => {
  const next = !$('#springLoadApps').classList.contains('on');
  $('#springLoadApps').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'springLoadApps', value: next });
});
$('#showDelay').addEventListener('input', (e) => {
  if (applying) return;
  const v = parseInt(e.target.value, 10);
  $('#showDelayVal').textContent = v + 'ms';
  window.dock.invoke('set-setting', { key: 'showDelayMs', value: v });
});
$('#hideDelay').addEventListener('input', (e) => {
  if (applying) return;
  const v = parseInt(e.target.value, 10);
  $('#hideDelayVal').textContent = v + 'ms';
  window.dock.invoke('set-setting', { key: 'hideDelayMs', value: v });
});
$('#autologin').addEventListener('click', () => {
  const next = !$('#autologin').classList.contains('on');
  $('#autologin').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'launchAtLogin', value: next });
});
$('#topbar').addEventListener('click', () => {
  const next = !$('#topbar').classList.contains('on');
  $('#topbar').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'showTopbar', value: next });
});
$('#hideTaskbar').addEventListener('click', async () => {
  const next = !$('#hideTaskbar').classList.contains('on');
  const res = await window.dock.invoke('set-setting', { key: 'hideTaskbar', value: next });
  if (res && res.ok === false) {
    alert('隐藏任务栏设置失败：' + (res.err || '未知错误'));
    return;
  }
  $('#hideTaskbar').classList.toggle('on', next);
});
$('#multidisplay').addEventListener('click', () => {
  const next = !$('#multidisplay').classList.contains('on');
  $('#multidisplay').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'multidisplay', value: next });
});
$('#occludeAway').addEventListener('click', () => {
  const next = !$('#occludeAway').classList.contains('on');
  $('#occludeAway').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'occludeAway', value: next });
});
$('#workareaReserve').addEventListener('click', () => {
  const next = !$('#workareaReserve').classList.contains('on');
  $('#workareaReserve').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'workareaReserve', value: next });
});
$('#appearance').addEventListener('change', (e) => {
  window.dock.invoke('set-setting', { key: 'appearance', value: e.target.value });
});
$('#position').addEventListener('change', (e) => {
  window.dock.invoke('set-setting', { key: 'position', value: e.target.value });
});
$('#minimizeEffect').addEventListener('change', (e) => {
  window.dock.invoke('set-setting', { key: 'minimizeEffect', value: e.target.value });
});
$('#minimizeIntoIcon').addEventListener('click', () => {
  const next = !$('#minimizeIntoIcon').classList.contains('on');
  $('#minimizeIntoIcon').classList.toggle('on', next);
  window.dock.invoke('set-setting', { key: 'minimizeIntoIcon', value: next });
});
