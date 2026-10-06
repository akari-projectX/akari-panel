//! R40 (W24): pluggable payment providers. A provider KIND (`ProviderKind`,
//! registered in `KINDS`) describes and validates the configuration of a
//! payment method and builds its client; a payment METHOD (a row of
//! `payment_methods`, `methods.rs`) is one configured instance of a kind —
//! several per kind are allowed (two Alipay merchants). The built client is
//! a `PaymentProvider`.
//!
//! The money invariants live OUTSIDE the providers and do not change: the
//! amount is computed in SQL and copied into the order (the client never
//! submits it), every payment goes through `orders::apply_mark_paid`
//! (exactly once), and only the order's own method may settle it (a
//! verified notify of method A never pays an order of method B,
//! `api::handle_notify`). A provider only talks to its gateway: create a
//! trade, query it, close it, verify a notify, test the configuration.
//!
//! Alipay Face-to-Face (`alipay.rs`, kind `alipay_f2f`) is the first kind.
//! Adding a kind = implement both traits, add it to `KINDS`, extend the
//! `payment_methods.kind` CHECK (new migration) and the SPA's form.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::auth::ApiError;

/// A boxed, sendable future (object-safe async methods without a crate).
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A failed gateway call. Messages carry no secrets.
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("gateway unreachable: {0}")]
    Transport(String),
    #[error("gateway answered HTTP {0}")]
    Status(u16),
    #[error("malformed gateway response: {0}")]
    Malformed(&'static str),
    #[error("gateway response signature invalid")]
    BadSignature,
    #[error("gateway error {code} {sub_code}: {sub_msg}")]
    Business {
        code: String,
        sub_code: String,
        sub_msg: String,
        /// The error response carried a signature that verified.
        verified: bool,
    },
    #[error("not supported by this payment method")]
    Unsupported,
}

/// What a trade query found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Query {
    /// No trade yet (the payer has not started).
    NotExist,
    Trade {
        /// The provider's own status text (logged, shown to admins).
        status: String,
        /// The status means "paid" (Alipay: TRADE_SUCCESS/TRADE_FINISHED).
        paid: bool,
        /// The provider's trade number.
        trade_no: String,
        /// What the provider says was paid, integer cents.
        total_cents: Option<i64>,
    },
}

/// A refund through the provider (the original payment route). The
/// request number makes it idempotent: the same number never refunds twice
/// and a retry of a refund that went through answers success again.
#[derive(Debug, Clone)]
pub struct RefundReq<'a> {
    pub out_trade_no: &'a str,
    pub out_request_no: &'a str,
    pub cents: i64,
    pub reason: &'a str,
}

/// What a refund (or a refund query) found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefundState {
    /// Refunded (this request number), integer cents if the provider
    /// says how much.
    Refunded { cents: Option<i64> },
    /// The provider knows no refund with this request number.
    NotFound,
}

/// What a close found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Close {
    Closed,
    /// Nothing to close (never started).
    NotExist,
}

/// How the payer pays a created trade.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checkout {
    /// A QR payload the portal renders (Alipay F2F).
    Qr(String),
    /// A URL the payer is sent to.
    Redirect(String),
}

/// A trade to create (the amount comes from the order row).
#[derive(Debug, Clone)]
pub struct CreateReq<'a> {
    pub out_trade_no: &'a str,
    pub amount_cents: i64,
    pub subject: &'a str,
    /// This method's notify URL (contains the route prefix: never log it).
    pub notify_url: &'a str,
}

/// A verified asynchronous notification.
#[derive(Debug, Clone, PartialEq)]
pub struct NotifyEvent {
    pub out_trade_no: String,
    pub trade_no: Option<String>,
    pub status: String,
    pub paid: bool,
    pub total_cents: Option<i64>,
    /// Redacted parameters for `payment_events` (no signature).
    pub params: Value,
}

/// The provider's verdict on a notify body.
#[derive(Debug, Clone, PartialEq)]
pub enum NotifyCheck {
    Verified(NotifyEvent),
    /// Refused. `verified`: the signature itself was valid (e.g. another
    /// merchant's app id). `reason` is a short machine word.
    Rejected {
        verified: bool,
        reason: &'static str,
        out_trade_no: Option<String>,
        status: Option<String>,
        params: Option<Value>,
    },
}

