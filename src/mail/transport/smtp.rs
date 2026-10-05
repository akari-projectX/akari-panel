//! SMTP provider (W15 transport, W31 plugin + diagnostic): lettre over
//! rustls with the public (webpki) roots, implicit TLS ("tls", usually
//! 465), STARTTLS ("starttls", usually 587) or plain ("none", local relays
//! only, never with credentials).
//!
//! The diagnostic speaks just enough SMTP itself (greeting, EHLO, STARTTLS,
//! AUTH PLAIN/LOGIN, QUIT) to tell the admin which part fails and why, then
//! sends the test mail through the same lettre transport the outbox uses.

use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use lettre::message::{Mailbox, MultiPart, SinglePart, header::ContentType};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Certificate, Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use uuid::Uuid;

use super::{DiagFuture, OutMsg, Provider, SendError, SendFuture, Transport, open_secret};
use crate::mail::MailSettings;
use crate::mail::diagnose::{self as d, Code, Report, Status, clip};
use crate::totp::Keys;

/// Per-command SMTP timeout (lettre).
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// How long an implicit-TLS setting waits for an unsolicited plaintext
/// greeting (= the port is not implicit TLS) before starting the handshake.
const PLAINTEXT_SNIFF: std::time::Duration = std::time::Duration::from_millis(1500);
/// Longest reply line / reply lines read by the diagnostic.
const MAX_LINE: usize = 1024;
const MAX_LINES: usize = 64;
/// EHLO name, as lettre sends it.
const EHLO_NAME: &str = "localhost";
const DIAG_STEPS: &[&str] = &["config", "dns", "tcp", "tls", "greeting", "auth", "send"];

pub struct SmtpProvider {
    /// An extra trusted root (DER) next to the public roots (tests' CA).
    pub extra_root: Option<&'static [u8]>,
}

pub static SMTP: SmtpProvider = SmtpProvider { extra_root: None };

struct Lettre {
    inner: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    domain: String,
}

impl Transport for Lettre {
    fn send<'a>(&'a self, msg: &'a OutMsg) -> SendFuture<'a> {
        Box::pin(async move {
            let to: Mailbox = msg.to.parse().map_err(|_| SendError {
                permanent: true,
                message: "invalid recipient address".into(),
            })?;
            let m = Message::builder()
                .from(self.from.clone())
                .to(to)
                .subject(msg.subject.clone())
                .message_id(Some(format!(
                    "<{}@{}>",
                    Uuid::new_v4().simple(),
                    self.domain
                )))
                .multipart(
                    MultiPart::alternative()
                        .singlepart(
                            SinglePart::builder()
                                .header(ContentType::TEXT_PLAIN)
                                .body(msg.text.clone()),
                        )
                        .singlepart(
                            SinglePart::builder()
                                .header(ContentType::TEXT_HTML)
                                .body(msg.html.clone()),
                        ),
                )
                .map_err(|e| SendError {
                    permanent: true,
                    message: format!("message: {e}"),
                })?;
            match self.inner.send(m).await {
                Ok(_) => Ok(()),
                Err(e) => Err(SendError {
                    permanent: e.is_permanent(),
                    message: e.to_string().chars().take(300).collect(),
                }),
            }
        })
    }
}

impl SmtpProvider {
    fn password(&self, s: &MailSettings, keys: &Keys) -> Result<String, String> {
        match &s.password_enc {
            Some(blob) => open_secret(keys, crate::mail::SMTP_AAD, blob, "SMTP password"),
            None => Ok(String::new()),
        }
    }

    fn tls_params(&self, host: &str) -> Result<TlsParameters, String> {
        let mut b = TlsParameters::builder(host.to_string());
        if let Some(der) = self.extra_root {
            b = b.add_root_certificate(
                Certificate::from_der(der.to_vec()).map_err(|e| format!("TLS setup: {e}"))?,
            );
        }
        b.build_rustls().map_err(|e| format!("TLS setup: {e}"))
    }
}

/// What a port conventionally expects: (security, zh, en).
fn expected_for(port: i32) -> Option<(&'static str, &'static str, &'static str)> {
    match port {
        465 => Some(("tls", "隐式 TLS（SSL/TLS）", "implicit TLS (SSL/TLS)")),
        587 | 25 => Some(("starttls", "STARTTLS", "STARTTLS")),
        _ => None,
    }
}

