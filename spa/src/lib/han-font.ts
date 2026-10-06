/* ?url：Vite 处理这张样式表（字体切片加哈希、改写地址），给出它的地址；声明本身不进应用样式表 */
import FONT_CSS from '@/assets/fonts/akari.css?url';
import { sourceOf } from '@/i18n';

/*
 * 正文字体 Noto Sans SC 的加载与预热，全平台通用。
 *
 * 字体声明只有一份 akari.css（一百多条 @font-face，见 scripts/subset-akari-font.py），
 * 单独一张样式表、不挡首帧：应用挂载时插入，切片按 unicode-range 用到才下载。这里还负责
 *   · 预热：英文界面在页面空闲后，把「切到中文时这一页要用的字」先下载好。
 *     不然切过去才开始下载，中文先用系统字体露一下，字体到了再跳一次。
 *     中文界面切英文不用预热：英文字母、数字在中文界面里本来就用着，那一片早已到位。
 */

/* 与 scripts/subset-akari-font.py 的 FAMILY 一致 */
const FAMILY = 'Noto Sans SC Variable';

let cssLoading: Promise<boolean> | null = null;

/** 插入（或复用）字体声明；失败时允许下一次预热重新请求 */
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

/** 确保字体声明在页面上 */
export function loadAkariFont() {
  void ensureCss();
}

/**
 * 切到中文之后这一页要显示的字，去重。
 * 页面现在是英文：逐个文本节点按英文词典反查简体原文；查不到的（带变量拼出来的句子、后台内容）跳过，切过去再下。
 * 不按字重分组：中文网页字体是可变字体，一片一个文件，各个字重都在里面。
 */
function pageText(): string {
  const set = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.textContent?.trim();
    if (!raw) continue;
    const text = /[\u3000-\u9fff\uff00-\uffef]/.test(raw) ? raw : sourceOf(raw);
    if (text) for (const ch of text) set.add(ch);
  }
  return [...set].join('');
}

/**
 * 预热「切到 target 之后这一页要用的字」：document.fonts.load 一次，
 * 浏览器只下载这些字所在的切片，下载完的切片在切语言后同步可用，不会先露一下系统字体。
 * 只有从英文切到中文需要；切到英文什么都不做。
 */
export function warmHanFont(target: string): Promise<void> {
  if (target === 'en') return Promise.resolve();
  const text = pageText();
  if (!text) return Promise.resolve();
  return ensureCss()
    .then((loaded) => loaded ? document.fonts.load(`16px "${FAMILY}"`, text) : undefined)
    .then(() => {}, () => {});
}