/// The outcome of 测试连接.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TestOutcome {
    pub ok: bool,
    /// A machine word (kind-specific, e.g. keys_ok / app_key_rejected).
    pub result: &'static str,
    /// Chinese explanation for the admin.
    pub message: String,
    pub code: Option<String>,
    pub sub_code: Option<String>,
}

/// One configured payment method's gateway client.
pub trait PaymentProvider: Send + Sync + std::fmt::Debug {
    /// The kind id (`ProviderKind::id`).
    fn kind(&self) -> &'static str;
    /// Minutes a created trade (and its order) stays payable.
    fn order_timeout_minutes(&self) -> u32;
    /// Create the trade of an order.
    fn create<'a>(&'a self, req: CreateReq<'a>) -> BoxFut<'a, Result<Checkout, CallError>>;
    /// Query a trade by our out_trade_no.
    fn query<'a>(&'a self, out_trade_no: &'a str) -> BoxFut<'a, Result<Query, CallError>>;
    /// Close an unpaid trade.
    fn close<'a>(&'a self, out_trade_no: &'a str) -> BoxFut<'a, Result<Close, CallError>>;
    /// Verify an asynchronous notify (raw body).
    fn verify_notify(&self, body: &[u8]) -> NotifyCheck;
    /// The body the provider expects when a notify was accepted.
    fn notify_ack(&self) -> &'static str;
    /// The method allows refunds through the provider (the channel's
    /// "allow original-route refunds" switch).
    fn refunds(&self) -> bool {
        false
    }
    /// Refund through the provider (idempotent per `out_request_no`).
    fn refund<'a>(&'a self, _req: RefundReq<'a>) -> BoxFut<'a, Result<RefundState, CallError>> {
        Box::pin(async { Err(CallError::Unsupported) })
    }
    /// Look a refund up by its request number (reconciliation).
    fn refund_query<'a>(
        &'a self,
        _out_trade_no: &'a str,
        _out_request_no: &'a str,
    ) -> BoxFut<'a, Result<RefundState, CallError>> {
        Box::pin(async { Err(CallError::Unsupported) })
    }
    /// 测试连接: one harmless authenticated call.
    fn test_connection(&self) -> BoxFut<'_, TestOutcome>;
}

/// A validated configuration of a method.
#[derive(Debug, Clone)]
pub struct Validated {
    /// Non-secret fields, stored as plain JSON.
    pub config: Value,
    /// Every secret field (merged with the kept ones), stored sealed.
    pub secrets: Value,
    /// Names of the secret fields this change replaced (audited as
    /// "changed").
    pub changed_secrets: Vec<&'static str>,
}

/// A provider kind: schema, validation, client construction.
pub trait ProviderKind: Sync {
    fn id(&self) -> &'static str;
    /// Chinese name for the admin.
    fn label(&self) -> &'static str;
    /// The admin form: `[{name, label, type, secret, required, …}]`.
    fn schema(&self) -> Value;
    /// Validate a submitted configuration. `input` = the form's `config`
    /// object (secret fields absent/null = keep); `prev` = the stored
    /// (config, secrets) when editing. `complete` = the method is being
    /// enabled (every required field must then be present).
    fn validate(
        &self,
        input: &Value,
        prev: Option<(&Value, &Value)>,
        complete: bool,
    ) -> Result<Validated, ApiError>;
    /// Build the client (None-free: an incomplete configuration is Err).
    fn build(&self, config: &Value, secrets: &Value) -> Result<Arc<dyn PaymentProvider>, String>;
    /// Admin view of the stored configuration: non-secret fields plus
    /// derived public facts (fingerprints, `<secret>_set` flags). Never a
    /// secret.
    fn view(&self, config: &Value, secrets: Option<&Value>) -> Value;
    /// The out_trade_no a notify body claims (legacy route: find the
    /// order before verifying with its method). Unverified.
    fn peek_out_trade_no(&self, body: &[u8]) -> Option<String>;
}

/// Every provider kind.
pub static KINDS: &[&dyn ProviderKind] = &[&super::alipay::AlipayKind];

pub fn kind(id: &str) -> Option<&'static dyn ProviderKind> {
    KINDS.iter().copied().find(|k| k.id() == id)
}