/// One SMTP reply: code and text (continuation lines joined by " / ").
struct Reply {
    code: u16,
    text: String,
}

impl Reply {
    fn shown(&self) -> String {
        clip(&format!("{} {}", self.code, self.text))
    }
    fn lines(&self) -> impl Iterator<Item = &str> {
        self.text.split(" / ")
    }
}

async fn read_reply<S: AsyncRead + Unpin>(io: &mut BufReader<S>) -> Result<Reply, String> {
    let mut parts = Vec::new();
    let mut code = 0u16;
    for _ in 0..MAX_LINES {
        let mut line = Vec::new();
        let n = tokio::time::timeout(d::STEP_TIMEOUT, async {
            let mut limited = (&mut *io).take(MAX_LINE as u64);
            limited.read_until(b'\n', &mut line).await
        })
        .await
        .map_err(|_| "timed out waiting for the server".to_string())?
        .map_err(|e| format!("read: {}", e.kind()))?;
        if n == 0 {
            return Err("the server closed the connection".into());
        }
        let s = String::from_utf8_lossy(&line);
        let s = s.trim_end_matches(['\r', '\n']);
        if s.len() < 3 || !s.is_char_boundary(3) {
            return Err(format!("not an SMTP reply: {}", clip(s)));
        }
        code = s[..3]
            .parse()
            .map_err(|_| format!("not an SMTP reply: {}", clip(s)))?;
        parts.push(s.get(4..).unwrap_or("").to_string());
        if s.as_bytes().get(3) != Some(&b'-') {
            return Ok(Reply {
                code,
                text: parts.join(" / "),
            });
        }
    }
    Err(format!("reply too long ({code})"))
}

async fn command<S: AsyncRead + AsyncWrite + Unpin>(
    io: &mut BufReader<S>,
    line: &str,
) -> Result<Reply, String> {
    tokio::time::timeout(d::STEP_TIMEOUT, async {
        io.get_mut().write_all(line.as_bytes()).await?;
        io.get_mut().write_all(b"\r\n").await?;
        io.get_mut().flush().await
    })
    .await
    .map_err(|_| "timed out writing to the server".to_string())?
    .map_err(|e| format!("write: {}", e.kind()))?;
    read_reply(io).await
}

/// EHLO; `Err` = the step failure was already reported.
async fn ehlo<S: AsyncRead + AsyncWrite + Unpin>(
    r: &mut Report,
    io: &mut BufReader<S>,
    step: &'static str,
    t: Instant,
) -> Result<Reply, ()> {
    match command(io, &format!("EHLO {EHLO_NAME}")).await {
        Ok(rep) if rep.code == 250 => Ok(rep),
        Ok(rep) => {
            r.push(
                step,
                Status::Fail,
                t,
                Code::EhloFailed,
                vec![("reply", rep.shown())],
            );
            Err(())
        }
        Err(e) => {
            r.push(
                step,
                Status::Fail,
                t,
                Code::EhloFailed,
                vec![("reply", clip(&e))],
            );
            Err(())
        }
    }
}

fn has_ext(ehlo: &Reply, name: &str) -> bool {
    ehlo.lines().any(|l| {
        l.split_whitespace()
            .next()
            .is_some_and(|w| w.eq_ignore_ascii_case(name))
    })
}

/// The mechanisms of the AUTH extension (upper case).
fn auth_mechanisms(ehlo: &Reply) -> Vec<String> {
    ehlo.lines()
        .find_map(|l| {
            let mut w = l.split_whitespace();
            w.next()
                .filter(|k| k.eq_ignore_ascii_case("AUTH") || k.eq_ignore_ascii_case("AUTH="))
                .map(|_| w.map(|m| m.to_ascii_uppercase()).collect())
        })
        .unwrap_or_default()
}

/// Classify a failed AUTH reply.
fn auth_failure(rep: &Reply) -> Code {
    let low = rep.text.to_ascii_lowercase();
    if rep.code == 534
        || low.contains("application-specific")
        || low.contains("app password")
        || low.contains("authorization code")
    {
        Code::AuthAppPassword
    } else if rep.code == 530 || rep.code == 538 {
        Code::AuthNeedsTls
    } else if rep.code == 535 {
        Code::AuthRejected
    } else {
        Code::AuthFailed
    }
}

