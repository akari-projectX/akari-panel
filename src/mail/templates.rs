//! Email templates (W15; editable since Ops): every mail the panel sends,
//! in Chinese and English (the recipient's `users.locale`; the request's
//! locale before an account exists).
//!
//! A template is a **subject line** and a **plain-text body** with
//! `{placeholders}`; the body's blank-line-separated paragraphs become
//! `<p>`s of a simple HTML part with inline styles only — no remote assets
//! (images, fonts, trackers), no scripts. Every interpolated value is
//! HTML-escaped in the HTML part (values that are HTML by construction —
//! the sanitized announcement body — are rendered by `markdown.rs`);
//! subjects never carry user-controlled text except the site name.
//!
//! The built-in defaults live in `defaults()`; an admin's override of a
//! (kind, locale) is stored in `mail_templates` (`mail::overrides`) and
//! rendered by the same `render_custom`. `spec(kind)` is the placeholder
//! whitelist: `validate` refuses unknown placeholders and missing required
//! ones, so an edited template can never drop the verification code or the
//! reset link. A paragraph whose placeholders are all empty (an optional
//! link, no discount lines) is dropped; a paragraph that is exactly one
//! placeholder renders in that value's style (code box, button link,
//! block of HTML).

use chrono::{DateTime, Utc};

use crate::auth::{ApiError, bad_request};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    Zh,
    En,
}

impl Locale {
    /// "en" → English; anything else → Chinese (the panel's default).
    pub fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("en") || s.to_ascii_lowercase().starts_with("en-") {
            Locale::En
        } else {
            Locale::Zh
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Locale::Zh => "zh",
            Locale::En => "en",
        }
    }
}

/// What to send. `outbox_kind` is the `mail_outbox.kind` value.
#[derive(Debug, Clone)]
pub enum Template {
    RegisterCode {
        code: String,
        minutes: i64,
    },
    /// A registration code was requested for an address that already has
    /// an account (no oracle in the API: the owner learns it by mail).
    RegisterExists {
        reset_enabled: bool,
        login_url: Option<String>,
    },
    EmailCode {
        code: String,
        minutes: i64,
    },
    /// The one-time code of a passkey-only account's password fallback
    /// sign-in (sent to its verified address).
    LoginCode {
        code: String,
        minutes: i64,
    },
    PasswordReset {
        link: String,
        minutes: i64,
    },
    OrderPaid {
        order_no: String,
        plan_name: String,
        /// The order's money split (W16): list price, coupon discount,
        /// plan-switch credit, balance used, and the rest paid at the
        /// gateway (`orders.amount_cents`).
        money: OrderMoney,
        paid_at: DateTime<Utc>,
        expires_at: Option<DateTime<Utc>>,
    },
    ExpirySoon {
        expires_at: DateTime<Utc>,
        portal_url: Option<String>,
    },
    Expired {
        expires_at: DateTime<Utc>,
        portal_url: Option<String>,
    },
    Quota {
        percent: u8,
        used_bytes: i64,
        limit_bytes: i64,
        portal_url: Option<String>,
    },
    Test,
    /// W17: staff answered the customer's ticket. `subject` is the
    /// customer's own text: body only, never the mail subject.
    TicketReply {
        subject: String,
        portal_url: Option<String>,
    },
    /// W17: a customer opened a ticket (to admins; Chinese console).
    TicketNew {
        subject: String,
        user_email: String,
        category: String,
        console_url: Option<String>,
    },
    /// W17: a node alert (to the alert recipients; text rendered by
    /// `alerts::channels::Message`, Chinese like the console).
    NodeAlert {
        title: String,
        text: String,
    },
    /// Ops: a notice an admin sends to users in bulk (batch action
    /// `send_email`). The admin's text, paragraphs by blank line; same in
    /// both locales (the admin writes the language they want).
    AdminNotice {
        subject: String,
        body: String,
    },
    /// Ops: an announcement mailed to its audience. `body_md` is the safe
    /// Markdown subset (rendered by `markdown.rs` for the HTML part).
    Announcement {
        title: String,
        body_md: String,
        portal_url: Option<String>,
    },
    /// Phase A PR ①: an order was refunded — where the money went and what
    /// happened to the subscription.
    Refund {
        order_no: String,
        plan_name: String,
        /// Credited to the account balance.
        to_balance_cents: i64,
        /// Refunded through the payment provider (outside the panel).
        external_cents: i64,
        plan: RefundPlan,
        portal_url: Option<String>,
    },
    /// Audit batch 2, P2-1: the account's sign-in security changed (to the
    /// account's verified address). `ip` = the client address of the
    /// change; None for an administrator's action (their address is not
    /// the user's business).
    SecurityNotice {
        event: SecurityEvent,
        at: DateTime<Utc>,
        ip: Option<String>,
        portal_url: Option<String>,
    },
}

/// What changed about an account's sign-in security (audit batch 2, P2-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecurityEvent {
    PasskeyAdded,
    PasskeyDeleted,
    PasswordLoginDisabled,
    PasswordLoginEnabled,
    /// Sent to the OLD verified address.
    EmailChanged,
    PasswordChanged,
    /// An administrator (or the server's operator) deleted every passkey
    /// and switched the password login back on.
    LoginMethodReset,
    /// A passkey-only account signed in with its password and an emailed
    /// code (passkeys unusable).
    PasskeyFallbackLogin,
}

impl SecurityEvent {
    /// The one-sentence description in the mail.
    pub fn text(self, zh: bool) -> &'static str {
        match (self, zh) {
            (Self::PasskeyAdded, true) => "你的账号添加了一个通行密钥。",
            (Self::PasskeyAdded, false) => "A passkey was added to your account.",
            (Self::PasskeyDeleted, true) => "你的账号删除了一个通行密钥。",
            (Self::PasskeyDeleted, false) => "A passkey was removed from your account.",
            (Self::PasswordLoginDisabled, true) => "你的账号已关闭密码登录（仅限通行密钥）。",
            (Self::PasswordLoginDisabled, false) => {
                "Password sign-in was switched off for your account (passkeys only)."
            }
            (Self::PasswordLoginEnabled, true) => "你的账号已重新开启密码登录。",
            (Self::PasswordLoginEnabled, false) => {
                "Password sign-in was switched back on for your account."
            }
            (Self::EmailChanged, true) => {
                "你的账号登录邮箱已更换为另一个地址（本邮件发给旧地址）。"
            }
            (Self::EmailChanged, false) => {
                "The sign-in email of your account was changed to another address (this notice goes to the old one)."
            }
            (Self::PasswordChanged, true) => "你的账号密码已被修改。",
            (Self::PasswordChanged, false) => "The password of your account was changed.",
            (Self::LoginMethodReset, true) => {
                "管理员重置了你的登录方式：所有通行密钥已删除，密码登录已重新开启。"
            }
            (Self::PasskeyFallbackLogin, true) => {
                "你的账号刚刚用密码 + 邮箱验证码登录（该账号设为仅通行密钥）。"
            }
            (Self::PasskeyFallbackLogin, false) => {
                "Your account just signed in with its password and an emailed code (it is set to passkey-only)."
            }
            (Self::LoginMethodReset, false) => {
                "An administrator reset your sign-in method: every passkey was removed and password sign-in is on again."
            }
        }
    }
}

/// What a refund did to the subscription (the mail's plan line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefundPlan {
    /// Money only (reset pack, kept plan, a subscription no longer active).
    Unchanged,
    /// The order had not granted the plan.
    NotGranted,
    /// The subscription the order created ended.
    Cancelled,
    /// The renewal was taken back: the new expiry.
    RolledBack { expires_at: DateTime<Utc> },
    /// The plan before the switch is back.
    Restored {
        plan_name: String,
        expires_at: Option<DateTime<Utc>>,
    },
}

/// Every template kind (= `mail_outbox.kind` / `mail_templates.kind`).
pub const KINDS: [&str; 18] = [
    "register_code",
    "register_exists",
    "email_code",
    "password_reset",
    "order_paid",
    "expiry_soon",
    "expired",
    "quota_80",
    "quota_100",
    "test",
    "ticket_reply",
    "ticket_new",
    "node_alert",
    "announcement",
    "admin_notice",
    "refund",
    "security_notice",
    "login_code",
];

