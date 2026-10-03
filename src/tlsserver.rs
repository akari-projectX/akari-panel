//! TLS of the agent gRPC endpoint with a hot-swappable server certificate
//! (R22).
//!
//! tonic's own `ServerTlsConfig` fixes the certificate at startup. The
//! panel instead terminates TLS itself (tokio-rustls) and hands tonic the
//! established streams (`serve_with_incoming_shutdown`); tonic's
//! `Connected` impl for `tokio_rustls::server::TlsStream` still exposes the
//! verified client chain, so `Request::peer_certs` (enroll::peer_cert)
//! works unchanged. The certificate comes from `CertResolver`, which
//! `settings::reload` swaps whenever the set of gRPC server names changes
//! (a node domain saved in the admin UI): new handshakes get the new
//! certificate at once, on every instance, without a restart; established
//! agent streams are untouched.
//!
//! Policy is the one tonic had: TLS 1.2/1.3 (ring), ALPN `h2` (grpc-go
//! requires it), client certificates OPTIONAL at the handshake (a presented
//! one must chain to the panel CA, be valid now and carry ClientAuth) so a
//! fresh agent can call AgentEnrollment.Enroll; every AgentChannel method
//! requires one (`enroll::peer_cert`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use arc_swap::ArcSwapOption;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert, WebPkiClientVerifier};
use rustls::sign::CertifiedKey;
use rustls::{RootCertStore, ServerConfig};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;
use tokio_stream::wrappers::ReceiverStream;

/// A handshake that has not completed after this long is dropped (a
/// slow or silent peer must not hold a task forever).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Completed handshakes waiting for the gRPC server to pick them up.
const BACKLOG: usize = 128;
/// Handshakes in progress at once (review 2026-10-02 C4). The gRPC port is
/// public and each pending handshake holds a task, the socket and rustls
/// buffers (~40 KiB) for up to HANDSHAKE_TIMEOUT: without a bound a flood of
/// silent connections costs gigabytes. Past the bound a new TCP connection
/// is closed at once (counted in `akari_grpc_handshakes_dropped_total`);
/// agents retry with backoff. 1024 x ~40 KiB = ~40 MiB worst case, far above
/// a fleet's reconnect burst (200 nodes).
pub const MAX_HANDSHAKES: usize = 1024;

/// The current server certificate and the names it covers.
#[derive(Debug, Default)]
pub struct CertResolver {
    key: ArcSwapOption<CertifiedKey>,
    names: Mutex<Vec<String>>,
}

impl CertResolver {
    /// Install a certificate (PEM chain + PEM private key) valid for
    /// `names` (sorted, deduplicated by the caller).
    pub fn set(&self, cert_pem: &str, key_pem: &str, names: Vec<String>) -> Result<()> {
        let key = certified_key(cert_pem, key_pem)?;
        // Names first under the lock: readers comparing names never see a
        // newer name list with an older certificate for long, and the
        // reload path is serialized anyway (settings::Live::reload_lock).
        let mut current = self.names.lock().unwrap_or_else(|p| p.into_inner());
        self.key.store(Some(Arc::new(key)));
        *current = names;
        Ok(())
    }

    /// The names the served certificate covers (empty before the first
    /// `set`).
    pub fn names(&self) -> Vec<String> {
        self.names.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn has_certificate(&self) -> bool {
        self.key.load().is_some()
    }
}

impl ResolvesServerCert for CertResolver {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.key.load_full()
    }
}

fn certified_key(cert_pem: &str, key_pem: &str) -> Result<CertifiedKey> {
    let chain = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .context("server certificate PEM")?;
    anyhow::ensure!(!chain.is_empty(), "no server certificate in PEM");
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).context("server key PEM")?;
    let signer = rustls::crypto::ring::sign::any_supported_type(&key).context("server key type")?;
    Ok(CertifiedKey::new(chain, signer))
}

/// The rustls server configuration of the gRPC endpoint.
pub fn server_config(ca_pem: &str, resolver: Arc<CertResolver>) -> Result<Arc<ServerConfig>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = RootCertStore::empty();
    for c in CertificateDer::pem_slice_iter(ca_pem.as_bytes()) {
        roots
            .add(c.context("panel CA PEM")?)
            .context("panel CA certificate")?;
    }
    let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .allow_unauthenticated()
        .build()
        .context("client certificate verifier")?;
    let mut cfg = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .context("TLS protocol versions")?
        .with_client_cert_verifier(verifier)
        .with_cert_resolver(resolver);
    cfg.alpn_protocols = vec![b"h2".to_vec()];
    Ok(Arc::new(cfg))
}

/// Accept TCP connections on `listener` and complete TLS handshakes
/// concurrently; established streams come out of the returned stream. The
/// task ends when the receiving side is dropped (abort it to stop
/// accepting at once).
pub fn incoming(
    listener: TcpListener,
    cfg: Arc<ServerConfig>,
) -> (
    ReceiverStream<std::io::Result<TlsStream<TcpStream>>>,
    tokio::task::JoinHandle<()>,
) {
    incoming_limited(listener, cfg, MAX_HANDSHAKES)
}

