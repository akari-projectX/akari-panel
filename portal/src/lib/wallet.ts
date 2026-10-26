import { portalUrl, type Commission, type CommissionStatus, type InviteCodes, type LedgerKind, type MyInvite, type UsdtChain, type WithdrawalStatus } from '@/api';
import { R } from './routes';

/*
 * 钱包与邀请页（pages/Wallet.svelte、components/wallet/）的文案表与纯函数，与 React 门户 pages/dash/wallet.tsx、
 * wallet-invite.tsx 相同。文案是简体原文，显示时再 t()。
 */

export const LEDGER_TEXT: Record<LedgerKind, string> = {
  commission: '邀请佣金入账',
  admin_adjust: '管理员调整',
  order_payment: '订单支付',
  refund_to_balance: '退款到余额',
  withdrawal: '提现',
  withdrawal_reversal: '提现退回',
  commission_clawback: '佣金追回',
};

/** USDT 网络的显示名（历史记录里可能出现后台后来关掉的网络，所以不只靠 /me/invite 给的那份） */
const CHAIN_NAME: Record<UsdtChain, string> = {
  trc20: 'TRC20 (Tron)',
  plasma: 'Plasma',
  polygon: 'Polygon',
  arbitrum: 'Arbitrum One',
  solana: 'Solana',
  xlayer: 'X Layer',
  ton: 'TON',
};

export const chainName = (c: string) => CHAIN_NAME[c as UsdtChain] ?? c;

/** 每个网络的地址格式提示（面板按网络严格校验，这里只帮用户别填错网络） */
export const ADDRESS_HINT: Record<UsdtChain, { hint: string; placeholder: string }> = {
  trc20: { hint: 'T 开头的 34 位 Tron 地址', placeholder: 'T…' },
  plasma: { hint: '0x 开头的 42 位地址（EVM）', placeholder: '0x…' },
  polygon: { hint: '0x 开头的 42 位地址（EVM）', placeholder: '0x…' },
  arbitrum: { hint: '0x 开头的 42 位地址（EVM）', placeholder: '0x…' },
  xlayer: { hint: '0x 开头的 42 位地址（EVM）', placeholder: '0x…' },
  solana: { hint: 'Base58 编码的 Solana 地址（32–44 位）', placeholder: '' },
  ton: { hint: 'TON 地址（UQ / EQ 开头）；转到交易所时请填写 Memo', placeholder: 'UQ…' },
};

/** 参考折合 USDT（只用于显示，两位小数）；没设参考汇率为 null */
export function usdtEstimate(cents: number, rateCents: number | null | undefined): string | null {
  return rateCents && rateCents > 0 ? (cents / rateCents).toFixed(2) : null;
}

/** 状态 = 色点 + 文字（pages.css 的 .st）：ok 绿、warn 琥珀、off 红点、空 = 灰点 */
export type Tone = 'ok' | 'warn' | 'off' | '';

export const W_STATUS: Record<WithdrawalStatus, { text: string; tone: Tone }> = {
  pending: { text: '待审核', tone: 'warn' },
  approved: { text: '已打款', tone: 'ok' },
  rejected: { text: '已驳回', tone: 'off' },
  cancelled: { text: '已撤回', tone: '' },
};

export const C_STATUS: Record<CommissionStatus, { text: string; tone: Tone }> = {
  pending: { text: '冻结中', tone: 'warn' },
  credited: { text: '已入账', tone: 'ok' },
  reversed: { text: '已追回', tone: '' },
};

/** 一条返佣的状态：入账后被退款追回的（面板里仍是 credited，带 clawback_cents）也显示「已追回」 */
export const commissionStatus = (x: Pick<Commission, 'status' | 'clawback_cents'>) =>
  C_STATUS[x.status === 'credited' && x.clawback_cents ? 'reversed' : x.status];

/** 有没有被追回的佣金（入账前撤销的 reversed，或入账后被退款追回的） */
export const anyClawback = (i: Pick<MyInvite, 'reversed_cents' | 'commissions'>) =>
  i.reversed_cents > 0 || i.commissions.some((x) => !!x.clawback_cents);

/** 长地址 / 交易哈希：中间省略 */
export const shorten = (v: string) => (v.length > 20 ? `${v.slice(0, 8)}…${v.slice(-8)}` : v);

/** 邀请链接：面板给的 link_base（以 ?invite= 结尾）+ 邀请码；没有时用门户自己的注册页 */
export function inviteLink(code: string, linkBase: string | null): string {
  return `${linkBase ?? portalUrl(`${R.register}?invite=`)}${encodeURIComponent(code)}`;
}

/** 单次使用的站点上，邀请码已经用过（每个账户只有这一个码，不会再生成新的） */
export const spent = (c: InviteCodes) => c.single_use && !!c.code && c.code.uses > 0;

/** 返佣条款，一行：「返佣 20% · 每一笔订单 · 冻结 7 天后入账」；没开返佣时说明 */
export function terms(i: MyInvite, t: (s: string) => string, tp: (s: string, v: Record<string, string | number>) => string): string {
  if (!i.enabled) return t('站点暂未开启邀请返佣。');
  return [
    tp('返佣 {n}%', { n: i.rate_percent }),
    i.first_order_only ? t('只返被邀请人的首单') : t('被邀请人的每一笔订单都返'),
    tp('冻结 {n} 天后入账', { n: i.hold_days }),
  ].join(' · ');
}

/** 状态色调 → Badge 的色调类（flat.css 的 .bdg） */
export const bdgTone = (t: Tone): string => (t === 'ok' ? 'success' : t === 'warn' ? 'warning' : t === 'off' ? 'danger' : 'neutral');