impl Template {
    pub fn outbox_kind(&self) -> &'static str {
        match self {
            Template::RegisterCode { .. } => "register_code",
            Template::RegisterExists { .. } => "register_exists",
            Template::EmailCode { .. } => "email_code",
            Template::LoginCode { .. } => "login_code",
            Template::PasswordReset { .. } => "password_reset",
            Template::OrderPaid { .. } => "order_paid",
            Template::ExpirySoon { .. } => "expiry_soon",
            Template::Expired { .. } => "expired",
            Template::Quota { percent, .. } if *percent >= 100 => "quota_100",
            Template::Quota { .. } => "quota_80",
            Template::Test => "test",
            Template::TicketReply { .. } => "ticket_reply",
            Template::TicketNew { .. } => "ticket_new",
            Template::NodeAlert { .. } => "node_alert",
            Template::AdminNotice { .. } => "admin_notice",
            Template::Announcement { .. } => "announcement",
            Template::Refund { .. } => "refund",
            Template::SecurityNotice { .. } => "security_notice",
        }
    }

    /// Sample values of a kind (the editor's preview and test mail).
    pub fn sample(kind: &str) -> Option<Template> {
        let t = DateTime::parse_from_rfc3339("2026-10-02T08:30:00Z")
            .ok()?
            .with_timezone(&Utc);
        let portal = Some("https://panel.example".to_string());
        Some(match kind {
            "register_code" => Template::RegisterCode {
                code: "123456".into(),
                minutes: 10,
            },
            "register_exists" => Template::RegisterExists {
                reset_enabled: true,
                login_url: portal,
            },
            "email_code" => Template::EmailCode {
                code: "123456".into(),
                minutes: 10,
            },
            "login_code" => Template::LoginCode {
                code: "123456".into(),
                minutes: 10,
            },
            "password_reset" => Template::PasswordReset {
                link: "https://panel.example/reset#token=example".into(),
                minutes: 30,
            },
            "order_paid" => Template::OrderPaid {
                order_no: "AK20261002EXAMPLE".into(),
                plan_name: "Pro".into(),
                money: OrderMoney {
                    list_cents: 2000,
                    discount_cents: 500,
                    credit_cents: 0,
                    balance_cents: 266,
                    paid_cents: 1234,
                },
                paid_at: t,
                expires_at: Some(t + chrono::Duration::days(30)),
            },
            "expiry_soon" => Template::ExpirySoon {
                expires_at: t,
                portal_url: portal,
            },
            "expired" => Template::Expired {
                expires_at: t,
                portal_url: portal,
            },
            "quota_80" => Template::Quota {
                percent: 80,
                used_bytes: 80 << 30,
                limit_bytes: 100 << 30,
                portal_url: portal,
            },
            "quota_100" => Template::Quota {
                percent: 100,
                used_bytes: 100 << 30,
                limit_bytes: 100 << 30,
                portal_url: portal,
            },
            "test" => Template::Test,
            "ticket_reply" => Template::TicketReply {
                subject: "节点连不上 / Cannot connect".into(),
                portal_url: portal,
            },
            "ticket_new" => Template::TicketNew {
                subject: "节点连不上".into(),
                user_email: "alice@example.com".into(),
                category: "technical".into(),
                console_url: Some("https://panel.example/prefix/admin".into()),
            },
            "node_alert" => Template::NodeAlert {
                title: "[告警] hk-1：节点离线".into(),
                text: "[告警] hk-1：节点离线\n节点：hk-1\n情况：离线 6 分钟".into(),
            },
            "admin_notice" => Template::AdminNotice {
                subject: "维护通知 / Maintenance".into(),
                body: "今晚 23:00 维护约 30 分钟。\n\nMaintenance tonight at 23:00 for about 30 minutes."
                    .into(),
            },
            "announcement" => Template::Announcement {
                title: "系统维护通知 / Maintenance".into(),
                body_md: "节点将于 **周六 02:00–04:00** 维护。\n\nNodes will be maintained on Saturday 02:00–04:00.".into(),
                portal_url: portal,
            },
            "refund" => Template::Refund {
                order_no: "AK20261002EXAMPLE".into(),
                plan_name: "Pro".into(),
                to_balance_cents: 266,
                external_cents: 1234,
                plan: RefundPlan::Cancelled,
                portal_url: portal,
            },
            "security_notice" => Template::SecurityNotice {
                event: SecurityEvent::PasskeyAdded,
                at: t,
                ip: Some("203.0.113.7".into()),
                portal_url: portal,
            },
            _ => return None,
        })
    }
}

/// How a paid order's list price was covered (all integer fen).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OrderMoney {
    pub list_cents: i64,
    pub discount_cents: i64,
    pub credit_cents: i64,
    pub balance_cents: i64,
    pub paid_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// HTML-escape (text nodes and double-quoted attributes).
pub fn esc(s: &str) -> String {
    crate::markdown::esc(s)
}

/// Binary units like the portal (`humanBytes`): KiB/MiB/GiB/TiB.
pub fn human_bytes(b: i64) -> String {
    let b = b.max(0) as f64;
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = b;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} B", b as i64)
    } else {
        format!("{v:.2} {}", UNITS[i])
    }
}

fn when(t: &DateTime<Utc>) -> String {
    t.format("%Y-%m-%d %H:%M UTC").to_string()
}

fn yuan(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let c = cents.unsigned_abs();
    format!("{sign}{}.{:02}", c / 100, c % 100)
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/// One placeholder of a kind: name and what it is (Chinese, for the
/// editor).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Placeholder {
    pub name: &'static str,
    pub description: &'static str,
}

const fn ph(name: &'static str, description: &'static str) -> Placeholder {
    Placeholder { name, description }
}

/// Placeholders every kind has.
pub const COMMON: [Placeholder; 1] = [ph("site", "站点名称")];

const CODE_PH: [Placeholder; 2] = [ph("code", "验证码"), ph("minutes", "有效分钟数")];
const REGISTER_EXISTS_PH: [Placeholder; 2] = [
    ph("reset_hint", "按是否开启找回密码给出的提示句"),
    ph("login_url", "登录页链接（按钮；未配置主域名时为空）"),
];
const RESET_PH: [Placeholder; 2] = [ph("link", "重置链接（按钮）"), ph("minutes", "有效分钟数")];
const ORDER_PH: [Placeholder; 7] = [
    ph("order_no", "订单号"),
    ph("plan_name", "套餐名称"),
    ph("list_price", "套餐价格（含货币符号）"),
    ph("discount_lines", "优惠券 / 抵扣 / 余额行（可能为空）"),
    ph("paid", "实付金额（含货币符号）"),
    ph("paid_at", "支付时间"),
    ph("expiry_line", "套餐到期行（永久套餐时为空）"),
];
const EXPIRY_PH: [Placeholder; 2] = [
    ph("expires_at", "到期时间"),
    ph("portal_url", "用户门户链接（按钮；未配置主域名时为空）"),
];
const QUOTA_PH: [Placeholder; 4] = [
    ph("percent", "已用百分比"),
    ph("used", "已用流量"),
    ph("limit", "流量上限"),
    ph("portal_url", "用户门户链接（按钮；未配置主域名时为空）"),
];
const TICKET_REPLY_PH: [Placeholder; 2] = [
    ph("ticket_subject", "工单标题"),
    ph("portal_url", "用户门户链接（按钮；未配置主域名时为空）"),
];
const TICKET_NEW_PH: [Placeholder; 4] = [
    ph("ticket_subject", "工单标题"),
    ph("user_email", "用户邮箱"),
    ph("category", "工单分类"),
    ph("console_url", "管理后台链接（按钮；未配置主域名时为空）"),
];
const ALERT_PH: [Placeholder; 2] = [ph("title", "告警标题"), ph("text", "告警正文（多行）")];
const ADMIN_NOTICE_PH: [Placeholder; 2] = [
    ph("subject", "管理员填写的主题"),
    ph("body", "管理员填写的正文（多段）"),
];
const REFUND_PH: [Placeholder; 6] = [
    ph("order_no", "订单号"),
    ph("plan_name", "套餐名称"),
    ph("refund", "退款总额（含货币符号）"),
    ph("refund_lines", "退回余额 / 原路退回的金额行（可能为空）"),
    ph(
        "plan_line",
        "套餐处理说明（已取消 / 到期时间回退 / 恢复原套餐 / 不受影响）",
    ),
    ph("portal_url", "用户门户链接（按钮；未配置主域名时为空）"),
];
const SECURITY_PH: [Placeholder; 4] = [
    ph("event", "发生了什么（一句话）"),
    ph("time", "发生时间（UTC）"),
    ph("ip", "操作来源 IP（管理员代为操作时为空）"),
    ph("portal_url", "用户门户链接（按钮；未配置主域名时为空）"),
];
const ANNOUNCEMENT_PH: [Placeholder; 3] = [
    ph("title", "公告标题"),
    ph("body", "公告正文（已渲染）"),
    ph("portal_url", "用户门户链接（按钮；未配置主域名时为空）"),
];

/// The placeholder whitelist of a kind (besides `COMMON`) and the ones a
/// template must contain. None = unknown kind.
pub fn spec(kind: &str) -> Option<(&'static [Placeholder], &'static [&'static str])> {
    Some(match kind {
        "register_code" | "email_code" | "login_code" => (&CODE_PH, &["code"]),
        "register_exists" => (&REGISTER_EXISTS_PH, &[]),
        "password_reset" => (&RESET_PH, &["link"]),
        "order_paid" => (&ORDER_PH, &["order_no"]),
        "expiry_soon" | "expired" => (&EXPIRY_PH, &[]),
        "quota_80" | "quota_100" => (&QUOTA_PH, &[]),
        "test" => (&[], &[]),
        "ticket_reply" => (&TICKET_REPLY_PH, &[]),
        "ticket_new" => (&TICKET_NEW_PH, &[]),
        "node_alert" => (&ALERT_PH, &["text"]),
        "announcement" => (&ANNOUNCEMENT_PH, &["body"]),
        "admin_notice" => (&ADMIN_NOTICE_PH, &["body"]),
        "refund" => (&REFUND_PH, &["order_no"]),
        "security_notice" => (&SECURITY_PH, &["event"]),
        _ => return None,
    })
}

/// Chinese label of a kind (the editor's list).
pub fn kind_label(kind: &str) -> &'static str {
    match kind {
        "register_code" => "注册验证码",
        "register_exists" => "注册：邮箱已注册",
        "email_code" => "邮箱验证码",
        "login_code" => "登录验证码（通行密钥回退）",
        "password_reset" => "重置密码",
        "order_paid" => "支付回执",
        "expiry_soon" => "套餐即将到期",
        "expired" => "套餐已到期",
        "quota_80" => "流量已用 80%",
        "quota_100" => "流量已用完",
        "test" => "测试邮件",
        "ticket_reply" => "工单有新回复（给用户）",
        "ticket_new" => "新工单（给管理员）",
        "node_alert" => "节点告警",
        "announcement" => "公告",
        "admin_notice" => "管理员群发邮件",
        "refund" => "订单退款通知",
        "security_notice" => "账号安全通知",
        _ => "",
    }
}

