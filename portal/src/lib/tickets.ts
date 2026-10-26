import type { TicketCategory, TicketPriority, TicketStatus } from '@/api';

/**
 * 工单的文字（与 React 门户 pages/dash/tickets.tsx 相同；值是词典的键，用时 t()）。
 * 面板的三种状态：open（等客服）/ answered（客服回了，等你）/ closed。
 */
export const CATEGORY: Record<TicketCategory, string> = {
  general: '一般问题',
  billing: '账单与付款',
  technical: '连接与技术',
  account: '账户',
  other: '其他',
};

/** 优先级：文字 + 说明；cls = 文字颜色（高 = 琥珀、紧急 = 红，只用文字颜色） */
export const PRIORITY: Record<TicketPriority, { text: string; hint: string; cls: string; bdg: string }> = {
  low: { text: '低', hint: '咨询、建议，不着急', cls: 'pr-low', bdg: 'neutral' },
  normal: { text: '普通', hint: '部分节点或功能异常', cls: 'pr-normal', bdg: 'info' },
  high: { text: '高', hint: '无法正常使用', cls: 'pr-high', bdg: 'warn12' },
  urgent: { text: '紧急', hint: '完全不能用、涉及付款', cls: 'pr-urgent', bdg: 'danger' },
};

/** 状态：文字 + pages.css 的 .st 色点类 */
export const STATE: Record<TicketStatus, { text: string; cls: string; bdg: string }> = {
  open: { text: '待处理', cls: 'st', bdg: 'info' },
  answered: { text: '已回复', cls: 'st ok', bdg: 'success' },
  closed: { text: '已关闭', cls: 'st', bdg: 'neutral' },
};

/** 发送快捷键的写法：苹果设备是 ⌘，其余 Ctrl */
export const SEND_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? '⌘ + Enter' : 'Ctrl + Enter';
