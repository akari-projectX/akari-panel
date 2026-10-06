import { useCallback } from 'react';
import type { Announcement } from '@/api';
import { pick } from '@/lib/doc-categories';
import { useLocale } from '@/i18n';

/** 公告按界面语言取标题与正文（英文为空回落中文） */
export function useAnnouncementText() {
  const { locale } = useLocale();
  return useCallback(
    (a: Announcement) => ({ title: pick(locale, a.title_zh, a.title_en), html: pick(locale, a.html_zh, a.html_en) }),
    [locale],
  );
}
