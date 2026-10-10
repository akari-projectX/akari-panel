/**
 * 面板用户接口的数据形状（akari-panel 的 src/api.rs、billing/、tickets.rs 等的视图，原样镜像）。
 *
 * 全站的单位约定，写在这里一次：
 *   · id 一律是 UUID 字符串（工单消息、流水条目除外，它们是数字）；
 *   · 时间一律是 RFC 3339 字符串（"2026-10-06T08:00:00Z"，带时区偏移的也有），不是 Unix 秒；
 *     日期类字段（"2026-10-06"）是全站时区里的日历日；
 *   · 金额一律是人民币**分**（整数），流水的变动有正有负（余额本身不会为负）；
 *   · 流量一律是**字节**。
 */

/* ───────────── 认证与站点 ───────────── */

export type Role = 'user' | 'admin';

export const PLATFORMS = ['windows', 'macos', 'linux', 'android', 'ios', 'harmony', 'other'] as const;
export type ClientPlatform = (typeof PLATFORMS)[number];

export type Branding = {
  version: number;
  /** 相对面板根（"brand/logo?v=…"），用 base.brandUrl 解析 */
  logo_url: string | null;
  favicon_url: string | null;
  footer_text: string | null;
  footer_links: { label: string; url: string }[];
  tos_url: string | null;
  privacy_url: string | null;
  client_downloads: { platform: ClientPlatform; label: string | null; url: string }[];
  updated_at: string;
};

export type FormGuardOptions = {
  /** 签发时间的签名；表单要在 form_min_secs 之后才能提交（关闭最短提交时间时为 null） */
  form_token: string | null;
  form_min_secs: number;
  honeypot: boolean;
  /** Cloudflare Turnstile：站点密钥和需要它的表单；没开为 null */
  turnstile: { site_key: string; login: boolean; register: boolean; reset: boolean } | null;
};

/** GET /auth/options：登录页能提供什么 */
export type AuthOptions = {
  register: boolean;
  invite_required: boolean;
  /** 空数组 = 不限域名 */
  email_domains: string[];
  reset: boolean;
  /** false = 注册不发验证码，改做工作量证明 */
  email_verify: boolean;
  site_name: string;
  branding: Branding | null;
  /** null = 设置读不出来：公开表单一律会被拒 */
  guard: FormGuardOptions | null;
  /** 这里能用通行密钥登录（需要 https 主域名） */
  passkey: boolean;
  /** 全站时区（IANA 名）：日期一律按它显示 */
  timezone: string;
};

/** POST /auth/login、/auth/passkey/login、/auth/register 的答复 */
export type LoginResult = {
  id: string;
  email: string;
  role: Role;
  expired: boolean;
  quota_exhausted: boolean;
  banned?: boolean;
  /** 策略开着、这个账户还没有通行密钥：登录后引导绑定 */
  passkey_prompt?: boolean;
  /** 注册时赠送了试用套餐 */
  trial?: boolean;
};

/** 表单的 guard 段：表单令牌 + 留空的蜜罐 + Turnstile 令牌 */
export type FormGuard = { form_token?: string; website: string; turnstile?: string };

/* ───────────── 账户 ───────────── */

export type Me = {
  id: string;
  role: Role;
  /** 计费后的已用流量 */
  traffic_used_bytes: number;
  traffic_limit_bytes: number | null;
  expires_at: string | null;
  /** 已过期：只剩续费范围（商店、订单、钱包、工单、帮助、账户） */
  expired: boolean;
  /** 流量用完被停用：同样只剩续费范围 */
  quota_exhausted: boolean;
  /** 被管理员封禁：只能看封禁说明和工单 */
  banned: boolean;
  ban_reason: string | null;
  banned_at: string | null;
  email: string;
  email_verified: boolean;
  /** 邮件语言 */
  locale: 'zh' | 'en';
  /**
   * 订阅链接（D11 随机订阅路径；D8 可能在订阅域名上）；管理员、续费范围、旧链接（sub_legacy）都是 null。
   * 没配域名时是相对地址 `/<订阅路径>/<令牌>`（lib/sub-links 的 mySubUrl 补 origin）。
   */
  sub_token: string | null;
  sub_url: string | null;
  /** 旧格式链接：还能用，但重置之前显示不出来 */
  sub_legacy: boolean;
  /** 系统设置里开着的订阅格式（clash / sing-box / links） */
  sub_formats: string[];
  /** 要显示的一键导入按钮（客户端 id，已按开着的格式筛过；顺序即显示顺序） */
  sub_import_clients: string[];
  probe_interval_secs: number;
  /** 全站时区（IANA 名）：日期一律按它显示 */
  timezone: string;
};