/// How a value renders when a paragraph is exactly that placeholder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Style {
    Text,
    /// A large monospaced value (verification code).
    Code,
    /// A button with this label; the URL is shown in full in the text part.
    Link(String),
    /// Already HTML (sanitized by `markdown.rs`); `text` is the plain form.
    Html(String),
}

/// A placeholder's value for one rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Value {
    pub name: &'static str,
    pub text: String,
    pub style: Style,
}

fn text(name: &'static str, text: impl Into<String>) -> Value {
    Value {
        name,
        text: text.into(),
        style: Style::Text,
    }
}

fn link(name: &'static str, url: Option<&String>, label: &str) -> Value {
    Value {
        name,
        text: url.cloned().unwrap_or_default(),
        style: Style::Link(label.to_string()),
    }
}

impl Template {
    /// The placeholder values of this mail.
    pub fn values(&self, locale: Locale) -> Vec<Value> {
        let zh = locale == Locale::Zh;
        match self {
            Template::RegisterCode { code, minutes }
            | Template::EmailCode { code, minutes }
            | Template::LoginCode { code, minutes } => {
                vec![
                    Value {
                        name: "code",
                        text: code.clone(),
                        style: Style::Code,
                    },
                    text("minutes", minutes.to_string()),
                ]
            }
            Template::RegisterExists {
                reset_enabled,
                login_url,
            } => vec![
                text(
                    "reset_hint",
                    match (zh, reset_enabled) {
                        (true, true) => "如果忘记了密码，可以在登录页使用「忘记密码」重置。",
                        (true, false) => "如果忘记了密码，请联系管理员。",
                        (false, true) => {
                            "If you forgot your password, use \"Forgot password\" on the sign-in page."
                        }
                        (false, false) => "If you forgot your password, contact the administrator.",
                    },
                ),
                link(
                    "login_url",
                    login_url.as_ref(),
                    if zh { "前往登录" } else { "Sign in" },
                ),
            ],
            Template::PasswordReset { link: url, minutes } => vec![
                link(
                    "link",
                    Some(url),
                    if zh { "重置密码" } else { "Reset password" },
                ),
                text("minutes", minutes.to_string()),
            ],
            Template::OrderPaid {
                order_no,
                plan_name,
                money,
                paid_at,
                expires_at,
            } => {
                let amount = |c: i64| {
                    if zh {
                        format!("¥{}", yuan(c))
                    } else {
                        format!("CNY {}", yuan(c))
                    }
                };
                let mut lines = Vec::new();
                for (cents, zh_label, en_label) in [
                    (money.discount_cents, "优惠券", "Coupon"),
                    (money.credit_cents, "原套餐抵扣", "Plan switch credit"),
                    (money.balance_cents, "余额支付", "Paid from balance"),
                ] {
                    if cents > 0 {
                        lines.push(if zh {
                            format!("{zh_label}：-{}", amount(cents))
                        } else {
                            format!("{en_label}: -{}", amount(cents))
                        });
                    }
                }
                vec![
                    text("order_no", order_no.clone()),
                    text("plan_name", plan_name.clone()),
                    text("list_price", amount(money.list_cents)),
                    text("discount_lines", lines.join("\n")),
                    text("paid", amount(money.paid_cents)),
                    text("paid_at", when(paid_at)),
                    text(
                        "expiry_line",
                        match expires_at {
                            Some(e) if zh => format!("套餐到期：{}", when(e)),
                            Some(e) => format!("Plan expires: {}", when(e)),
                            None => String::new(),
                        },
                    ),
                ]
            }
            Template::ExpirySoon {
                expires_at,
                portal_url,
            }
            | Template::Expired {
                expires_at,
                portal_url,
            } => vec![
                text("expires_at", when(expires_at)),
                link(
                    "portal_url",
                    portal_url.as_ref(),
                    if zh { "前往续费" } else { "Renew" },
                ),
            ],
            Template::Quota {
                percent,
                used_bytes,
                limit_bytes,
                portal_url,
            } => vec![
                text("percent", percent.to_string()),
                text("used", human_bytes(*used_bytes)),
                text("limit", human_bytes(*limit_bytes)),
                link(
                    "portal_url",
                    portal_url.as_ref(),
                    if zh { "查看账户" } else { "View account" },
                ),
            ],
            Template::Test => vec![],
            Template::TicketReply {
                subject,
                portal_url,
            } => vec![
                text("ticket_subject", subject.clone()),
                link(
                    "portal_url",
                    portal_url.as_ref(),
                    if zh { "查看工单" } else { "View ticket" },
                ),
            ],
            Template::TicketNew {
                subject,
                user_email,
                category,
                console_url,
            } => vec![
                text("ticket_subject", subject.clone()),
                text("user_email", user_email.clone()),
                text("category", category.clone()),
                link("console_url", console_url.as_ref(), "前往工单管理"),
            ],
            // Node names are admin-controlled (not customer text); control
            // characters are dropped all the same.
            Template::NodeAlert { title, text: body } => vec![
                text(
                    "title",
                    title
                        .chars()
                        .filter(|c| !c.is_control())
                        .collect::<String>(),
                ),
                text(
                    "text",
                    body.lines()
                        .filter(|l| !l.trim().is_empty())
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
            ],
            // The admin's own text (batch action `send_email`): paragraphs
            // by blank line, control characters dropped from the subject.
            Template::AdminNotice { subject, body } => vec![
                text(
                    "subject",
                    subject
                        .chars()
                        .filter(|c| !c.is_control())
                        .collect::<String>(),
                ),
                text(
                    "body",
                    body.replace("\r\n", "\n")
                        .split("\n\n")
                        .map(str::trim)
                        .filter(|l| !l.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n\n"),
                ),
            ],
            Template::Refund {
                order_no,
                plan_name,
                to_balance_cents,
                external_cents,
                plan,
                portal_url,
            } => {
                let amount = |c: i64| {
                    if zh {
                        format!("¥{}", yuan(c))
                    } else {
                        format!("CNY {}", yuan(c))
                    }
                };
                let mut lines = Vec::new();
                if *to_balance_cents > 0 {
                    lines.push(if zh {
                        format!("退回账户余额：{}", amount(*to_balance_cents))
                    } else {
                        format!("Credited to your balance: {}", amount(*to_balance_cents))
                    });
                }
                if *external_cents > 0 {
                    lines.push(if zh {
                        format!("原路退回（支付渠道）：{}", amount(*external_cents))
                    } else {
                        format!(
                            "Returned to your payment account: {}",
                            amount(*external_cents)
                        )
                    });
                }
                let plan_line = match (plan, zh) {
                    (RefundPlan::Unchanged, true) => "你的套餐不受影响。".to_string(),
                    (RefundPlan::Unchanged, false) => "Your plan is not affected.".to_string(),
                    (RefundPlan::NotGranted, true) => "该订单没有开通套餐。".to_string(),
                    (RefundPlan::NotGranted, false) => {
                        "This order had not granted a plan.".to_string()
                    }
                    (RefundPlan::Cancelled, true) => {
                        "该订单开通的套餐已取消，节点与订阅已停止服务。".to_string()
                    }
                    (RefundPlan::Cancelled, false) => {
                        "The plan this order granted has been cancelled; its nodes and subscription have stopped."
                            .to_string()
                    }
                    (RefundPlan::RolledBack { expires_at }, true) => {
                        format!("该续费已撤销，套餐到期时间调整为 {}。", when(expires_at))
                    }
                    (RefundPlan::RolledBack { expires_at }, false) => format!(
                        "The renewal was taken back; your plan now expires on {}.",
                        when(expires_at)
                    ),
                    (
                        RefundPlan::Restored {
                            plan_name,
                            expires_at,
                        },
                        true,
                    ) => format!(
                        "已恢复为换套餐之前的套餐「{plan_name}」{}。",
                        expires_at
                            .map(|e| format!("，到期时间 {}", when(&e)))
                            .unwrap_or_default()
                    ),
                    (
                        RefundPlan::Restored {
                            plan_name,
                            expires_at,
                        },
                        false,
                    ) => format!(
                        "Your previous plan \"{plan_name}\" is back{}.",
                        expires_at
                            .map(|e| format!(", expiring on {}", when(&e)))
                            .unwrap_or_default()
                    ),
                };
                vec![
                    text("order_no", order_no.clone()),
                    text("plan_name", plan_name.clone()),
                    text("refund", amount(to_balance_cents + external_cents)),
                    text("refund_lines", lines.join("\n")),
                    text("plan_line", plan_line),
                    link(
                        "portal_url",
                        portal_url.as_ref(),
                        if zh { "查看账户" } else { "View account" },
                    ),
                ]
            }
            Template::SecurityNotice {
                event,
                at,
                ip,
                portal_url,
            } => vec![
                text("event", event.text(zh).to_string()),
                text("time", when(at)),
                text(
                    "ip",
                    match ip {
                        Some(ip) => ip.clone(),
                        None if zh => "（管理员操作）".to_string(),
                        None => "(done by an administrator)".to_string(),
                    },
                ),
                link(
                    "portal_url",
                    portal_url.as_ref(),
                    if zh {
                        "检查账号安全"
                    } else {
                        "Review account security"
                    },
                ),
            ],
            Template::Announcement {
                title,
                body_md,
                portal_url,
            } => vec![
                text("title", title.clone()),
                Value {
                    name: "body",
                    text: crate::markdown::to_text(body_md),
                    style: Style::Html(crate::markdown::render(body_md)),
                },
                link(
                    "portal_url",
                    portal_url.as_ref(),
                    if zh {
                        "打开用户门户"
                    } else {
                        "Open the portal"
                    },
                ),
            ],
        }
    }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/// The built-in subject and body of a kind in a locale. None = unknown kind.
pub fn defaults(kind: &str, locale: Locale) -> Option<(&'static str, &'static str)> {
    let zh = locale == Locale::Zh;
    Some(match (kind, zh) {
        ("register_code", true) => (
            "{site} 注册验证码",
            "你正在注册账号，验证码：\n\n{code}\n\n验证码 {minutes} 分钟内有效，只能使用一次。如果不是你本人操作，请忽略此邮件。",
        ),
        ("register_code", false) => (
            "Your {site} sign-up code",
            "Use this code to finish signing up:\n\n{code}\n\nThe code is valid for {minutes} minutes and can be used once. If you did not request it, ignore this message.",
        ),
        ("register_exists", true) => (
            "{site}：该邮箱已注册",
            "有人（可能是你）尝试用这个邮箱注册账号，但该邮箱已经注册过了，因此没有创建新账号。\n\n{reset_hint}\n\n{login_url}\n\n如果不是你本人操作，请忽略此邮件，你的账号不受影响。",
        ),
        ("register_exists", false) => (
            "{site}: this address already has an account",
            "Someone (probably you) tried to sign up with this address, but it already has an account, so no new account was created.\n\n{reset_hint}\n\n{login_url}\n\nIf this was not you, ignore this message; your account is unaffected.",
        ),
        ("email_code", true) => (
            "{site} 邮箱验证码",
            "你正在为账号绑定这个邮箱，验证码：\n\n{code}\n\n验证码 {minutes} 分钟内有效，只能使用一次。如果不是你本人操作，请忽略此邮件。",
        ),
        ("email_code", false) => (
            "Your {site} email verification code",
            "Use this code to confirm this address for your account:\n\n{code}\n\nThe code is valid for {minutes} minutes and can be used once. If you did not request it, ignore this message.",
        ),
        ("login_code", true) => (
            "{site} 登录验证码",
            "你的账号只能用通行密钥登录，但有人（可能是你）用密码申请了改用邮箱验证码登录，验证码：\n\n{code}\n\n验证码 {minutes} 分钟内有效，只能使用一次。如果不是你本人操作，请不要把验证码告诉任何人，并尽快修改密码。",
        ),
        ("login_code", false) => (
            "Your {site} sign-in code",
            "Your account normally signs in with a passkey, but someone (probably you) asked to sign in with the password plus an emailed code instead. Code:\n\n{code}\n\nThe code is valid for {minutes} minutes and can be used once. If this was not you, do not share the code with anyone and change your password.",
        ),
        ("password_reset", true) => (
            "{site} 重置密码",
            "我们收到了重置你账号密码的请求。点击下面的链接设置新密码：\n\n{link}\n\n链接 {minutes} 分钟内有效，只能使用一次；重置后所有已登录的设备都会退出。如果不是你本人操作，请忽略此邮件，密码不会改变。",
        ),
        ("password_reset", false) => (
            "Reset your {site} password",
            "We received a request to reset your password. Open the link below to choose a new one:\n\n{link}\n\nThe link is valid for {minutes} minutes and works once; resetting signs out every device. If you did not request it, ignore this message — your password stays the same.",
        ),
        ("order_paid", true) => (
            "{site} 支付成功",
            "感谢购买，你的订单已支付成功：\n\n订单号：{order_no}\n\n套餐：{plan_name}\n\n价格：{list_price}\n\n{discount_lines}\n\n实付：{paid}\n\n支付时间：{paid_at}\n\n{expiry_line}",
        ),
        ("order_paid", false) => (
            "{site} payment received",
            "Thank you for your purchase. Your order has been paid:\n\nOrder: {order_no}\n\nPlan: {plan_name}\n\nPrice: {list_price}\n\n{discount_lines}\n\nPaid: {paid}\n\nPaid at: {paid_at}\n\n{expiry_line}",
        ),
        ("expiry_soon", true) => (
            "{site}：套餐即将到期",
            "你的套餐将于 {expires_at} 到期。到期后节点与订阅将停止服务，请及时续费。\n\n{portal_url}",
        ),
        ("expiry_soon", false) => (
            "{site}: your plan expires soon",
            "Your plan expires on {expires_at}. After that your nodes and subscription stop working; renew in time to keep them.\n\n{portal_url}",
        ),
        ("expired", true) => (
            "{site}：套餐已到期",
            "你的套餐已于 {expires_at} 到期，节点与订阅已停止服务。续费或购买套餐后即可恢复使用。\n\n{portal_url}",
        ),
        ("expired", false) => (
            "{site}: your plan has expired",
            "Your plan expired on {expires_at}; your nodes and subscription have stopped. Renew or buy a plan to restore them.\n\n{portal_url}",
        ),
        ("quota_80", true) => (
            "{site}：流量已使用 {percent}%",
            "你本周期的流量已使用 {percent}%（{used} / {limit}）。用完后节点与订阅将暂停。\n\n{portal_url}",
        ),
        ("quota_80", false) => (
            "{site}: {percent}% of your traffic used",
            "You have used {percent}% of this period's traffic ({used} / {limit}). When it runs out your nodes and subscription pause.\n\n{portal_url}",
        ),
        ("quota_100", true) => (
            "{site}：流量已用完",
            "你本周期的流量已用完（{used} / {limit}），节点与订阅已暂停。流量重置或续费/升级套餐后即可恢复。\n\n{portal_url}",
        ),
        ("quota_100", false) => (
            "{site}: traffic used up",
            "You have used all of this period's traffic ({used} / {limit}); your nodes and subscription are paused until the traffic resets or you renew/upgrade.\n\n{portal_url}",
        ),
        ("test", true) => (
            "{site} 测试邮件",
            "这是一封测试邮件：面板的 SMTP 设置可以正常发信。",
        ),
        ("test", false) => (
            "{site} test message",
            "This is a test message: the panel's SMTP settings work.",
        ),
        ("ticket_reply", true) => (
            "{site}：工单有新回复",
            "客服回复了你的工单：\n\n{ticket_subject}\n\n请登录用户门户查看回复并继续沟通。\n\n{portal_url}",
        ),
        ("ticket_reply", false) => (
            "{site}: new reply to your ticket",
            "Support replied to your ticket:\n\n{ticket_subject}\n\nSign in to the portal to read the reply and answer.\n\n{portal_url}",
        ),
        ("ticket_new", _) => (
            "{site}：新工单",
            "用户 {user_email} 提交了新工单（{category}）：\n\n{ticket_subject}\n\n{console_url}",
        ),
        ("node_alert", _) => ("{site}：{title}", "{text}"),
        ("admin_notice", _) => ("{subject}", "{body}"),
        ("announcement", true) => ("{site}：{title}", "{title}\n\n{body}\n\n{portal_url}"),
        ("announcement", false) => ("{site}: {title}", "{title}\n\n{body}\n\n{portal_url}"),
        ("refund", true) => (
            "{site}：订单已退款",
            "你的订单已退款：\n\n订单号：{order_no}\n\n套餐：{plan_name}\n\n退款金额：{refund}\n\n{refund_lines}\n\n{plan_line}\n\n{portal_url}",
        ),
        ("refund", false) => (
            "{site}: your order was refunded",
            "Your order has been refunded:\n\nOrder: {order_no}\n\nPlan: {plan_name}\n\nRefund: {refund}\n\n{refund_lines}\n\n{plan_line}\n\n{portal_url}",
        ),
        ("security_notice", true) => (
            "{site}：账号安全提醒",
            "{event}\n\n时间：{time}\n\n来源 IP：{ip}\n\n如果这不是你本人操作，请立即重置密码、检查并删除不认识的通行密钥，然后联系站长。\n\n{portal_url}",
        ),
        ("security_notice", false) => (
            "{site}: security alert for your account",
            "{event}\n\nTime: {time}\n\nFrom IP: {ip}\n\nIf this was not you, reset your password right away, remove any passkey you do not recognise, and contact the site owner.\n\n{portal_url}",
        ),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Validation and rendering
// ---------------------------------------------------------------------------

/// Longest subject / body an admin may store (characters).
pub const MAX_SUBJECT: usize = 200;
pub const MAX_TEMPLATE_BODY: usize = 20_000;
/// Longest HTML source an admin may store (characters).
pub const MAX_TEMPLATE_HTML: usize = 100_000;

/// The `{name}` tokens of a template text (lower-case letters, digits,
/// underscores). Anything else in braces is literal text.
pub fn placeholders_in(s: &str) -> Vec<&str> {
    placeholder_spans(s).into_iter().map(|(_, n)| n).collect()
}

/// `placeholders_in` with the byte offset of each token's `{`.
fn placeholder_spans(s: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut base = 0;
    let mut rest = s;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let name = &after[..close];
                if !name.is_empty()
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                {
                    out.push((base + open, name));
                    base += open + 1 + close + 1;
                    rest = &after[close + 1..];
                } else {
                    base += open + 1;
                    rest = after;
                }
            }
            None => break,
        }
    }
    out
}

/// The 1-based line and column (in characters) of byte offset `at` in `s`,
/// as the admin's editor shows it: `\r\n`, `\r` and `\n` each end a line.
pub fn line_col(s: &str, at: usize) -> (usize, usize) {
    let (mut line, mut column) = (1, 1);
    let mut after_cr = false;
    for (i, c) in s.char_indices() {
        if i >= at {
            break;
        }
        match c {
            '\n' if after_cr => {}
            '\n' | '\r' => {
                line += 1;
                column = 1;
            }
            _ => column += 1,
        }
        after_cr = c == '\r';
    }
    (line, column)
}

/// A character not allowed in a body / HTML source: a control character
/// other than line breaks and tabs. Its byte offset, if there is one.
fn first_control(s: &str) -> Option<usize> {
    s.char_indices()
        .find(|&(_, c)| c.is_control() && c != '\n' && c != '\t' && c != '\r')
        .map(|(i, _)| i)
}

/// An unknown placeholder of `field` (`text` is that field as submitted).
fn unknown_placeholder(field: &'static str, text: &str, at: usize, name: &str) -> ApiError {
    let (line, column) = line_col(text, at);
    bad_request!(
        "mail_template.placeholder_unknown",
        "unknown placeholder {{{name}}} in the {field} at line {line}, column {column}",
        name = name,
        field = field,
        line = line,
        column = column
    )
}

/// Check an admin's template for a kind: lengths, a one-line subject, only
/// whitelisted placeholders, every required one present. Errors name the
/// `field` ("subject" / "body") and, where there is one, the `line` and
/// `column` (1-based, characters) of the problem.
pub fn validate(kind: &str, subject: &str, body: &str) -> Result<(), ApiError> {
    let Some((allowed, required)) = spec(kind) else {
        return Err(bad_request!(
            "mail_template.kind_unknown",
            "unknown template kind: {kind}",
            kind = kind
        ));
    };
    let raw_subject = subject;
    let subject = subject.trim();
    if subject.is_empty() || subject.chars().count() > MAX_SUBJECT {
        return Err(bad_request!(
            "mail_template.subject_length",
            "subject must be 1-{max} characters",
            max = MAX_SUBJECT
        ));
    }
    if let Some(i) = subject.find(char::is_control) {
        let lead = raw_subject.len() - raw_subject.trim_start().len();
        let (line, column) = line_col(raw_subject, lead + i);
        return Err(bad_request!(
            "mail_template.subject_multiline",
            "subject must be a single line (line break or control character at column {column})",
            field = "subject",
            line = line,
            column = column
        ));
    }
    if body.trim().is_empty() || body.chars().count() > MAX_TEMPLATE_BODY {
        return Err(bad_request!(
            "mail_template.body_length",
            "body must be 1-{max} characters",
            max = MAX_TEMPLATE_BODY
        ));
    }
    if let Some(at) = first_control(body) {
        let (line, column) = line_col(body, at);
        return Err(bad_request!(
            "mail_template.body_control",
            "body must not contain control characters (line {line}, column {column})",
            field = "body",
            line = line,
            column = column
        ));
    }
    let known = |name: &str| name == "site" || allowed.iter().any(|p| p.name == name);
    for (field, text) in [("subject", raw_subject), ("body", body)] {
        if let Some((at, name)) = placeholder_spans(text).into_iter().find(|(_, n)| !known(n)) {
            return Err(unknown_placeholder(field, text, at, name));
        }
    }
    let present: Vec<&str> = placeholders_in(body)
        .into_iter()
        .chain(placeholders_in(subject))
        .collect();
    for r in required {
        if !present.contains(r) {
            return Err(bad_request!(
                "mail_template.placeholder_missing",
                "the template must contain {{{name}}} (missing from the {field})",
                name = *r,
                field = "body"
            ));
        }
    }
    Ok(())
}

/// Tags an HTML source may not contain: they run code, load other pages or
/// submit data. (A mail client strips most of them anyway; refusing them
/// here keeps a typo or a pasted web page from becoming a phishing form.)
const FORBIDDEN_TAGS: [&str; 10] = [
    "script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "base", "link",
];

/// Why an HTML source is refused, if it is: a forbidden tag, an inline
/// event handler, a script-capable URL or a style import — the earliest
/// one, with its byte offset in `html`.
fn forbidden_html(html: &str) -> Option<(usize, &'static str)> {
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut found: Option<(usize, &'static str)> = None;
    let mut hit = |at: usize, what: &'static str| {
        if found.is_none_or(|(f, _)| at < f) {
            found = Some((at, what));
        }
    };
    // Tags: `<name` followed by whitespace, `/` or `>`; `<script` followed
    // by anything (no legitimate mail markup starts so, and the rendered
    // mail must never contain the string — fuzz/content).
    for tag in FORBIDDEN_TAGS {
        let needle = format!("<{tag}");
        let mut from = 0;
        while let Some(i) = lower[from..].find(&needle) {
            let end = from + i + needle.len();
            if tag == "script" {
                hit(from + i, "<script>、<iframe>、<form> 等标签");
                break;
            }
            match bytes.get(end) {
                None | Some(b'>' | b'/') => {
                    hit(from + i, "<script>、<iframe>、<form> 等标签");
                    break;
                }
                Some(c) if c.is_ascii_whitespace() => {
                    hit(from + i, "<script>、<iframe>、<form> 等标签");
                    break;
                }
                _ => {}
            }
            from = end;
        }
    }
    // Inline event handlers: ` onxxx=` after whitespace, a quote or `/`.
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == b'o'
            && bytes[i + 1] == b'n'
            && i > 0
            && (bytes[i - 1].is_ascii_whitespace() || matches!(bytes[i - 1], b'"' | b'\'' | b'/'))
        {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j].is_ascii_lowercase() {
                j += 1;
            }
            if j > i + 2 {
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if bytes.get(j) == Some(&b'=') {
                    hit(i, "onclick= 之类的事件属性");
                    break;
                }
            }
        }
        i += 1;
    }
    // Script-capable URLs: browsers ignore whitespace and control
    // characters inside a scheme, so look at a copy without them
    // (`origin[k]` = the offset in `html` of the squeezed copy's byte k).
    let mut squeezed = String::with_capacity(lower.len());
    let mut origin = Vec::with_capacity(lower.len());
    for (k, c) in lower.char_indices() {
        if !c.is_whitespace() && !c.is_control() {
            squeezed.push(c);
            origin.extend(std::iter::repeat_n(k, c.len_utf8()));
        }
    }
    for (needle, what) in [
        ("javascript:", "javascript: 链接、@import 等"),
        ("vbscript:", "javascript: 链接、@import 等"),
        ("data:text/html", "javascript: 链接、@import 等"),
        ("@import", "javascript: 链接、@import 等"),
        ("expression(", "javascript: 链接、@import 等"),
        ("http-equiv", "<meta http-equiv>"),
    ] {
        if let Some(k) = squeezed.find(needle) {
            hit(origin[k], what);
        }
    }
    found
}

/// Check an admin's HTML source for a kind: size, no control characters,
/// nothing script-capable, only whitelisted placeholders, every required
/// one present (the HTML part must carry the code or the link too). Errors
/// name the `field` ("html_source") and, where there is one, the `line`
/// and `column` (1-based, characters) of the problem.
pub fn validate_html(kind: &str, html: &str) -> Result<(), ApiError> {
    let Some((allowed, required)) = spec(kind) else {
        return Err(bad_request!(
            "mail_template.kind_unknown",
            "unknown template kind: {kind}",
            kind = kind
        ));
    };
    if html.trim().is_empty() || html.chars().count() > MAX_TEMPLATE_HTML {
        return Err(bad_request!(
            "mail_template.html_length",
            "html source must be 1-{max} characters",
            max = MAX_TEMPLATE_HTML
        ));
    }
    if let Some(at) = first_control(html) {
        let (line, column) = line_col(html, at);
        return Err(bad_request!(
            "mail_template.html_control",
            "html source must not contain control characters (line {line}, column {column})",
            field = "html_source",
            line = line,
            column = column
        ));
    }
    if let Some((at, what)) = forbidden_html(html) {
        let (line, column) = line_col(html, at);
        return Err(bad_request!(
            "mail_template.html_forbidden",
            "html source must not contain {what} (line {line}, column {column})",
            what = what,
            field = "html_source",
            line = line,
            column = column
        ));
    }
    let known = |name: &str| name == "site" || allowed.iter().any(|p| p.name == name);
    let found = placeholder_spans(html);
    if let Some(&(at, name)) = found.iter().find(|(_, n)| !known(n)) {
        return Err(unknown_placeholder("html_source", html, at, name));
    }
    for r in required {
        if !found.iter().any(|(_, n)| n == r) {
            return Err(bad_request!(
                "mail_template.placeholder_missing",
                "the template must contain {{{name}}} (missing from the {field})",
                name = *r,
                field = "html_source"
            ));
        }
    }
    Ok(())
}

/// Fill an admin's HTML source with the mail's values. `{name}` becomes the
/// value's text, HTML-escaped (so it is safe in text and in a double-quoted
/// attribute: `<a href="{reset_link}">`); multi-line text gets `<br>`; the
/// one value that is already HTML (an announcement's body) goes in as is.
pub fn render_source(src: &str, values: &[Value], site: &str) -> String {
    let src = src.replace("\r\n", "\n").replace('\r', "\n");
    substitute(&src, |name| {
        if name == "site" {
            return Some(esc(site));
        }
        values
            .iter()
            .find(|v| v.name == name)
            .map(|v| match &v.style {
                Style::Html(h) => h.clone(),
                Style::Link(_) => esc(&v.text),
                Style::Text | Style::Code => esc(&v.text).replace('\n', "<br>"),
            })
    })
}

/// `render_custom`, with the HTML part replaced by the admin's source when
/// there is one (subject and plain text are rendered the same either way).
pub fn render_custom_html(
    subject: &str,
    body: &str,
    html_source: Option<&str>,
    values: &[Value],
    locale: Locale,
    site: &str,
) -> Rendered {
    let mut r = render_custom(subject, body, values, locale, site);
    if let Some(src) = html_source {
        r.html = render_source(src, values, site);
    }
    r
}

/// The starting point of the editor's "edit the source" button: the HTML
/// the panel builds from this subject and body, with the `{placeholders}`
/// left in (including `{site}`).
pub fn starter_html(subject: &str, body: &str, locale: Locale) -> String {
    render_custom(subject, body, &[], locale, "{site}").html
}

/// Substitute `{name}` tokens with `f(name)` (None = keep the token).
fn substitute(s: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = &after[..close];
        let ok = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        match if ok { f(name) } else { None } {
            Some(v) => {
                out.push_str(&v);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn html_of(v: &Value) -> String {
    match &v.style {
        Style::Text | Style::Code => esc(&v.text).replace('\n', "<br>"),
        Style::Link(_) => format!("<a href=\"{0}\">{0}</a>", esc(&v.text)),
        Style::Html(h) => h.clone(),
    }
}

/// Render a (possibly admin-edited) template with the mail's values.
pub fn render_custom(
    subject: &str,
    body: &str,
    values: &[Value],
    locale: Locale,
    site: &str,
) -> Rendered {
    let lookup = |name: &str| -> Option<&Value> { values.iter().find(|v| v.name == name) };
    let text_of = |name: &str| -> Option<String> {
        if name == "site" {
            return Some(site.to_string());
        }
        lookup(name).map(|v| v.text.clone())
    };
    // Defense in depth (the site name is validated when saved; lettre
    // encodes headers anyway): a subject is one line of text.
    let subject: String = substitute(subject.trim(), text_of)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let footer = match locale {
        Locale::Zh => format!("此邮件由 {site} 自动发送，请勿直接回复。"),
        Locale::En => {
            format!("This message was sent automatically by {site}. Please do not reply.")
        }
    };
    let lang = match locale {
        Locale::Zh => "zh-CN",
        Locale::En => "en",
    };
    let mut text = String::new();
    let mut html = format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width\"><title>{}</title></head>\
         <body style=\"margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,\
         'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a\">\
         <div style=\"max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;\
         padding:24px\"><h1 style=\"font-size:18px;margin:0 0 16px\">{}</h1>",
        esc(&subject),
        esc(site)
    );
    let body = body.replace("\r\n", "\n").replace('\r', "\n");
    for para in body.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        // A paragraph that is exactly one placeholder renders in the
        // value's style.
        if let Some(name) = para
            .strip_prefix('{')
            .and_then(|p| p.strip_suffix('}'))
            .filter(|n| !n.contains('{') && !n.contains('}'))
            && let Some(v) = lookup(name)
        {
            if v.text.trim().is_empty() {
                continue;
            }
            match &v.style {
                Style::Code => {
                    text.push_str(&format!("    {}\n\n", v.text));
                    html.push_str(&format!(
                        "<p style=\"font-size:28px;font-weight:600;letter-spacing:6px;\
                         font-family:Menlo,Consolas,monospace;margin:8px 0 16px\">{}</p>",
                        esc(&v.text)
                    ));
                }
                Style::Link(label) => {
                    text.push_str(&format!("{label}:\n{}\n\n", v.text));
                    html.push_str(&format!(
                        "<p style=\"margin:8px 0 16px\"><a href=\"{}\" style=\"display:inline-block;\
                         background:#1a1a1a;color:#ffffff;text-decoration:none;padding:10px 16px;\
                         border-radius:6px;font-size:14px\">{}</a></p>\
                         <p style=\"font-size:12px;color:#666;word-break:break-all;margin:0 0 12px\">{}</p>",
                        esc(&v.text),
                        esc(label),
                        esc(&v.text)
                    ));
                }
                Style::Html(h) => {
                    text.push_str(&v.text);
                    text.push_str("\n\n");
                    html.push_str(&format!(
                        "<div style=\"font-size:14px;line-height:1.6;margin:0 0 12px\">{h}</div>"
                    ));
                }
                Style::Text => {
                    text.push_str(&v.text);
                    text.push_str("\n\n");
                    html.push_str(&format!(
                        "<p style=\"font-size:14px;line-height:1.6;margin:0 0 12px\">{}</p>",
                        html_of(v)
                    ));
                }
            }
            continue;
        }
        let t = substitute(para, text_of);
        if t.trim().is_empty() {
            continue;
        }
        let h = substitute(&esc(para), |name| {
            if name == "site" {
                return Some(esc(site));
            }
            lookup(name).map(html_of)
        })
        .replace('\n', "<br>");
        text.push_str(&t);
        text.push_str("\n\n");
        html.push_str(&format!(
            "<p style=\"font-size:14px;line-height:1.6;margin:0 0 12px\">{h}</p>"
        ));
    }
    text.push_str("--\n");
    text.push_str(&footer);
    text.push('\n');
    html.push_str(&format!(
        "<hr style=\"border:none;border-top:1px solid #eee;margin:16px 0\">\
         <p style=\"font-size:12px;color:#888;margin:0\">{}</p></div></body></html>",
        esc(&footer)
    ));
    Rendered {
        subject,
        text,
        html,
    }
}

/// Render `t` with the built-in template for `locale`; `site` is the site
/// name (系统设置 → 站点名称, default "Akari").
pub fn render(t: &Template, locale: Locale, site: &str) -> Rendered {
    let (subject, body) = defaults(t.outbox_kind(), locale).unwrap_or(("{site}", "{site}"));
    render_custom(subject, body, &t.values(locale), locale, site)
}

#[cfg(test)]
mod tests {
    const REG: &str = "register_code";

    fn html_err(kind: &str, html: &str) -> Option<String> {
        validate_html(kind, html).err().map(|e| format!("{e:?}"))
    }

    #[test]
    fn html_source_validation() {
        let ok = "<!doctype html><html><head><meta charset=\"utf-8\"><style>p{margin:0}</style></head>\
                  <body><h1>{site}</h1><p style=\"color:#333\">{code}</p>\
                  <a href=\"https://example.com/?a=1&b=2\" title=\"online\">link</a></body></html>";
        assert!(validate_html(REG, ok).is_ok(), "{:?}", html_err(REG, ok));
        // Required and unknown placeholders are checked like in the text body.
        assert!(
            html_err(REG, "<p>{site}</p>")
                .unwrap()
                .contains("placeholder_missing")
        );
        assert!(
            html_err(REG, "<p>{code}{nope}</p>")
                .unwrap()
                .contains("placeholder_unknown")
        );
        assert!(
            html_err("nope", "<p>x</p>")
                .unwrap()
                .contains("kind_unknown")
        );
        // Size and control characters.
        assert!(html_err(REG, "  ").unwrap().contains("html_length"));
        let big = format!("{{code}}{}", "x".repeat(MAX_TEMPLATE_HTML));
        assert!(html_err(REG, &big).unwrap().contains("html_length"));
        assert!(
            html_err(REG, "{code}\u{0}")
                .unwrap()
                .contains("html_control")
        );
        // Script-capable constructs, in the spellings a browser accepts.
        for bad in [
            "<script>alert(1)</script>{code}",
            "<SCRIPT src=x>{code}",
            "<iframe src=\"https://x\"></iframe>{code}",
            "<form action=\"https://x\"><input></form>{code}",
            "<object data=x>{code}",
            "<embed src=x>{code}",
            "<base href=\"https://x/\">{code}",
            "<link rel=\"stylesheet\" href=\"https://x/a.css\">{code}",
            "<img src=x onerror=alert(1)>{code}",
            "<a href=\"x\" OnClick = \"y()\">{code}</a>",
            "<p style=\"a\"onmouseover=\"y\">{code}</p>",
            "<a href=\"javascript:alert(1)\">{code}</a>",
            "<a href=\"java\tscript:alert(1)\">{code}</a>",
            "<a href=\" JavaScript:alert(1)\">{code}</a>",
            "<a href=\"vbscript:x\">{code}</a>",
            "<a href=\"data:text/html,<b>x</b>\">{code}</a>",
            "<style>@import url(https://x/a.css);</style>{code}",
            "<meta http-equiv=\"refresh\" content=\"0;url=https://x\">{code}",
            // Any `<script…` (fuzz/content: the mail must never contain it).
            "<p>{code} <scripted>z</scripted></p>",
            "{code} {site<script}",
        ] {
            assert!(
                html_err(REG, bad)
                    .unwrap_or_default()
                    .contains("html_forbidden"),
                "accepted: {bad}"
            );
        }
        // Look-alikes that are fine: a word that merely starts with a tag
        // name or contains "on", and text about scripts.
        for fine in [
            "<p>{code} <formal>x</formal> <linked>y</linked></p>",
            "<p>{code} Please confirm: one, two, only this</p>",
            "<p style=\"font-weight:600\">{code} javascript is not mentioned as a scheme</p>",
        ] {
            assert!(
                validate_html(REG, fine).is_ok(),
                "{:?}: {fine}",
                html_err(REG, fine)
            );
        }
    }

    #[test]
    fn html_source_renders_escaped_values() {
        let t = Template::sample("password_reset").unwrap();
        let v = t.values(Locale::En);
        let link = v.iter().find(|x| x.name == "link").unwrap().text.clone();
        let src = "<a href=\"{link}\">go</a> <b>{site}</b> {not a placeholder} p{margin:0}";
        let out = render_source(src, &v, "Fish & <Chips>");
        assert!(
            out.contains(&format!("<a href=\"{}\">go</a>", esc(&link))),
            "{out}"
        );
        assert!(out.contains("<b>Fish &amp; &lt;Chips&gt;</b>"), "{out}");
        // Not a token (space, ':'): left alone, so CSS braces survive.
        assert!(out.contains("{not a placeholder} p{margin:0}"), "{out}");
        // A value with quotes cannot leave a double-quoted attribute.
        let evil = vec![Value {
            name: "link",
            text: "x\" onclick=\"y".into(),
            style: Style::Link("L".into()),
        }];
        let out = render_source("<a href=\"{link}\">", &evil, "S");
        assert_eq!(out, "<a href=\"x&quot; onclick=&quot;y\">");
        // Subject and text part are rendered as without a source.
        let a = render_custom_html("S {site}", "{link}", None, &v, Locale::En, "Q");
        let b = render_custom_html(
            "S {site}",
            "{link}",
            Some("<p>{link}</p>"),
            &v,
            Locale::En,
            "Q",
        );
        assert_eq!((&a.subject, &a.text), (&b.subject, &b.text));
        assert_ne!(a.html, b.html);
        assert_eq!(b.html, format!("<p>{}</p>", esc(&link)));
    }

    #[test]
    fn starter_html_keeps_the_placeholders() {
        let (subject, body) = defaults("register_code", Locale::En).unwrap();
        let h = starter_html(subject, body, Locale::En);
        assert!(h.starts_with("<!doctype html>"), "{h}");
        assert!(h.contains("{code}") && h.contains("{site}"), "{h}");
        // The starter is itself a valid source for its kind.
        assert!(
            validate_html("register_code", &h).is_ok(),
            "{:?}",
            html_err("register_code", &h)
        );
    }

    use super::*;

    fn all(code: &str) -> Vec<Template> {
        let t = DateTime::parse_from_rfc3339("2026-10-02T08:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        vec![
            Template::RegisterCode {
                code: code.into(),
                minutes: 10,
            },
            Template::RegisterExists {
                reset_enabled: true,
                login_url: Some("https://p.example/x/app".into()),
            },
            Template::RegisterExists {
                reset_enabled: false,
                login_url: None,
            },
            Template::EmailCode {
                code: code.into(),
                minutes: 10,
            },
            Template::PasswordReset {
                link: "https://p.example/x/app/reset#token=abc&x=<y>".into(),
                minutes: 30,
            },
            Template::OrderPaid {
                order_no: "AK20261002x".into(),
                plan_name: "<b>Pro</b>".into(),
                money: OrderMoney {
                    list_cents: 2000,
                    discount_cents: 500,
                    credit_cents: 0,
                    balance_cents: 266,
                    paid_cents: 1234,
                },
                paid_at: t,
                expires_at: Some(t),
            },
            Template::ExpirySoon {
                expires_at: t,
                portal_url: Some("https://p.example/x/app".into()),
            },
            Template::Expired {
                expires_at: t,
                portal_url: None,
            },
            Template::Quota {
                percent: 80,
                used_bytes: 80 << 30,
                limit_bytes: 100 << 30,
                portal_url: None,
            },
            Template::Quota {
                percent: 100,
                used_bytes: 100 << 30,
                limit_bytes: 100 << 30,
                portal_url: None,
            },
            Template::Test,
            Template::TicketReply {
                subject: "<b>no connection</b>".into(),
                portal_url: Some("https://p.example/x/app".into()),
            },
            Template::LoginCode {
                code: code.into(),
                minutes: 10,
            },
        ]
    }

    #[test]
    fn every_template_renders_in_both_locales() {
        for t in all("123456") {
            for loc in [Locale::Zh, Locale::En] {
                let r = render(&t, loc, "Akari & Co");
                assert!(!r.subject.is_empty() && !r.text.is_empty(), "{t:?}");
                assert!(!r.subject.contains('\n') && !r.subject.contains('\r'));
                assert!(r.html.starts_with("<!doctype html>"));
                // No remote assets or scripts in the HTML part.
                for bad in ["<img", "<script", "src=", "url(", "@import", "<link"] {
                    assert!(!r.html.contains(bad), "{bad} in {t:?}");
                }
                // The site name is escaped in HTML, verbatim in text.
                assert!(r.html.contains("Akari &amp; Co"));
                assert!(!r.html.contains("Akari & Co"));
                assert!(r.text.contains("Akari & Co"));
                // No placeholder survives rendering.
                assert!(!r.text.contains('{') || !r.text.contains('}'), "{}", r.text);
                let is_zh = r
                    .text
                    .chars()
                    .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
                assert_eq!(is_zh, loc == Locale::Zh, "{loc:?} {t:?}");
            }
        }
    }

    #[test]
    fn values_are_escaped_and_present() {
        let r = render(
            &Template::RegisterCode {
                code: "042917".into(),
                minutes: 10,
            },
            Locale::En,
            "Akari",
        );
        assert!(r.text.contains("042917") && r.html.contains("042917"));
        assert!(r.text.contains("10 minutes"));
        assert!(r.text.contains("    042917\n"), "code paragraph style");
        let r = render(&all("1")[5], Locale::Zh, "Akari");
        assert!(r.html.contains("&lt;b&gt;Pro&lt;/b&gt;"));
        assert!(r.text.contains("<b>Pro</b>"), "plain text is not escaped");
        assert!(r.text.contains("实付：¥12.34"));
        assert!(r.text.contains("价格：¥20.00") && r.text.contains("优惠券：-¥5.00"));
        assert!(r.text.contains("余额支付：-¥2.66") && !r.text.contains("原套餐抵扣"));
        assert!(r.text.contains("2026-10-02 08:30 UTC"));
        assert!(r.text.contains("套餐到期："));
        let r = render(&all("1")[4], Locale::En, "Akari");
        assert!(
            r.html
                .contains("href=\"https://p.example/x/app/reset#token=abc&amp;x=&lt;y&gt;\"")
        );
        assert!(
            r.text
                .contains("https://p.example/x/app/reset#token=abc&x=<y>")
        );
        let r = render(&all("1")[8], Locale::En, "Akari");
        assert!(r.subject.contains("80%"));
        assert!(r.text.contains("80.00 GiB / 100.00 GiB"));
        // Empty optional values drop their paragraph (no dangling button).
        let r = render(&all("1")[7], Locale::Zh, "Akari");
        assert!(!r.html.contains("<a href") && !r.text.contains("前往续费"));
        let r = render(&all("1")[2], Locale::Zh, "Akari");
        assert!(r.text.contains("请联系管理员") && !r.text.contains("前往登录"));
    }

    #[test]
    fn kinds_and_helpers() {
        let kinds: Vec<_> = all("1").iter().map(Template::outbox_kind).collect();
        assert_eq!(
            kinds,
            [
                "register_code",
                "register_exists",
                "register_exists",
                "email_code",
                "password_reset",
                "order_paid",
                "expiry_soon",
                "expired",
                "quota_80",
                "quota_100",
                "test",
                "ticket_reply",
                "login_code"
            ]
        );
        assert_eq!(Locale::parse("en"), Locale::En);
        assert_eq!(Locale::parse("en-US"), Locale::En);
        assert_eq!(Locale::parse("zh"), Locale::Zh);
        assert_eq!(Locale::parse("fr"), Locale::Zh);
        assert_eq!(Locale::En.as_str(), "en");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1536), "1.50 KiB");
        assert_eq!(human_bytes(-5), "0 B");
        assert_eq!(yuan(5), "0.05");
        assert_eq!(yuan(-150), "-1.50");
        assert_eq!(
            esc("<a href='x'>&\"</a>"),
            "&lt;a href=&#39;x&#39;&gt;&amp;&quot;&lt;/a&gt;"
        );
        for k in KINDS {
            assert!(spec(k).is_some() && !kind_label(k).is_empty(), "{k}");
            let s = Template::sample(k).expect(k);
            assert_eq!(s.outbox_kind(), k);
            for loc in [Locale::Zh, Locale::En] {
                let (subject, body) = defaults(k, loc).expect(k);
                validate(k, subject, body).expect(k);
                let r = render(&s, loc, "Akari");
                assert!(!r.subject.is_empty() && r.html.contains("</html>"));
            }
        }
        assert!(spec("nope").is_none() && Template::sample("nope").is_none());
    }

