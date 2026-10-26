import { describe, expect, it } from 'vitest';
import type { Announcement, AnnouncementTag } from '@/api';
import { tagFilters, tagOf } from './announcement';

const tag = (id: string, name_zh: string, name_en: string | null, color: string): AnnouncementTag => ({ id, name_zh, name_en, color });
const ann = (id: string, t: AnnouncementTag | null): Announcement => ({
  id, title_zh: id, title_en: null, html_zh: '', html_en: null, pinned: false, tag: t, created_at: '2026-10-01T00:00:00Z', read: false,
});

describe('announcement tags', () => {
  it('names the tag in the interface language and falls back to Chinese', () => {
    const a = ann('a', tag('1', '维护', 'Maintenance', 'amber'));
    expect(tagOf(a, 'zh-CN')).toEqual({ id: '1', name: '维护', cls: 'c-amber' });
    expect(tagOf(a, 'en')?.name).toBe('Maintenance');
    expect(tagOf(ann('b', tag('2', '通知', null, 'slate')), 'en')?.name).toBe('通知');
    expect(tagOf(ann('c', null), 'en')).toBeNull();
  });

  it('draws an unknown colour as slate (the class is never made from server text)', () => {
    expect(tagOf(ann('a', tag('1', 'x', null, 'red; x')), 'en')?.cls).toBe('c-slate');
  });

  it('offers a filter only when more than one tag is in use, counted in the panel order', () => {
    const m = tag('1', '维护', null, 'amber');
    const e = tag('2', '活动', null, 'pink');
    expect(tagFilters([ann('a', m), ann('b', m), ann('c', null)], 'zh-CN')).toEqual([]);
    expect(tagFilters([ann('a', m), ann('b', e), ann('c', m), ann('d', null)], 'zh-CN')).toEqual([
      { id: '1', name: '维护', cls: 'c-amber', n: 2 },
      { id: '2', name: '活动', cls: 'c-pink', n: 1 },
    ]);
  });
});
