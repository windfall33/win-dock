'use strict';

const img = document.querySelector('#genie-img');
let curAnim = null;

// genie 吸入：侧向弧线 + 底缘原点收缩（genie.html 里 transform-origin: 50% 100%），
// 比直线缩放更贴近 macOS 的「吸进 Dock」观感
window.dock.onGenie((g) => {
  if (curAnim) curAnim.cancel();
  img.src = g.img;
  img.style.left = g.sx + 'px';
  img.style.top = g.sy + 'px';
  img.style.width = g.sw + 'px';
  img.style.height = g.sh + 'px';
  img.style.transform = 'none';
  img.style.opacity = '1';

  const dx = g.tx - g.sx;
  const dy = g.ty - g.sy;
  const ex = g.tw / g.sw;
  const ey = g.th / g.sh;
  const dir = dx === 0 ? 1 : Math.sign(dx);
  const bow = Math.min(70, Math.abs(dx) * 0.12 + 24);

  const keys = g.mode === 'scale'
    ? [
      { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1, offset: 0 },
      { transform: `translate(${dx}px, ${dy}px) scale(${ex}, ${ey})`, opacity: 0.82, offset: 1 },
    ]
    : [
      { transform: 'translate(0px, 0px) scale(1, 1) rotate(0deg)', opacity: 1, offset: 0 },
      {
        transform: `translate(${dx * 0.38}px, ${dy * 0.30 - bow * 0.35}px) ` +
          `scale(${0.62 + ex * 0.38}, ${0.55 + ey * 0.45}) rotate(${dir * 2.5}deg)`,
        opacity: 0.98, offset: 0.4,
      },
      {
        transform: `translate(${dx * 0.74}px, ${dy * 0.70 - bow * 0.1}px) ` +
          `scale(${0.24 + ex * 0.76}, ${0.18 + ey * 0.82}) rotate(${dir * 4}deg)`,
        opacity: 0.96, offset: 0.74,
      },
      {
        transform: `translate(${dx}px, ${dy}px) scale(${ex}, ${ey}) rotate(0deg)`,
        opacity: 0.92, offset: 1,
      },
    ];
  curAnim = img.animate(keys, {
    duration: g.mode === 'scale' ? 380 : 560,
    easing: 'cubic-bezier(.32,.72,.35,1)',
    fill: 'forwards',
  });
  curAnim.onfinish = () => { img.style.opacity = '0'; };
});
