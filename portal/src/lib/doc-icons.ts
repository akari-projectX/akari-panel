import BookOpen from '@lucide/svelte/icons/book-open';
import CircleHelp from '@lucide/svelte/icons/circle-help';
import CreditCard from '@lucide/svelte/icons/credit-card';
import Laptop from '@lucide/svelte/icons/laptop';
import Megaphone from '@lucide/svelte/icons/megaphone';
import Monitor from '@lucide/svelte/icons/monitor';
import Rocket from '@lucide/svelte/icons/rocket';
import Router from '@lucide/svelte/icons/router';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import Smartphone from '@lucide/svelte/icons/smartphone';
import SquareTerminal from '@lucide/svelte/icons/square-terminal';
import type { DocCategory } from '@/lib/doc-categories';

/**
 * 文档分类的单色线性图标（仪表盘的文档入口、文档页的设备一行）：认得出平台的用平台的通用图形，
 * 其余按名字里的关键词挑一个，都对不上就是一本书（只是装饰，图标一律 aria-hidden）。
 */
export type Icon = typeof BookOpen;

export const PLATFORM_ICON: Record<string, Icon> = {
  windows: Monitor, macos: Laptop, ios: Smartphone, android: Smartphone, harmony: Smartphone, linux: SquareTerminal, router: Router,
};

const GENERIC: [RegExp, Icon][] = [
  [/常见|问题|疑问|faq|q&a|help/i, CircleHelp],
  [/购买|付款|支付|续费|订单|账单|充值|退款|billing|pay/i, CreditCard],
  [/账号|账户|帐号|安全|密码|登录|account|security/i, ShieldCheck],
  [/公告|更新|日志|变更|news|changelog/i, Megaphone],
  [/新手|入门|开始|快速|指南|start|guide/i, Rocket],
];

export const iconOf = (c: Pick<DocCategory, 'name' | 'platform'>): Icon =>
  (c.platform && PLATFORM_ICON[c.platform.id]) || GENERIC.find(([re]) => re.test(c.name))?.[1] || BookOpen;
