//! The Cloudflare API client of the DNS management (`dns`).
//!
//! Every call goes through the SSRF guard `outbound` and only to the API
//! root `Limits::cloudflare_api_base` (`api.cloudflare.com`; tests point it
//! at a loopback mock, which switches the plain-http-to-loopback exception
//! on — see `Client::new`). The token travels in the `Authorization`
//! header of that one request and nowhere else; errors never carry it, the
//! URL or a response body beyond Cloudflare's own short error message.
//!
//! Cloudflare rate limits (HTTP 429, `Retry-After`) are retried a couple of
//! times when the wait is short and otherwise reported with the wait.

use std::time::Duration;

use hyper::body::Bytes;
use hyper::header;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::{ApiError, api_error};
use crate::outbound::{self, FetchError, Policy};

/// One request, connect to last byte.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// Records and zones are small; a page is far below this.
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
/// A 429 whose wait is at most this is waited out (at most `MAX_RETRIES`).
const RETRY_WAIT_MAX_SECS: u64 = 3;
const MAX_RETRIES: u32 = 2;
/// Zones listed per request / at most this many pages (1000 zones).
pub const ZONES_PER_PAGE: u32 = 50;
const ZONES_MAX_PAGES: u32 = 20;

/// Why a Cloudflare call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsError {
    /// Network, TLS, timeout, or an unreadable answer.
    Unreachable(String),
    /// HTTP 429; the wait Cloudflare asked for.
    RateLimited { retry_after_secs: Option<u64> },
    /// 401: the token is invalid, expired or revoked.
    TokenRejected,
    /// 403: the token lacks the permission (or the zone) for this call.
    Forbidden,
    /// 404: no such zone or record.
    NotFound,
    /// The record already exists (or clashes with a CNAME).
    Conflict(String),
    /// Cloudflare refused the content (400/422 and validation codes).
    Invalid(String),
    /// Anything else Cloudflare answered.
    Upstream { status: u16, message: String },
}

impl From<DnsError> for ApiError {
    fn from(e: DnsError) -> Self {
        match e {
            DnsError::Unreachable(detail) => api_error!(
                BAD_GATEWAY,
                "dns.unreachable",
                "cannot reach the Cloudflare API: {detail}",
                detail = detail
            ),
            DnsError::RateLimited { retry_after_secs } => api_error!(
                TOO_MANY_REQUESTS,
                "dns.rate_limited",
                "Cloudflare rate limit reached, retry later",
                retry_after_secs = retry_after_secs
            ),
            DnsError::TokenRejected => api_error!(
                BAD_GATEWAY,
                "dns.token_rejected",
                "Cloudflare rejected the API token (invalid, expired or revoked)"
            ),
            DnsError::Forbidden => api_error!(
                BAD_GATEWAY,
                "dns.permission_denied",
                "the API token lacks the permission for this zone or action"
            ),
            DnsError::NotFound => api_error!(
                NOT_FOUND,
                "dns.not_found",
                "no such zone or record at Cloudflare"
            ),
            DnsError::Conflict(detail) => api_error!(
                CONFLICT,
                "dns.record_conflict",
                "Cloudflare: {detail}",
                detail = detail
            ),
            DnsError::Invalid(detail) => api_error!(
                UNPROCESSABLE_ENTITY,
                "dns.record_invalid",
                "Cloudflare refused the record: {detail}",
                detail = detail
            ),
            DnsError::Upstream { status, message } => api_error!(
                BAD_GATEWAY,
                "dns.cloudflare_error",
                "Cloudflare answered {status}: {message}",
                status = status,
                message = message
            ),
        }
    }
}

/// A zone as the console needs it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Zone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub paused: bool,
    /// Cloudflare's legacy permission strings of the token on this zone
    /// (`#dns_records:edit`, …); empty when it does not list them.
    #[serde(default, skip_serializing)]
    pub permissions: Vec<String>,
}

impl Zone {
    /// Whether the token may edit DNS here (`None` = Cloudflare did not say).
    pub fn can_edit(&self) -> Option<bool> {
        if self.permissions.is_empty() {
            return None;
        }
        Some(self.permissions.iter().any(|p| p == "#dns_records:edit"))
    }
}

/// A DNS record as Cloudflare returns it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Record {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub proxied: Option<bool>,
    #[serde(default)]
    pub proxiable: Option<bool>,
    #[serde(default)]
    pub ttl: u32,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub priority: Option<u32>,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub zone_name: Option<String>,
    #[serde(default)]
    pub modified_on: Option<String>,
}