    /// W17: the customer's ticket subject is in the body only (escaped);
    /// the console-facing mails are Chinese and keep subjects one line.
    #[test]
    fn w17_templates() {
        let r = render(&all("1")[11], Locale::En, "Akari");
        assert_eq!(r.subject, "Akari: new reply to your ticket");
        assert!(
            r.html.contains("&lt;b&gt;no connection&lt;/b&gt;")
                && r.text.contains("<b>no connection</b>")
        );
        assert!(r.text.contains("https://p.example/x/app"));
        let r = render(
            &Template::TicketNew {
                subject: "<i>x</i>".into(),
                user_email: "alice@example.com".into(),
                category: "technical".into(),
                console_url: None,
            },
            Locale::Zh,
            "Akari",
        );
        assert_eq!(r.subject, "Akari：新工单");
        assert!(r.html.contains("&lt;i&gt;x&lt;/i&gt;") && r.text.contains("alice"));
        let r = render(
            &Template::NodeAlert {
                title: "[告警] hk-1\r\nBcc: x：节点离线".into(),
                text: "[告警] hk-1：节点离线\n节点：hk-1\n\n情况：离线 6 分钟".into(),
            },
            Locale::Zh,
            "Akari",
        );
        assert!(!r.subject.contains('\n') && !r.subject.contains('\r'));
        assert!(r.text.contains("情况：离线 6 分钟"));
        assert!(r.html.contains("节点：hk-1<br>情况"));
        assert_eq!(
            Template::NodeAlert {
                title: String::new(),
                text: String::new()
            }
            .outbox_kind(),
            "node_alert"
        );
    }

