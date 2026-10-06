/**
 * 本机的已读记录：只剩文档（知识库文章）读过哪些——上手清单要的是「还没点开过的」。
 * 公告、工单的已读由面板记（/me/announcements 的 read、/me/tickets 的 unread），换设备也一致，不在这里。
 *
 * localStorage 在隐私模式下可能读写都抛错，这里全部吞掉，退化成「什么都没读过」。
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

const KEY = 'akari.read.kb';
/* 只留最近这么多条，免得几年下来越攒越大 */
const MAX_IDS = 400;

let cache: string[] | null = null;
const subs = new Set<() => void>();

function read(): string[] {
  if (cache) return cache;
  let ids: string[] = [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === 'string');
  } catch { /* 读不了就当第一次来 */ }
  cache = ids;
  return ids;
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** 标记一篇文档已读。重复标记是空操作，不会触发重渲染 */
export function markRead(id: string) {
  const ids = read();
  if (ids.includes(id)) return;
  cache = [...ids, id].slice(-MAX_IDS);
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* 存不下也不影响页面 */ }
  subs.forEach((f) => f());
}

export function useReadState() {
  const ids = useSyncExternalStore(subscribe, read, read);
  const set = useMemo(() => new Set(ids), [ids]);
  const isUnread = useCallback((id: string) => !set.has(id), [set]);
  return { isUnread, markRead };
}
