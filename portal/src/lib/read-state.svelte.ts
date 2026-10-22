/**
 * 本机的已读记录：只有文档（知识库文章）读过哪些（与 React 门户 lib/read-state.ts 同一个键 `akari.read.kb`，同一个源上互通）。
 * 公告、工单的已读由面板记（/me/announcements 的 read、/me/tickets 的 unread），换设备也一致，不在这里。
 * localStorage 在隐私模式下可能读写都抛错：全部吞掉，退化成「什么都没读过」。
 */
const KEY = 'akari.read.kb';
/* 只留最近这么多条，免得几年下来越攒越大 */
const MAX_IDS = 400;

function read(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const state = $state({ ids: read() });

/** 这篇文档还没打开过 */
export const isUnread = (id: string) => !state.ids.includes(id);

/** 标记一篇文档已读；重复标记是空操作 */
export function markRead(id: string) {
  if (state.ids.includes(id)) return;
  state.ids = [...state.ids, id].slice(-MAX_IDS);
  try { localStorage.setItem(KEY, JSON.stringify(state.ids)); } catch { /* 存不下也不影响页面 */ }
}