/// AUTH with PLAIN (preferred) or LOGIN; reports the auth step.
async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(
    r: &mut Report,
    io: &mut BufReader<S>,
    ehlo: &Reply,
    user: &str,
    password: &str,
) -> bool {
    let t = Instant::now();
    let mechs = auth_mechanisms(ehlo);
    let res = if mechs.iter().any(|m| m == "PLAIN") {
        let token = B64.encode(format!("\0{user}\0{password}"));
        command(io, &format!("AUTH PLAIN {token}"))
            .await
            .map(|rep| ("PLAIN", rep))
    } else if mechs.iter().any(|m| m == "LOGIN") {
        async {
            let rep = command(io, "AUTH LOGIN").await?;
            if rep.code != 334 {
                return Ok(rep);
            }
            let rep = command(io, &B64.encode(user)).await?;
            if rep.code != 334 {
                return Ok(rep);
            }
            command(io, &B64.encode(password)).await
        }
        .await
        .map(|rep| ("LOGIN", rep))
    } else {
        let shown = if mechs.is_empty() {
            "-".to_string()
        } else {
            mechs.join(" ")
        };
        r.push(
            "auth",
            Status::Fail,
            t,
            Code::AuthUnsupported,
            vec![("mechanisms", clip(&shown))],
        );
        return false;
    };
    match res {
        Ok((mech, rep)) if rep.code == 235 => {
            r.push(
                "auth",
                Status::Ok,
                t,
                Code::AuthOk,
                vec![("mechanism", mech.to_string())],
            );
            true
        }
        Ok((_, rep)) => {
            r.push(
                "auth",
                Status::Fail,
                t,
                auth_failure(&rep),
                vec![("reply", rep.shown())],
            );
            false
        }
        Err(e) => {
            r.push(
                "auth",
                Status::Fail,
                t,
                Code::AuthFailed,
                vec![("reply", clip(&e))],
            );
            false
        }
    }
}

/// Greeting + EHLO (+ AUTH) over an established stream; true = ready to send.
async fn session<S: AsyncRead + AsyncWrite + Unpin>(
    r: &mut Report,
    io: &mut BufReader<S>,
    greeted: Option<Reply>,
    creds: Option<(&str, &str)>,
) -> bool {
    let t = Instant::now();
    let greeting = match greeted {
        Some(g) => g,
        None => match read_reply(io).await {
            Ok(g) => g,
            Err(e) => {
                r.push(
                    "greeting",
                    Status::Fail,
                    t,
                    Code::GreetingBad,
                    vec![("reply", clip(&e))],
                );
                return false;
            }
        },
    };
    if greeting.code != 220 {
        r.push(
            "greeting",
            Status::Fail,
            t,
            Code::GreetingBad,
            vec![("reply", greeting.shown())],
        );
        return false;
    }
    let Ok(ehlo_reply) = ehlo(r, io, "greeting", t).await else {
        return false;
    };
    r.push(
        "greeting",
        Status::Ok,
        t,
        Code::GreetingOk,
        vec![("reply", greeting.shown())],
    );
    let ok = match creds {
        None => {
            r.push(
                "auth",
                Status::Skip,
                Instant::now(),
                Code::AuthSkipped,
                vec![],
            );
            true
        }
        Some((user, password)) => authenticate(r, io, &ehlo_reply, user, password).await,
    };
    let _ = command(io, "QUIT").await;
    ok
}

