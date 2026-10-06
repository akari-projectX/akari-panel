import { BookOpen, CircleHelp, CreditCard, Megaphone, Rocket, ShieldCheck, type LucideIcon } from 'lucide-react';
import PlatformIcon from '@/components/platform-icon';
import type { Platform } from '@/data/platforms';
import { cn } from '@/lib/utils';

/*
 * 分类名常见的几种写法 → 图标。认得出平台的用平台图标（见 lib/doc-categories），
 * 其余按名字里的关键词挑一个，都对不上就是一本书。只是装饰，认错了也不影响点进去。
 */
const GENERIC: [RegExp, LucideIcon][] = [
  [/常见|问题|疑问|faq|q&a|help/i, CircleHelp],
  [/购买|付款|支付|续费|订单|账单|充值|退款|billing|pay/i, CreditCard],
  [/账号|账户|帐号|安全|密码|登录|account|security/i, ShieldCheck],
  [/公告|更新|日志|变更|news|changelog/i, Megaphone],
  [/新手|入门|开始|快速|指南|start|guide/i, Rocket],
];

export default function DocCategoryIcon({ name, platform, className }: {
  name: string; platform: Platform | null; className?: string;
}) {
  if (platform) return <PlatformIcon name={platform.icon} className={className} />;
  const Icon = GENERIC.find(([re]) => re.test(name))?.[1] ?? BookOpen;
  return <Icon className={cn('size-4', className)} />;
}
