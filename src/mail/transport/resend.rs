//! Resend provider (W31): `POST <base>/emails` over HTTPS with the API key
//! as a bearer token. No SMTP port needed (useful where the host blocks
//! outbound 25/465/587). The sender address must be on a domain verified in
//! the Resend dashboard.
//!
//! Errors: 401/403/404/422 and other 4xx are permanent (a bad key, an
//! unverified domain, an invalid message: retrying cannot help), 429 and
//! 5xx and network failures are retried by the outbox.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;

use super::{DiagFuture, OutMsg, Provider, SendError, SendFuture, Transport, open_secret};
use crate::mail::MailSettings;
use crate::mail::diagnose::{self as d, Code, Report, Status, clip};
use crate::masterkey::Keys;

/// Upper bound of one API call.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const DIAG_STEPS: &[&str] = &["config", "dns", "tcp", "tls", "auth", "send"];

pub struct ResendProvider {
    /// API origin: `https://api.resend.com` (tests: a loopback mock).
    pub base: &'static str,
}

pub static RESEND: ResendProvider = ResendProvider {
    base: "https://api.resend.com",
};

struct Api {
    url: String,
    key: String,
    from: String,
}

/// Resend's error body: `{"statusCode", "name", "message"}`.
#[derive(Deserialize, Default)]
struct ApiError {
    #[serde(default)]
    name: String,
    #[serde(default)]
    message: String,
}

/// The outcome of one call: Ok, or (HTTP status (0 = no answer), detail).
async fn call(api: &Api, msg: &OutMsg) -> Result<(), (u16, String)> {
    let body = json!({
        "from": api.from,
        "to": [msg.to],
        "subject": msg.subject,
        "text": msg.text,
        "html": msg.html,
    });
    let body = serde_json::to_vec(&body).map_err(|e| (0, e.to_string()))?;
    let (status, resp) = crate::billing::http::post(
        &api.url,
        "application/json",
        &[("authorization", format!("Bearer {}", api.key))],
        body,
        CALL_TIMEOUT,
    )
    .await
    .map_err(|e| (0, e))?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    let e: ApiError = serde_json::from_slice(&resp).unwrap_or_default();
    let detail = match (e.name.is_empty(), e.message.is_empty()) {
        (_, false) if !e.name.is_empty() => format!("{}: {}", e.name, e.message),
        (_, false) => e.message,
        (false, true) => e.name,
        (true, true) => String::from_utf8_lossy(&resp).chars().take(200).collect(),
    };
    Err((status, clip(&detail)))
}

/// 429, 5xx and no answer can be retried.
fn retryable(status: u16) -> bool {
    status == 0 || status == 408 || status == 429 || status >= 500
}

impl Transport for Api {
    fn send<'a>(&'a self, msg: &'a OutMsg) -> SendFuture<'a> {
        Box::pin(async move {
            call(self, msg).await.map_err(|(status, detail)| SendError {
                permanent: !retryable(status),
                message: if status == 0 {
                    format!("resend: {detail}")
                } else {
                    format!("resend: HTTP {status}: {detail}")
                },
            })
        })
    }
}

impl ResendProvider {
    fn api(&self, s: &MailSettings, keys: &Keys) -> Result<Api, String> {
        let blob = s.api_key_enc.as_deref().ok_or("no Resend API key")?;
        let from_addr = s.from_addr.as_deref().ok_or("no sender address")?;
        let key = open_secret(keys, crate::mail::RESEND_AAD, blob, "Resend API key")?;
        // RFC 5322 display name, quoted (quotes/backslashes escaped).
        let name = s.sender_name().replace('\\', "\\\\").replace('"', "\\\"");
        Ok(Api {
            url: format!("{}/emails", self.base),
            key,
            from: format!("\"{name}\" <{from_addr}>"),
        })
    }

