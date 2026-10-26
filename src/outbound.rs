//! The SSRF guard of every panel request to an operator-supplied URL
//! (remote rule-sets, `sub::rulesets::fetch`):
//!
//! * https only (plain http only to a loopback host — 127.0.0.0/8, ::1,
//!   `localhost` — when the caller's `Policy::loopback_http` allows it: the
//!   documented exception of alert webhooks / a self-hosted Telegram Bot
//!   API, the update-check source and local mock gateways; the address
//!   must then really be loopback); no user info, no fragment;
//! * the host is resolved here and EVERY address must be public
//!   (`public_address`: no loopback, private, link-local / metadata
//!   169.254.169.254, CGNAT, ULA, multicast, documentation, benchmarking,
//!   reserved, and IPv6 forms embedding such an IPv4 address); the
//!   connection goes to the vetted address itself (no second lookup:
//!   no DNS rebinding), TLS is verified for the host name (webpki roots);
//! * compressed bodies are refused (none is asked for) and bodies are
//!   capped by the caller (`read_capped`); deadlines and redirects are the
//!   caller's (the rule-set GET follows a few, re-checked one by one).
//!
//! Errors are short English details for the admin; they never carry the
//! URL (it may hold a token) nor the response body.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header;
use hyper_util::rt::TokioIo;

/// What a request may do beyond the rules above.
#[derive(Debug, Clone, Copy, Default)]
pub struct Policy {
    /// Plain http to a loopback host (`is_loopback_host`); every address
    /// the name resolves to must be loopback, the public-address guard is
    /// skipped for it.
    pub loopback_http: bool,
}

/// Policy of the operator-configured callbacks (webhook, Telegram, the
/// update source, payment gateways): https to public addresses, plain http
/// only to loopback.
pub const OPERATOR: Policy = Policy {
    loopback_http: true,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The URL or a redirect leads to an address that is not public.
    Blocked,
    /// The body is larger than the caller's cap.
    TooLarge,
    /// Anything else (a short detail).
    Failed(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Blocked => f.write_str("the address is not public"),
            FetchError::TooLarge => f.write_str("the response is too large"),
            FetchError::Failed(d) => f.write_str(d),
        }
    }
}

pub fn failed(d: impl Into<String>) -> FetchError {
    FetchError::Failed(d.into())
}

/// Whether the panel may connect to `ip` for an operator-supplied URL.
pub fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn public_v4(a: Ipv4Addr) -> bool {
    let [o0, o1, o2, _] = a.octets();
    !(o0 == 0 // "this network"
        || a.is_loopback()
        || a.is_private()
        || a.is_link_local() // 169.254/16: cloud metadata
        || (o0 == 100 && (o1 & 0xc0) == 64) // 100.64/10 CGNAT
        || (o0 == 192 && o1 == 0 && o2 == 0) // 192.0.0/24 IETF
        || (o0 == 192 && o1 == 0 && o2 == 2) // TEST-NET-1
        || (o0 == 198 && o1 == 51 && o2 == 100) // TEST-NET-2
        || (o0 == 203 && o1 == 0 && o2 == 113) // TEST-NET-3
        || (o0 == 192 && o1 == 88 && o2 == 99) // 6to4 relay anycast
        || (o0 == 198 && (o1 & 0xfe) == 18) // 198.18/15 benchmarking
        || a.is_multicast()
        || o0 >= 240) // reserved + broadcast
}

fn public_v6(a: Ipv6Addr) -> bool {
    let s = a.segments();
    let v4 = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if let Some(m) = a.to_ipv4_mapped() {
        return public_v4(m);
    }
    // ::/96 (IPv4-compatible, also :: and ::1)
    if s[..6] == [0; 6] {
        return false;
    }
    // NAT64 64:ff9b::/96 → the embedded address; 64:ff9b:1::/48 local use.
    if s[0] == 0x64 && s[1] == 0xff9b {
        return s[2..6] == [0; 4] && public_v4(v4(s[6], s[7]));
    }
    // 6to4 2002::/16 → the embedded address.
    if s[0] == 0x2002 {
        return public_v4(v4(s[1], s[2]));
    }
    !(a.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00 // ULA (incl. fd00:ec2::254 metadata)
        || (s[0] & 0xffc0) == 0xfe80 // link-local
        || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        || (s[0] == 0x3fff && s[1] < 0x1000) // documentation 3fff::/20
        || (s[0] == 0x2001 && s[1] == 0) // Teredo
        || (s[0] == 0x2001 && (s[1] & 0xfff0) == 0x0010) // ORCHID
        || (s[0] == 0x2001 && (s[1] & 0xfff0) == 0x0020) // ORCHIDv2
        || (s[0] == 0x0100 && s[1..4] == [0; 3]) // discard 100::/64
        || (s[0] == 0x5f00)) // SRv6 SIDs 5f00::/16
}

