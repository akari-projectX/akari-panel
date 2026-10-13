//! The panel's only fetch of an operator-supplied URL (remote rule-sets),
//! guarded against SSRF:
//!
//! * https only (plain http only to 127.0.0.1 when the test switch
//!   `rule_set_fetch_loopback` is set — smoke's fixture server); no user
//!   info, no fragment;
//! * the host is resolved here and EVERY address must be public
//!   (`public_address`: no loopback, private, link-local / metadata
//!   169.254.169.254, CGNAT, ULA, multicast, documentation, benchmarking,
//!   reserved, and IPv6 forms embedding such an IPv4 address); the
//!   connection goes to the vetted address itself (no second lookup:
//!   no DNS rebinding), TLS is verified for the host name (webpki roots);
//! * at most `MAX_REDIRECTS` redirects, each one re-checked as above;
//! * one deadline (`TIMEOUT`) for the whole fetch, the body is capped at
//!   `MAX_BYTES`, compressed bodies are refused (none is asked for), the
//!   content type is not trusted (the parser decides).
//!
//! Errors are short English details for the admin; they never carry the
//! response body.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use http_body_util::{BodyExt, Empty, Limited};
use hyper::StatusCode;
use hyper::body::{Bytes, Incoming};
use hyper::header;
use hyper_util::rt::TokioIo;

/// The largest list accepted.
pub const MAX_BYTES: usize = 5 << 20;
/// The whole fetch (lookups, connections, redirects, body).
pub const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 3;

/// What a fetch may do beyond the rules above (tests only).
#[derive(Debug, Clone, Copy, Default)]
pub struct Policy {
    /// Plain http to 127.0.0.1 (the address guard is skipped for it).
    pub loopback_http: bool,
}

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The URL or a redirect leads to an address that is not public.
    Blocked,
    TooLarge,
    /// Anything else (a short detail).
    Failed(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Blocked => f.write_str("the address is not public"),
            FetchError::TooLarge => write!(f, "larger than {} MiB", MAX_BYTES >> 20),
            FetchError::Failed(d) => f.write_str(d),
        }
    }
}

fn failed(d: impl Into<String>) -> FetchError {
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

/// A parsed fetch target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    tls: bool,
    host: String,
    port: u16,
    authority: String,
    path: String,
}

/// An absolute URL the policy allows (before any lookup).
pub(crate) fn target(url: &str, policy: Policy) -> Result<Target, FetchError> {
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
        Some("http") if policy.loopback_http && host == "127.0.0.1" => false,
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
        // Plain http is only ever the loopback test fixture.
        return Ok(vec![SocketAddr::from(([127, 0, 0, 1], t.port))]);
    }
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
    if addrs.iter().any(|a| !public_address(a.ip())) {
        return Err(FetchError::Blocked);
    }
    Ok(addrs)
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
        let res = send(&t, held).await?;
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
    if length.is_some_and(|n| n > MAX_BYTES as u64) {
        return Err(FetchError::TooLarge);
    }
    let etag = header_text(&res, header::ETAG);
    let last_modified = header_text(&res, header::LAST_MODIFIED);
    let bytes = match Limited::new(res.into_body(), MAX_BYTES).collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) if e.is::<http_body_util::LengthLimitError>() => return Err(FetchError::TooLarge),
        Err(_) => return Err(failed("the download was interrupted")),
    };
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| failed("not a UTF-8 text file"))?;
    Ok(Fetched::Body {
        text,
        etag,
        last_modified,
    })
}

async fn send(t: &Target, held: &Held) -> Result<hyper::Response<Incoming>, FetchError> {
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
        let mut req = hyper::Request::get(t.path.as_str())
            .header(header::HOST, t.authority.as_str())
            .header(header::ACCEPT, "text/plain, text/yaml, */*")
            .header(header::USER_AGENT, "akari-panel");
        if let Some(e) = &held.etag {
            req = req.header(header::IF_NONE_MATCH, e.as_str());
        }
        if let Some(m) = &held.last_modified {
            req = req.header(header::IF_MODIFIED_SINCE, m.as_str());
        }
        let req = req
            .body(Empty::<Bytes>::new())
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
    req: hyper::Request<Empty<Bytes>>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(target("http://localhost:18205/a.list", test).is_err());
        assert!(target("http://10.0.0.1/a.list", test).is_err());
    }

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