    async fn run(&self, s: &MailSettings, keys: &Keys, msg: &OutMsg) -> Report {
        let mut r = Report::new("resend");
        let t = Instant::now();
        if s.api_key_enc.is_none() || s.from_addr.is_none() {
            let (missing, missing_zh) = if s.api_key_enc.is_none() {
                ("the API key", "API 密钥")
            } else {
                ("the sender address", "发件地址")
            };
            r.push(
                "config",
                Status::Fail,
                t,
                Code::Incomplete,
                vec![
                    ("missing", missing.into()),
                    ("missing_zh", missing_zh.into()),
                ],
            );
            r.not_reached(DIAG_STEPS);
            return r;
        }
        let api = match self.api(s, keys) {
            Ok(a) => a,
            Err(_) => {
                r.push("config", Status::Fail, t, Code::SecretUnreadable, vec![]);
                r.not_reached(DIAG_STEPS);
                return r;
            }
        };
        r.push(
            "config",
            Status::Ok,
            t,
            Code::ConfigOk,
            vec![("provider", "Resend".into())],
        );
        // The path to the API host (the call below opens its own connection).
        let Ok(uri) = self.base.parse::<hyper::Uri>() else {
            r.not_reached(DIAG_STEPS);
            return r;
        };
        let host = uri
            .host()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        let https = uri.scheme_str() == Some("https");
        let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });
        let Some(addrs) = d::dns(&mut r, &host, port).await else {
            r.not_reached(DIAG_STEPS);
            return r;
        };
        let Some(tcp) = d::tcp(&mut r, &addrs, port).await else {
            r.not_reached(DIAG_STEPS);
            return r;
        };
        if https {
            if d::tls(&mut r, tcp, &host, "https", None).await.is_none() {
                r.not_reached(DIAG_STEPS);
                return r;
            }
        } else {
            drop(tcp);
            r.push(
                "tls",
                Status::Skip,
                Instant::now(),
                Code::TlsSkipped,
                vec![],
            );
        }
        // The send itself; its answer also tells whether the key is good.
        let t = Instant::now();
        match call(&api, msg).await {
            Ok(()) => {
                r.push(
                    "auth",
                    Status::Ok,
                    t,
                    Code::AuthOk,
                    vec![("mechanism", "API key".into())],
                );
                r.push(
                    "send",
                    Status::Ok,
                    t,
                    Code::SendOk,
                    vec![("to", msg.to.clone())],
                );
            }
            Err((status, detail)) => {
                let low = detail.to_ascii_lowercase();
                let params = vec![("status", status.to_string()), ("detail", detail)];
                let domain = low.contains("domain") && (status == 403 || status == 422);
                if (status == 401 || status == 403) && !domain {
                    r.push("auth", Status::Fail, t, Code::ApiUnauthorized, params);
                    r.not_reached(DIAG_STEPS);
                    return r;
                }
                r.push(
                    "auth",
                    Status::Ok,
                    t,
                    Code::AuthOk,
                    vec![("mechanism", "API key".into())],
                );
                let code = match status {
                    0 => Code::SendFailed,
                    429 => Code::ApiRateLimited,
                    s if s >= 500 => Code::ApiServerError,
                    _ if domain => Code::ApiDomainUnverified,
                    400 | 422 => Code::ApiValidation,
                    _ => Code::ApiUnexpected,
                };
                r.push("send", Status::Fail, t, code, params);
            }
        }
        r
    }
}

impl Provider for ResendProvider {
    fn id(&self) -> &'static str {
        "resend"
    }

    fn complete(&self, s: &MailSettings) -> bool {
        s.api_key_enc.is_some() && s.from_addr.is_some()
    }

    fn build(&self, s: &MailSettings, keys: &Keys) -> Result<Box<dyn Transport>, String> {
        Ok(Box::new(self.api(s, keys)?))
    }

    fn diagnose<'a>(
        &'a self,
        s: &'a MailSettings,
        keys: &'a Keys,
        msg: &'a OutMsg,
    ) -> DiagFuture<'a> {
        Box::pin(self.run(s, keys, msg))
    }
}
