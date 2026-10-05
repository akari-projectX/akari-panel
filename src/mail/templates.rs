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
}

/// Every template kind (= `mail_outbox.kind` / `mail_templates.kind`).
pub const KINDS: [&str; 15] = [
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
];

impl Template {
    pub fn outbox_kind(&self) -> &'static str {
        match self {
            Template::RegisterCode { .. } => "register_code",
            Template::RegisterExists { .. } => "register_exists",
            Template::EmailCode { .. } => "email_code",
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
        }
    }

    /// Sample values of a kind (the editor's preview and test mail).
    pub fn sample(kind: &str) -> Option<Template> {
        let t = DateTime::parse_from_rfc3339("2026-10-02T08:30:00Z")
            .ok()?
            .with_timezone(&Utc);
        let portal = Some("https://panel.example/prefix/app".to_string());
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
            "password_reset" => Template::PasswordReset {
                link: "https://panel.example/prefix/app/reset#token=example".into(),
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
const ANNOUNCEMENT_PH: [Placeholder; 3] = [
    ph("title", "公告标题"),
    ph("body", "公告正文（已渲染）"),
    ph("portal_url", "用户门户链接（按钮；未配置主域名时为空）"),
];

/// The placeholder whitelist of a kind (besides `COMMON`) and the ones a
/// template must contain. None = unknown kind.
pub fn spec(kind: &str) -> Option<(&'static [Placeholder], &'static [&'static str])> {
    Some(match kind {
        "register_code" | "email_code" => (&CODE_PH, &["code"]),
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
        _ => return None,
    })
}

/// Chinese label of a kind (the editor's list).
pub fn kind_label(kind: &str) -> &'static str {
    match kind {
        "register_code" => "注册验证码",
        "register_exists" => "注册：邮箱已注册",
        "email_code" => "邮箱验证码",
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
            Template::RegisterCode { code, minutes } | Template::EmailCode { code, minutes } => {
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
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Validation and rendering
// ---------------------------------------------------------------------------

/// Longest subject / body an admin may store (characters).
pub const MAX_SUBJECT: usize = 200;
pub const MAX_TEMPLATE_BODY: usize = 20_000;

/// The `{name}` tokens of a template text (lower-case letters, digits,
/// underscores). Anything else in braces is literal text.
pub fn placeholders_in(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
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
                    out.push(name);
                    rest = &after[close + 1..];
                } else {
                    rest = after;
                }
            }
            None => break,
        }
    }
    out
}

/// Check an admin's template for a kind: lengths, a one-line subject, only
/// whitelisted placeholders, every required one present.
pub fn validate(kind: &str, subject: &str, body: &str) -> Result<(), ApiError> {
    let Some((allowed, required)) = spec(kind) else {
        return Err(bad_request!(
            "mail_template.kind_unknown",
            "unknown template kind: {kind}",
            kind = kind
        ));
    };
    let subject = subject.trim();
    if subject.is_empty() || subject.chars().count() > MAX_SUBJECT {
        return Err(bad_request!(
            "mail_template.subject_length",
            "subject must be 1-{max} characters",
            max = MAX_SUBJECT
        ));
    }
    if subject.chars().any(char::is_control) {
        return Err(bad_request!(
            "mail_template.subject_multiline",
            "subject must be a single line"
        ));
    }
    if body.trim().is_empty() || body.chars().count() > MAX_TEMPLATE_BODY {
        return Err(bad_request!(
            "mail_template.body_length",
            "body must be 1-{max} characters",
            max = MAX_TEMPLATE_BODY
        ));
    }
    if body
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
    {
        return Err(bad_request!(
            "mail_template.body_control",
            "body must not contain control characters"
        ));
    }
    let known = |name: &str| name == "site" || allowed.iter().any(|p| p.name == name);
    for name in placeholders_in(subject)
        .into_iter()
        .chain(placeholders_in(body))
    {
        if !known(name) {
            return Err(bad_request!(
                "mail_template.placeholder_unknown",
                "unknown placeholder {{{name}}}",
                name = name
            ));
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
                "the template must contain {{{name}}}",
                name = *r
            ));
        }
    }
    Ok(())
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
                "ticket_reply"
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
}