/// A parsed request target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub(crate) tls: bool,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) authority: String,
    pub(crate) path: String,
}

/// An absolute URL the policy allows (before any lookup).
pub fn target(url: &str, policy: Policy) -> Result<Target, FetchError> {
    if url.len() > 2048 || url.contains('#') || url.chars().any(|c| c.is_ascii_control()) {
        return Err(failed("not a plain URL"));
    }
    let uri: hyper::Uri = url.parse().map_err(|_| failed("not a URL"))?;
    let auth = uri.authority().ok_or_else(|| failed("URL without host"))?;
    if auth.as_str().contains('@') {
        return Err(failed("the URL must not carry credentials"));
    }
    let host = auth
        .host()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host.is_empty() {
        return Err(failed("URL without host"));
    }
    let tls = match uri.scheme_str() {
        Some("https") => true,
        Some("http") if policy.loopback_http && crate::billing::http::is_loopback_host(&host) => {
            false
        }
        _ => return Err(failed("the URL must be https")),
    };
    let port = auth.port_u16().unwrap_or(if tls { 443 } else { 80 });
    if port == 0 {
        return Err(failed("bad port"));
    }
    Ok(Target {
        tls,
        authority: auth.as_str().to_ascii_lowercase(),
        host,
        port,
        path: uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "/".into()),
    })
}

/// The addresses to try for `t`: every resolved address must be public
/// (one private answer refuses the whole name).
async fn addresses(t: &Target) -> Result<Vec<SocketAddr>, FetchError> {
    if !t.tls {
        // Plain http is loopback only: resolve and require loopback.
        let addrs = resolve(t).await?;
        if addrs.iter().any(|a| !a.ip().to_canonical().is_loopback()) {
            return Err(FetchError::Blocked);
        }
        return Ok(addrs);
    }
    let addrs = resolve(t).await?;
    if addrs.iter().any(|a| !public_address(a.ip())) {
        return Err(FetchError::Blocked);
    }
    Ok(addrs)
}

/// The (at most 16) addresses of `t`'s host.
async fn resolve(t: &Target) -> Result<Vec<SocketAddr>, FetchError> {
    let addrs: Vec<SocketAddr> = match t.host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, t.port)],
        Err(_) => tokio::net::lookup_host((t.host.as_str(), t.port))
            .await
            .map_err(|_| failed("the name does not resolve"))?
            .take(16)
            .collect(),
    };
    if addrs.is_empty() {
        return Err(failed("the name does not resolve"));
    }
    Ok(addrs)
}

/// One request to `t` (no redirect handling): `method` with `headers` and
/// `body` (a content type among the headers when there is a body).
pub async fn send(
    t: &Target,
    method: hyper::Method,
    headers: &[(header::HeaderName, String)],
    body: Bytes,
) -> Result<hyper::Response<Incoming>, FetchError> {
    let mut last = failed("no address");
    for addr in addresses(t).await? {
        let tcp = match tokio::net::TcpStream::connect(addr).await {
            Ok(s) => s,
            Err(e) => {
                last = failed(format!("connect: {}", e.kind()));
                continue;
            }
        };
        let _ = tcp.set_nodelay(true);
        let mut req = hyper::Request::builder()
            .method(method.clone())
            .uri(t.path.as_str())
            .header(header::HOST, t.authority.as_str())
            .header(header::USER_AGENT, "akari-panel");
        for (k, v) in headers {
            req = req.header(k, v.as_str());
        }
        if !body.is_empty() {
            req = req.header(header::CONTENT_LENGTH, body.len());
        }
        let req = req
            .body(Full::new(body.clone()))
            .map_err(|_| failed("bad request"))?;
        return if t.tls {
            let name = rustls::pki_types::ServerName::try_from(t.host.clone())
                .map_err(|_| failed("bad host name"))?;
            let cfg = crate::billing::http::tls_config().map_err(failed)?;
            let stream = tokio_rustls::TlsConnector::from(cfg)
                .connect(name, tcp)
                .await
                .map_err(|e| failed(format!("tls: {e}")))?;
            request(TokioIo::new(stream), req).await
        } else {
            request(TokioIo::new(tcp), req).await
        };
    }
    Err(last)
}

