//! 系统设置 → 邮件 → 测试发信 (W31): a step-by-step check of the path to the
//! mail provider with the SAVED settings, ending in a real test mail.
//!
//! Each step reports a status, its duration, a stable code
//! (`mail.diag.<name>`, for UI translations), the parameters and the
//! explanation in Chinese and English. The first failing step ends the run;
//! later steps are reported as `skip` (`not_reached`). Explanations name the
//! likely cause (a blocked port, implicit TLS on a STARTTLS setting, an app
//! password…) and never contain a secret: parameters are host names,
//! addresses, ports and the server's own replies (cut to 300 characters).
//!
//! The network steps shared by providers (DNS, TCP, TLS) live here; each
//! provider (`transport::*`) runs them, then its own protocol steps.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpStream;

use super::transport::{self, OutMsg};
use super::{Locale, Template, overrides};
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request};
use crate::state::AppState;

/// Connect / handshake / reply timeout of one network step.
pub const STEP_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest any single diagnostic may run (all steps and the send).
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    /// Works, but probably not what the admin wants (port/mode mismatch).
    Warn,
    Fail,
    /// Not run (an earlier step failed, or nothing to check).
    Skip,
}

/// What a step found (one variant per explanation; `text` is exhaustive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    ConfigOk,
    Incomplete,
    SecretUnreadable,
    PortModeMismatch,
    Plaintext,
    DnsOk,
    DnsFailed,
    TcpOk,
    TcpRefused,
    TcpTimeout,
    TcpFailed,
    TlsOk,
    TlsSkipped,
    TlsPlaintextPort,
    TlsImplicitPort,
    TlsNoGreeting,
    TlsCertInvalid,
    TlsHandshakeFailed,
    StarttlsUnsupported,
    StarttlsRefused,
    GreetingOk,
    GreetingBad,
    EhloFailed,
    AuthOk,
    AuthSkipped,
    AuthUnsupported,
    AuthNeedsTls,
    AuthRejected,
    AuthAppPassword,
    AuthFailed,
    ApiUnauthorized,
    ApiDomainUnverified,
    ApiValidation,
    ApiRateLimited,
    ApiServerError,
    ApiUnexpected,
    SendOk,
    SendRejected,
    SendFailed,
    SendTimeout,
    NotReached,
}

/// Every code (tests: unique keys, both languages present).
pub const CODES: &[Code] = &[
    Code::ConfigOk,
    Code::Incomplete,
    Code::SecretUnreadable,
    Code::PortModeMismatch,
    Code::Plaintext,
    Code::DnsOk,
    Code::DnsFailed,
    Code::TcpOk,
    Code::TcpRefused,
    Code::TcpTimeout,
    Code::TcpFailed,
    Code::TlsOk,
    Code::TlsSkipped,
    Code::TlsPlaintextPort,
    Code::TlsImplicitPort,
    Code::TlsNoGreeting,
    Code::TlsCertInvalid,
    Code::TlsHandshakeFailed,
    Code::StarttlsUnsupported,
    Code::StarttlsRefused,
    Code::GreetingOk,
    Code::GreetingBad,
    Code::EhloFailed,
    Code::AuthOk,
    Code::AuthSkipped,
    Code::AuthUnsupported,
    Code::AuthNeedsTls,
    Code::AuthRejected,
    Code::AuthAppPassword,
    Code::AuthFailed,
    Code::ApiUnauthorized,
    Code::ApiDomainUnverified,
    Code::ApiValidation,
    Code::ApiRateLimited,
    Code::ApiServerError,
    Code::ApiUnexpected,
    Code::SendOk,
    Code::SendRejected,
    Code::SendFailed,
    Code::SendTimeout,
    Code::NotReached,
];

/// Step parameters (name → value), in insertion order.
pub type Params = Vec<(&'static str, String)>;

fn param<'a>(p: &'a Params, k: &str) -> &'a str {
    p.iter()
        .find(|(n, _)| *n == k)
        .map(|(_, v)| v.as_str())
        .unwrap_or("")
}

