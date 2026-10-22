import type { Announcement } from '@/api';
import { pick } from './site';

/** 公告按界面语言取标题与正文（英文为空回落中文；与 React 门户 lib/announcement.ts 相同） */
export function announcementText(a: Announcement, locale: string): { title: string; html: string } {
  return { title: pick(locale, a.title_zh, a.title_en), html: pick(locale, a.html_zh, a.html_en) };
}