    /// Ops: the announcement body is sanitized Markdown in the HTML part
    /// and the source in the text part; raw HTML never gets through.
    #[test]
    fn announcement_template() {
        let r = render(
            &Template::Announcement {
                title: "维护 <b>".into(),
                body_md: "**重要** <script>x</script>\n\n[门户](https://p.example/app)".into(),
                portal_url: None,
            },
            Locale::Zh,
            "Akari",
        );
        assert_eq!(r.subject, "Akari：维护 <b>");
        assert!(r.html.contains("<strong>重要</strong>"));
        assert!(r.html.contains("&lt;script&gt;") && !r.html.contains("<script"));
        assert!(r.html.contains("维护 &lt;b&gt;"));
        assert!(r.html.contains("rel=\"noopener noreferrer\""));
        assert!(r.text.contains("**重要** <script>x</script>"));
    }

    /// The admin's batch notice: subject as written (control characters
    /// dropped), body paragraphs by blank line, all escaped; editable like
    /// every kind ({body} required).
    #[test]
    fn admin_notice_template() {
        let t = Template::AdminNotice {
            subject: "维护\n通知 <b>".into(),
            body: "  今晚 23:00 维护。 \r\n\r\n\n\n<i>谢谢</i>。".into(),
        };
        assert_eq!(t.outbox_kind(), "admin_notice");
        let r = render(&t, Locale::En, "Akari");
        assert_eq!(r.subject, "维护通知 <b>");
        assert!(
            r.text.starts_with("今晚 23:00 维护。\n\n<i>谢谢</i>。\n\n"),
            "{}",
            r.text
        );
        assert!(
            r.html
                .contains("今晚 23:00 维护。<br><br>&lt;i&gt;谢谢&lt;/i&gt;。")
        );
        assert!(!r.html.contains("<i>"));
        assert!(validate("admin_notice", "{site}：{subject}", "{body}").is_ok());
        assert_eq!(
            validate("admin_notice", "{subject}", "固定正文")
                .unwrap_err()
                .code(),
            "mail_template.placeholder_missing"
        );
        let r = render_custom(
            "{site}：{subject}",
            "你好：\n\n{body}",
            &t.values(Locale::Zh),
            Locale::Zh,
            "Akari",
        );
        assert_eq!(r.subject, "Akari：维护通知 <b>");
        assert!(r.text.starts_with("你好：\n\n今晚 23:00 维护。"));
    }

