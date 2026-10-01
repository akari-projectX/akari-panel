// User-facing billing strings (zh/en), namespace "billing". TEMPORARY local
// shim until the shared i18n (spa/src/i18n, useT()) lands: at merge, move
// `billing.zh`/`billing.en` into the per-locale dictionaries and replace
// `useBillingT` with `useT("billing")` (same call shape: t(key, vars)).

export const billing = {
  zh: {
    title: "购买套餐",
    subtitle: "使用支付宝扫码付款，付款后套餐自动开通。",
    unavailable: "暂不支持在线购买，请联系管理员。",
    current: "当前套餐：{name}",
    currentExpires: "当前套餐：{name}（{date} 到期）",
    currentNoExpiry: "当前套餐：{name}（长期有效）",
    noPlans: "暂无可购买的套餐。",
    perPeriod: "¥{price} / {days} 天",
    quota: "流量 {quota}",
    unlimited: "流量不限",
    resetMonthly: "每月重置",
    resetDays: "每 {days} 天重置",
    resetNone: "不重置",
    speed: "限速 {mbps} Mbps",
    buy: "购买",
    renew: "续费",
    replace: "更换为此套餐",
    unavailableAction: "无需续费",
    confirmReplace: "购买「{name}」将替换当前套餐「{current}」，已用流量清零。继续吗？",
    creating: "正在创建订单…",
    scanTitle: "请使用支付宝扫码付款",
    amount: "金额：¥{price}",
    openAlipay: "在支付宝中打开",
    expiresIn: "{min} 分 {sec} 秒后过期",
    waiting: "等待付款…",
    paid: "付款成功，套餐已开通。",
    paidPending: "已收到付款，正在开通套餐，请稍候或联系管理员。",
    expired: "订单已过期，请重新下单。",
    cancelled: "订单已取消。",
    cancel: "取消订单",
    close: "关闭",
    qrLabel: "支付宝付款二维码",
    ordersTitle: "我的订单",
    ordersEmpty: "暂无订单。",
    colCreated: "下单时间",
    colPlan: "套餐",
    colAmount: "金额",
    colStatus: "状态",
    colPaid: "付款时间",
    continuePay: "继续付款",
    status_pending: "待付款",
    status_paid: "已付款",
    status_expired: "已过期",
    status_cancelled: "已取消",
    error: "操作失败：{msg}",
  },
  en: {
    title: "Buy a plan",
    subtitle: "Pay by scanning the QR code with Alipay; the plan activates automatically.",
    unavailable: "Online purchase is not available. Please contact the administrator.",
    current: "Current plan: {name}",
    currentExpires: "Current plan: {name} (expires {date})",
    currentNoExpiry: "Current plan: {name} (no expiry)",
    noPlans: "No plans are for sale right now.",
    perPeriod: "¥{price} / {days} days",
    quota: "{quota} traffic",
    unlimited: "Unlimited traffic",
    resetMonthly: "resets monthly",
    resetDays: "resets every {days} days",
    resetNone: "no reset",
    speed: "{mbps} Mbps",
    buy: "Buy",
    renew: "Renew",
    replace: "Switch to this plan",
    unavailableAction: "Nothing to renew",
    confirmReplace:
      "Buying “{name}” replaces your current plan “{current}” and resets your used traffic. Continue?",
    creating: "Creating the order…",
    scanTitle: "Scan with Alipay to pay",
    amount: "Amount: ¥{price}",
    openAlipay: "Open in Alipay",
    expiresIn: "Expires in {min}m {sec}s",
    waiting: "Waiting for payment…",
    paid: "Payment received. Your plan is active.",
    paidPending: "Payment received; activating your plan. Please wait or contact the administrator.",
    expired: "The order expired. Please order again.",
    cancelled: "The order was cancelled.",
    cancel: "Cancel order",
    close: "Close",
    qrLabel: "Alipay payment QR code",
    ordersTitle: "My orders",
    ordersEmpty: "No orders yet.",
    colCreated: "Ordered",
    colPlan: "Plan",
    colAmount: "Amount",
    colStatus: "Status",
    colPaid: "Paid",
    continuePay: "Continue payment",
    status_pending: "Awaiting payment",
    status_paid: "Paid",
    status_expired: "Expired",
    status_cancelled: "Cancelled",
    error: "Failed: {msg}",
  },
} as const;

export type BillingKey = keyof typeof billing.en;
export type Locale = keyof typeof billing;

// Shim locale choice: a stored choice ("akari.locale"), else the browser.
export function currentLocale(): Locale {
  try {
    const saved = localStorage.getItem("akari.locale");
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // storage unavailable: fall through
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function translate(locale: Locale, key: BillingKey, vars?: Record<string, string | number>): string {
  let s: string = billing[locale][key];
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function useBillingT() {
  const locale = currentLocale();
  return {
    locale,
    t: (key: BillingKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
  };
}