/** "monthly" | "none" | "days-N" */
export type ResetPeriod = string;

export type MyPlan = {
  plan: {
    name: string;
    traffic_quota_bytes: number | null;
    period: ResetPeriod;
    speed_limit_mbps: number | null;
    device_seats: number | null;
    starts_at: string;
    expires_at: string | null;
    period_anchor: string;
    last_reset_at: string | null;
    /** 带全站时区的偏移 */
    next_reset_at: string | null;
  } | null;
  traffic_used_bytes: number;
  traffic_limit_bytes: number | null;
  expires_at: string | null;
  /** 可用入口：入口名与标签（不给节点、服务器名） */
  nodes: { name: string; tags: string[]; region: string | null }[];
};

export type PasskeyItem = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  /** 属于当前主域名（能用来登录） */
  current: boolean;
};

/** GET /me/passkeys：登录方式 */
export type LoginMethods = {
  available: boolean;
  rp_id: string | null;
  passkeys: PasskeyItem[];
  password_set: boolean;
  /** 账户自己开了「只用通行密钥」 */
  password_login_disabled: boolean;
  /** 现在能不能用密码登录（站点策略 + 账户开关的结果） */
  password_login: boolean;
  max: number;
};

/** WebAuthn 挑战：state 原样交回，options 是 publicKey 选项（base64url 编码） */
export type PasskeyChallenge = { state: string; options: { publicKey: Record<string, unknown> } };

/* ───────────── 订阅、节点、流量 ───────────── */

export type SubFormat = 'auto' | 'clash' | 'sing-box' | 'links';

export type SubTokenReset = { sub_token: string; sub_url: string | null; credentials_rotated: number };

/** GET /me/nodes 的一行：一个可用入口（只给入口名与标签，不给节点、服务器名） */
export type MyNode = {
  entrance: string;
  region: string | null;
  tags: string[];
  /** 入口此刻生效的倍率（D9：基础倍率 + 站点时区的时段规则，面板在 SQL 里算） */
  rate: number;
  online: boolean;
  /**
   * 在线 / 离线 / 维护中。维护中 = 中转入口没通过健康检查或服务器流量额度用完：
   * 仍列出来（置灰），但订阅里没有它。
   */
  status: 'online' | 'offline' | 'maintenance';
  /** 负载等级（CPU 与网卡速率，面板按心跳算好；不给数字）；不在线或未知为 null */
  load: 'low' | 'medium' | 'high' | null;
  /** 面板 → 入口的 TCP 测速（ms），没开或没测到为 null */
  probe_ms: number | null;
  latency_ms: number | null;
  latency_status: 'ok' | 'timeout' | 'unknown';
  latency_measured_at: string | null;
};

export type TrafficBytes = { up_bytes: number; down_bytes: number; billed_bytes: number };

/** GET /me/traffic：按全站时区的日界 */
export type MyTraffic = {
  from: string;
  to: string;
  timezone: string;
  /** 按天的明细从这一天开始保留；更早的只剩月汇总 */
  daily_since: string | null;
  total: TrafficBytes;
  days: (TrafficBytes & { day: string })[];
  /**
   * 按入口（直连 1x 与中转 10x 不会加在一起）。name 是入口名（不给节点、服务器名），tags 是入口标签；
   * name 为 null：隐藏或已删除的线路合在一起。
   * rate 是此刻生效的倍率，rules 是该入口的时段规则（全站时区）；都不是历史上的计费 ÷ 原始。
   */
  entrances: (TrafficBytes & { name: string | null; tags: string[]; rate: number | null; rules: RateRule[] })[];
};

/** 入口的时段倍率规则：ISO 星期（1 = 周一），一天里的分钟 [start, end)，end < start 跨午夜，1440 = 24:00 */
export type RateRule = { weekdays: number[]; start: number; end: number; rate: number };

/* ───────────── 商店与订单 ───────────── */

export const PERIOD_KINDS = [
  'month', 'quarter', 'half_year', 'year', 'two_year', 'three_year', 'days', 'onetime', 'reset',
] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export type OfferAction = 'new' | 'renew' | 'switch' | 'reset';
export type OfferRefusal =
  'not_for_sale' | 'sold_out' | 'renewal_only' | 'no_switch' | 'reset_needs_subscription' | 'no_expiry';
export type CouponRefusal =
  'invalid' | 'not_started' | 'expired' | 'used_up' | 'user_limit' | 'new_users_only' | 'plan' | 'period' | 'below_minimum';