    /// Editable templates: placeholder whitelist, required placeholders,
    /// custom text renders with the values, literal braces survive.
    #[test]
    fn custom_templates_validate_and_render() {
        assert!(validate("register_code", "{site} code", "code {code} {minutes}").is_ok());
        let e = validate("register_code", "x", "code {code} {nope}").unwrap_err();
        assert_eq!(e.code(), "mail_template.placeholder_unknown");
        let e = validate("register_code", "x", "no code here").unwrap_err();
        assert_eq!(e.code(), "mail_template.placeholder_missing");
        assert!(validate("register_code", "x", "{code}").is_ok());
        assert_eq!(
            validate("register_code", "a\nb", "{code}")
                .unwrap_err()
                .code(),
            "mail_template.subject_multiline"
        );
        assert_eq!(
            validate("register_code", "", "{code}").unwrap_err().code(),
            "mail_template.subject_length"
        );
        assert_eq!(
            validate("register_code", "x", " ").unwrap_err().code(),
            "mail_template.body_length"
        );
        assert_eq!(
            validate("register_code", "x", "{code}\u{1}")
                .unwrap_err()
                .code(),
            "mail_template.body_control"
        );
        assert_eq!(
            validate("zzz", "x", "y").unwrap_err().code(),
            "mail_template.kind_unknown"
        );
        // Literal braces and JSON-looking text are kept.
        assert!(validate("test", "x", "{ \"a\": 1 } {Site} {}").is_ok());
        assert_eq!(placeholders_in("{a} {B} {} {c_1}{"), vec!["a", "c_1"]);
        let r = render_custom(
            "Hi {site} {code}",
            "Your code is {code} ({minutes} min).\n\n{code}\n\n{ not a placeholder } {unknown}",
            &Template::RegisterCode {
                code: "9<9".into(),
                minutes: 5,
            }
            .values(Locale::En),
            Locale::En,
            "A&B",
        );
        assert_eq!(r.subject, "Hi A&B 9<9");
        assert!(r.text.contains("Your code is 9<9 (5 min)."));
        assert!(r.text.contains("    9<9\n"));
        assert!(r.text.contains("{ not a placeholder } {unknown}"));
        assert!(r.html.contains("Your code is 9&lt;9 (5 min)."));
        assert!(r.html.contains("letter-spacing:6px"));
        assert!(r.html.contains("{ not a placeholder } {unknown}"));
        assert!(
            r.html
                .contains("<h1 style=\"font-size:18px;margin:0 0 16px\">A&amp;B</h1>")
        );
        // An inline link placeholder is a plain link; a lone one a button.
        let v = Template::PasswordReset {
            link: "https://x/y?a=1&b=2".into(),
            minutes: 1,
        }
        .values(Locale::Zh);
        let r = render_custom("s", "打开 {link} 即可", &v, Locale::Zh, "S");
        assert!(
            r.html.contains(
                "打开 <a href=\"https://x/y?a=1&amp;b=2\">https://x/y?a=1&amp;b=2</a> 即可"
            )
        );
        assert!(r.text.contains("打开 https://x/y?a=1&b=2 即可"));
        let r = render_custom("s", "{link}", &v, Locale::Zh, "S");
        assert!(
            r.html.contains("display:inline-block")
                && r.text.contains("重置密码:\nhttps://x/y?a=1&b=2")
        );
    }

