//! W31 transports: a mock SMTP server (plain, STARTTLS, implicit TLS, AUTH
//! PLAIN/LOGIN, recipient rejection) and a mock Resend API, driving both
//! the outbox transports and the step-by-step diagnostic.

use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair, KeyUsagePurpose};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use super::resend::ResendProvider;
use super::smtp::SmtpProvider;
use super::*;
use crate::mail::diagnose::{Report, Status};

fn keys() -> Keys {
    Keys::from_material(&[7u8; 32]).unwrap()
}

/// A CA (DER, leaked for the provider's `&'static` root) and a rustls
/// server config for `localhost` signed by it.
fn tls() -> (&'static [u8], Arc<rustls::ServerConfig>) {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let key_pem = key.serialize_pem();
    let ca = CertifiedIssuer::self_signed(params, key).unwrap();
    let (cert_pem, leaf_key_pem) =
        crate::install::issue_server_cert(&ca.pem(), &key_pem, &["localhost".into()]).unwrap();
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
        .map(Result::unwrap)
        .collect();
    let leaf_key = PrivateKeyDer::from_pem_slice(leaf_key_pem.as_bytes()).unwrap();
    let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(chain, leaf_key)
    .unwrap();
    let der: &'static [u8] = Box::leak(ca.der().to_vec().into_boxed_slice());
    (der, Arc::new(cfg))
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Plain,
    Starttls,
    Implicit,
    /// Accepts TCP and says nothing (not a mail service).
    Silent,
}

#[derive(Clone)]
struct MockSmtp {
    mode: Mode,
    tls: Arc<rustls::ServerConfig>,
    /// Required credentials (None = AUTH not offered).
    auth: Option<(String, String)>,
    /// Failed AUTH answers 534 "application-specific password required".
    app_password: bool,
    /// Messages accepted (DATA), by recipient.
    delivered: Arc<Mutex<Vec<String>>>,
}

async fn line<S: AsyncRead + Unpin>(io: &mut BufReader<S>) -> Option<String> {
    let mut l = String::new();
    match io.read_line(&mut l).await {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(l.trim_end().to_string()),
    }
}

async fn say<S: AsyncRead + AsyncWrite + Unpin>(io: &mut BufReader<S>, s: &str) {
    let _ = io.get_mut().write_all(format!("{s}\r\n").as_bytes()).await;
}

impl MockSmtp {
    /// The SMTP dialog over `io` (greeted = the 220 was already sent).
    /// Returns the stream when the client asked for STARTTLS.
    async fn dialog<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        io: &mut BufReader<S>,
        greet: bool,
        secure: bool,
    ) -> bool {
        if greet {
            say(io, "220 mock.test ESMTP ready").await;
        }
        let mut rcpt = String::new();
        while let Some(cmd) = line(io).await {
            let upper = cmd.to_ascii_uppercase();
            if upper.starts_with("EHLO") {
                let mut ext = vec!["250-mock.test".to_string()];
                if self.mode == Mode::Starttls && !secure {
                    ext.push("250-STARTTLS".into());
                }
                if self.auth.is_some() {
                    ext.push("250-AUTH LOGIN PLAIN".into());
                }
                ext.push("250 8BITMIME".into());
                say(io, &ext.join("\r\n")).await;
            } else if upper == "STARTTLS" {
                say(io, "220 go ahead").await;
                return true;
            } else if let Some(rest) = upper.strip_prefix("AUTH ") {
                let creds = if let Some(tok) = rest.strip_prefix("PLAIN ") {
                    let raw = B64.decode(cmd[11..].trim()).unwrap_or_default();
                    let _ = tok;
                    let parts: Vec<String> = raw
                        .split(|b| *b == 0)
                        .map(|p| String::from_utf8_lossy(p).into_owned())
                        .collect();
                    parts.get(1).cloned().zip(parts.get(2).cloned())
                } else {
                    say(io, "334 VXNlcm5hbWU6").await;
                    let u = line(io).await.unwrap_or_default();
                    say(io, "334 UGFzc3dvcmQ6").await;
                    let p = line(io).await.unwrap_or_default();
                    let d = |s: &str| {
                        String::from_utf8_lossy(&B64.decode(s).unwrap_or_default()).into_owned()
                    };
                    Some((d(&u), d(&p)))
                };
                if creds == self.auth {
                    say(io, "235 2.7.0 Authentication successful").await;
                } else if self.app_password {
                    say(
                        io,
                        "534-5.7.9 Application-specific password required.\r\n534 5.7.9 Learn more",
                    )
                    .await;
                } else {
                    say(io, "535 5.7.8 Username and Password not accepted").await;
                }
            } else if upper.starts_with("MAIL FROM") {
                say(io, "250 ok").await;
            } else if upper.starts_with("RCPT TO") {
                rcpt = cmd[8..].trim().trim_matches(['<', '>']).to_string();
                if rcpt.starts_with("nobody@") {
                    say(io, "550 5.1.1 no such user").await;
                } else {
                    say(io, "250 ok").await;
                }
            } else if upper == "DATA" {
                say(io, "354 go").await;
                while let Some(l) = line(io).await {
                    if l == "." {
                        break;
                    }
                }
                self.delivered.lock().unwrap().push(rcpt.clone());
                say(io, "250 queued").await;
            } else if upper == "QUIT" {
                say(io, "221 bye").await;
                return false;
            } else {
                say(io, "250 ok").await;
            }
        }
        false
    }

    async fn serve(self) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = l.accept().await {
                let me = self.clone();
                tokio::spawn(async move {
                    let acceptor = tokio_rustls::TlsAcceptor::from(me.tls.clone());
                    match me.mode {
                        Mode::Silent => {
                            let mut tcp = tcp;
                            let mut b = [0u8; 64];
                            let _ = tcp.read(&mut b).await;
                        }
                        Mode::Implicit => {
                            if let Ok(s) = acceptor.accept(tcp).await {
                                me.dialog(&mut BufReader::new(s), true, true).await;
                            }
                        }
                        Mode::Plain | Mode::Starttls => {
                            let mut io = BufReader::new(tcp);
                            if me.dialog(&mut io, true, false).await
                                && let Ok(s) = acceptor.accept(io.into_inner()).await
                            {
                                me.dialog(&mut BufReader::new(s), false, true).await;
                            }
                        }
                    }
                });
            }
        });
        port
    }
}