impl Code {
    /// The i18n key.
    pub fn key(self) -> &'static str {
        match self {
            Code::ConfigOk => "mail.diag.config_ok",
            Code::Incomplete => "mail.diag.incomplete",
            Code::SecretUnreadable => "mail.diag.secret_unreadable",
            Code::PortModeMismatch => "mail.diag.port_mode_mismatch",
            Code::Plaintext => "mail.diag.plaintext",
            Code::DnsOk => "mail.diag.dns_ok",
            Code::DnsFailed => "mail.diag.dns_failed",
            Code::TcpOk => "mail.diag.tcp_ok",
            Code::TcpRefused => "mail.diag.tcp_refused",
            Code::TcpTimeout => "mail.diag.tcp_timeout",
            Code::TcpFailed => "mail.diag.tcp_failed",
            Code::TlsOk => "mail.diag.tls_ok",
            Code::TlsSkipped => "mail.diag.tls_skipped",
            Code::TlsPlaintextPort => "mail.diag.tls_plaintext_port",
            Code::TlsImplicitPort => "mail.diag.tls_implicit_port",
            Code::TlsNoGreeting => "mail.diag.tls_no_greeting",
            Code::TlsCertInvalid => "mail.diag.tls_cert_invalid",
            Code::TlsHandshakeFailed => "mail.diag.tls_handshake_failed",
            Code::StarttlsUnsupported => "mail.diag.starttls_unsupported",
            Code::StarttlsRefused => "mail.diag.starttls_refused",
            Code::GreetingOk => "mail.diag.greeting_ok",
            Code::GreetingBad => "mail.diag.greeting_bad",
            Code::EhloFailed => "mail.diag.ehlo_failed",
            Code::AuthOk => "mail.diag.auth_ok",
            Code::AuthSkipped => "mail.diag.auth_skipped",
            Code::AuthUnsupported => "mail.diag.auth_unsupported",
            Code::AuthNeedsTls => "mail.diag.auth_needs_tls",
            Code::AuthRejected => "mail.diag.auth_rejected",
            Code::AuthAppPassword => "mail.diag.auth_app_password",
            Code::AuthFailed => "mail.diag.auth_failed",
            Code::ApiUnauthorized => "mail.diag.api_unauthorized",
            Code::ApiDomainUnverified => "mail.diag.api_domain_unverified",
            Code::ApiValidation => "mail.diag.api_validation",
            Code::ApiRateLimited => "mail.diag.api_rate_limited",
            Code::ApiServerError => "mail.diag.api_server_error",
            Code::ApiUnexpected => "mail.diag.api_unexpected",
            Code::SendOk => "mail.diag.send_ok",
            Code::SendRejected => "mail.diag.send_rejected",
            Code::SendFailed => "mail.diag.send_failed",
            Code::SendTimeout => "mail.diag.send_timeout",
            Code::NotReached => "mail.diag.not_reached",
        }
    }

    /// The explanation (zh, en) with the parameters filled in.
    pub fn text(self, p: &Params) -> (String, String) {
        let g = |k| param(p, k);
        match self {
            Code::ConfigOk => (
                format!("配置完整（{}）", g("provider")),
                format!("Settings complete ({})", g("provider")),
            ),
            Code::Incomplete => (
                format!("配置不完整：缺少{}。请先填写并保存", g("missing_zh")),
                format!("Settings incomplete: {} missing. Fill it in and save first", g("missing")),
            ),
            Code::SecretUnreadable => (
                "保存的密码/密钥无法解密（面板主密钥已更换？），请重新填写并保存".into(),
                "The stored password/key cannot be decrypted (the panel's master key changed?); enter it again and save".into(),
            ),
            Code::PortModeMismatch => (
                format!(
                    "端口 {} 通常使用{}，而当前加密方式是 {}。如果后面的步骤失败，请先改正这一项",
                    g("port"),
                    g("expected_zh"),
                    g("security")
                ),
                format!(
                    "Port {} normally uses {}, but security is set to {}. If a later step fails, fix this first",
                    g("port"),
                    g("expected"),
                    g("security")
                ),
            ),
            Code::Plaintext => (
                "未加密连接：只适用于本机或内网的中继服务".into(),
                "Unencrypted connection: only for a relay on this host or a private network".into(),
            ),
            Code::DnsOk => (
                format!("{} 解析为 {}", g("host"), g("addrs")),
                format!("{} resolves to {}", g("host"), g("addrs")),
            ),
            Code::DnsFailed => (
                format!("无法解析主机名 {}：请检查拼写，或面板机器的 DNS 设置", g("host")),
                format!("Cannot resolve {}: check the spelling, or the panel host's DNS", g("host")),
            ),
            Code::TcpOk => (
                format!("已连接 {}", g("addr")),
                format!("Connected to {}", g("addr")),
            ),
            Code::TcpRefused => (
                format!(
                    "{} 拒绝连接：端口 {} 上没有邮件服务。请核对端口号（常用 465 或 587）",
                    g("addr"),
                    g("port")
                ),
                format!(
                    "{} refused the connection: nothing listens on port {}. Check the port (usually 465 or 587)",
                    g("addr"),
                    g("port")
                ),
            ),
            Code::TcpTimeout => (
                format!(
                    "连接 {} 超时（{} 秒）：出站端口 {} 很可能被服务商或防火墙封锁。很多云服务商默认封锁 25/465/587，需要提交工单开通；也可以改用 Resend（HTTPS 443）",
                    g("addr"),
                    g("secs"),
                    g("port")
                ),
                format!(
                    "Connecting to {} timed out ({} s): outbound port {} is most likely blocked by the hosting provider or a firewall. Many clouds block 25/465/587 until you ask support; Resend (HTTPS 443) avoids it",
                    g("addr"),
                    g("secs"),
                    g("port")
                ),
            ),
            Code::TcpFailed => (
                format!("无法连接 {}：{}", g("addr"), g("detail")),
                format!("Cannot connect to {}: {}", g("addr"), g("detail")),
            ),
            Code::TlsOk => (
                format!("TLS 已建立（{}，{}），证书有效", g("mode_zh"), g("version")),
                format!("TLS established ({}, {}), certificate valid", g("mode"), g("version")),
            ),
            Code::TlsSkipped => ("未加密，跳过 TLS".into(), "Unencrypted: no TLS".into()),
            Code::TlsPlaintextPort => (
                format!(
                    "端口 {} 是明文/STARTTLS 端口（服务器直接发送了明文问候），但加密方式设为 SSL/TLS。请把加密方式改为 STARTTLS（或把端口改为 465）",
                    g("port")
                ),
                format!(
                    "Port {} is a plaintext/STARTTLS port (the server greeted in plain text), but security is SSL/TLS. Set security to STARTTLS (or use port 465)",
                    g("port")
                ),
            ),
            Code::TlsImplicitPort => (
                format!(
                    "端口 {} 使用隐式 TLS（连接后服务器等待 TLS 握手，不发送明文问候），但加密方式设为 {}。请把加密方式改为 SSL/TLS（或把端口改为 587 并使用 STARTTLS）",
                    g("port"),
                    g("security")
                ),
                format!(
                    "Port {} uses implicit TLS (the server waits for a TLS handshake instead of greeting), but security is {}. Set security to SSL/TLS (or use port 587 with STARTTLS)",
                    g("port"),
                    g("security")
                ),
            ),
            Code::TlsNoGreeting => (
                format!(
                    "服务器 {} 秒内没有发送问候语，也不接受 TLS 握手：这个端口上可能不是邮件服务",
                    g("secs")
                ),
                format!(
                    "The server sent no greeting within {} s and does not accept a TLS handshake either: this port may not be a mail service",
                    g("secs")
                ),
            ),
            Code::TlsCertInvalid => (
                format!(
                    "服务器证书不受信任：{}。请确认主机名与证书一致（填写服务商给出的主机名，不要填 IP），且证书由公共 CA 签发",
                    g("detail")
                ),
                format!(
                    "The server's certificate is not trusted: {}. Use the host name the certificate is issued for (not an IP) and a publicly trusted certificate",
                    g("detail")
                ),
            ),
            Code::TlsHandshakeFailed => (
                format!("TLS 握手失败：{}", g("detail")),
                format!("TLS handshake failed: {}", g("detail")),
            ),
            Code::StarttlsUnsupported => (
                "服务器不支持 STARTTLS：如果是 465 端口，请把加密方式改为 SSL/TLS".into(),
                "The server does not offer STARTTLS: on port 465 set security to SSL/TLS".into(),
            ),
            Code::StarttlsRefused => (
                format!("服务器拒绝了 STARTTLS：{}", g("reply")),
                format!("The server refused STARTTLS: {}", g("reply")),
            ),
            Code::GreetingOk => (
                format!("服务器问候：{}", g("reply")),
                format!("Server greeting: {}", g("reply")),
            ),
            Code::GreetingBad => (
                format!("服务器拒绝服务：{}", g("reply")),
                format!("The server refuses service: {}", g("reply")),
            ),
            Code::EhloFailed => (
                format!("服务器不接受 EHLO：{}", g("reply")),
                format!("The server rejected EHLO: {}", g("reply")),
            ),
            Code::AuthOk => (
                format!("登录成功（{}）", g("mechanism")),
                format!("Authenticated ({})", g("mechanism")),
            ),
            Code::AuthSkipped => (
                "未填写用户名，不登录".into(),
                "No user name: not authenticating".into(),
            ),
            Code::AuthUnsupported => (
                format!(
                    "服务器没有提供可用的登录方式（支持：{}；面板使用 PLAIN 或 LOGIN）",
                    g("mechanisms")
                ),
                format!(
                    "The server offers no usable login mechanism (offered: {}; the panel uses PLAIN or LOGIN)",
                    g("mechanisms")
                ),
            ),
            Code::AuthNeedsTls => (
                format!("服务器要求先加密才能登录：请使用 STARTTLS 或 SSL/TLS。{}", g("reply")),
                format!("The server requires encryption before login: use STARTTLS or SSL/TLS. {}", g("reply")),
            ),
            Code::AuthRejected => (
                format!(
                    "用户名或密码错误：{}。QQ/163/Gmail/Outlook 等邮箱需要使用「授权码/应用专用密码」，而不是登录密码",
                    g("reply")
                ),
                format!(
                    "Wrong user name or password: {}. Gmail, Outlook, QQ, 163 and similar need an app password, not the account password",
                    g("reply")
                ),
            ),
            Code::AuthAppPassword => (
                format!(
                    "邮箱服务商要求使用应用专用密码（授权码）登录：{}。请在邮箱设置中开启 SMTP 并生成授权码",
                    g("reply")
                ),
                format!(
                    "The provider requires an app-specific password: {}. Enable SMTP in the mailbox settings and create one",
                    g("reply")
                ),
            ),
            Code::AuthFailed => (
                format!("登录失败：{}", g("reply")),
                format!("Login failed: {}", g("reply")),
            ),
            Code::ApiUnauthorized => (
                format!(
                    "API 密钥无效或没有发信权限（HTTP {}）：{}。请在服务商后台重新生成密钥",
                    g("status"),
                    g("detail")
                ),
                format!(
                    "The API key is invalid or may not send (HTTP {}): {}. Create a new key in the provider's dashboard",
                    g("status"),
                    g("detail")
                ),
            ),
            Code::ApiDomainUnverified => (
                format!(
                    "发件地址的域名未在服务商处验证：{}。请在服务商后台添加并验证该域名（DNS 记录），或改用已验证域名的发件地址",
                    g("detail")
                ),
                format!(
                    "The sender's domain is not verified with the provider: {}. Add and verify the domain (DNS records), or use a sender on a verified domain",
                    g("detail")
                ),
            ),
            Code::ApiValidation => (
                format!("服务商拒绝了这封邮件：{}", g("detail")),
                format!("The provider rejected the message: {}", g("detail")),
            ),
            Code::ApiRateLimited => (
                "请求过于频繁（HTTP 429），请稍后再试".into(),
                "Rate limited (HTTP 429); try again later".into(),
            ),
            Code::ApiServerError => (
                format!("服务商暂时故障（HTTP {}），请稍后再试", g("status")),
                format!("The provider failed (HTTP {}); try again later", g("status")),
            ),
            Code::ApiUnexpected => (
                format!("服务商返回了意外的结果（HTTP {}）：{}", g("status"), g("detail")),
                format!("Unexpected answer from the provider (HTTP {}): {}", g("status"), g("detail")),
            ),
            Code::SendOk => (
                format!("测试邮件已发出，请到 {} 的收件箱（以及垃圾邮件）查看", g("to")),
                format!("Test mail sent: check {}'s inbox (and spam folder)", g("to")),
            ),
            Code::SendRejected => (
                format!("服务器拒绝了这封邮件：{}。常见原因：发件地址与登录账号不一致、收件地址不存在", g("detail")),
                format!("The server rejected the message: {}. Common causes: the sender differs from the login account, or the recipient does not exist", g("detail")),
            ),
            Code::SendFailed => (
                format!("发送失败（可重试）：{}", g("detail")),
                format!("Sending failed (retryable): {}", g("detail")),
            ),
            Code::SendTimeout => (
                "发送超时：服务器在规定时间内没有完成".into(),
                "Sending timed out: the server did not finish in time".into(),
            ),
            Code::NotReached => (
                "前一步失败，未执行".into(),
                "Not run: an earlier step failed".into(),
            ),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Message {
    pub zh: String,
    pub en: String,
}

#[derive(Debug, Serialize)]
pub struct Step {
    /// config | dns | tcp | tls | greeting | auth | send
    pub step: &'static str,
    pub status: Status,
    pub elapsed_ms: u64,
    pub code: &'static str,
    pub params: serde_json::Map<String, serde_json::Value>,
    pub message: Message,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub provider: &'static str,
    /// The test mail was accepted by the provider.
    pub ok: bool,
    pub steps: Vec<Step>,
}

/// Server text in a step parameter: one line-ish, at most 300 characters.
pub fn clip(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(300)
        .collect::<String>()
        .trim()
        .to_string()
}

impl Report {
    pub fn new(provider: &'static str) -> Self {
        Self {
            provider,
            ok: false,
            steps: Vec::new(),
        }
    }

    pub fn push(
        &mut self,
        step: &'static str,
        status: Status,
        started: Instant,
        code: Code,
        params: Params,
    ) {
        let (zh, en) = code.text(&params);
        if step == "send" && status == Status::Ok {
            self.ok = true;
        }
        self.steps.push(Step {
            step,
            status,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            code: code.key(),
            params: params
                .into_iter()
                .map(|(k, v)| (k.to_string(), serde_json::Value::String(v)))
                .collect(),
            message: Message { zh, en },
        });
    }

    /// Mark the steps that did not run after a failure.
    pub fn not_reached(&mut self, steps: &[&'static str]) {
        let now = Instant::now();
        for s in steps {
            if !self.steps.iter().any(|x| x.step == *s) {
                self.push(s, Status::Skip, now, Code::NotReached, vec![]);
            }
        }
    }

    pub fn failed(&self) -> bool {
        self.steps.iter().any(|s| s.status == Status::Fail)
    }

    /// The first failing step (for the audit row and the legacy test endpoint).
    pub fn first_failure(&self) -> Option<&Step> {
        self.steps.iter().find(|s| s.status == Status::Fail)
    }
}

/// DNS step: resolve `host:port`.
pub async fn dns(r: &mut Report, host: &str, port: u16) -> Option<Vec<SocketAddr>> {
    let t = Instant::now();
    let looked = tokio::time::timeout(STEP_TIMEOUT, tokio::net::lookup_host((host, port))).await;
    let addrs: Vec<SocketAddr> = match looked {
        Ok(Ok(a)) => a.collect(),
        _ => Vec::new(),
    };
    if addrs.is_empty() {
        r.push(
            "dns",
            Status::Fail,
            t,
            Code::DnsFailed,
            vec![("host", host.to_string())],
        );
        return None;
    }
    let shown = addrs
        .iter()
        .take(4)
        .map(|a| a.ip().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    r.push(
        "dns",
        Status::Ok,
        t,
        Code::DnsOk,
        vec![("host", host.to_string()), ("addrs", shown)],
    );
    Some(addrs)
}

/// One TCP connection to the first address that answers (no step entry).
pub async fn connect(
    addrs: &[SocketAddr],
) -> Result<(TcpStream, SocketAddr), (SocketAddr, std::io::Error)> {
    let mut last = None;
    for a in addrs.iter().take(4) {
        match tokio::time::timeout(STEP_TIMEOUT, TcpStream::connect(a)).await {
            Ok(Ok(s)) => return Ok((s, *a)),
            Ok(Err(e)) => last = Some((*a, e)),
            Err(_) => {
                last = Some((
                    *a,
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out"),
                ))
            }
        }
    }
    Err(last.unwrap_or_else(|| {
        (
            SocketAddr::from(([0, 0, 0, 0], 0)),
            std::io::Error::new(std::io::ErrorKind::AddrNotAvailable, "no address"),
        )
    }))
}

/// TCP step.
pub async fn tcp(r: &mut Report, addrs: &[SocketAddr], port: u16) -> Option<TcpStream> {
    let t = Instant::now();
    match connect(addrs).await {
        Ok((s, a)) => {
            let _ = s.set_nodelay(true);
            r.push(
                "tcp",
                Status::Ok,
                t,
                Code::TcpOk,
                vec![("addr", a.to_string())],
            );
            Some(s)
        }
        Err((a, e)) => {
            let (code, params) = match e.kind() {
                std::io::ErrorKind::ConnectionRefused => (
                    Code::TcpRefused,
                    vec![("addr", a.to_string()), ("port", port.to_string())],
                ),
                std::io::ErrorKind::TimedOut => (
                    Code::TcpTimeout,
                    vec![
                        ("addr", a.to_string()),
                        ("port", port.to_string()),
                        ("secs", STEP_TIMEOUT.as_secs().to_string()),
                    ],
                ),
                _ => (
                    Code::TcpFailed,
                    vec![("addr", a.to_string()), ("detail", clip(&e.to_string()))],
                ),
            };
            r.push("tcp", Status::Fail, t, code, params);
            None
        }
    }
}

/// rustls client config: the public roots (webpki), plus `extra_root` (a
/// DER certificate; tests' local CA).
pub fn tls_config(extra_root: Option<&[u8]>) -> Result<Arc<rustls::ClientConfig>, String> {
    let Some(der) = extra_root else {
        return crate::billing::http::tls_config();
    };
    let mut roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    roots
        .add(rustls::pki_types::CertificateDer::from(der.to_vec()))
        .map_err(|e| format!("tls: {e}"))?;
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("tls: {e}"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Arc::new(cfg))
}

pub type Tls = tokio_rustls::client::TlsStream<TcpStream>;

/// A TLS handshake over `tcp` (no step entry): `Err((cert_problem, detail))`.
pub async fn handshake(
    tcp: TcpStream,
    host: &str,
    cfg: Arc<rustls::ClientConfig>,
) -> Result<Tls, (bool, String)> {
    let name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| (false, "invalid server name".to_string()))?;
    match tokio::time::timeout(
        STEP_TIMEOUT,
        tokio_rustls::TlsConnector::from(cfg).connect(name, tcp),
    )
    .await
    {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => {
            let cert = e
                .get_ref()
                .and_then(|i| i.downcast_ref::<rustls::Error>())
                .is_some_and(|e| matches!(e, rustls::Error::InvalidCertificate(_)));
            Err((cert, clip(&e.to_string())))
        }
        Err(_) => Err((false, "timed out".into())),
    }
}

/// The negotiated TLS version, for the report.
pub fn tls_version(s: &Tls) -> String {
    match s.get_ref().1.protocol_version() {
        Some(rustls::ProtocolVersion::TLSv1_3) => "TLS 1.3".into(),
        Some(rustls::ProtocolVersion::TLSv1_2) => "TLS 1.2".into(),
        Some(v) => format!("{v:?}"),
        None => "TLS".into(),
    }
}

/// TLS step (`mode`: implicit | starttls | https).
pub async fn tls(
    r: &mut Report,
    tcp: TcpStream,
    host: &str,
    mode: &'static str,
    extra_root: Option<&[u8]>,
) -> Option<Tls> {
    let t = Instant::now();
    let cfg = match tls_config(extra_root) {
        Ok(c) => c,
        Err(e) => {
            r.push(
                "tls",
                Status::Fail,
                t,
                Code::TlsHandshakeFailed,
                vec![("detail", e)],
            );
            return None;
        }
    };
    match handshake(tcp, host, cfg).await {
        Ok(s) => {
            let mode_zh = match mode {
                "implicit" => "隐式 TLS",
                "starttls" => "STARTTLS",
                _ => "HTTPS",
            };
            r.push(
                "tls",
                Status::Ok,
                t,
                Code::TlsOk,
                vec![
                    ("mode", mode.to_string()),
                    ("mode_zh", mode_zh.to_string()),
                    ("version", tls_version(&s)),
                ],
            );
            Some(s)
        }
        Err((cert, detail)) => {
            let code = if cert {
                Code::TlsCertInvalid
            } else {
                Code::TlsHandshakeFailed
            };
            r.push("tls", Status::Fail, t, code, vec![("detail", detail)]);
            None
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnoseReq {
    pub to: String,
}

/// POST /api/v1/settings/mail/diagnose (admin): run the diagnostic with the
/// SAVED settings (enabled or not) and send the `test` template to `to`.
/// Always 200 with the report (`ok` = the provider accepted the mail);
/// audited as `settings.mail.test` with the outcome.
pub async fn diagnose(
    State(state): State<AppState>,
    user: AuthUser,
    crate::api::ApiJson(req): crate::api::ApiJson<DiagnoseReq>,
) -> Result<Json<Report>, ApiError> {
    user.require_admin()?;
    let to = crate::signup::email::parse(&req.to)
        .ok_or_else(|| bad_request!("mail.to_invalid", "to is not a valid email address"))?;
    let (settings, rendered) = {
        let mut c = state.pg().acquire().await?;
        let s = super::load(&mut c).await?;
        let r = overrides::render_for(&mut c, &Template::Test, Locale::Zh, s.site()).await?;
        (s, r)
    };
    let Some(provider) = transport::provider(&settings.provider) else {
        return Err(bad_request!(
            "mail.provider_invalid",
            "unknown mail provider"
        ));
    };
    let msg = OutMsg {
        to: to.clone(),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
    };
    let report = match tokio::time::timeout(
        TOTAL_TIMEOUT,
        provider.diagnose(&settings, state.totp(), &msg),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            let mut r = Report::new(provider.id());
            r.push(
                "send",
                Status::Fail,
                Instant::now(),
                Code::SendTimeout,
                vec![],
            );
            r
        }
    };
    let outcome = match report.first_failure() {
        None if report.ok => "sent".to_string(),
        None => "not sent".to_string(),
        Some(s) => s.code.to_string(),
    };
    let mut c = state.pg().acquire().await?;
    crate::audit::record(
        &mut c,
        &Actor::of(&user),
        "settings.mail.test",
        "settings",
        Some("mail".into()),
        None,
        Some(
            json!({ "to": to, "outcome": outcome, "provider": provider.id(), "diagnostic": true }),
        ),
    )
    .await?;
    Ok(Json(report))
}
