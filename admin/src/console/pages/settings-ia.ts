// 系统设置的信息架构（2026-10 改版，proposal §3.2）：按领域分组的分区，
// 每个分区一个 URL（/settings/<id>）。旧的标签页地址重定向到新分区
// （OLD_IDS），搜索覆盖分区名、说明、旧名称与常用设置项（keywords）。
// Tile colours are icon-tile data like nav.ts (system-settings style).
import {
  ArrowRightLeft,
  Bell,
  BellRing,
  Brush,
  Cable,
  CreditCard,
  Database,
  DoorClosed,
  Download,
  Fingerprint,
  Gift,
  Globe,
  KeyRound,
  Mail,
  MailOpen,
  Radar,
  Route,
  ShieldBan,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

export type SectionId =
  | "site"
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
  /** A link to another page instead of a section. */
  href?: string;
  /** Search words: old names and the settings inside. */
  keywords: string;
};

export type SectionGroup = { zh: string; en: string; sections: Section[] };

export const SETTINGS_IA: SectionGroup[] = [
  {
    zh: "通用",
    en: "General",
    sections: [
      {
        id: "site",
        zh: "站点与品牌",
        en: "Site and branding",
        icon: Brush,
        tint: "#2563eb",
        desc: [
          "站点名称、时区、Logo、页脚与客户端下载链接。",
          "Site name, time zone, logo, footer and client downloads.",
        ],
        danger: true,
        keywords:
          "站点 品牌 名称 时区 timezone logo favicon 网站图标 页脚 条款 隐私 客户端下载 site branding name footer terms privacy downloads",
      },
      {
        id: "domains",
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
        zh: "分流规则",
        en: "Routing rules",
        icon: Route,
        tint: "#d97706",
        desc: [
          "Clash 与 sing-box 订阅里的分流规则模板与规则集地址。",
          "The routing template and rule-set URLs of Clash and sing-box subscriptions.",
        ],
        keywords: "分流规则 模板 规则集 geosite geoip 直连 代理 拒绝 routing rules rule set",
      },
    ],
  },
  {
    zh: "节点",
    en: "Nodes",
    sections: [
      {
        id: "install",
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
        zh: "更新源与验签",
        en: "Update source and signing keys",
        icon: ArrowRightLeft,
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
        zh: "邮件模板",
        en: "Mail templates",
        icon: MailOpen,
        tint: "#0891b2",
        desc: [
          "每种邮件的主题与正文（中英各一份），可编辑 HTML 源码。",
          "Subject and body of every mail (Chinese and English), HTML source optional.",
        ],
        keywords: "邮件模板 主题 正文 占位符 HTML templates",
      },
      {
        id: "notices",
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
        zh: "我的账户与通行密钥",
        en: "My account and passkeys",
        icon: KeyRound,
        tint: "#6b7280",
        desc: [
          "你自己的密码、通行密钥与登录方式（独立页面）。",
          "Your own password, passkeys and sign-in method (a page of its own).",
        ],
        href: "/account",
        keywords: "我的账户 密码 通行密钥 account password passkeys",
      },
    ],
  },
];

/** The overview's tile colour (neutral graphite, like 系统设置 in the sidebar). */
export const OVERVIEW_TINT = "#6b7280";

export const SECTIONS: Section[] = SETTINGS_IA.flatMap((g) => g.sections);

/** Old tab ids (`/settings/<tab>` before the 2026-10 redesign) → the new section. */
export const OLD_IDS: Record<string, SectionId> = {
  security: "access",
  branding: "site",
  nodes: "install",
  "block-rules": "block",
  "audit-rules": "block",
  sub: "subscription",
  "mail-template": "templates",
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