    /// The params of an error: field, line, column.
    fn at(e: &ApiError) -> (String, Option<i64>, Option<i64>) {
        let p = e.params();
        (
            p.get("field")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            p.get("line").and_then(serde_json::Value::as_i64),
            p.get("column").and_then(serde_json::Value::as_i64),
        )
    }

    #[test]
    fn line_col_counts_lines_and_chars() {
        assert_eq!(line_col("abc", 0), (1, 1));
        assert_eq!(line_col("abc", 2), (1, 3));
        assert_eq!(line_col("a\nbc", 3), (2, 2));
        // CRLF is one break; a lone CR is one too (stored text becomes LF).
        assert_eq!(line_col("a\r\nb\r\nc", 6), (3, 1));
        assert_eq!(line_col("a\rb\r\rc", 5), (4, 1));
        // Columns count characters, not bytes.
        let s = "第一行\n你好{x}";
        assert_eq!(line_col(s, s.find('{').unwrap()), (2, 3));
        // Past the end: the position after the last character.
        assert_eq!(line_col("ab\n", 99), (2, 1));
    }

    /// Validation errors say where: field, 1-based line and column.
    #[test]
    fn validation_errors_carry_positions() {
        // Unknown placeholder on line 3 after CRLF breaks and non-ASCII text.
        let e = validate(REG, "s", "你好\r\n{code}\r\n验证 {nope}").unwrap_err();
        assert_eq!(e.code(), "mail_template.placeholder_unknown");
        assert_eq!(e.params()["name"], "nope");
        assert_eq!(at(&e), ("body".into(), Some(3), Some(4)));
        assert!(e.message().contains("line 3, column 4"), "{}", e.message());
        // In the subject (which wins over the body).
        let e = validate(REG, "  é {bad}", "{nope}").unwrap_err();
        assert_eq!(at(&e), ("subject".into(), Some(1), Some(5)));
        assert_eq!(e.params()["name"], "bad");
        // The subject's line break, counted on the text as submitted.
        let e = validate(REG, " 维护\n通知", "{code}").unwrap_err();
        assert_eq!(e.code(), "mail_template.subject_multiline");
        assert_eq!(at(&e), ("subject".into(), Some(1), Some(4)));
        // A control character in the body.
        let e = validate(REG, "s", "{code}\n\nab\u{7}").unwrap_err();
        assert_eq!(e.code(), "mail_template.body_control");
        assert_eq!(at(&e), ("body".into(), Some(3), Some(3)));
        // A missing required placeholder has only the field.
        let e = validate(REG, "s", "no code").unwrap_err();
        assert_eq!(e.code(), "mail_template.placeholder_missing");
        assert_eq!(at(&e), ("body".into(), None, None));
        assert_eq!(e.params()["name"], "code");

        // HTML source.
        let e = validate_html(REG, "<p>\n  <b>码</b> {code}\r\n  <i>{nope}</i></p>").unwrap_err();
        assert_eq!(e.code(), "mail_template.placeholder_unknown");
        assert_eq!(at(&e), ("html_source".into(), Some(3), Some(6)));
        let e = validate_html(REG, "<p>{code}</p>\n<p>中文\u{0}</p>").unwrap_err();
        assert_eq!(e.code(), "mail_template.html_control");
        assert_eq!(at(&e), ("html_source".into(), Some(2), Some(6)));
        let e = validate_html(REG, "<p>{site}</p>").unwrap_err();
        assert_eq!(at(&e), ("html_source".into(), None, None));
        // The earliest forbidden construct, wherever its check runs.
        let e = validate_html(
            REG,
            "<p>{code}</p>\r\n<p>说明</p>\n  <a href=\"java\tscript:x\" onclick=\"y\">a</a><script>",
        )
        .unwrap_err();
        assert_eq!(e.code(), "mail_template.html_forbidden");
        assert_eq!(at(&e), ("html_source".into(), Some(3), Some(12)));
        assert_eq!(e.params()["what"], "javascript: 链接、@import 等");
        let e = validate_html(REG, "{code}\n<p>é</p><SCRIPT>").unwrap_err();
        assert_eq!(at(&e), ("html_source".into(), Some(2), Some(9)));
        let e = validate_html(REG, "{code}\n<img src=x\n  onerror=1>").unwrap_err();
        assert_eq!(at(&e), ("html_source".into(), Some(3), Some(3)));
        let e = validate_html(REG, "{code}<meta http-equiv=refresh>").unwrap_err();
        assert_eq!(at(&e), ("html_source".into(), Some(1), Some(13)));
        assert_eq!(e.params()["what"], "<meta http-equiv>");
    }
}