impl SmtpProvider {
    async fn run(&self, s: &MailSettings, keys: &Keys, msg: &OutMsg) -> Report {
        let mut r = Report::new("smtp");
        let t = Instant::now();
        // Config.
        let (Some(host), Some(_from)) = (s.host.as_deref(), s.from_addr.as_deref()) else {
            let (missing, missing_zh) = if s.host.is_none() {
                ("the SMTP host", "SMTP 服务器")
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
        };
        let Ok(port) = u16::try_from(s.port) else {
            r.push(
                "config",
                Status::Fail,
                t,
                Code::Incomplete,
                vec![
                    ("missing", "a valid port".into()),
                    ("missing_zh", "有效的端口".into()),
                ],
            );
            r.not_reached(DIAG_STEPS);
            return r;
        };
        let password = match &s.username {
            None => None,
            Some(_) => match self.password(s, keys) {
                Ok(p) => Some(p),
                Err(_) => {
                    r.push("config", Status::Fail, t, Code::SecretUnreadable, vec![]);
                    r.not_reached(DIAG_STEPS);
                    return r;
                }
            },
        };
        let creds = s.username.as_deref().zip(password.as_deref());
        match expected_for(s.port) {
            Some((want, zh, en)) if want != s.security && s.security != "none" => r.push(
                "config",
                Status::Warn,
                t,
                Code::PortModeMismatch,
                vec![
                    ("port", port.to_string()),
                    ("security", s.security.clone()),
                    ("expected", en.into()),
                    ("expected_zh", zh.into()),
                ],
            ),
            _ if s.security == "none" => r.push("config", Status::Warn, t, Code::Plaintext, vec![]),
            _ => r.push(
                "config",
                Status::Ok,
                t,
                Code::ConfigOk,
                vec![("provider", "SMTP".into())],
            ),
        }
        // Network.
        let Some(addrs) = d::dns(&mut r, host, port).await else {
            r.not_reached(DIAG_STEPS);
            return r;
        };
        let Some(tcp) = d::tcp(&mut r, &addrs, port).await else {
            r.not_reached(DIAG_STEPS);
            return r;
        };
        let ready = match s.security.as_str() {
            "tls" => self.implicit(&mut r, tcp, host, port, creds).await,
            mode => {
                self.plain_or_starttls(&mut r, tcp, &addrs, host, port, mode == "starttls", creds)
                    .await
            }
        };
        if !ready {
            r.not_reached(DIAG_STEPS);
            return r;
        }
        // Send through the real transport.
        let t = Instant::now();
        let res = match self.build(s, keys) {
            Ok(tr) => {
                match tokio::time::timeout(crate::mail::sender::SEND_TIMEOUT, tr.send(msg)).await {
                    Ok(res) => res,
                    Err(_) => {
                        r.push("send", Status::Fail, t, Code::SendTimeout, vec![]);
                        return r;
                    }
                }
            }
            Err(e) => Err(SendError {
                permanent: true,
                message: e,
            }),
        };
        match res {
            Ok(()) => r.push(
                "send",
                Status::Ok,
                t,
                Code::SendOk,
                vec![("to", msg.to.clone())],
            ),
            Err(e) => {
                let code = if e.permanent {
                    Code::SendRejected
                } else {
                    Code::SendFailed
                };
                r.push(
                    "send",
                    Status::Fail,
                    t,
                    code,
                    vec![("detail", clip(&e.message))],
                );
            }
        }
        r
    }

    /// security = tls: a plaintext greeting means the port is not implicit
    /// TLS; otherwise handshake, then the SMTP session inside TLS.
    async fn implicit(
        &self,
        r: &mut Report,
        tcp: tokio::net::TcpStream,
        host: &str,
        port: u16,
        creds: Option<(&str, &str)>,
    ) -> bool {
        let t = Instant::now();
        let mut peek = [0u8; 8];
        if let Ok(Ok(n)) = tokio::time::timeout(PLAINTEXT_SNIFF, tcp.peek(&mut peek)).await
            && n >= 3
            && peek[..3].iter().all(u8::is_ascii_digit)
        {
            r.push(
                "tls",
                Status::Fail,
                t,
                Code::TlsPlaintextPort,
                vec![("port", port.to_string())],
            );
            return false;
        }
        let Some(tls) = d::tls(r, tcp, host, "implicit", self.extra_root).await else {
            return false;
        };
        session(r, &mut BufReader::new(tls), None, creds).await
    }

    /// security = starttls | none: greeting in plain text (silence = an
    /// implicit TLS port), EHLO, STARTTLS when asked, then the session.
    #[allow(clippy::too_many_arguments)]
    async fn plain_or_starttls(
        &self,
        r: &mut Report,
        tcp: tokio::net::TcpStream,
        addrs: &[std::net::SocketAddr],
        host: &str,
        port: u16,
        starttls: bool,
        creds: Option<(&str, &str)>,
    ) -> bool {
        let t = Instant::now();
        let mut io = BufReader::new(tcp);
        let greeting = match read_reply(&mut io).await {
            Ok(g) => g,
            Err(_) => {
                // No greeting: is it an implicit TLS port?
                let security = if starttls { "starttls" } else { "none" };
                let implicit = match d::connect(addrs).await {
                    Ok((s, _)) => match d::tls_config(self.extra_root) {
                        Ok(cfg) => d::handshake(s, host, cfg).await.is_ok(),
                        Err(_) => false,
                    },
                    Err(_) => false,
                };
                let (code, params) = if implicit {
                    (
                        Code::TlsImplicitPort,
                        vec![
                            ("port", port.to_string()),
                            ("security", security.to_string()),
                        ],
                    )
                } else {
                    (
                        Code::TlsNoGreeting,
                        vec![("secs", d::STEP_TIMEOUT.as_secs().to_string())],
                    )
                };
                r.push("tls", Status::Fail, t, code, params);
                return false;
            }
        };
        if !starttls {
            if creds.is_some() {
                r.push("tls", Status::Skip, t, Code::TlsSkipped, vec![]);
                r.push(
                    "auth",
                    Status::Fail,
                    Instant::now(),
                    Code::AuthNeedsTls,
                    vec![("reply", String::new())],
                );
                return false;
            }
            r.push("tls", Status::Skip, t, Code::TlsSkipped, vec![]);
            return session(r, &mut io, Some(greeting), None).await;
        }
        if greeting.code != 220 {
            r.push(
                "greeting",
                Status::Fail,
                t,
                Code::GreetingBad,
                vec![("reply", greeting.shown())],
            );
            return false;
        }
        let Ok(first) = ehlo(r, &mut io, "tls", t).await else {
            return false;
        };
        if !has_ext(&first, "STARTTLS") {
            r.push("tls", Status::Fail, t, Code::StarttlsUnsupported, vec![]);
            return false;
        }
        match command(&mut io, "STARTTLS").await {
            Ok(rep) if rep.code == 220 => {}
            Ok(rep) => {
                r.push(
                    "tls",
                    Status::Fail,
                    t,
                    Code::StarttlsRefused,
                    vec![("reply", rep.shown())],
                );
                return false;
            }
            Err(e) => {
                r.push(
                    "tls",
                    Status::Fail,
                    t,
                    Code::StarttlsRefused,
                    vec![("reply", clip(&e))],
                );
                return false;
            }
        }
        let Some(tls) = d::tls(r, io.into_inner(), host, "starttls", self.extra_root).await else {
            return false;
        };
        // After STARTTLS the client speaks first: a synthetic greeting
        // stands for the one already checked in plain text.
        session(r, &mut BufReader::new(tls), Some(greeting), creds).await
    }
}

impl Provider for SmtpProvider {
    fn id(&self) -> &'static str {
        "smtp"
    }

    fn complete(&self, s: &MailSettings) -> bool {
        s.host.is_some() && s.from_addr.is_some()
    }

    fn build(&self, s: &MailSettings, keys: &Keys) -> Result<Box<dyn Transport>, String> {
        let host = s.host.as_deref().ok_or("no SMTP host")?;
        let from_addr = s.from_addr.as_deref().ok_or("no sender address")?;
        let port = u16::try_from(s.port).map_err(|_| "invalid port")?;
        let tls = match s.security.as_str() {
            "tls" => Tls::Wrapper(self.tls_params(host)?),
            "starttls" => Tls::Required(self.tls_params(host)?),
            _ => Tls::None,
        };
        let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
            .port(port)
            .tls(tls)
            .timeout(Some(COMMAND_TIMEOUT));
        if let Some(user) = &s.username {
            builder = builder.credentials(Credentials::new(user.clone(), self.password(s, keys)?));
        }
        let from = Mailbox::new(
            Some(s.sender_name().to_string()),
            from_addr
                .parse()
                .map_err(|_| "the sender address is invalid")?,
        );
        Ok(Box::new(Lettre {
            inner: builder.build(),
            from,
            domain: crate::signup::email::domain_of(from_addr).to_string(),
        }))
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
