/*
 * 仪表盘提示胶囊的「×」：关掉的是「这一版」提示，内容变了就再出现。
 *   · 待支付订单：记订单 id——同一笔订单不再提示（订单页、导航上的数字照旧），下一笔订单照常出现；
 *   · 工单回复：记工单 id + 最后更新时间——客服再回复一次（更新时间变了）就再出现。
 * 存在 localStorage（隐私模式 / 存储被禁用时读写都静默失败：提示照常显示，× 只在本页生效）。
 */
export type DismissKind = 'order' | 'ticket';

const PREFIX = 'akari.dismiss.';

/** 存储键：每种一个键，只记最近关掉的那一版 */
export const dismissKey = (kind: DismissKind) => `${PREFIX}${kind}`;

/** 一版提示的标识：订单只看 id，工单还要看最后更新时间 */
export const dismissMark = (id: string, version?: string) => (version ? `${id}@${version}` : id);

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function isDismissed(kind: DismissKind, mark: string, s: Storage | null = store()): boolean {
  try {
    return s?.getItem(dismissKey(kind)) === mark;
  } catch {
    return false;
  }
}

export function dismiss(kind: DismissKind, mark: string, s: Storage | null = store()): void {
  try {
    s?.setItem(dismissKey(kind), mark);
  } catch {
    /* 存不下：只在本页关掉 */
  }
}