/// `incoming` with an explicit in-progress handshake bound (tests).
fn incoming_limited(
    listener: TcpListener,
    cfg: Arc<ServerConfig>,
    max_handshakes: usize,
) -> (
    ReceiverStream<std::io::Result<TlsStream<TcpStream>>>,
    tokio::task::JoinHandle<()>,
) {
    let (tx, rx) = tokio::sync::mpsc::channel(BACKLOG);
    let acceptor = TlsAcceptor::from(cfg);
    let gate = Arc::new(tokio::sync::Semaphore::new(max_handshakes));
    let task = tokio::spawn(async move {
        loop {
            let (tcp, peer) = match listener.accept().await {
                Ok(c) => c,
                Err(e) => {
                    // EMFILE and friends: back off instead of spinning.
                    tracing::warn!(error = %e, "grpc accept failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            if tx.is_closed() {
                return;
            }
            // Taken before spawning; held until the stream is handed over
            // (a handshake waiting on a full backlog still holds memory).
            let Ok(permit) = gate.clone().try_acquire_owned() else {
                crate::metrics::handshake_dropped();
                tracing::debug!(peer = %peer, "grpc handshake limit reached; connection dropped");
                drop(tcp);
                continue;
            };
            let _ = tcp.set_nodelay(true);
            let (acceptor, tx) = (acceptor.clone(), tx.clone());
            tokio::spawn(async move {
                let _permit = permit;
                match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await {
                    Ok(Ok(tls)) => {
                        let _ = tx.send(Ok(tls)).await;
                    }
                    Ok(Err(e)) => {
                        tracing::debug!(peer = %peer, error = %e, "grpc TLS handshake failed")
                    }
                    Err(_) => tracing::debug!(peer = %peer, "grpc TLS handshake timed out"),
                }
            });
        }
    });
    (ReceiverStream::new(rx), task)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_swaps_certificates() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = std::env::temp_dir().join(format!("akari-tls-{}", uuid::Uuid::new_v4()));
        let cfg = crate::config::PanelConfig {
            data_dir: dir.clone(),
            ..Default::default()
        };
        let inst = crate::install::ensure(&cfg).unwrap();
        let r = CertResolver::default();
        assert!(!r.has_certificate() && r.names().is_empty());
        r.set(
            &inst.server_cert_pem,
            &inst.server_key_pem,
            vec!["a".into()],
        )
        .unwrap();
        let first = r.key.load_full().unwrap();
        let (c2, k2) = crate::install::issue_server_cert(
            &inst.ca_pem,
            &inst.ca_key_pem,
            &["a".into(), "b.example".into()],
        )
        .unwrap();
        r.set(&c2, &k2, vec!["a".into(), "b.example".into()])
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &r.key.load_full().unwrap()));
        assert_eq!(r.names(), vec!["a".to_string(), "b.example".to_string()]);
        assert!(r.set("garbage", &k2, vec![]).is_err());
        assert!(server_config(&inst.ca_pem, Arc::new(r)).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// C4: past the in-progress handshake bound new connections are closed
    /// at once; a finished (here: abandoned) handshake frees its slot.
    #[tokio::test]
    async fn handshakes_in_progress_are_bounded() {
        use tokio::io::AsyncReadExt;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = std::env::temp_dir().join(format!("akari-tls-{}", uuid::Uuid::new_v4()));
        let cfg = crate::config::PanelConfig {
            data_dir: dir.clone(),
            ..Default::default()
        };
        let inst = crate::install::ensure(&cfg).unwrap();
        let r = Arc::new(CertResolver::default());
        r.set(
            &inst.server_cert_pem,
            &inst.server_key_pem,
            vec!["a".into()],
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (_rx, task) = incoming_limited(listener, server_config(&inst.ca_pem, r).unwrap(), 2);

        // Is the connection still open after a short wait? A silent client
        // whose handshake is in progress gets nothing back (timeout); a
        // dropped one reads EOF (or a reset) at once.
        async fn held(c: &mut TcpStream) -> bool {
            let mut b = [0u8; 1];
            tokio::time::timeout(Duration::from_millis(300), c.read(&mut b))
                .await
                .is_err()
        }
        let mut a = TcpStream::connect(addr).await.unwrap();
        let mut b = TcpStream::connect(addr).await.unwrap();
        assert!(held(&mut a).await && held(&mut b).await);
        let mut c = TcpStream::connect(addr).await.unwrap();
        assert!(!held(&mut c).await, "third handshake must be dropped");
        // A slot frees when a pending handshake ends (client went away).
        drop(a);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut d = TcpStream::connect(addr).await.unwrap();
        assert!(held(&mut d).await, "freed slot must admit a new handshake");
        assert!(held(&mut b).await);
        task.abort();
        let _ = std::fs::remove_dir_all(dir);
    }
}
