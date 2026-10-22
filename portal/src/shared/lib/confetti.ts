/**
 * 付款成功的一次性撒花（按需加载：components/shop/PayResult.svelte 在成功时才 import 它）。
 *
 * 不用库：几十片小色块，每片一段 Web Animations（只动 transform 与 opacity，合成器上跑，不占主线程、不触发布局），
 * 从 origin 的中心向上小幅散开、落下并淡出，DUR.celebrate（0.8 秒）左右播完，容器随即移除。片数少、飞得近（2026-10-13：短而小）。
 * 色块是 fixed 定位、pointer-events: none 的 span，盖在弹窗之上但不挡任何点击；样式全是行内 style（CSP 允许）。
 * 颜色只用品牌色令牌（src/styles/tokens.css 的 --brand、--brand-2）。调用方负责：系统要求减少动效时不调用。
 */
const PIECES = 18;

export default function confetti(origin: Element, duration = 800) {
  const r = origin.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const css = getComputedStyle(document.documentElement);
  const colors = ['--brand', '--brand-2']
    .map((v) => css.getPropertyValue(v).trim())
    .filter(Boolean);

  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '60', pointerEvents: 'none', overflow: 'hidden' });

  for (let i = 0; i < PIECES; i++) {
    const p = document.createElement('span');
    const w = 4 + Math.random() * 3;
    Object.assign(p.style, {
      position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${w * (1.3 + Math.random())}px`,
      marginLeft: `${-w / 2}px`, borderRadius: Math.random() < 0.3 ? '9999px' : '1.5px',
      background: colors[i % colors.length] || 'currentColor', willChange: 'transform, opacity',
    });
    layer.appendChild(p);
    /* 向上为主的扇形，左右各 70°；速度不一，远的飞得高 */
    const a = (-90 + (Math.random() * 140 - 70)) * (Math.PI / 180);
    const v = 60 + Math.random() * 90;
    const dx = Math.cos(a) * v;
    const dy = Math.sin(a) * v;
    const spin = (Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 480);
    const t = duration * (0.75 + Math.random() * 0.25);
    p.animate([
      { transform: 'translate(0, 0) rotate(0deg) scale(.6)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${spin * 0.5}deg) scale(1)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx * 1.2}px, ${dy + 80}px) rotate(${spin}deg) scale(.9)`, opacity: 0 },
    ], { duration: t, easing: 'cubic-bezier(.2, .7, .35, 1)', fill: 'forwards' });
  }

  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), duration + 100);
}
