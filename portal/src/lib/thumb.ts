import type { Attachment } from 'svelte/attachments';

/*
 * 分段切换的滑块（2026-10-31 统一交互：与顶栏导航那道会滑的细线同一种手感）。
 * 挂在 .seg-t / .tabs-pill / .seg 容器上：量出当前项（aria-pressed / aria-selected 为 true 的按钮）的位置与宽度，
 * 写进 --thumb-x / -y / -w / -h，容器的 ::before 画实底并滑过去（app.css「分段切换」）；当前项本身不再铺底，只换字色。
 * 第一次量到之前不画、量到后的第一帧才加过渡（刷新时不从最左边滑进来）；减少动效时直接跳。
 * 尺寸变化（换语言、窗口变宽）与当前项变化（属性变化）都会重量。
 */
const ACTIVE = '[aria-pressed="true"], [aria-selected="true"]';

export const thumb: Attachment<HTMLElement> = (el) => {
  let raf = 0;
  const measure = () => {
    const a = el.querySelector<HTMLElement>(ACTIVE);
    if (!a || !a.offsetWidth) {
      el.removeAttribute('data-thumb');
      return;
    }
    el.style.setProperty('--thumb-x', `${a.offsetLeft}px`);
    el.style.setProperty('--thumb-y', `${a.offsetTop}px`);
    el.style.setProperty('--thumb-w', `${a.offsetWidth}px`);
    el.style.setProperty('--thumb-h', `${a.offsetHeight}px`);
    if (!el.hasAttribute('data-thumb')) {
      el.setAttribute('data-thumb', '');
      raf = requestAnimationFrame(() => el.setAttribute('data-thumb', 'ready'));
    }
  };
  const ro = new ResizeObserver(measure);
  ro.observe(el);
  const mo = new MutationObserver(measure);
  mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected'] });
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    mo.disconnect();
  };
};
