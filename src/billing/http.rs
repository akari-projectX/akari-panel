//! Minimal HTTPS client for the Alipay gateway: one form POST per
//! connection over rustls (ring provider, webpki roots) and hyper http1.
//! `http://` is accepted only for loopback hosts (tests, local mock
//! gateways; config_check enforces it). No proxy support: the panel
//! reaches the gateway directly. Response bodies are capped.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Bytes;
use hyper::header;
use hyper_util::rt::TokioIo;

const MAX_RESPONSE: usize = 256 * 1024;

fn tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
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
    tokio::time::timeout(timeout, post_inner(url, body))
        .await
        .map_err(|_| "timed out".to_string())?
}

async fn post_inner(url: &str, body: String) -> Result<(u16, Bytes), String> {
    let uri: hyper::Uri = url.parse().map_err(|_| "bad gateway url".to_string())?;
    let host = uri.host().ok_or("gateway url without host")?.to_string();
    let tls = match uri.scheme_str() {
        Some("https") => true,
        Some("http") if is_loopback_host(&host) => false,
        _ => return Err("gateway url must be https".into()),
    };
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let path = uri
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let connect_host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let tcp = tokio::net::TcpStream::connect((connect_host.as_str(), port))
        .await
        .map_err(|e| format!("connect: {}", e.kind()))?;
    let _ = tcp.set_nodelay(true);
    let authority = match uri.port_u16() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    let req = hyper::Request::post(path)
        .header(header::HOST, authority)
        .header(
            header::CONTENT_TYPE,
            "application/x-www-form-urlencoded;charset=utf-8",
        )
        .header(header::CONTENT_LENGTH, body.len())
        .header(header::ACCEPT, "application/json")
        .header(header::USER_AGENT, "akari-panel")
        .body(Full::new(Bytes::from(body)))
        .map_err(|_| "bad request".to_string())?;
    if tls {
        let name = rustls::pki_types::ServerName::try_from(connect_host)
            .map_err(|_| "bad gateway host name".to_string())?;
        let stream = tokio_rustls::TlsConnector::from(tls_config()?)
            .connect(name, tcp)
            .await
            .map_err(|e| format!("tls: {e}"))?;
        send(TokioIo::new(stream), req).await
    } else {
        send(TokioIo::new(tcp), req).await
    }
}

async fn send<T>(io: T, req: hyper::Request<Full<Bytes>>) -> Result<(u16, Bytes), String>
where
    T: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("http: {e}"))?;
    let driver = tokio::spawn(async move {
        let _ = conn.await;
    });
    let res = sender
        .send_request(req)
        .await
        .map_err(|e| format!("http: {e}"));
    let out = match res {
        Ok(res) => {
            let status = res.status().as_u16();
            Limited::new(res.into_body(), MAX_RESPONSE)
                .collect()
                .await
                .map(|b| (status, b.to_bytes()))
                .map_err(|_| "response body too large or broken".to_string())
        }
        Err(e) => Err(e),
    };
    driver.abort();
    out
}