async fn request<T>(
    io: T,
    req: hyper::Request<Full<Bytes>>,
) -> Result<hyper::Response<Incoming>, FetchError>
where
    T: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| failed(format!("http: {e}")))?;
    // The connection task ends with the body (or when it is dropped).
    tokio::spawn(async move {
        let _ = conn.await;
    });
    sender
        .send_request(req)
        .await
        .map_err(|e| failed(format!("http: {e}")))
}

/// The body of `res`, at most `max` bytes; compressed bodies are refused.
pub async fn read_capped(res: hyper::Response<Incoming>, max: usize) -> Result<Bytes, FetchError> {
    if res
        .headers()
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !v.trim().eq_ignore_ascii_case("identity"))
    {
        return Err(failed("compressed response"));
    }
    let length = res
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if length.is_some_and(|n| n > max as u64) {
        return Err(FetchError::TooLarge);
    }
    match Limited::new(res.into_body(), max).collect().await {
        Ok(b) => Ok(b.to_bytes()),
        Err(e) if e.is::<http_body_util::LengthLimitError>() => Err(FetchError::TooLarge),
        Err(_) => Err(failed("the download was interrupted")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// POST a JSON `body` to `url` through the guard (no redirects),
    /// bounded by `timeout`; returns (status, body ≤ `max`).
    async fn post_json(
        url: &str,
        policy: Policy,
        body: Vec<u8>,
        timeout: std::time::Duration,
        max: usize,
    ) -> Result<(u16, Bytes), FetchError> {
        let call = async {
            let t = target(url, policy)?;
            let res = send(
                &t,
                hyper::Method::POST,
                &[(header::CONTENT_TYPE, "application/json".to_string())],
                Bytes::from(body),
            )
            .await?;
            let status = res.status().as_u16();
            Ok((status, read_capped(res, max).await?))
        };
        match tokio::time::timeout(timeout, call).await {
            Ok(r) => r,
            Err(_) => Err(failed("timed out")),
        }
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn non_public_addresses_are_refused() {
        for a in [
            "0.0.0.0",
            "0.1.2.3",
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.5.4",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "169.254.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "198.51.100.7",
            "203.0.113.9",
            "198.18.0.1",
            "198.19.255.255",
            "192.88.99.1",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::127.0.0.1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b:1::1",
            "2002:7f00:1::1",
            "2002:a9fe:a9fe::1",
            "fc00::1",
            "fd00:ec2::254",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "3fff::1",
            "2001::1",
            "2001:10::1",
            "2001:20::1",
            "100::1",
            "5f00::1",
        ] {
            assert!(!public_address(ip(a)), "{a} must be refused");
        }
    }

    #[test]
    fn public_addresses_pass() {
        for a in [
            "1.1.1.1",
            "8.8.8.8",
            "104.16.0.1",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "198.17.255.255",
            "198.20.0.1",
            "223.255.255.255",
            "2606:4700::1111",
            "2400:cb00::1",
            "::ffff:1.1.1.1",
            "64:ff9b::101:101",
            "2002:101:101::1",
            "3fff:1000::1",
        ] {
            assert!(public_address(ip(a)), "{a} must pass");
        }
    }

    #[test]
    fn url_policy() {
        let p = Policy::default();
        let t = target("https://cdn.jsdelivr.net/gh/x/y@master/a.yaml?v=1", p).unwrap();
        assert_eq!(
            (t.tls, t.host.as_str(), t.port, t.path.as_str()),
            (true, "cdn.jsdelivr.net", 443, "/gh/x/y@master/a.yaml?v=1")
        );
        let t = target("https://[2606:4700::1111]:8443/x", p).unwrap();
        assert_eq!((t.host.as_str(), t.port), ("2606:4700::1111", 8443));
        for bad in [
            "http://example.com/a.list",
            "ftp://example.com/a.list",
            "https://user:pw@example.com/a.list",
            "https://example.com/a.list#frag",
            "https://example.com:0/a",
            "https:///a",
            "/relative",
            "http://127.0.0.1:8080/a.list",
        ] {
            assert!(target(bad, p).is_err(), "{bad}");
        }
        let test = Policy {
            loopback_http: true,
        };
        assert!(target("http://127.0.0.1:18205/a.list", test).is_ok());
        // A loopback NAME too (its addresses must then all be loopback).
        assert!(target("http://localhost:18205/a.list", test).is_ok());
        assert!(target("http://127.0.0.1.evil.test/a.list", test).is_err());
        assert!(target("http://10.0.0.1/a.list", test).is_err());
        assert_eq!(
            FetchError::TooLarge.to_string(),
            "the response is too large"
        );
        assert_eq!(FetchError::Blocked.to_string(), "the address is not public");
    }

    #[tokio::test]
    async fn private_targets_are_blocked_before_connecting() {
        for url in [
            "https://127.0.0.1/rpc",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/rpc",
            "https://[fd00:ec2::254]/",
            "https://10.1.2.3:8443/rpc",
            "https://localhost/rpc",
        ] {
            assert_eq!(
                post_json(
                    url,
                    Policy::default(),
                    b"{}".to_vec(),
                    std::time::Duration::from_secs(5),
                    1024
                )
                .await
                .unwrap_err(),
                FetchError::Blocked,
                "{url}"
            );
        }
        // Plain http to loopback only with the test switch.
        assert!(matches!(
            post_json(
                "http://127.0.0.1:9/rpc",
                Policy::default(),
                Vec::new(),
                std::time::Duration::from_secs(5),
                1024
            )
            .await,
            Err(FetchError::Failed(_))
        ));
    }

    #[tokio::test]
    async fn bodies_are_capped_and_redirects_not_followed() {
        let app = axum::Router::new()
            .route("/big", axum::routing::post(|| async { "x".repeat(4096) }))
            .route(
                "/gz",
                axum::routing::post(|| async {
                    ([(axum::http::header::CONTENT_ENCODING, "gzip")], "zz")
                }),
            )
            .route(
                "/moved",
                axum::routing::post(|| async {
                    axum::response::Redirect::temporary("http://127.0.0.1:9/x")
                }),
            )
            .route(
                "/ok",
                axum::routing::post(|body: String| async move { body }),
            );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(l, app).await;
        });
        let p = Policy {
            loopback_http: true,
        };
        let t = std::time::Duration::from_secs(5);
        let url = |p: &str| format!("http://127.0.0.1:{}{p}", addr.port());
        assert_eq!(
            post_json(&url("/big"), p, Vec::new(), t, 1024).await,
            Err(FetchError::TooLarge)
        );
        assert_eq!(
            post_json(&url("/gz"), p, Vec::new(), t, 1024).await,
            Err(failed("compressed response"))
        );
        let (status, _) = post_json(&url("/moved"), p, Vec::new(), t, 1024)
            .await
            .unwrap();
        assert_eq!(status, 307);
        let (status, body) = post_json(&url("/ok"), p, b"{\"a\":1}".to_vec(), t, 1024)
            .await
            .unwrap();
        assert_eq!((status, &body[..]), (200, &b"{\"a\":1}"[..]));
    }

    #[tokio::test]
    async fn operator_policy_reaches_loopback_over_http_only() {
        let t = target("http://localhost:8080/x", OPERATOR).unwrap();
        assert!(!t.tls);
        assert!(target("http://[::1]:8080/", OPERATOR).is_ok());
        assert!(target("http://127.0.0.2/", OPERATOR).is_ok());
        for bad in [
            "http://example.com/",
            "http://10.0.0.1/",
            "http://127.0.0.1.evil.test/",
        ] {
            assert!(target(bad, OPERATOR).is_err(), "{bad}");
        }
        // The default policy has no plain http at all.
        assert!(target("http://127.0.0.1/", Policy::default()).is_err());
        // https to a non-public address: refused before any connection
        // (every address of the name must be public).
        for url in [
            "https://10.0.0.1/",
            "https://127.0.0.1:1/",
            "https://[::1]/",
            "https://169.254.169.254/latest",
            "https://[fd00:ec2::254]/",
            "https://localhost:1/",
        ] {
            let t = target(url, OPERATOR).unwrap();
            let r = send(&t, hyper::Method::GET, &[], Bytes::new()).await;
            assert_eq!(r.err(), Some(FetchError::Blocked), "{url}");
        }
    }
}
