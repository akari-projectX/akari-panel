import type { MyNode } from '@/api';

/*
 * 线路的显示规则（仪表盘的线路预览与线路页共用，content.css 的 .st / .mult）：
 * 状态 = 色点 + 文字（在线绿、维护中琥珀、离线红点灰字）；倍率纯文字，≤ 0.5× 绿、> 1× 琥珀（只对能用的线路上色）。
 */
export const stClass = (n: Pick<MyNode, 'status'>) => (n.status === 'online' ? 'ok' : n.status === 'maintenance' ? 'warn' : 'off');

export const multClass = (rate: number) => (rate <= 0.5 ? 'lo' : rate > 1 ? 'hi' : '');
