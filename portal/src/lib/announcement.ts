import type { Announcement } from '@/api';
import { pick } from './site';

/** 公告按界面语言取标题与正文（英文为空回落中文） */
export function announcementText(a: Announcement, locale: string): { title: string; html: string } {
  return { title: pick(locale, a.title_zh, a.title_en), html: pick(locale, a.html_zh, a.html_en) };
}

/** 预设色键（面板只给这十一个；类名 `c-<色>` 在 styles/pages/common.css，颜色在 tokens.css 的 --t-*） */
const TAG_COLORS = ['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'slate'];

export type TagView = { id: string; name: string; cls: string };

/** 公告的标签（按界面语言取名；没有标签是 null）。认不得的颜色按 slate 画。 */
export function tagOf(a: Announcement, locale: string): TagView | null {
  const tag = a.tag;
  if (!tag) return null;
  return { id: tag.id, name: pick(locale, tag.name_zh, tag.name_en), cls: `c-${TAG_COLORS.includes(tag.color) ? tag.color : 'slate'}` };
}

/** 公告页的筛选项：用到的标签（按首次出现的顺序，即面板排好的顺序）和各自的条数；少于两个标签时不需要筛选 */
export function tagFilters(list: Announcement[], locale: string): (TagView & { n: number })[] {
  const out = new Map<string, TagView & { n: number }>();
  for (const a of list) {
    const tg = tagOf(a, locale);
    if (!tg) continue;
    const seen = out.get(tg.id);
    if (seen) seen.n++;
    else out.set(tg.id, { ...tg, n: 1 });
  }
  return out.size > 1 ? [...out.values()] : [];
}