/** 一个周期「现在下单」的报价，全部由服务端算好 */
export type Offer = {
  period: PeriodKind;
  /** days 必有；onetime 可有（null = 永久）；其余 null */
  days: number | null;
  price_cents: number;
  /** 实际要付的（价格 − 优惠 − 折算 − 余额）；被拒时为 null */
  amount_cents: number | null;
  discount_cents: number;
  /** 换套餐时旧套餐折算抵扣 */
  credit_cents: number;
  /** 折算里超出新套餐价格、换过去就作废的部分 */
  forfeited_cents: number;
  balance_cents: number;
  coupon_refusal: CouponRefusal | null;
  action: OfferAction | null;
  refusal: OfferRefusal | null;
};

export type ShopPlan = {
  plan_id: string;
  name: string;
  /** 纯文本（Markdown-lite），永不当 HTML */
  description: string;
  traffic_quota_bytes: number | null;
  period: ResetPeriod;
  speed_limit_mbps: number | null;
  device_seats: number | null;
  current: boolean;
  /** 剩余名额（null = 不限） */
  remaining: number | null;
  sold_out: boolean;
  offers: Offer[];
};

export type PayMethod = { id: string; kind: string; display_name: string; icon: string | null };

export type Shop = {
  /** 有没有可用的支付方式 */
  enabled: boolean;
  methods: PayMethod[];
  current: { plan_id: string; name: string; expires_at: string | null } | null;
  credit_cents: number;
  balance_cents: number;
  coupon: { code: string; refusal: CouponRefusal | null } | null;
  plans: ShopPlan[];
};

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export type MyOrder = {
  id: string;
  /** 只用来显示 */
  out_trade_no: string;
  plan_id: string | null;
  plan_name: string;
  amount_cents: number;
  period: PeriodKind;
  period_days: number | null;
  list_price_cents: number;
  credit_cents: number;
  discount_cents: number;
  coupon_code: string | null;
  balance_cents: number;
  refunded_at: string | null;
  status: OrderStatus;
  /** 只在待支付时有：支付宝二维码内容 */
  qr_code: string | null;
  /** 只在待支付时有：跳转类支付的收银台 */
  pay_url: string | null;
  payment_method_id: string | null;
  payment_method_name: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  /** 已付款且已开通；已付款但没开通的会被自动退到余额 */
  fulfilled: boolean;
  /** 订单类型 */
  action: OfferAction;
  /**
   * 退款去向（退款后才有）：original = 原路退回支付渠道，balance = 退到余额，
   * manual = 站长已在支付渠道后台退款并登记
   */
  refund_route: RefundRoute | null;
  /** 退到余额的部分、经支付渠道退回的部分（分；退款后才有） */
  refund_balance_cents: number | null;
  refund_external_cents: number | null;
  /** 已向支付渠道发起原路退款、渠道还没确认 */
  refund_pending: boolean;
  /** 退款对套餐的影响：none 只退钱、cancel 套餐已结束、rollback 到期时间已回退、restore 已恢复换套餐前的套餐 */
  refund_effect: RefundEffect | null;
};

export type RefundRoute = 'original' | 'balance' | 'manual';
export type RefundEffect = 'none' | 'cancel' | 'rollback' | 'restore';

export type CreateOrder = {
  plan_id: string;
  period: PeriodKind;
  coupon?: string;
  use_balance?: boolean;
  method_id?: string;
};

/* ───────────── 钱包与邀请 ───────────── */

export type LedgerKind =
  | 'commission' | 'admin_adjust' | 'order_payment' | 'refund_to_balance'
  | 'withdrawal' | 'withdrawal_reversal' | 'commission_clawback';

export type LedgerEntry = {
  id: number;
  kind: LedgerKind;
  /** 有符号 */
  amount_cents: number;
  balance_after_cents: number;
  order_id: string | null;
  out_trade_no: string | null;
  commission_id: string | null;
  withdrawal_id: string | null;
  reason: string | null;
  created_at: string;
};

export type MyBalance = { balance_cents: number; withdrawable_cents: number; entries: LedgerEntry[] };

/** R46：佣金只用 USDT 提现，可选的网络由站长在后台勾选 */
export type UsdtChain = 'trc20' | 'plasma' | 'polygon' | 'arbitrum' | 'solana' | 'xlayer' | 'ton';
export type WithdrawalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type Withdrawal = {
  id: string;
  /** 申请时从余额扣除的人民币（分） */
  amount_cents: number;
  chain: UsdtChain;
  /** 收款地址（只有本人和管理员看得到） */
  address: string;
  /** TON 的 Memo / 备注 */
  memo: string | null;
  status: WithdrawalStatus;
  /** 实际打出的 USDT（6 位小数的文本）与链上交易哈希：通过后才有 */
  usdt_amount: string | null;
  txid: string | null;
  note: string | null;
  decided_at: string | null;
  created_at: string;
};

