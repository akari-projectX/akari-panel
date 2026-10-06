import type { HelpItem, HelpList } from '@/api';
import { PLATFORMS, detectPlatform, type Platform } from '@/data/platforms';

/**
 * 知识库（GET /me/help）→ 页面上的「分类入口」。
 *
 * 分类完全以后台为准：站长建了几个就显示几个、叫什么就显示什么、顺序照后台排。
 * 标题、分类名按界面语言取 *_zh / *_en，英文为空时回落中文（同面板的 pick）。
 * 平台清单（data/platforms）只用来认出「这个分类讲的是哪个平台」，借它的图标，并把当前设备的分类排前面。
 */
export type KbArticle = { id: string; title: string; category: string; updated_at: string };

export type DocCategory = {
  name: string;
  articles: KbArticle[];
  platform: Platform | null;
  mine: boolean;
};

/** 按界面语言选：英文有内容就用英文，否则中文 */
export function pick<T>(locale: string, zh: T, en: T | null | undefined): T {
  return locale === 'en' && en != null && en !== '' ? en : zh;
}

const MINE = detectPlatform();

function platformOfCategory(name: string): Platform | null {
  const t = name.toLowerCase();
  return PLATFORMS.find((p) => p.keywords.some((k) => t.includes(k))) ?? null;
}

const article = (a: HelpItem, category: string, locale: string): KbArticle =>
  ({ id: a.id, title: pick(locale, a.title_zh, a.title_en), category, updated_at: a.updated_at });

/**
 * 默认把当前设备的分类排第一（仪表盘的入口用）。mineFirst: false 时完全照后台排（文档页）。
 * 没有分类的文章归到「其他」，排在最后。
 */
export function docCategories(
  list: HelpList | undefined, locale: string, other: string, { mineFirst = true } = {},
): DocCategory[] {
  const out: DocCategory[] = (list?.categories ?? [])
    .filter((c) => c.articles.length > 0)
    .map((c) => {
      const name = pick(locale, c.name_zh, c.name_en);
      const platform = platformOfCategory(`${c.name_zh} ${c.name_en ?? ''}`);
      return { name, articles: c.articles.map((a) => article(a, name, locale)), platform, mine: platform?.id === MINE.id };
    });
  if (list?.uncategorized.length) {
    out.push({ name: other, articles: list.uncategorized.map((a) => article(a, other, locale)), platform: null, mine: false });
  }
  const i = mineFirst ? out.findIndex((c) => c.mine) : -1;
  return i > 0 ? [out[i], ...out.slice(0, i), ...out.slice(i + 1)] : out;
}