fn mock(mode: Mode, tls: Arc<rustls::ServerConfig>) -> MockSmtp {
    MockSmtp {
        mode,
        tls,
        auth: Some(("user@mock.test".into(), "secret".into())),
        app_password: false,
        delivered: Arc::default(),
    }
}

fn settings(port: u16, security: &str, password: Option<&str>) -> MailSettings {
    let k = keys();
    MailSettings {
        version: 1,
        enabled: true,
        provider: "smtp".into(),
        api_key_enc: None,
        host: Some("localhost".into()),
        port: i32::from(port),
        security: security.into(),
        username: password.map(|_| "user@mock.test".into()),
        password_enc: password.map(|p| k.seal(crate::mail::SMTP_AAD, p.as_bytes()).unwrap()),
        from_addr: Some("noreply@mock.test".into()),
        from_name: Some("Akari \"Test\"".into()),
        notify_order_paid: true,
        notify_expiry_days: 3,
        notify_expired: true,
        notify_quota: true,
        notify_refund: true,
        site_name: None,
    }
}

fn msg(to: &str) -> OutMsg {
    OutMsg {
        to: to.into(),
        subject: "s".into(),
        text: "t".into(),
        html: "<p>h</p>".into(),
    }
}

/// (step, status, code) of every step.
fn steps(r: &Report) -> Vec<(&'static str, Status, &'static str)> {
    r.steps.iter().map(|s| (s.step, s.status, s.code)).collect()
}

fn step<'a>(r: &'a Report, name: &str) -> &'a crate::mail::diagnose::Step {
    r.steps.iter().find(|s| s.step == name).unwrap()
}

async fn diag(p: &SmtpProvider, s: &MailSettings, to: &str) -> Report {
    p.diagnose(s, &keys(), &msg(to)).await
}

