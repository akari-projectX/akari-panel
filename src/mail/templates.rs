//! Email templates (W15): every mail the panel sends, in Chinese and
//! English (the recipient's `users.locale`; the request's locale before an
//! account exists). Each renders to a subject, a plain-text body and a
//! simple HTML body with inline styles only — no remote assets (images,
//! fonts, trackers), no scripts. Every interpolated value is HTML-escaped
//! in the HTML part; subjects never carry user-controlled text except the
//! site name (from the admin's settings).

use chrono::{DateTime, Utc};

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
        user_login: String,
        category: String,
        console_url: Option<String>,
    },
    /// W17: a node alert (to the alert recipients; text rendered by
    /// `alerts::channels::Message`, Chinese like the console).
    NodeAlert {
        title: String,
        text: String,
    },
}

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
        }
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
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
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

/// One paragraph of the body: plain text and its HTML form.
enum Part {
    P(String),
    /// A large, monospaced value (verification code).
    Code(String),
    /// A link: label + URL (the URL is shown in full in the text part).
    Link(String, String),
}

fn assemble(site: &str, locale: Locale, subject: String, parts: Vec<Part>) -> Rendered {
    // Defense in depth (the site name is validated when saved; lettre
    // encodes headers anyway): a subject is one line of text.
    let subject: String = subject
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let footer = match locale {
        Locale::Zh => format!("此邮件由 {site} 自动发送，请勿直接回复。"),
        Locale::En => {
            format!("This message was sent automatically by {site}. Please do not reply.")
        }
    };
    let mut text = String::new();
    let mut html = String::new();
    let lang = match locale {
        Locale::Zh => "zh-CN",
        Locale::En => "en",
    };
    html.push_str(&format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width\"><title>{}</title></head>\
         <body style=\"margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,\
         'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a\">\
         <div style=\"max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;\
         padding:24px\"><h1 style=\"font-size:18px;margin:0 0 16px\">{}</h1>",
        esc(&subject),
        esc(site)
    ));
    for p in &parts {
        match p {
            Part::P(s) => {
                text.push_str(s);
                text.push_str("\n\n");
                html.push_str(&format!(
                    "<p style=\"font-size:14px;line-height:1.6;margin:0 0 12px\">{}</p>",
                    esc(s)
                ));
            }
            Part::Code(c) => {
                text.push_str(&format!("    {c}\n\n"));
                html.push_str(&format!(
                    "<p style=\"font-size:28px;font-weight:600;letter-spacing:6px;\
                     font-family:Menlo,Consolas,monospace;margin:8px 0 16px\">{}</p>",
                    esc(c)
                ));
            }
            Part::Link(label, url) => {
                text.push_str(&format!("{label}:\n{url}\n\n"));
                html.push_str(&format!(
                    "<p style=\"margin:8px 0 16px\"><a href=\"{}\" style=\"display:inline-block;\
                     background:#1a1a1a;color:#ffffff;text-decoration:none;padding:10px 16px;\
                     border-radius:6px;font-size:14px\">{}</a></p>\
                     <p style=\"font-size:12px;color:#666;word-break:break-all;margin:0 0 12px\">{}</p>",
                    esc(url),
                    esc(label),
                    esc(url)
                ));
            }
        }
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

/// Render `t` for `locale`; `site` is the sender name (系统设置 → 邮件,
/// default "Akari").
pub fn render(t: &Template, locale: Locale, site: &str) -> Rendered {
    use Locale::*;
    use Part::*;
    let zh = locale == Zh;
    let (subject, parts) = match t {
        Template::RegisterCode { code, minutes } => (
            if zh {
                format!("{site} 注册验证码")
            } else {
                format!("Your {site} sign-up code")
            },
            vec![
                P(if zh {
                    "你正在注册账号，验证码：".into()
                } else {
                    "Use this code to finish signing up:".into()
                }),
                Code(code.clone()),
                P(if zh {
                    format!("验证码 {minutes} 分钟内有效，只能使用一次。如果不是你本人操作，请忽略此邮件。")
                } else {
                    format!("The code is valid for {minutes} minutes and can be used once. If you did not request it, ignore this message.")
                }),
            ],
        ),
        Template::RegisterExists {
            reset_enabled,
            login_url,
        } => {
            let mut parts = vec![P(if zh {
                "有人（可能是你）尝试用这个邮箱注册账号，但该邮箱已经注册过了，因此没有创建新账号。"
                    .into()
            } else {
                "Someone (probably you) tried to sign up with this address, but it already has an account, so no new account was created.".into()
            })];
            parts.push(P(match (zh, reset_enabled) {
                (true, true) => "如果忘记了密码，可以在登录页使用「忘记密码」重置。".into(),
                (true, false) => "如果忘记了密码，请联系管理员。".into(),
                (false, true) => {
                    "If you forgot your password, use \"Forgot password\" on the sign-in page."
                        .into()
                }
                (false, false) => "If you forgot your password, contact the administrator.".into(),
            }));
            if let Some(u) = login_url {
                parts.push(Link(
                    if zh { "前往登录" } else { "Sign in" }.into(),
                    u.clone(),
                ));
            }
            parts.push(P(if zh {
                "如果不是你本人操作，请忽略此邮件，你的账号不受影响。".into()
            } else {
                "If this was not you, ignore this message; your account is unaffected.".into()
            }));
            (
                if zh {
                    format!("{site}：该邮箱已注册")
                } else {
                    format!("{site}: this address already has an account")
                },
                parts,
            )
        }
        Template::EmailCode { code, minutes } => (
            if zh {
                format!("{site} 邮箱验证码")
            } else {
                format!("Your {site} email verification code")
            },
            vec![
                P(if zh {
                    "你正在为账号绑定这个邮箱，验证码：".into()
                } else {
                    "Use this code to confirm this address for your account:".into()
                }),
                Code(code.clone()),
                P(if zh {
                    format!("验证码 {minutes} 分钟内有效，只能使用一次。如果不是你本人操作，请忽略此邮件。")
                } else {
                    format!("The code is valid for {minutes} minutes and can be used once. If you did not request it, ignore this message.")
                }),
            ],
        ),
        Template::PasswordReset { link, minutes } => (
            if zh {
                format!("{site} 重置密码")
            } else {
                format!("Reset your {site} password")
            },
            vec![
                P(if zh {
                    "我们收到了重置你账号密码的请求。点击下面的链接设置新密码：".into()
                } else {
                    "We received a request to reset your password. Open the link below to choose a new one:".into()
                }),
                Link(
                    if zh { "重置密码" } else { "Reset password" }.into(),
                    link.clone(),
                ),
                P(if zh {
                    format!("链接 {minutes} 分钟内有效，只能使用一次；重置后所有已登录的设备都会退出。如果不是你本人操作，请忽略此邮件，密码不会改变。")
                } else {
                    format!("The link is valid for {minutes} minutes and works once; resetting signs out every device. If you did not request it, ignore this message — your password stays the same.")
                }),
            ],
        ),
        Template::OrderPaid {
            order_no,
            plan_name,
            money,
            paid_at,
            expires_at,
        } => {
            let mut parts = vec![
                P(if zh {
                    "感谢购买，你的订单已支付成功：".into()
                } else {
                    "Thank you for your purchase. Your order has been paid:".into()
                }),
                P(if zh {
                    format!("订单号：{order_no}")
                } else {
                    format!("Order: {order_no}")
                }),
                P(if zh {
                    format!("套餐：{plan_name}")
                } else {
                    format!("Plan: {plan_name}")
                }),
                P(if zh {
                    format!("价格：¥{}", yuan(money.list_cents))
                } else {
                    format!("Price: CNY {}", yuan(money.list_cents))
                }),
            ];
            for (cents, zh_label, en_label) in [
                (money.discount_cents, "优惠券", "Coupon"),
                (money.credit_cents, "原套餐抵扣", "Plan switch credit"),
                (money.balance_cents, "余额支付", "Paid from balance"),
            ] {
                if cents > 0 {
                    parts.push(P(if zh {
                        format!("{zh_label}：-¥{}", yuan(cents))
                    } else {
                        format!("{en_label}: -CNY {}", yuan(cents))
                    }));
                }
            }
            parts.push(P(if zh {
                format!("实付：¥{}", yuan(money.paid_cents))
            } else {
                format!("Paid: CNY {}", yuan(money.paid_cents))
            }));
            parts.push(P(if zh {
                format!("支付时间：{}", when(paid_at))
            } else {
                format!("Paid at: {}", when(paid_at))
            }));
            if let Some(e) = expires_at {
                parts.push(P(if zh {
                    format!("套餐到期：{}", when(e))
                } else {
                    format!("Plan expires: {}", when(e))
                }));
            }
            (
                if zh {
                    format!("{site} 支付成功")
                } else {
                    format!("{site} payment received")
                },
                parts,
            )
        }
        Template::ExpirySoon {
            expires_at,
            portal_url,
        } => {
            let mut parts = vec![P(if zh {
                format!(
                    "你的套餐将于 {} 到期。到期后节点与订阅将停止服务，请及时续费。",
                    when(expires_at)
                )
            } else {
                format!(
                    "Your plan expires on {}. After that your nodes and subscription stop working; renew in time to keep them.",
                    when(expires_at)
                )
            })];
            if let Some(u) = portal_url {
                parts.push(Link(
                    if zh { "前往续费" } else { "Renew" }.into(),
                    u.clone(),
                ));
            }
            (
                if zh {
                    format!("{site}：套餐即将到期")
                } else {
                    format!("{site}: your plan expires soon")
                },
                parts,
            )
        }
        Template::Expired {
            expires_at,
            portal_url,
        } => {
            let mut parts = vec![P(if zh {
                format!(
                    "你的套餐已于 {} 到期，节点与订阅已停止服务。续费或购买套餐后即可恢复使用。",
                    when(expires_at)
                )
            } else {
                format!(
                    "Your plan expired on {}; your nodes and subscription have stopped. Renew or buy a plan to restore them.",
                    when(expires_at)
                )
            })];
            if let Some(u) = portal_url {
                parts.push(Link(
                    if zh { "前往续费" } else { "Renew" }.into(),
                    u.clone(),
                ));
            }
            (
                if zh {
                    format!("{site}：套餐已到期")
                } else {
                    format!("{site}: your plan has expired")
                },
                parts,
            )
        }
        Template::Quota {
            percent,
            used_bytes,
            limit_bytes,
            portal_url,
        } => {
            let used = human_bytes(*used_bytes);
            let limit = human_bytes(*limit_bytes);
            let full = *percent >= 100;
            let mut parts = vec![P(match (zh, full) {
                (true, true) => format!("你本周期的流量已用完（{used} / {limit}），节点与订阅已暂停。流量重置或续费/升级套餐后即可恢复。"),
                (true, false) => format!("你本周期的流量已使用 {percent}%（{used} / {limit}）。用完后节点与订阅将暂停。"),
                (false, true) => format!("You have used all of this period's traffic ({used} / {limit}); your nodes and subscription are paused until the traffic resets or you renew/upgrade."),
                (false, false) => format!("You have used {percent}% of this period's traffic ({used} / {limit}). When it runs out your nodes and subscription pause."),
            })];
            if let Some(u) = portal_url {
                parts.push(Link(
                    if zh { "查看账户" } else { "View account" }.into(),
                    u.clone(),
                ));
            }
            (
                match (zh, full) {
                    (true, true) => format!("{site}：流量已用完"),
                    (true, false) => format!("{site}：流量已使用 {percent}%"),
                    (false, true) => format!("{site}: traffic used up"),
                    (false, false) => format!("{site}: {percent}% of your traffic used"),
                },
                parts,
            )
        }
        Template::Test => (
            if zh {
                format!("{site} 测试邮件")
            } else {
                format!("{site} test message")
            },
            vec![P(if zh {
                "这是一封测试邮件：面板的 SMTP 设置可以正常发信。".into()
            } else {
                "This is a test message: the panel's SMTP settings work.".into()
            })],
        ),
        Template::TicketReply {
            subject,
            portal_url,
        } => {
            let mut parts = vec![
                P(if zh {
                    "客服回复了你的工单：".into()
                } else {
                    "Support replied to your ticket:".into()
                }),
                P(subject.clone()),
                P(if zh {
                    "请登录用户门户查看回复并继续沟通。".into()
                } else {
                    "Sign in to the portal to read the reply and answer.".into()
                }),
            ];
            if let Some(u) = portal_url {
                parts.push(Link(
                    if zh { "查看工单" } else { "View ticket" }.into(),
                    u.clone(),
                ));
            }
            (
                if zh {
                    format!("{site}：工单有新回复")
                } else {
                    format!("{site}: new reply to your ticket")
                },
                parts,
            )
        }
        Template::TicketNew {
            subject,
            user_login,
            category,
            console_url,
        } => {
            let mut parts = vec![
                P(format!("用户 {user_login} 提交了新工单（{category}）：")),
                P(subject.clone()),
            ];
            if let Some(u) = console_url {
                parts.push(Link("前往工单管理".into(), u.clone()));
            }
            (format!("{site}：新工单"), parts)
        }
        // Node names are admin-controlled (not customer text); control
        // characters are dropped all the same.
        Template::NodeAlert { title, text } => (
            format!(
                "{site}：{}",
                title
                    .chars()
                    .filter(|c| !c.is_control())
                    .collect::<String>()
            ),
            text.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| P(l.to_string()))
                .collect(),
        ),
    };
    assemble(site, locale, subject, parts)
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
        let r = render(&all("1")[5], Locale::Zh, "Akari");
        assert!(r.html.contains("&lt;b&gt;Pro&lt;/b&gt;"));
        assert!(r.text.contains("<b>Pro</b>"), "plain text is not escaped");
        assert!(r.text.contains("实付：¥12.34"));
        assert!(r.text.contains("价格：¥20.00") && r.text.contains("优惠券：-¥5.00"));
        assert!(r.text.contains("余额支付：-¥2.66") && !r.text.contains("原套餐抵扣"));
        assert!(r.text.contains("2026-10-02 08:30 UTC"));
        let r = render(&all("1")[4], Locale::En, "Akari");
        assert!(r
            .html
            .contains("href=\"https://p.example/x/app/reset#token=abc&amp;x=&lt;y&gt;\""));
        assert!(r
            .text
            .contains("https://p.example/x/app/reset#token=abc&x=<y>"));
        let r = render(&all("1")[8], Locale::En, "Akari");
        assert!(r.subject.contains("80%"));
        assert!(r.text.contains("80.00 GiB / 100.00 GiB"));
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
                user_login: "alice".into(),
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
        assert_eq!(
            Template::NodeAlert {
                title: String::new(),
                text: String::new()
            }
            .outbox_kind(),
            "node_alert"
        );
    }
}
