/**
 * 接口层：页面能调的全部函数。与面板之间的唯一边界——页面只从 '@/api' 导入。
 *
 * 每个函数对应面板的一个用户接口（akari-panel README「API surface」），形状见 ./types。
 */

import { api, auth, qs } from './http';
import { rememberGuard } from './guard';
import { creationOptions, credentialJSON, requestOptions } from './webauthn';
import type {
  Announcements, AuthOptions, CreateOrder, DeleteImpact, FormGuard, HelpArticle, HelpList, HolderProof, InviteCodes, LegalPage,
  LoginMethods, LoginResult, Me, MyBalance, MyInvite, MyNode, MyOrder, MyPlan, MyTraffic, NewTicket, PasskeyChallenge,
  Shop, SubTokenReset, TicketDetail, TicketRow, UsdtChain, Withdrawal,
} from './types';

/* ───────────── 认证（/auth，公开） ───────────── */

export const authApi = {
  /** 登录页能提供什么；每次都带一个新的表单令牌 */
  options: async (): Promise<AuthOptions> => {
    const o = await auth.get<AuthOptions>('/options');
    rememberGuard(o);
    return o;
  },

  /** 所有失败都是统一的 401；仅通行密钥账户用密码登录是 403 auth.passkey_required */
  login: (email: string, password: string, guard: FormGuard) =>
    auth.post<LoginResult>('/login', { email, password, guard }),

  /** 结束这个账户的**所有**会话 */
  logout: () => auth.post<void>('/logout'),

  /** 发注册验证码。对任何地址都答 {ok:true}，不能据此判断邮箱是否已注册 */
  registerCode: (body: { email: string; invite_code?: string; locale?: string; guard: FormGuard }) =>
    auth.post<{ ok: true }>('/register/code', body),

  /** 关闭邮箱验证时的工作量证明挑战 */
  registerChallenge: () => auth.get<{ challenge: string; bits: number }>('/register/challenge'),

  register: (body: {
    email: string;
    password: string;
    code?: string;
    pow?: { challenge: string; nonce: string };
    invite_code?: string;
    locale?: string;
    guard: FormGuard;
  }) => auth.post<LoginResult>('/register', body),

  /** 申请重置链接（发到已验证的地址；对任何地址都答 ok） */
  resetRequest: (email: string, guard: FormGuard) =>
    auth.post<{ ok: true }>('/password-reset/request', { email, guard }),

  /** 用邮件里的令牌设新密码，所有会话结束 */
  reset: (token: string, password: string) => auth.post<{ ok: true }>('/password-reset', { token, password }),

  /** 通行密钥登录（可发现凭据，不用填邮箱）：取挑战 → 设备签名 → 交回 */
  passkeyLogin: async (signal?: AbortSignal): Promise<LoginResult> => {
    const ch = await auth.post<PasskeyChallenge>('/passkey/options');
    const cred = (await navigator.credentials.get({
      publicKey: requestOptions(ch.options.publicKey),
      signal,
    })) as PublicKeyCredential | null;
    if (!cred) throw new DOMException('cancelled', 'NotAllowedError');
    return auth.post<LoginResult>('/passkey/login', { state: ch.state, credential: credentialJSON(cred) });
  },
};

/* ───────────── 账户 ───────────── */

export const meApi = {
  get: (signal?: AbortSignal) => api.get<Me>('/me', signal),
  plan: () => api.get<MyPlan>('/me/plan'),
  nodes: () => api.get<MyNode[]>('/me/nodes'),
  /** from / to 是全站时区的日历日 YYYY-MM-DD */
  traffic: (from: string, to: string) => api.get<MyTraffic>(`/me/traffic${qs({ from, to })}`),
  /** 新链接 + 所有入口的凭据轮换 + 断开现有连接（每小时 5 次） */
  resetSubscription: () => api.post<SubTokenReset>('/me/sub-token'),
  setLocale: (locale: 'zh' | 'en') => api.put<void>('/me/locale', { locale }),
  changePassword: (current_password: string, new_password: string) =>
    api.post<void>('/me/password', { current_password, new_password }),
  /**
   * 验证码发到这个地址：账户自己当前（未验证）的地址不用确认身份；换成别的地址要当前密码或通行密钥
   * （只用通行密钥的账户必须用通行密钥）。地址被别的账户占用时答复一样，验证那一步才失败。
   */
  emailCode: (email: string, confirm?: HolderProof) => api.post<void>('/me/email/code', { email, ...confirm }),
  emailVerify: (code: string) => api.post<{ email: string }>('/me/email/verify', { code }),
};

/* ───────────── 自助注销 ───────────── */

export const accountApi = {
  /** 注销会丢掉什么（与后台的 delete-impact 同形） */
  deleteImpact: () => api.get<DeleteImpact>('/me/delete-impact'),
  /** 删除个人数据，财务记录匿名化保留；要当前密码或通行密钥确认（面板校验）。成功后面板清掉会话 cookie */
  deleteAccount: (confirm: HolderProof) => api.post<void>('/me/delete', { confirm: true, ...confirm }),
};

/* ───────────── 通行密钥（已登录） ───────────── */