export type CommissionStatus = 'pending' | 'credited' | 'reversed';

export type Commission = {
  id: string;
  /** 被邀请人的非个人标签，永远不是邮箱 */
  invitee_label: string;
  base_cents: number;
  rate_percent: number;
  amount_cents: number;
  status: CommissionStatus;
  available_at: string;
  credited_at: string | null;
  reversed_at: string | null;
  created_at: string;
};

export type MyInvite = {
  enabled: boolean;
  rate_percent: number;
  first_order_only: boolean;
  hold_days: number;
  min_withdrawal_cents: number;
  /** 后台开着的 USDT 网络（顺序即显示顺序） */
  usdt_chains: { id: UsdtChain; name: string }[];
  /** 参考汇率：1 USDT 折合多少分人民币（只用于显示「约 N USDT」）；没设为 null */
  usdt_rate_cents: number | null;
  invite_codes: string[] | null;
  invited_count: number;
  pending_cents: number;
  credited_cents: number;
  reversed_cents: number;
  balance_cents: number;
  withdrawable_cents: number;
  commissions: Commission[];
};

export type InviteCodes = {
  codes: { code: string; uses: number; created_at: string }[];
  limit: number;
  register_enabled: boolean;
  invite_required: boolean;
  single_use: boolean;
  invited: number;
  /** 邀请链接前缀（以 ?invite= 结尾）；null 时用门户自己的注册页 */
  link_base: string | null;
};

/* ───────────── 工单、公告、知识库 ───────────── */

export const TICKET_CATEGORIES = ['general', 'billing', 'technical', 'account', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = 'open' | 'answered' | 'closed';
export const TICKET_MAX_SUBJECT = 120;
export const TICKET_MAX_BODY = 5000;

export type TicketRow = {
  id: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  messages: number;
  created_at: string;
  updated_at: string;
  /** 有客服的新回复没看 */
  unread: boolean;
};

export type TicketMessage = { id: number; staff: boolean; body: string; created_at: string };

export type TicketDetail = {
  id: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  order_id: string | null;
  order_no: string | null;
  node_id: string | null;
  node_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: 'user' | 'staff' | null;
  messages: TicketMessage[];
};

export type NewTicket = {
  subject: string;
  category: TicketCategory;
  priority?: TicketPriority;
  message: string;
  order_id?: string;
};

export type Announcement = {
  id: string;
  title_zh: string;
  title_en: string | null;
  /** 面板渲染并清洗过的 HTML */
  html_zh: string;
  html_en: string | null;
  pinned: boolean;
  created_at: string;
  read: boolean;
};

export type Announcements = { announcements: Announcement[]; unread: number };

export type HelpItem = {
  id: string;
  category_id: string | null;
  title_zh: string;
  title_en: string | null;
  updated_at: string;
};

export type HelpList = {
  categories: { id: string; name_zh: string; name_en: string | null; articles: HelpItem[] }[];
  uncategorized: HelpItem[];
  total: number;
};

export type HelpArticle = {
  id: string;
  category_id: string | null;
  category_zh: string | null;
  category_en: string | null;
  title_zh: string;
  title_en: string | null;
  html_zh: string;
  html_en: string | null;
  updated_at: string;
};

/* ───────────── 条款与隐私（公开） ───────────── */

/** GET /api/v1/pages/{terms|privacy}：站长在知识库里写的条款 / 隐私（固定 slug），服务端渲染好的 HTML */
export type LegalPage = {
  title_zh: string;
  title_en: string | null;
  html_zh: string;
  html_en: string | null;
  updated_at: string;
};

/* ───────────── 自助注销 ───────────── */

/** GET /me/delete-impact：注销前给用户看的影响摘要（与后台的 delete-impact 同形） */
export type DeleteImpact = {
  email: string;
  balance_cents: number;
  withdrawable_cents: number;
  pending_withdrawals: number;
  pending_withdrawal_cents: number;
  pending_orders: number;
  /** 已付款但没能开通的订单 */
  unfulfilled_orders: number;
  plan: { name: string; expires_at: string | null } | null;
  /** 有财务记录：账户匿名化保留，而不是整个删除 */
  anonymized: boolean;
};