/// A test provider (unit tests of the trait plumbing and the method
/// registry): deterministic answers, records calls.
#[cfg(test)]
pub mod mock {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    pub struct MockProvider {
        pub calls: Mutex<Vec<String>>,
        pub paid: Mutex<std::collections::HashMap<String, i64>>,
    }

    impl PaymentProvider for MockProvider {
        fn kind(&self) -> &'static str {
            "mock"
        }
        fn order_timeout_minutes(&self) -> u32 {
            15
        }
        fn create<'a>(&'a self, req: CreateReq<'a>) -> BoxFut<'a, Result<Checkout, CallError>> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("create {}", req.out_trade_no));
                Ok(Checkout::Redirect(format!(
                    "https://pay.example/{}",
                    req.out_trade_no
                )))
            })
        }
        fn query<'a>(&'a self, otn: &'a str) -> BoxFut<'a, Result<Query, CallError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(format!("query {otn}"));
                Ok(match self.paid.lock().unwrap().get(otn) {
                    Some(c) => Query::Trade {
                        status: "PAID".into(),
                        paid: true,
                        trade_no: format!("M{otn}"),
                        total_cents: Some(*c),
                    },
                    None => Query::NotExist,
                })
            })
        }
        fn close<'a>(&'a self, otn: &'a str) -> BoxFut<'a, Result<Close, CallError>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(format!("close {otn}"));
                Ok(Close::NotExist)
            })
        }
        fn verify_notify(&self, body: &[u8]) -> NotifyCheck {
            // "otn:cents" is a valid notify; anything else is not.
            let s = std::str::from_utf8(body).unwrap_or_default();
            match s
                .split_once(':')
                .and_then(|(o, c)| Some((o, c.parse::<i64>().ok()?)))
            {
                Some((o, c)) => NotifyCheck::Verified(NotifyEvent {
                    out_trade_no: o.into(),
                    trade_no: Some(format!("M{o}")),
                    status: "PAID".into(),
                    paid: true,
                    total_cents: Some(c),
                    params: serde_json::json!({}),
                }),
                None => NotifyCheck::Rejected {
                    verified: false,
                    reason: "bad_signature",
                    out_trade_no: None,
                    status: None,
                    params: None,
                },
            }
        }
        fn notify_ack(&self) -> &'static str {
            "ok"
        }
        fn test_connection(&self) -> BoxFut<'_, TestOutcome> {
            Box::pin(async {
                TestOutcome {
                    ok: true,
                    result: "keys_ok",
                    message: "ok".into(),
                    code: None,
                    sub_code: None,
                }
            })
        }
    }

    #[tokio::test]
    async fn trait_objects_dispatch() {
        let m: Arc<dyn PaymentProvider> = Arc::new(MockProvider::default());
        let c = m
            .create(CreateReq {
                out_trade_no: "AK1",
                amount_cents: 100,
                subject: "s",
                notify_url: "https://x/n",
            })
            .await
            .unwrap();
        assert_eq!(c, Checkout::Redirect("https://pay.example/AK1".into()));
        assert_eq!(m.query("AK1").await.unwrap(), Query::NotExist);
        assert_eq!(m.close("AK1").await.unwrap(), Close::NotExist);
        assert!(!m.refunds());
        assert!(matches!(
            m.refund(RefundReq {
                out_trade_no: "AK1",
                out_request_no: "R1",
                cents: 1,
                reason: "r",
            })
            .await,
            Err(CallError::Unsupported)
        ));
        assert!(matches!(
            m.refund_query("AK1", "R1").await,
            Err(CallError::Unsupported)
        ));
        assert!(matches!(
            m.verify_notify(b"AK1:100"),
            NotifyCheck::Verified(_)
        ));
        assert!(matches!(
            m.verify_notify(b"junk"),
            NotifyCheck::Rejected { .. }
        ));
        assert!(m.test_connection().await.ok);
        assert_eq!(m.notify_ack(), "ok");
        // The registry knows Alipay F2F and nothing unknown.
        assert_eq!(kind("alipay_f2f").map(|k| k.id()), Some("alipay_f2f"));
        assert!(kind("paypal").is_none());
        for k in KINDS {
            assert!(k.schema().as_array().is_some_and(|a| !a.is_empty()));
        }
    }
}