export const passkeyApi = {
  list: () => api.get<LoginMethods>('/me/passkeys'),

  /** 绑定一个通行密钥。disablePassword = 登录后引导里勾选的「以后只用通行密钥」 */
  add: async (name: string, disablePassword = false): Promise<{ id: string; name: string }> => {
    const ch = await api.post<PasskeyChallenge>('/me/passkeys/options');
    const cred = (await navigator.credentials.create({
      publicKey: creationOptions(ch.options.publicKey),
    })) as PublicKeyCredential | null;
    if (!cred) throw new DOMException('cancelled', 'NotAllowedError');
    return api.post('/me/passkeys', {
      state: ch.state,
      credential: credentialJSON(cred),
      name,
      ...(disablePassword ? { disable_password: true } : {}),
    });
  },

  /** 用本账户的通行密钥确认是本人（注销、换邮箱）：取挑战 → 设备签名 → 交给要确认的那个接口 */
  confirm: async (): Promise<HolderProof> => {
    const ch = await api.post<PasskeyChallenge>('/me/reauth/options');
    const cred = (await navigator.credentials.get({
      publicKey: requestOptions(ch.options.publicKey),
    })) as PublicKeyCredential | null;
    if (!cred) throw new DOMException('cancelled', 'NotAllowedError');
    return { passkey: { state: ch.state, credential: credentialJSON(cred) } };
  },

  rename: (id: string, name: string) => api.patch<{ id: string; name: string }>(`/me/passkeys/${id}`, { name }),
  remove: (id: string) => api.del(`/me/passkeys/${id}`),
  /** 账户自己的「只用通行密钥」开关；enabled=false 前必须有一个当前可用的通行密钥 */
  setPasswordLogin: (enabled: boolean) => api.put<LoginMethods>('/me/password-login', { enabled }),
};

/* ───────────── 商店与订单 ───────────── */

export const shopApi = {
  /** 每个周期都按「现在下单」由服务端算好价；coupon / useBalance 让服务端一起算进去 */
  get: (opts: { coupon?: string; useBalance?: boolean } = {}) =>
    api.get<Shop>(`/me/shop${qs({ coupon: opts.coupon, use_balance: opts.useBalance })}`),
};

export const orderApi = {
  /** 最近 50 笔 */
  list: () => api.get<MyOrder[]>('/me/orders'),
  /** 一次调用：金额在面板的 SQL 里算，前端从不发金额；全额抵扣时立即付款 */
  create: (body: CreateOrder) => api.post<MyOrder>('/me/orders', body),
  /** 待支付的订单会主动去支付宝查单 */
  get: (id: string) => api.get<MyOrder>(`/me/orders/${id}`),
  cancel: (id: string) => api.post<MyOrder>(`/me/orders/${id}/cancel`),
};

/* ───────────── 钱包与邀请 ───────────── */

export const walletApi = {
  balance: (opts: { before?: number; limit?: number } = {}) =>
    api.get<MyBalance>(`/me/balance${qs({ before: opts.before, limit: opts.limit })}`),
  withdrawals: () => api.get<Withdrawal[]>('/me/withdrawals'),
  /** 立即从余额扣除；不超过可提现金额 */
  /** R46：USDT 提现，网络必须是后台开着的；memo 只有 TON 用 */
  withdraw: (body: { amount_cents: number; chain: UsdtChain; address: string; memo?: string }) =>
    api.post<Withdrawal>('/me/withdrawals', body),
  cancelWithdrawal: (id: string) => api.post<Withdrawal>(`/me/withdrawals/${id}/cancel`),
};

export const inviteApi = {
  get: () => api.get<MyInvite>('/me/invite'),
  codes: () => api.get<InviteCodes>('/me/invite-codes'),
  createCode: () => api.post<void>('/me/invite-codes'),
  deleteCode: (code: string) => api.del(`/me/invite-codes/${encodeURIComponent(code)}`),
};

/* ───────────── 工单、公告、知识库 ───────────── */

export const ticketApi = {
  list: () => api.get<TicketRow[]>('/me/tickets'),
  /** 打开即标记客服回复已读 */
  get: (id: string) => api.get<TicketDetail>(`/me/tickets/${id}`),
  create: (body: NewTicket) => api.post<{ id: string }>('/me/tickets', body),
  reply: (id: string, message: string) => api.post<void>(`/me/tickets/${id}/replies`, { message }),
  close: (id: string) => api.post<void>(`/me/tickets/${id}/close`),
};

/** 条款与隐私（公开，未登录也能看）：站长没写时面板答统一的拒绝（404），页面改显示中性的缺省文案 */
export const pageApi = {
  get: (slug: 'terms' | 'privacy') => api.get<LegalPage>(`/pages/${slug}`),
};

export const contentApi = {
  announcements: () => api.get<Announcements>('/me/announcements'),
  markRead: (id: string) => api.post<void>(`/me/announcements/${id}/read`),
  help: (q?: string) => api.get<HelpList>(`/me/help${qs({ q })}`),
  article: (id: string) => api.get<HelpArticle>(`/me/help/${id}`),
};

export { ApiError, onSessionEvent } from './http';
export { brandUrl, portalUrl } from './base';
export * from './types';