/// Cloudflare's paging block.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct PageInfo {
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub per_page: u32,
    #[serde(default)]
    pub total_count: u32,
    #[serde(default)]
    pub total_pages: u32,
}

#[derive(Deserialize)]
struct CfError {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Vec<CfError>,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    result_info: Option<PageInfo>,
}

/// One token's view of the API.
pub struct Client {
    base: String,
    policy: Policy,
    token: String,
}

impl Client {
    /// `base` is `Limits::cloudflare_api_base`; anything but the default
    /// (the test mock) may use plain http to loopback.
    pub fn new(base: &str, token: String) -> Self {
        let policy = if base == crate::config::CLOUDFLARE_API_BASE {
            Policy::default()
        } else {
            outbound::OPERATOR
        };
        Self {
            base: base.trim_end_matches('/').to_string(),
            policy,
            token,
        }
    }

    async fn call(
        &self,
        method: hyper::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(Value, Option<PageInfo>), DnsError> {
        let mut attempt = 0;
        loop {
            match self.once(method.clone(), path, body).await {
                Err(DnsError::RateLimited {
                    retry_after_secs: Some(wait),
                }) if wait <= RETRY_WAIT_MAX_SECS && attempt < MAX_RETRIES => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_secs(wait.max(1))).await;
                }
                other => return other,
            }
        }
    }

    async fn once(
        &self,
        method: hyper::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(Value, Option<PageInfo>), DnsError> {
        let work = async {
            let target = outbound::target(&format!("{}{path}", self.base), self.policy)
                .map_err(unreachable)?;
            let mut headers = vec![
                (header::AUTHORIZATION, format!("Bearer {}", self.token)),
                (header::ACCEPT, "application/json".to_string()),
            ];
            let payload = match body {
                Some(b) => {
                    headers.push((header::CONTENT_TYPE, "application/json".to_string()));
                    Bytes::from(b.to_string())
                }
                None => Bytes::new(),
            };
            let res = outbound::send(&target, method, &headers, payload)
                .await
                .map_err(unreachable)?;
            let status = res.status().as_u16();
            let retry_after = res
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            let bytes = outbound::read_capped(res, MAX_RESPONSE)
                .await
                .map_err(unreachable)?;
            interpret(status, retry_after, &bytes)
        };
        tokio::time::timeout(CALL_TIMEOUT, work)
            .await
            .map_err(|_| DnsError::Unreachable("timed out".into()))?
    }

    /// Every zone the token sees, newest API page size, name order.
    pub async fn zones(&self) -> Result<Vec<Zone>, DnsError> {
        let mut out = Vec::new();
        for page in 1..=ZONES_MAX_PAGES {
            let path = format!("/zones?per_page={ZONES_PER_PAGE}&page={page}&order=name");
            let (result, info) = self.call(hyper::Method::GET, &path, None).await?;
            out.extend(parse::<Vec<Zone>>(result)?);
            if info.is_none_or(|i| page >= i.total_pages) {
                break;
            }
        }
        Ok(out)
    }

    /// One page of a zone's records (`search` matches name and content).
    pub async fn records(
        &self,
        zone: &str,
        search: Option<&str>,
        kind: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> Result<(Vec<Record>, PageInfo), DnsError> {
        let mut path = format!("/zones/{zone}/dns_records?page={page}&per_page={per_page}");
        path.push_str("&order=type&direction=asc");
        if let Some(s) = search {
            path.push_str("&search=");
            path.push_str(&urlencode(s));
        }
        if let Some(k) = kind {
            path.push_str("&type=");
            path.push_str(&urlencode(k));
        }
        let (result, info) = self.call(hyper::Method::GET, &path, None).await?;
        Ok((parse(result)?, info.unwrap_or_default()))
    }

    pub async fn record(&self, zone: &str, id: &str) -> Result<Record, DnsError> {
        let path = format!("/zones/{zone}/dns_records/{id}");
        parse(self.call(hyper::Method::GET, &path, None).await?.0)
    }

    pub async fn create(&self, zone: &str, body: &Value) -> Result<Record, DnsError> {
        let path = format!("/zones/{zone}/dns_records");
        parse(self.call(hyper::Method::POST, &path, Some(body)).await?.0)
    }

    pub async fn update(&self, zone: &str, id: &str, body: &Value) -> Result<Record, DnsError> {
        let path = format!("/zones/{zone}/dns_records/{id}");
        parse(self.call(hyper::Method::PATCH, &path, Some(body)).await?.0)
    }

    pub async fn delete(&self, zone: &str, id: &str) -> Result<(), DnsError> {
        let path = format!("/zones/{zone}/dns_records/{id}");
        self.call(hyper::Method::DELETE, &path, None).await?;
        Ok(())
    }
}

fn unreachable(e: FetchError) -> DnsError {
    DnsError::Unreachable(e.to_string())
}

fn parse<T: serde::de::DeserializeOwned>(result: Value) -> Result<T, DnsError> {
    serde_json::from_value(result)
        .map_err(|_| DnsError::Unreachable("unexpected answer from Cloudflare".into()))
}

/// The status line and envelope of one answer as a result or an error.
fn interpret(
    status: u16,
    retry_after: Option<u64>,
    body: &[u8],
) -> Result<(Value, Option<PageInfo>), DnsError> {
    if status == 429 {
        return Err(DnsError::RateLimited {
            retry_after_secs: retry_after,
        });
    }
    let envelope: Option<Envelope> = serde_json::from_slice(body).ok();
    if (200..300).contains(&status)
        && let Some(e) = envelope.as_ref().filter(|e| e.success)
    {
        return Ok((e.result.clone(), e.result_info));
    }
    let message = envelope
        .as_ref()
        .map(|e| {
            e.errors
                .iter()
                .map(|c| format!("{} (code {})", c.message, c.code))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| format!("HTTP {status}"));
    let code = envelope
        .as_ref()
        .and_then(|e| e.errors.first())
        .map_or(0, |c| c.code);
    Err(match status {
        401 => DnsError::TokenRejected,
        403 => DnsError::Forbidden,
        404 => DnsError::NotFound,
        409 => DnsError::Conflict(message),
        _ if matches!(code, 81053 | 81057 | 81058) => DnsError::Conflict(message),
        400 | 422 => DnsError::Invalid(message),
        _ => DnsError::Upstream { status, message },
    })
}

/// Percent-encode a query value.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn answers_map_to_errors() {
        let ok = br#"{"success":true,"errors":[],"result":[1],"result_info":{"page":1,"per_page":50,"total_count":1,"total_pages":1}}"#;
        let (v, info) = interpret(200, None, ok).unwrap();
        assert_eq!(v, serde_json::json!([1]));
        assert_eq!(info.unwrap().total_pages, 1);
        let denied =
            br#"{"success":false,"errors":[{"code":9109,"message":"Invalid access token"}]}"#;
        assert_eq!(interpret(401, None, denied), Err(DnsError::TokenRejected));
        assert_eq!(interpret(403, None, denied), Err(DnsError::Forbidden));
        assert_eq!(interpret(404, None, b"{}"), Err(DnsError::NotFound));
        assert_eq!(
            interpret(429, Some(7), b""),
            Err(DnsError::RateLimited {
                retry_after_secs: Some(7)
            })
        );
        let dup = br#"{"success":false,"errors":[{"code":81058,"message":"A record with those settings already exists."}]}"#;
        assert!(matches!(
            interpret(400, None, dup),
            Err(DnsError::Conflict(_))
        ));
        let bad = br#"{"success":false,"errors":[{"code":9005,"message":"Content for A record is invalid."}]}"#;
        assert!(matches!(
            interpret(400, None, bad),
            Err(DnsError::Invalid(_))
        ));
        assert!(matches!(
            interpret(502, None, b"<html>"),
            Err(DnsError::Upstream { status: 502, .. })
        ));
        // A 200 that is not a success envelope is not trusted.
        assert!(interpret(200, None, br#"{"success":false}"#).is_err());
    }

    #[test]
    fn query_values_are_encoded() {
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(urlencode("x-y_z.1~"), "x-y_z.1~");
    }

    #[test]
    fn zone_edit_permission() {
        let mut z = Zone {
            id: "a".into(),
            name: "x.test".into(),
            status: "active".into(),
            paused: false,
            permissions: vec![],
        };
        assert_eq!(z.can_edit(), None);
        z.permissions = vec!["#zone:read".into()];
        assert_eq!(z.can_edit(), Some(false));
        z.permissions.push("#dns_records:edit".into());
        assert_eq!(z.can_edit(), Some(true));
    }
}
