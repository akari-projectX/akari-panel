import type { Offer, PayMethod } from '@/api';
import { PERIOD_MONTHS, type StatusTone } from '@/lib/format';

/**
 * 商店、订单页的小工具（价格一律由面板算好，这里只换说法）。挑选默认周期、卡片大字价格、拒绝原因的文案在
 * React 门户共用的 `@/lib/shop`（框架无关、有单测）。
 */

/**
 * 确认订单里每个周期旁边的「省 x%」：相对月付标价按月折算省了多少（与卡片上「年付省 x%」同一个算法，≥ 5% 才写）。
 * 只是标价的换算，不是本次应付。
 */
export function savePercent(offers: Offer[], o: Offer): number | null {
  const month = offers.find((x) => x.period === 'month');
  const m = PERIOD_MONTHS[o.period];
  if (!month || month.price_cents <= 0 || !m || m <= 1) return null;
  const p = Math.round((1 - o.price_cents / (month.price_cents * m)) * 100);
  return p >= 5 ? p : null;
}

/** 支付方式下面的一行说明（按面板的种类；不认得的不写） */
export const METHOD_HINT: Record<string, string> = {
  alipay_f2f: '扫码付款',
  epay: '跳转到收银台',
  usdt_chain: 'USDT 链上转账',
};

export const methodHint = (m: PayMethod): string | undefined => METHOD_HINT[m.kind];

/**
 * 一个地址能不能交给浏览器打开（同 React 门户 lib/utils 的 safeUrl）：只挡会执行代码的协议。
 * 浏览器解析协议时忽略空白和控制字符，「java\tscript:」也是 javascript:，先去掉再判断。
 */
export function safeUrl(value: string): boolean {
  // oxlint-disable-next-line no-control-regex -- 就是要匹配控制字符
  const v = value.replace(/[\u0000- ]/g, '').toLowerCase();
  return !(v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:'));
}

/**
 * 支付宝当面付返回 https://qr.alipay.com/… 的二维码链接。手机上没法用这台手机扫自己屏幕上的码：
 * 包进支付宝的唤起地址（saId=10000007 是「扫一扫」，qrcode 参数就是码的内容），点一下直接打开支付宝的付款页。
 */
export const isAlipayQr = (url: string) => /^https:\/\/qr\.alipay\.com\//i.test(url);
export const alipayScheme = (url: string) => `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(url)}`;
export const IS_MOBILE = /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent);
/** 微信内置浏览器会屏蔽 alipays:// 唤起，只能让用户换到系统浏览器 */
export const IN_WECHAT = /MicroMessenger/i.test(navigator.userAgent);

/** 倒计时文字：mm:ss，超过一小时 h:mm:ss */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** 订单状态的色调（@/lib/format 的 orderState）→ 状态文字的类名（content.css 的 .st：色点 + 文字） */
export const toneClass = (tone: StatusTone): string =>
  tone === 'success' ? 'st ok' : tone === 'warning' ? 'st warn' : tone === 'danger' ? 'st off' : 'st';