#[tokio::test]
async fn starttls_with_auth_passes_every_step_and_sends() {
    let (ca, tls) = tls();
    let m = mock(Mode::Starttls, tls);
    let port = m.clone().serve().await;
    let p = SmtpProvider {
        extra_root: Some(ca),
    };
    let r = diag(
        &p,
        &settings(port, "starttls", Some("secret")),
        "a@example.com",
    )
    .await;
    assert!(r.ok, "{:#?}", r.steps);
    assert_eq!(
        steps(&r),
        [
            ("config", Status::Ok, "mail.diag.config_ok"),
            ("dns", Status::Ok, "mail.diag.dns_ok"),
            ("tcp", Status::Ok, "mail.diag.tcp_ok"),
            ("tls", Status::Ok, "mail.diag.tls_ok"),
            ("greeting", Status::Ok, "mail.diag.greeting_ok"),
            ("auth", Status::Ok, "mail.diag.auth_ok"),
            ("send", Status::Ok, "mail.diag.send_ok"),
        ]
    );
    assert_eq!(step(&r, "tls").params["mode"], "starttls");
    assert_eq!(step(&r, "auth").params["mechanism"], "PLAIN");
    // The diagnostic's own session sends no mail: exactly one, the test.
    assert_eq!(*m.delivered.lock().unwrap(), ["a@example.com"]);
    // The outbox transport works over the same path.
    let t = p
        .build(&settings(port, "starttls", Some("secret")), &keys())
        .unwrap();
    t.send(&msg("b@example.com")).await.unwrap();
    assert_eq!(m.delivered.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn implicit_tls_passes_and_wrong_password_is_explained() {
    let (ca, tls) = tls();
    let port = mock(Mode::Implicit, tls).serve().await;
    let p = SmtpProvider {
        extra_root: Some(ca),
    };
    let r = diag(&p, &settings(port, "tls", Some("secret")), "a@example.com").await;
    assert!(r.ok, "{:#?}", r.steps);
    assert_eq!(step(&r, "tls").params["mode"], "implicit");
    let r = diag(&p, &settings(port, "tls", Some("wrong")), "a@example.com").await;
    assert!(!r.ok);
    let auth = step(&r, "auth");
    assert_eq!(
        (auth.status, auth.code),
        (Status::Fail, "mail.diag.auth_rejected")
    );
    assert!(auth.message.zh.contains("授权码"), "{}", auth.message.zh);
    assert!(auth.params["reply"].as_str().unwrap().starts_with("535"));
    assert_eq!(step(&r, "send").code, "mail.diag.not_reached");
}

#[tokio::test]
async fn app_password_reply_is_recognised() {
    let (ca, tls) = tls();
    let mut m = mock(Mode::Implicit, tls);
    m.app_password = true;
    let port = m.serve().await;
    let p = SmtpProvider {
        extra_root: Some(ca),
    };
    let r = diag(&p, &settings(port, "tls", Some("wrong")), "a@example.com").await;
    assert_eq!(step(&r, "auth").code, "mail.diag.auth_app_password");
}

/// Port 587 style server (plaintext greeting) with security = tls.
#[tokio::test]
async fn implicit_setting_on_a_starttls_port_is_detected() {
    let (ca, tls) = tls();
    let port = mock(Mode::Starttls, tls).serve().await;
    let p = SmtpProvider {
        extra_root: Some(ca),
    };
    let r = diag(&p, &settings(port, "tls", Some("secret")), "a@example.com").await;
    let t = step(&r, "tls");
    assert_eq!(
        (t.status, t.code),
        (Status::Fail, "mail.diag.tls_plaintext_port")
    );
    assert!(t.message.zh.contains("STARTTLS"), "{}", t.message.zh);
    assert!(!r.ok);
}

/// Port 465 style server (TLS first) with security = starttls: no greeting
/// arrives, a TLS handshake on a second connection succeeds.
#[tokio::test]
async fn starttls_setting_on_an_implicit_port_is_detected() {
    let (ca, tls) = tls();
    let port = mock(Mode::Implicit, tls).serve().await;
    let p = SmtpProvider {
        extra_root: Some(ca),
    };
    let r = diag(
        &p,
        &settings(port, "starttls", Some("secret")),
        "a@example.com",
    )
    .await;
    let t = step(&r, "tls");
    assert_eq!(
        (t.status, t.code),
        (Status::Fail, "mail.diag.tls_implicit_port")
    );
    assert!(t.message.zh.contains("SSL/TLS"));
    assert_eq!(step(&r, "send").status, Status::Skip);
}

#[tokio::test]
async fn silent_port_and_closed_port() {
    let (ca, tls) = tls();
    let silent = mock(Mode::Silent, tls).serve().await;
    let p = SmtpProvider {
        extra_root: Some(ca),
    };
    let r = diag(&p, &settings(silent, "starttls", None), "a@example.com").await;
    assert_eq!(step(&r, "tls").code, "mail.diag.tls_no_greeting");
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut s = settings(closed, "starttls", None);
    s.host = Some("127.0.0.1".into());
    let r = diag(&p, &s, "a@example.com").await;
    let t = step(&r, "tcp");
    assert_eq!((t.status, t.code), (Status::Fail, "mail.diag.tcp_refused"));
    assert!(t.message.zh.contains("465 或 587"));
}

#[tokio::test]
async fn untrusted_certificate_is_explained() {
    let (_, tls) = tls();
    let port = mock(Mode::Implicit, tls).serve().await;
    // The public roots only: the mock's CA is unknown.
    let r = diag(
        &SmtpProvider { extra_root: None },
        &settings(port, "tls", None),
        "a@example.com",
    )
    .await;
    assert_eq!(step(&r, "tls").code, "mail.diag.tls_cert_invalid");
}

#[tokio::test]
async fn plain_relay_and_rejected_recipient() {
    let (ca, tls) = tls();
    let mut m = mock(Mode::Plain, tls);
    m.auth = None;
    let port = m.clone().serve().await;
    let p = SmtpProvider {
        extra_root: Some(ca),
    };
    let r = diag(&p, &settings(port, "none", None), "nobody@example.com").await;
    assert_eq!(
        steps(&r)[..6].iter().map(|s| s.1).collect::<Vec<_>>(),
        [
            Status::Warn,
            Status::Ok,
            Status::Ok,
            Status::Skip,
            Status::Ok,
            Status::Skip
        ]
    );
    let send = step(&r, "send");
    assert_eq!(
        (send.status, send.code),
        (Status::Fail, "mail.diag.send_rejected")
    );
    assert!(send.params["detail"].as_str().unwrap().contains("550"));
    let r = diag(&p, &settings(port, "none", None), "x@example.com").await;
    assert!(r.ok);
    assert_eq!(*m.delivered.lock().unwrap(), ["x@example.com"]);
}

#[tokio::test]
async fn config_problems_stop_before_the_network() {
    let p = SmtpProvider { extra_root: None };
    let mut s = settings(587, "starttls", None);
    s.host = None;
    let r = diag(&p, &s, "a@example.com").await;
    assert_eq!(step(&r, "config").code, "mail.diag.incomplete");
    assert!(r.steps[1..].iter().all(|s| s.status == Status::Skip));
    // A password sealed under another key (master key replaced).
    let mut s = settings(587, "starttls", None);
    s.username = Some("u".into());
    s.password_enc = Some(
        Keys::from_material(&[1u8; 32])
            .unwrap()
            .seal(crate::mail::SMTP_AAD, b"p")
            .unwrap(),
    );
    let r = diag(&p, &s, "a@example.com").await;
    assert_eq!(step(&r, "config").code, "mail.diag.secret_unreadable");
    assert!(p.build(&s, &keys()).is_err());
    // Port/mode mismatch is a warning, the run goes on.
    let mut s = settings(1, "starttls", None);
    s.port = 465;
    s.host = Some("127.0.0.1".into());
    let r = diag(&p, &s, "a@example.com").await;
    let c = step(&r, "config");
    assert_eq!(
        (c.status, c.code),
        (Status::Warn, "mail.diag.port_mode_mismatch")
    );
    assert_eq!(c.params["expected"], "implicit TLS (SSL/TLS)");
}

#[test]
fn every_code_has_both_languages_and_a_unique_key() {
    use crate::mail::diagnose::{CODES, Code};
    let mut keys = std::collections::HashSet::new();
    for c in CODES {
        assert!(keys.insert(c.key()), "duplicate {}", c.key());
        assert!(c.key().starts_with("mail.diag."));
        let (zh, en) = c.text(&vec![]);
        assert!(!zh.is_empty() && !en.is_empty(), "{}", c.key());
    }
    assert_eq!(keys.len(), CODES.len());
    let (zh, en) = Code::TcpTimeout.text(&vec![
        ("addr", "1.2.3.4:465".into()),
        ("port", "465".into()),
        ("secs", "10".into()),
    ]);
    assert!(zh.contains("1.2.3.4:465") && zh.contains("封锁"), "{zh}");
    assert!(en.contains("blocked"), "{en}");
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

/// A mock Resend API on loopback: answers `status` + `body`, records requests.
async fn mock_resend(
    status: u16,
    body: &'static str,
) -> (&'static str, Arc<Mutex<Vec<(String, serde_json::Value)>>>) {
    let seen: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::default();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let rec = seen.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = l.accept().await {
            let rec = rec.clone();
            tokio::spawn(async move {
                let mut io = BufReader::new(tcp);
                let mut auth = String::new();
                let mut len = 0usize;
                let mut first = String::new();
                io.read_line(&mut first).await.unwrap();
                loop {
                    let mut h = String::new();
                    io.read_line(&mut h).await.unwrap();
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    let (k, v) = h.split_once(':').unwrap();
                    match k.to_ascii_lowercase().as_str() {
                        "authorization" => auth = v.trim().to_string(),
                        "content-length" => len = v.trim().parse().unwrap(),
                        _ => {}
                    }
                }
                let mut b = vec![0u8; len];
                io.read_exact(&mut b).await.unwrap();
                assert!(first.starts_with("POST /emails "), "{first}");
                rec.lock()
                    .unwrap()
                    .push((auth, serde_json::from_slice(&b).unwrap()));
                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                io.get_mut().write_all(resp.as_bytes()).await.unwrap();
            });
        }
    });
    let base: &'static str = Box::leak(format!("http://127.0.0.1:{port}").into_boxed_str());
    (base, seen)
}

fn resend_settings(key: Option<&str>) -> MailSettings {
    let mut s = settings(587, "starttls", None);
    s.provider = "resend".into();
    s.api_key_enc = key.map(|k| keys().seal(crate::mail::RESEND_AAD, k.as_bytes()).unwrap());
    s
}

#[tokio::test]
async fn resend_sends_with_bearer_key() {
    let (base, seen) = mock_resend(200, r#"{"id":"e1"}"#).await;
    let p = ResendProvider { base };
    let s = resend_settings(Some("re_test_key"));
    p.build(&s, &keys())
        .unwrap()
        .send(&msg("a@example.com"))
        .await
        .unwrap();
    let r = p.diagnose(&s, &keys(), &msg("b@example.com")).await;
    assert!(r.ok, "{:#?}", r.steps);
    assert_eq!(
        steps(&r).iter().map(|s| (s.0, s.1)).collect::<Vec<_>>(),
        [
            ("config", Status::Ok),
            ("dns", Status::Ok),
            ("tcp", Status::Ok),
            ("tls", Status::Skip),
            ("auth", Status::Ok),
            ("send", Status::Ok),
        ]
    );
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    let (auth, body) = &seen[0];
    assert_eq!(auth, "Bearer re_test_key");
    assert_eq!(body["to"], serde_json::json!(["a@example.com"]));
    assert_eq!(body["from"], "\"Akari \\\"Test\\\"\" <noreply@mock.test>");
    assert_eq!(body["subject"], "s");
    assert_eq!(body["html"], "<p>h</p>");
}

#[tokio::test]
async fn resend_errors_are_classified() {
    let cases: [(u16, &'static str, &str, &str, bool); 5] = [
        (
            401,
            r#"{"statusCode":401,"name":"validation_error","message":"API key is invalid"}"#,
            "auth",
            "mail.diag.api_unauthorized",
            true,
        ),
        (
            403,
            r#"{"statusCode":403,"name":"validation_error","message":"The mock.test domain is not verified."}"#,
            "send",
            "mail.diag.api_domain_unverified",
            true,
        ),
        (
            422,
            r#"{"statusCode":422,"name":"validation_error","message":"Invalid `to` field."}"#,
            "send",
            "mail.diag.api_validation",
            true,
        ),
        (
            429,
            r#"{"name":"rate_limit_exceeded","message":"Too many requests"}"#,
            "send",
            "mail.diag.api_rate_limited",
            false,
        ),
        (503, "oops", "send", "mail.diag.api_server_error", false),
    ];
    for (status, body, failing, code, permanent) in cases {
        let (base, _) = mock_resend(status, body).await;
        let p = ResendProvider { base };
        let s = resend_settings(Some("re_k"));
        let r = p.diagnose(&s, &keys(), &msg("a@example.com")).await;
        let st = step(&r, failing);
        assert_eq!((st.status, st.code), (Status::Fail, code), "{status}");
        let e = p
            .build(&s, &keys())
            .unwrap()
            .send(&msg("a@example.com"))
            .await
            .unwrap_err();
        assert_eq!(e.permanent, permanent, "{status}: {}", e.message);
        assert!(e.message.contains(&status.to_string()));
    }
    let r = ResendProvider {
        base: "http://127.0.0.1:1",
    }
    .diagnose(&resend_settings(None), &keys(), &msg("a@example.com"))
    .await;
    assert_eq!(step(&r, "config").code, "mail.diag.incomplete");
    assert_eq!(step(&r, "config").params["missing"], "the API key");
}

#[test]
fn registry_knows_both_providers() {
    assert_eq!(
        PROVIDERS.iter().map(|p| p.id()).collect::<Vec<_>>(),
        ["smtp", "resend"]
    );
    assert!(provider("smtp").is_some() && provider("nope").is_none());
    let s = resend_settings(Some("k"));
    assert!(s.complete());
    let mut s = resend_settings(None);
    assert!(!s.complete());
    s.provider = "smtp".into();
    assert!(s.complete(), "smtp needs a host and a sender");
}
