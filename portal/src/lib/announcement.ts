import type { Announcement } from '@/api';
import { pick } from './site';

/** 公告按界面语言取标题与正文（英文为空回落中文；与 React 门户 lib/announcement.ts 相同） */
export function announcementText(a: Announcement, locale: string): { title: string; html: string } {
  return { title: pick(locale, a.title_zh, a.title_en), html: pick(locale, a.html_zh, a.html_en) };
}

/** 公告标签（实底，design/announcement-tags-2026-10）的颜色名：tokens.css 的 --t-* */
const TAG_COLORS = ['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'slate'] as const;
export type AnnouncementTag = { name: string; color: string };

/**
 * 公告的标签。数据模型还没做（单独的后端任务）：面板给了 `tags` 才画，没给就是空——标签位留着，不造假数据。
 * 认不得的颜色按 slate 画（类名只会是上面那几种）。
 */
export function tagsOf(a: Announcement): { name: string; cls: string }[] {
  const raw = (a as Announcement & { tags?: AnnouncementTag[] | null }).tags;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x) => x && typeof x.name === 'string' && x.name)
    .map((x) => ({ name: x.name, cls: `c-${(TAG_COLORS as readonly string[]).includes(x.color) ? x.color : 'slate'}` }));
}
