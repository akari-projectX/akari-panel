// 系统设置的信息架构（2026-10 改版 v2，proposal-v2 §5）：8 组 22 个分区，
// 每个分区一个 URL（/settings/<id>）；原"站点与品牌"按任务拆成 站点信息 /
// 外观与品牌 / 条款与下载链接。旧的标签页地址与旧 id 重定向到新分区
// （OLD_IDS、ALIASES），搜索覆盖分区名、说明、旧名称（keywords）与分区内的
// 行标签（rows：搜到行时显示"行 ↳ 组 › 分区"）。
// Tile colours are icon-tile data like nav.ts (system-settings style).
import {
  Bell,
  BellRing,
  Brush,
  Cable,
  Clock,
  CreditCard,
  Database,
  DoorClosed,
  Download,
  Fingerprint,
  Gift,
  Globe,
  KeyRound,
  Link2,
  Mail,
  MailOpen,
  PackageCheck,
  Radar,
  Route,
  ShieldBan,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

export type SectionId =
  | "site"
  | "brand"
  | "links"
  | "domains"
  | "signup"
  | "login"
  | "cleanup"
  | "subscription"
  | "routing"
  | "install"
  | "probe"
  | "block"
  | "updates"
  | "payments"
  | "commission"
  | "mail"
  | "templates"
  | "notices"
  | "alerts"
  | "access"
  | "retention"
  | "account";

export type Section = {
  id: SectionId;
  zh: string;
  en: string;
  icon: LucideIcon;
  tint: string;
  /** One line under the title (and on the overview). */
  desc: [string, string];
  /** Owner-only changes (R47). */
  owner?: boolean;
  /** Has a 危险操作 area. */
  danger?: boolean;
  /** A page of its own instead of a section body (the full-width template editor). */
  href?: string;
  /** Where it lived before the 2026-10 redesign (the overview's "从哪里搬来"). */
  from: [string, string];
  /** Search words: old names and the settings inside. */
  keywords: string;
  /** The labels of the rows inside (search finds a row and names its section). */
  rows: [string, string][];
  /** The audit action (exact, or a prefix ending in ".") of the section's last change. */
  audit?: string;
};

export type SectionGroup = { zh: string; en: string; sections: Section[] };

export const SETTINGS_IA: SectionGroup[] = [
  {
    zh: "通用",
    en: "General",
    sections: [
      {
        id: "site",
        rows: [
          ["站点名称", "Site name"],
          ["站点时区", "Site time zone"],
        ],
        audit: "settings.site.update",
        from: ["站点 tab 的站点卡", "the Site tab's site card"],
        zh: "站点信息",
        en: "Site",
        icon: Clock,
        tint: "#2563eb",
        desc: [
          "站点名称与时区。时区决定流量明细、套餐月重置、仪表盘与导出的日界。",
          "Site name and time zone. The time zone cuts the days of traffic history, monthly resets, the dashboard and exports.",
        ],
        danger: true,
        keywords: "站点 名称 时区 timezone site name",
      },
      {
        id: "brand",
        rows: [
          ["Logo", "Logo"],
          ["网站图标", "Favicon"],
          ["页脚文字", "Footer text"],
          ["页脚链接", "Footer links"],
        ],
        audit: "settings.branding.update",
        from: ["品牌 tab 的 Logo、网站图标与页脚", "the Branding tab's logo, favicon and footer"],
        zh: "外观与品牌",
        en: "Appearance and branding",
        icon: Brush,
        tint: "#8b5cf6",
        desc: [
          "Logo、网站图标与页脚。上传和删除图片立即生效；文字修改走保存栏。",
          "Logo, favicon and footer. Image uploads and removals apply at once; text goes through the save bar.",
        ],
        keywords: "品牌 logo favicon 网站图标 页脚 branding footer",
      },
      {
        id: "links",
        rows: [
          ["服务条款", "Terms of service"],
          ["隐私政策", "Privacy policy"],
          ["Windows 客户端", "Windows client"],
          ["macOS 客户端", "macOS client"],
          ["Linux 客户端", "Linux client"],
          ["Android 客户端", "Android client"],
          ["iOS 客户端", "iOS client"],
          ["鸿蒙客户端", "HarmonyOS client"],
        ],
        audit: "settings.branding.update",
        from: ["品牌 tab 的条款、隐私与客户端下载链接", "the Branding tab's terms, privacy and client downloads"],
        zh: "条款与下载链接",
        en: "Terms and downloads",
        icon: Link2,
        tint: "#0ea5e9",
        desc: [
          "注册页引用的服务条款与隐私政策，以及门户「下载客户端」里的各平台链接。",
          "The terms and privacy policy the sign-up page links to, and the per-platform links of the portal's client downloads.",
        ],
        keywords: "条款 隐私 服务条款 隐私政策 客户端下载 下载链接 terms privacy downloads client",
      },
      {
        id: "domains",
        rows: [
          ["主域名", "Main domains"],
          ["订阅域名", "Subscription domains"],
          ["节点通信域名", "Node domains"],
          ["首选域名", "Preferred domain"],
          ["DNS 检测", "DNS check"],
          ["每个用户随机分配订阅域名", "A random subscription domain per user"],
          ["信任 Cloudflare", "Trust Cloudflare"],
          ["Cloudflare 网段", "Cloudflare ranges"],
          ["节点通信证书域名", "gRPC certificate names"],
          ["通行密钥中心域名", "Passkey centre"],
          ["RP ID", "RP ID"],
        ],
        audit: "settings.update",
        from: [
          "站点 tab 的域名、通行密钥中心与证书域名 + 安全 tab 的 Cloudflare 网段",
          "the Site tab's domains, passkey centre and certificate names + the Security tab's Cloudflare ranges",
        ],
        zh: "域名与证书",
        en: "Domains and certificates",
        icon: Globe,
        tint: "#0891b2",
        desc: [
          "门户、订阅、节点通信各用哪些域名；Cloudflare、证书域名与通行密钥中心域名。",
          "Which domains serve the portal, subscriptions and nodes; Cloudflare, certificate names and the passkey centre.",
        ],
        danger: true,
        keywords:
          "站点与域名 主域名 订阅域名 节点通信域名 DNS 首选 Cloudflare CF 网段 证书 SAN 通行密钥中心域名 passkey domains certificate",
      },
    ],
  },
  {
    zh: "用户与登录",
    en: "Users and sign-in",
    sections: [
      {
        id: "signup",
        rows: [
          ["开放注册", "Open sign-up"],
          ["注册需要验证邮箱", "Verify email on sign-up"],
          ["允许用通行密钥注册", "Sign up with a passkey"],
          ["允许注册的邮箱域名", "Allowed email domains"],
          ["注册需要邀请码", "Invite code required"],
          ["邀请码只能使用一次", "Single-use invite codes"],
          ["每人最多邀请码", "Invite codes per user"],
          ["试用套餐", "Trial plan"],
          ["试用天数", "Trial days"],
          ["找回密码", "Password reset"],
        ],
        audit: "settings.signup.update",
        from: ["注册 tab 的注册卡", "the Sign-up tab's registration card"],
        zh: "注册与邀请",
        en: "Sign-up and invites",
        icon: UserPlus,
        tint: "#16a34a",
        desc: [
          "谁可以注册、是否验证邮箱与需要邀请码、新用户试用、找回密码。",
          "Who can sign up, email verification and invite codes, trials, password reset.",
        ],
        keywords:
          "注册与人机验证 开放注册 邮箱验证 邀请码 通行密钥注册 白名单 试用 找回密码 sign-up register invite trial reset",
      },
      {
        id: "login",
        rows: [
          ["密码登录后引导绑定通行密钥", "Suggest a passkey after password sign-in"],
          ["用户只能用通行密钥登录", "Users sign in with passkeys only"],
          ["Turnstile 站点密钥", "Turnstile site key"],
          ["Turnstile 密钥", "Turnstile secret"],
          ["需要人机验证的表单", "Forms with bot checks"],
          ["蜜罐字段", "Honeypot field"],
          ["最短提交时间", "Minimum submit time"],
          ["管理员只能用通行密钥登录", "Admins sign in with passkeys only"],
        ],
        audit: "settings.auth.update",
        from: [
          "安全 tab 的登录方式 + 注册 tab 的人机验证",
          "the Security tab's sign-in methods + the Sign-up tab's bot protection",
        ],
        zh: "登录与人机验证",
        en: "Sign-in and bot protection",
        icon: Fingerprint,
        tint: "#7c3aed",
        desc: [
          "密码与通行密钥的登录策略；Turnstile、蜜罐与最短提交时间。",
          "Password and passkey policies; Turnstile, honeypot and minimum submit time.",
        ],
        danger: true,
        keywords:
          "后台与登录安全 人机验证 登录方式 通行密钥 仅通行密钥 Turnstile 蜜罐 最短提交时间 passkey captcha honeypot",
      },
      {
        id: "cleanup",
        rows: [
          ["从未使用的天数", "Days never used"],
          ["删除前邮件提醒", "Warning mail before deletion"],
          ["提醒后等待天数", "Grace days after the warning"],
          ["自动清理", "Automatic cleanup"],
          ["上次运行", "Last run"],
        ],
        audit: "settings.cleanup.update",
        from: ["账号清理 tab", "the Account cleanup tab"],
        zh: "账号清理",
        en: "Account cleanup",
        icon: UserMinus,
        tint: "#64748b",
        desc: [
          "自动删除从未使用过的账号（默认关）：天数、提醒邮件与等待天数。",
          "Delete never-used accounts automatically (off by default): days, warning mail and grace days.",
        ],
        danger: true,
        keywords: "账号清理 从未使用 自动删除 提醒 cleanup never used",
      },
    ],
  },
  {
    zh: "订阅",
    en: "Subscriptions",
    sections: [
      {
        id: "subscription",
        rows: [
          ["Clash / mihomo", "Clash / mihomo"],
          ["sing-box", "sing-box"],
          ["通用链接", "Universal links"],
          ["一键导入", "Import buttons"],
          ["Shadowrocket", "Shadowrocket"],
          ["Stash", "Stash"],
          ["Hiddify", "Hiddify"],
          ["线路名显示倍率", "Multipliers in line names"],
          ["订阅路径", "Subscription path"],
        ],
        audit: "settings.subscription.update",
        from: [
          "订阅 tab 的格式、导入按钮与线路名 + 安全 tab 的订阅路径",
          "the Subscriptions tab's formats, import buttons and line names + the Security tab's subscription path",
        ],
        zh: "订阅链接与格式",
        en: "Subscription links and formats",
        icon: Cable,
        tint: "#ea580c",
        desc: [
          "订阅格式、门户一键导入按钮、线路名倍率与订阅路径。",
          "Subscription formats, portal import buttons, multipliers in line names and the subscription path.",
        ],
        danger: true,
        keywords:
          "订阅 订阅路径 格式 Clash mihomo sing-box 通用链接 一键导入 Stash Shadowrocket Hiddify 倍率 线路名 subscription path formats import",
      },
      {
        id: "routing",
        rows: [
          ["模式（规则分流 / 全局代理）", "Mode (rules / global)"],
          ["拦截与直连", "Blocked and direct"],
          ["服务分流", "Services"],
          ["首选与备用线路", "Primary and backup lines"],
          ["远程规则集", "Remote rule-sets"],
          ["默认代理", "Default proxy"],
          ["测试网址", "Test an address"],
          ["DNS", "DNS"],
          ["标签组", "Tag groups"],
          ["规则库地址", "Rule list URLs"],
          ["恢复推荐设置", "Restore the recommended routing"],
        ],
        audit: "settings.subscription.update",
        from: ["订阅 tab 的分流规则", "the Subscriptions tab's routing rules"],
        zh: "分流规则",
        en: "Routing rules",
        icon: Route,
        tint: "#d97706",
        desc: [
          "Clash 与 sing-box 订阅的分流：拦截、直连、服务分流的首选与备用线路、默认代理与 DNS。",
          "Routing in Clash and sing-box subscriptions: blocked, direct, services with primary and backup lines, the default proxy and DNS.",
        ],
        keywords:
          "分流规则 服务分流 线路 首选 备用 容灾 地区组 标签组 规则集 geosite geoip 直连 拦截 默认代理 全局代理 DNS Fake-IP routing services failover rule set",
      },
    ],
  },
  {
    zh: "节点",
    en: "Nodes",
    sections: [
      {
        id: "install",
        rows: [
          ["公钥钉扎", "Pinned key"],
          ["备用下载地址", "Fallback download"],
          ["ACME 目录", "ACME directory"],
          ["ACME 邮箱", "ACME email"],
          ["撤权方式", "How access is removed"],
        ],
        audit: "settings.nodes.update",
        from: ["节点 tab 的安装命令与证书", "the Nodes tab's install command and certificates"],
        zh: "安装与证书",
        en: "Install and certificates",
        icon: Download,
        tint: "#0284c7",
        desc: [
          "节点安装命令的公钥钉扎与备用下载、节点证书（ACME）与撤权方式。",
          "Install command pinning and fallback download, node certificates (ACME) and how access is removed.",
        ],
        keywords: "节点通信与测速 安装命令 公钥钉扎 备用下载 ACME 撤权方式 install pin fallback acme remove mode",
      },
      {
        id: "probe",
        rows: [
          ["测速间隔", "Probe interval"],
          ["测速地址", "Probe URLs"],
          ["面板 TCP 探测", "Panel TCP probe"],
        ],
        audit: "settings.probe.update",
        from: ["节点 tab 的延迟测试", "the Nodes tab's latency probes"],
        zh: "测速与健康检查",
        en: "Probes and health checks",
        icon: Radar,
        tint: "#0d9488",
        desc: [
          "节点测速间隔与地址、面板 TCP 测速（它同时决定中转入口的健康检查）。",
          "Probe interval and URLs, the panel TCP probe (it also runs the relay entrance health checks).",
        ],
        danger: true,
        keywords: "测速 延迟 间隔 测速地址 TCP 健康检查 中转 probe latency interval health",
      },
      {
        id: "block",
        rows: [
          ["内置规则集", "Built-in rule sets"],
          ["自定义规则集", "Custom rule sets"],
          ["近 7 天拦截", "Blocks in 7 days"],
        ],
        audit: "block_rule.",
        from: [
          "审计规则 tab（改名，避免与审计日志混淆）",
          "the Audit rules tab (renamed so it is not mistaken for the audit log)",
        ],
        zh: "出站拦截规则",
        en: "Outbound block rules",
        icon: ShieldBan,
        tint: "#dc2626",
        desc: [
          "节点拦截的出站目标（内置与自定义规则集）。只统计次数，不记录访问明细。",
          "Outbound targets the nodes block (built-in and custom rule sets). Counts only, never browsing.",
        ],
        danger: true,
        keywords: "审计规则 拦截 规则集 域名 IP 协议 bittorrent block rules",
      },
      {
        id: "updates",
        rows: [
          ["发布源地址", "Release source"],
          ["自动检查更新", "Check automatically"],
          ["内置官方公钥", "Built-in official key"],
          ["额外信任的发布公钥", "Extra release keys"],
        ],
        audit: "agent_update.settings.update",
        from: ["更新页的设置 + 安全 tab 的发布公钥", "the Updates page's settings + the Security tab's release keys"],
        zh: "更新源与验签",
        en: "Update source and signing keys",
        icon: PackageCheck,
        tint: "#4f46e5",
        desc: [
          "agent 发布源、自动检查更新与信任的发布公钥。",
          "The agent release source, automatic update checks and trusted release keys.",
        ],
        danger: true,
        keywords: "更新 发布源 自动检查 发布公钥 验签 release source auto check keys",
      },
    ],
  },
  {
    zh: "收款与返利",
    en: "Payments and commissions",
    sections: [
      {
        id: "payments",
        rows: [
          ["收款渠道", "Payment channels"],
          ["支付宝当面付", "Alipay face-to-face"],
          ["沙箱", "Sandbox"],
          ["支付通知地址", "Payment notify URL"],
          ["允许原路退款", "Refund to the original method"],
        ],
        audit: "payment_method.",
        from: ["支付 tab", "the Payments tab"],
        zh: "支付方式",
        en: "Payment methods",
        icon: CreditCard,
        tint: "#2563eb",
        desc: [
          "收款渠道、显示顺序、启停与测试；密钥只写不读。",
          "Payment channels, their order, enabling and tests; keys are write-only.",
        ],
        owner: true,
        danger: true,
        keywords: "支付 支付宝 当面付 渠道 密钥 通知地址 原路退款 payments alipay refund",
      },
      {
        id: "commission",
        rows: [
          ["启用返利", "Commissions on"],
          ["返利比例", "Commission rate"],
          ["仅首单", "First order only"],
          ["冻结天数", "Hold days"],
          ["最低提现金额", "Minimum withdrawal"],
          ["USDT 网络", "USDT networks"],
          ["参考汇率", "Reference rate"],
        ],
        audit: "commission.settings.update",
        from: ["资金页的邀请返利设置", "the Finance page's commission settings"],
        zh: "邀请返利",
        en: "Invite commissions",
        icon: Gift,
        tint: "#db2777",
        desc: [
          "返利比例、首单、冻结天数、最低提现与 USDT 网络。",
          "Commission rate, first order only, hold days, minimum withdrawal and USDT networks.",
        ],
        keywords: "资金 返利 邀请 比例 冻结 提现 USDT 汇率 commission invite withdrawal",
      },
    ],
  },
  {
    zh: "通知",
    en: "Notifications",
    sections: [
      {
        id: "mail",
        rows: [
          ["SMTP", "SMTP"],
          ["Resend", "Resend"],
          ["发件地址", "Sender address"],
          ["发件人名称", "Sender name"],
          ["测试发信", "Test mail"],
        ],
        audit: "settings.mail.update",
        from: ["邮件 tab 的发信方式与测试发信", "the Mail tab's transport and test mail"],
        zh: "发信通道",
        en: "Mail transport",
        icon: Mail,
        tint: "#0ea5e9",
        desc: [
          "SMTP 或 Resend、发件地址与名称；测试发信并逐步诊断。",
          "SMTP or Resend, the sender; send a test with a step-by-step diagnosis.",
        ],
        keywords: "邮件 发信 SMTP Resend 发件地址 测试发信 诊断 mail transport test",
      },
      {
        id: "templates",
        rows: [
          ["支付回执", "Payment receipt"],
          ["验证码", "Verification code"],
          ["到期提醒", "Expiry reminder"],
        ],
        audit: "settings.mail_template.",
        from: ["邮件模板 tab", "the Mail templates tab"],
        zh: "邮件模板",
        en: "Mail templates",
        icon: MailOpen,
        tint: "#0891b2",
        desc: [
          "每种邮件的主题与正文（中英各一份），可编辑 HTML 源码。",
          "Subject and body of every mail (Chinese and English), HTML source optional.",
        ],
        href: "/settings/templates",
        keywords: "邮件模板 主题 正文 占位符 HTML templates",
      },
      {
        id: "notices",
        rows: [
          ["支付回执", "Payment receipts"],
          ["到期前提醒", "Expiry reminder"],
          ["提前天数", "Days before"],
          ["已到期", "Expired"],
          ["流量提醒", "Traffic warnings"],
          ["退款通知", "Refund notices"],
        ],
        audit: "settings.mail.update",
        from: ["邮件 tab 里的通知开关", "the notice switches in the Mail tab"],
        zh: "通知种类",
        en: "Notices",
        icon: Bell,
        tint: "#f59e0b",
        desc: [
          "给用户发哪些通知邮件：回执、到期提醒、流量、退款。",
          "Which notices users get: receipts, expiry reminders, traffic, refunds.",
        ],
        keywords: "通知 回执 到期提醒 流量 退款 notices receipt expiry quota refund",
      },
      {
        id: "alerts",
        rows: [
          ["离线", "Offline"],
          ["CPU", "CPU"],
          ["内存", "Memory"],
          ["磁盘", "Disk"],
          ["证书剩余天数", "Certificate days left"],
          ["冷却", "Cooldown"],
          ["恢复时通知", "Notify on recovery"],
          ["Telegram", "Telegram"],
          ["Webhook", "Webhook"],
          ["告警邮件收件人", "Alert mail recipients"],
        ],
        audit: "alerts.settings.update",
        from: ["告警页的设置 tab", "the Alerts page's settings tab"],
        zh: "告警通道与阈值",
        en: "Alert channels and thresholds",
        icon: BellRing,
        tint: "#ef4444",
        desc: [
          "服务器告警的阈值，以及 Telegram、签名 Webhook 与邮件通道。",
          "Server alert thresholds, and the Telegram, signed webhook and mail channels.",
        ],
        keywords: "告警设置 阈值 离线 CPU 内存 磁盘 证书 冷却 Telegram Webhook 邮件 alerts thresholds",
      },
    ],
  },
  {
    zh: "管理与安全",
    en: "Administration and security",
    sections: [
      {
        id: "access",
        rows: [
          ["后台地址", "Console address"],
          ["轮换前缀", "Rotate the prefix"],
          ["IP 白名单", "IP allowlist"],
          ["你的地址", "Your address"],
        ],
        audit: "settings.admin_allowlist.update",
        from: ["安全 tab 的后台地址", "the Security tab's console address"],
        zh: "后台入口",
        en: "Console address",
        icon: DoorClosed,
        tint: "#334155",
        desc: [
          "后台的秘密前缀（打码显示）、轮换前缀与 IP 白名单。",
          "The console's secret prefix (masked), prefix rotation and the IP allowlist.",
        ],
        owner: true,
        danger: true,
        keywords: "后台与登录安全 后台地址 前缀 轮换 白名单 IP console prefix allowlist",
      },
      {
        id: "retention",
        rows: [
          ["审计日志保留", "Audit log retention"],
          ["流量明细保留", "Traffic history retention"],
          ["已删除用户的数据", "Deleted users' data"],
        ],
        audit: "settings.security.update",
        from: ["安全 tab 的「安全与数据保留」", "the Security tab's security and retention card"],
        zh: "数据保留",
        en: "Data retention",
        icon: Database,
        tint: "#475569",
        desc: ["审计日志与流量明细保留多少天。", "How long the audit log and traffic history are kept."],
        danger: true,
        keywords: "安全 保留 审计日志 流量明细 retention audit traffic",
      },
      {
        id: "account",
        rows: [
          ["修改密码", "Change password"],
          ["通行密钥", "Passkeys"],
          ["仅通行密钥登录", "Passkey-only sign-in"],
        ],
        from: ["我的账户页（保留独立页面，这里只放入口）", "the My account page (still its own page; linked here)"],
        zh: "我的账户与通行密钥",
        en: "My account and passkeys",
        icon: KeyRound,
        tint: "#6b7280",
        desc: [
          "你自己的密码、通行密钥与登录方式（独立页面）。",
          "Your own password, passkeys and sign-in method (a page of its own).",
        ],
        keywords: "我的账户 密码 通行密钥 account password passkeys",
      },
    ],
  },
];

/** Tiles of the payment kinds (brand colour and glyph); unknown kinds get a card icon. */
export const PAY_TILES: Record<string, { tint: string; glyph: string }> = {
  alipay_f2f: { tint: "#1677ff", glyph: "支" },
  epay: { tint: "#f97316", glyph: "易" },
  coinpayments: { tint: "#0f766e", glyph: "CP" },
  coinbase: { tint: "#0052ff", glyph: "C" },
};
export const PAY_TILE_DEFAULT = "#2563eb";

/** The overview's tile colour (neutral graphite, like 系统设置 in the sidebar). */
export const OVERVIEW_TINT = "#6b7280";

export const SECTIONS: Section[] = SETTINGS_IA.flatMap((g) => g.sections);

/** The group a section belongs to. */
export const groupOf = (id: SectionId): SectionGroup => SETTINGS_IA.find((g) => g.sections.some((s) => s.id === id))!;

export type SearchHit = { section: Section; row?: [string, string] };

/**
 * The settings search: a section whose name, description, old place or
 * keywords match, then every row label that matches ("行 ↳ 组 › 分区").
 */
export function searchSettings(q: string): SearchHit[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const out: SearchHit[] = [];
  for (const s of SECTIONS) {
    const hay = `${s.zh} ${s.en} ${s.keywords} ${s.desc.join(" ")} ${s.from.join(" ")}`.toLowerCase();
    if (hay.includes(t)) out.push({ section: s });
    for (const r of s.rows)
      if (`${r[0]} ${r[1]}`.toLowerCase().includes(t) && r[0] !== s.zh) out.push({ section: s, row: r });
  }
  return out;
}

/** Old tab ids (`/settings/<tab>` before the 2026-10 redesign) and aliases → the section. */
export const OLD_IDS: Record<string, SectionId> = {
  security: "access",
  branding: "brand",
  nodes: "install",
  "block-rules": "block",
  "audit-rules": "block",
  sub: "subscription",
  "mail-template": "templates",
  // The v2 design's ids for two sections.
  notify: "notices",
  passkeys: "account",
};

/** Things that moved out of the settings: search finds them and points there. */
export const MOVED_OUT: { zh: string; en: string; to: string; where: [string, string]; keywords: string }[] = [
  {
    zh: "发件箱",
    en: "Outbox",
    to: "/status?mail=dead",
    where: ["已移到 系统状态 → 邮件队列", "Moved to System status → mail queue"],
    keywords: "发件箱 失败邮件 死信 重试 邮件队列 outbox dead letters mail queue",
  },
];
