/* ?url：Vite 处理这张样式表（字体切片加哈希、改写地址），给出它的地址；声明本身不进应用样式表 */
import FONT_CSS from '@/assets/fonts/akari.css?url';
import INTER_CSS from '@/assets/fonts/inter.css?url';
import { sourceOf } from './i18n.svelte';

/*
 * 正文字体（自托管子集，src/shared/assets/fonts/）：Noto Sans SC（akari.css，按 unicode-range 分片）
 * 与显示拉丁字母、数字的 Inter（inter.css）。单独的样式表、不挡首帧：应用挂载时插入，切片用到才下载。
 * 英文界面在空闲时预热「切到中文时这一页要用的字」，切过去不闪系统字体。
 */

const FAMILY = 'Noto Sans SC Variable';

let cssLoading: Promise<boolean> | null = null;

function ensureCss(): Promise<boolean> {
  let link = document.getElementById('akari-font') as HTMLLinkElement | null;
  if (link?.sheet || link?.dataset.state === 'loaded') {
    if (link) link.dataset.state = 'loaded';
    return Promise.resolve(true);
  }
  if (link?.dataset.state === 'error') {
    link.remove();
    link = null;
  }
  if (cssLoading) return cssLoading;
  const fresh = !link;
  const el = link ?? document.createElement('link');
  if (fresh) {
    el.rel = 'stylesheet';
    el.id = 'akari-font';
    el.dataset.state = 'loading';
    el.href = FONT_CSS;
  }
  cssLoading = new Promise((resolve) => {
    const finish = (loaded: boolean) => {
      el.dataset.state = loaded ? 'loaded' : 'error';
      cssLoading = null;
      resolve(loaded);
    };
    el.addEventListener('load', () => finish(true), { once: true });
    el.addEventListener('error', () => finish(false), { once: true });
    if (fresh) document.head.appendChild(el);
  });
  return cssLoading;
}

/** 字体声明放上页面 */
export function loadFonts() {
  void ensureCss();
  if (!document.getElementById('inter-font')) {
    const el = document.createElement('link');
    el.rel = 'stylesheet';
    el.id = 'inter-font';
    el.href = INTER_CSS;
    document.head.appendChild(el);
  }
}

function pageText(): string {
  const set = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.textContent?.trim();
    if (!raw) continue;
    const text = /[　-鿿＀-￯]/.test(raw) ? raw : sourceOf(raw);
    if (text) for (const ch of text) set.add(ch);
  }
  return [...set].join('');
}

/** 切到中文之前，把这一页要用的中文切片先下载好（切到英文什么都不做） */
export function warmHanFont(target: string): Promise<void> {
  if (target === 'en') return Promise.resolve();
  const text = pageText();
  if (!text) return Promise.resolve();
  return ensureCss()
    .then((loaded) => (loaded ? document.fonts.load(`16px "${FAMILY}"`, text) : undefined))
    .then(() => {}, () => {});
}
