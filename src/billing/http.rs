//! Minimal HTTPS client for the payment gateways (and, W17, alert
//! notifications): one POST (or, for the EPay query API, one GET) per
//! connection over rustls (ring provider, webpki roots) and hyper http1.
//! `http://` is accepted only for loopback hosts (tests, local mock
//! gateways, a self-hosted webhook). Every request goes through the SSRF
//! guard `outbound` (https only to public addresses, redirects not
//! followed). No proxy support: the panel reaches the gateway directly.
//! Response bodies are capped.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use hyper::body::Bytes;
use hyper::header;

use crate::outbound;

const MAX_RESPONSE: usize = 256 * 1024;

pub(crate) fn tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    if let Some(c) = CFG.get() {
        return Ok(c.clone());
    }
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("tls: {e}"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(CFG.get_or_init(|| Arc::new(cfg)).clone())
}

/// Whether `host` is a loopback name/address (plain http allowed).
pub fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost")
        || h.parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// POST `body` (application/x-www-form-urlencoded, UTF-8) to `url`.
/// Returns (status, body). Errors carry no request content.
pub async fn post_form(url: &str, body: String, timeout: Duration) -> Result<(u16, Bytes), String> {
    post(
        url,
        "application/x-www-form-urlencoded;charset=utf-8",
        &[],
        body.into_bytes(),
        timeout,
    )
    .await
}

/// POST `body` with `content_type` and extra headers (W17: alert
/// notifications — Telegram Bot API, signed webhooks). Same rules as
/// `post_form`: https, or http to loopback only; errors carry no request
/// content (the URL of a Telegram call holds the bot token).
pub async fn post(
    url: &str,
    content_type: &str,
    headers: &[(&str, String)],
    body: Vec<u8>,
    timeout: Duration,
) -> Result<(u16, Bytes), String> {
    tokio::time::timeout(
        timeout,
        request(hyper::Method::POST, url, Some(content_type), headers, body),
    )
    .await
    .map_err(|_| "timed out".to_string())?
}

/// GET `url` (C1: the EPay query API). Same rules as `post`; the URL can
/// carry a credential (EPay's query takes the merchant key as a query
/// parameter), so errors never include it.
pub async fn get(url: &str, timeout: Duration) -> Result<(u16, Bytes), String> {
    tokio::time::timeout(
        timeout,
        request(hyper::Method::GET, url, None, &[], Vec::new()),
    )
    .await
    .map_err(|_| "timed out".to_string())?
}

/// GET `url` with extra request headers (the crypto gateways sign their
/// reads in headers). Same rules as `get`; the headers can carry
/// credentials, so errors never include them.
pub async fn get_with(
    url: &str,
    headers: &[(&str, String)],
    timeout: Duration,
) -> Result<(u16, Bytes), String> {
    tokio::time::timeout(
        timeout,
        request(hyper::Method::GET, url, None, headers, Vec::new()),
    )
    .await
    .map_err(|_| "timed out".to_string())?
}

async fn request(
    method: hyper::Method,
    url: &str,
    content_type: Option<&str>,
    headers: &[(&str, String)],
    body: Vec<u8>,
) -> Result<(u16, Bytes), String> {
    // The SSRF guard: https to public addresses (every resolved address
    // checked, the connection goes to the checked one), plain http only to
    // loopback; redirects are not followed.
    let target = outbound::target(url, outbound::OPERATOR).map_err(|e| e.to_string())?;
    let mut hs = vec![(header::ACCEPT, "application/json".to_string())];
    if let Some(ct) = content_type {
        hs.push((header::CONTENT_TYPE, ct.to_string()));
    }
    for (k, v) in headers {
        let name = header::HeaderName::from_bytes(k.as_bytes()).map_err(|_| "bad header")?;
        hs.push((name, v.clone()));
    }
    let res = outbound::send(&target, method, &hs, Bytes::from(body))
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = outbound::read_capped(res, MAX_RESPONSE)
        .await
        .map_err(|e| e.to_string())?;
    Ok((status, body))
}
