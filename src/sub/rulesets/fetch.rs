//! The remote rule-set download (GET with conditional validators) on top
//! of the shared SSRF guard (`crate::outbound`: https only, every resolved
//! address public, the connection to the vetted address, compressed
//! bodies refused):
//!
//! * at most `MAX_REDIRECTS` redirects, each one re-checked as above;
//! * one deadline (`TIMEOUT`) for the whole fetch, the body is capped at
//!   `MAX_BYTES`, the content type is not trusted (the parser decides).
//!
//! Errors are short English details for the admin; they never carry the
//! response body.

use std::time::Duration;

use hyper::StatusCode;
use hyper::body::{Bytes, Incoming};
use hyper::header;

pub use crate::outbound::{FetchError, Policy};
use crate::outbound::{failed, read_capped, send, target};

/// The largest list accepted.
pub const MAX_BYTES: usize = 5 << 20;
/// The whole fetch (lookups, connections, redirects, body).
pub const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 3;

/// Validators of the copy held (conditional request).
#[derive(Debug, Clone, Default)]
pub struct Held {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Debug)]
pub enum Fetched {
    Body {
        text: String,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    /// 304: the held copy is current.
    NotModified,
}

/// GET `url` (redirects followed under the same rules), bounded by
/// `TIMEOUT` in total.
pub async fn fetch(url: &str, policy: Policy, held: &Held) -> Result<Fetched, FetchError> {
    match tokio::time::timeout(TIMEOUT, fetch_inner(url, policy, held)).await {
        Ok(r) => r,
        Err(_) => Err(failed("timed out")),
    }
}

async fn fetch_inner(url: &str, policy: Policy, held: &Held) -> Result<Fetched, FetchError> {
    let mut url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let t = target(&url, policy)?;
        let res = get(&t, held).await?;
        let status = res.status();
        if status.is_redirection() && status != StatusCode::NOT_MODIFIED {
            let loc = res
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| failed("redirect without a location"))?;
            url = if let Some(rest) = loc.strip_prefix("//") {
                format!("https://{rest}")
            } else if loc.starts_with('/') {
                format!(
                    "{}://{}{loc}",
                    if t.tls { "https" } else { "http" },
                    t.authority
                )
            } else {
                loc.to_string()
            };
            continue;
        }
        if status == StatusCode::NOT_MODIFIED {
            return Ok(Fetched::NotModified);
        }
        if status != StatusCode::OK {
            return Err(failed(format!("HTTP {}", status.as_u16())));
        }
        return body(res).await;
    }
    Err(failed("too many redirects"))
}

fn header_text(res: &hyper::Response<Incoming>, name: header::HeaderName) -> Option<String> {
    res.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .map(str::to_string)
}

async fn body(res: hyper::Response<Incoming>) -> Result<Fetched, FetchError> {
    let etag = header_text(&res, header::ETAG);
    let last_modified = header_text(&res, header::LAST_MODIFIED);
    let bytes = read_capped(res, MAX_BYTES).await?;
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| failed("not a UTF-8 text file"))?;
    Ok(Fetched::Body {
        text,
        etag,
        last_modified,
    })
}

/// One GET of `t` with the held validators.
async fn get(
    t: &crate::outbound::Target,
    held: &Held,
) -> Result<hyper::Response<Incoming>, FetchError> {
    let mut headers = vec![(header::ACCEPT, "text/plain, text/yaml, */*".to_string())];
    if let Some(e) = &held.etag {
        headers.push((header::IF_NONE_MATCH, e.clone()));
    }
    if let Some(m) = &held.last_modified {
        headers.push((header::IF_MODIFIED_SINCE, m.clone()));
    }
    send(t, hyper::Method::GET, &headers, Bytes::new()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn private_targets_are_blocked_before_connecting() {
        for url in [
            "https://127.0.0.1/a.list",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/a.list",
            "https://[fd00:ec2::254]/",
            "https://10.1.2.3:8443/a.list",
            "https://localhost/a.list",
        ] {
            assert_eq!(
                fetch(url, Policy::default(), &Held::default())
                    .await
                    .unwrap_err(),
                FetchError::Blocked,
                "{url}"
            );
        }
    }
}
