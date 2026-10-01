//! Startup validation of `panel.toml` (M1-3) and the redacted effective
//! config shown by `akari config check`.
//!
//! Validation is split in two: `validate` is pure (no I/O, unit-tested) and
//! `check_data_dir` probes the filesystem. Every problem is collected, so the
//! operator fixes the file once instead of once per restart. Errors stop
//! `serve`; warnings are logged and printed but never stop it.

use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::str::FromStr;

use crate::config::PanelConfig;

/// Lease bounds (seconds): agents clamp to >= 1 h, the panel to <= 30 d.
const LEASE_MIN: u64 = 3600;
const LEASE_MAX: u64 = 30 * 86400;

#[derive(Debug, Default)]
pub struct Report {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl Report {
    fn err(&mut self, msg: impl Into<String>) {
        self.errors.push(msg.into());
    }
    fn warn(&mut self, msg: impl Into<String>) {
        self.warnings.push(msg.into());
    }

    /// `Ok(warnings)` when there is no error, else one readable message.
    pub fn into_result(self) -> anyhow::Result<Vec<String>> {
        if self.errors.is_empty() {
            return Ok(self.warnings);
        }
        let list = self
            .errors
            .iter()
            .map(|e| format!("  - {e}"))
            .collect::<Vec<_>>()
            .join("\n");
        anyhow::bail!(
            "invalid configuration ({} problem{}):\n{list}",
            self.errors.len(),
            if self.errors.len() == 1 { "" } else { "s" }
        )
    }
}

impl PanelConfig {
    /// Pure validation (no filesystem or network access).
    pub fn validate(&self) -> Report {
        let mut r = Report::default();
        self.validate_addresses(&mut r);
        self.validate_names(&mut r);
        self.validate_numbers(&mut r);
        self.validate_urls(&mut r);
        self.validate_proxy_consistency(&mut r);
        self.validate_updates(&mut r);
        self.validate_payments(&mut r);
        r
    }

    /// `[payments.alipay]` (R18-3). Key files are checked separately
    /// (`billing::check_files`, startup and `config check`).
    fn validate_payments(&self, r: &mut Report) {
        let a = &self.payments.alipay;
        if !a.enabled {
            return;
        }
        let p = "payments.alipay";
        if a.app_id.is_empty()
            || a.app_id.len() > 32
            || !a.app_id.bytes().all(|b| b.is_ascii_digit())
        {
            r.err(format!("{p}.app_id: required, digits only"));
        }
        if !a.seller_id.is_empty()
            && (a.seller_id.len() > 32 || !a.seller_id.bytes().all(|b| b.is_ascii_digit()))
        {
            r.err(format!("{p}.seller_id: digits only (or empty)"));
        }
        if a.app_private_key_file.as_os_str().is_empty() {
            r.err(format!("{p}.app_private_key_file: required"));
        }
        if a.alipay_public_key_file.as_os_str().is_empty() {
            r.err(format!("{p}.alipay_public_key_file: required"));
        }
        if !(5..=120).contains(&a.order_timeout_minutes) {
            r.err(format!("{p}.order_timeout_minutes: must be 5..=120"));
        }
        match url_parts(&a.gateway_url) {
            Some((scheme, host, _)) => {
                if scheme == "http" && crate::billing::http::is_loopback_host(&host) {
                    r.warn(format!(
                        "{p}.gateway_url is plain http on loopback (a mock gateway, not Alipay)"
                    ));
                } else if scheme != "https" {
                    r.err(format!("{p}.gateway_url: must be https (http only on loopback)"));
                }
            }
            None => r.err(format!("{p}.gateway_url: not a URL")),
        }
        // The message never echoes notify_url: it contains the route prefix.
        match url_parts(&a.notify_url) {
            Some((scheme, _, path)) => {
                if !matches!(scheme.as_str(), "http" | "https") {
                    r.err(format!("{p}.notify_url: must be http(s)"));
                } else if scheme == "http" {
                    r.warn(format!(
                        "{p}.notify_url is plain http: Alipay delivers notifies over the \
                         internet; use https in production"
                    ));
                }
                let segs: Vec<&str> = path.split('/').collect();
                if segs.len() != 5
                    || !segs[0].is_empty()
                    || segs[1].is_empty()
                    || segs[2..] != ["pay", "alipay", "notify"]
                {
                    r.err(format!(
                        "{p}.notify_url: path must be /<route prefix>/pay/alipay/notify \
                         (no query, no extra segments)"
                    ));
                }
            }
            None => r.err(format!("{p}.notify_url: required, absolute URL")),
        }
    }

    fn validate_updates(&self, r: &mut Report) {
        let u = &self.updates;
        if let Err(e) = crate::updates::parse_release_keys(&u.release_keys) {
            r.err(format!("updates.release_keys: {e}"));
        }
        if !(1..=256).contains(&u.max_concurrent_downloads) {
            r.err("updates.max_concurrent_downloads: must be 1..=256");
        }
    }

    fn validate_addresses(&self, r: &mut Report) {
        let (web, grpc) = (self.web.bind, self.grpc.bind);
        if web.port() == 0 {
            r.err("web.bind: port 0 is not allowed (pick a fixed port)");
        }
        if grpc.port() == 0 {
            r.err("grpc.bind: port 0 is not allowed (agents need a fixed port)");
        }
        if conflicts(web, grpc) {
            r.err(format!(
                "web.bind and grpc.bind are both {web}: they need different ports"
            ));
        }
        if let Some(m) = self.metrics.bind {
            if m.port() == 0 {
                r.err("metrics.bind: port 0 is not allowed");
            }
            if conflicts(m, web) || conflicts(m, grpc) {
                r.err(format!(
                    "metrics.bind {m} collides with web.bind/grpc.bind: metrics must have \
                     its own listener, never the public web port"
                ));
            }
            if !m.ip().is_loopback() && !self.metrics.allow_non_loopback {
                r.err(format!(
                    "metrics.bind {m} is not a loopback address: the endpoint is \
                     unauthenticated. Bind 127.0.0.1 (scrape via a local agent/SSH tunnel) \
                     or set metrics.allow_non_loopback = true and firewall the port"
                ));
            }
        } else if self.metrics.allow_non_loopback {
            r.warn(
                "metrics.allow_non_loopback is set but metrics.bind is not: metrics are disabled",
            );
        }
    }

    fn validate_names(&self, r: &mut Report) {
        let names = &self.web.advertised_names;
        if names.is_empty() {
            r.err(
                "web.advertised_names is empty: the gRPC server certificate would have no \
                 SAN and every agent handshake would fail. List the host agents dial",
            );
        }
        for n in names {
            if let Err(e) = check_name(n, true) {
                r.err(format!("web.advertised_names entry {n:?}: {e}"));
            }
        }

        let adv = &self.grpc.advertise;
        match split_host_port(adv) {
            Err(e) => r.err(format!(
                "grpc.advertise {adv:?}: {e} (write an explicit IP:port, e.g. \
                 \"203.0.113.10:8443\", or hostname:port)"
            )),
            Ok((host, _port)) => {
                if !names.is_empty() && !covered(names, &host) {
                    r.err(format!(
                        "grpc.advertise host {host:?} is not covered by web.advertised_names \
                         {names:?}: add it so the certificate is valid for it"
                    ));
                }
            }
        }

        let sn = &self.grpc.server_name;
        match check_name(sn, false) {
            Err(e) => r.err(format!("grpc.server_name {sn:?}: {e}")),
            Ok(()) => {
                if !names.is_empty() && !covered(names, sn) {
                    r.err(format!(
                        "grpc.server_name {sn:?} is not covered by web.advertised_names \
                         {names:?}: agents verify the certificate against this name"
                    ));
                }
            }
        }
    }

    fn validate_numbers(&self, r: &mut Report) {
        let g = &self.grpc;
        if !(LEASE_MIN..=LEASE_MAX).contains(&g.lease_seconds) {
            r.err(format!(
                "grpc.lease_seconds = {} is outside {LEASE_MIN}..={LEASE_MAX} (1 hour to 30 days)",
                g.lease_seconds
            ));
        }
        let t = &self.traffic;
        if t.node_burst_secs == 0 {
            r.err("traffic.node_burst_secs must be > 0");
        } else if g.lease_seconds >= LEASE_MIN && t.node_burst_secs > g.lease_seconds {
            r.err(format!(
                "traffic.node_burst_secs = {} exceeds grpc.lease_seconds = {}",
                t.node_burst_secs, g.lease_seconds
            ));
        }
        if t.max_rate_bytes_per_sec <= 0 {
            r.err("traffic.max_rate_bytes_per_sec must be > 0");
        }
        if t.node_max_rate_bytes_per_sec <= 0 {
            r.err("traffic.node_max_rate_bytes_per_sec must be > 0");
        }
        if t.departed_grace_secs == 0 {
            r.err("traffic.departed_grace_secs must be > 0");
        }
        let sub = &self.sub;
        if sub.rate_per_ip <= 0 || sub.rate_per_token <= 0 {
            r.err("sub.rate_per_ip and sub.rate_per_token must be > 0");
        }
        if !(1..=86_400).contains(&sub.rate_window_secs) {
            r.err(format!(
                "sub.rate_window_secs = {} is outside 1..=86400",
                sub.rate_window_secs
            ));
        }
        let a = &self.agent;
        if !(60..=825 * 86400).contains(&a.cert_validity_secs) {
            r.err(format!(
                "agent.cert_validity_secs = {} is outside 60..={} (1 minute to 825 days)",
                a.cert_validity_secs,
                825 * 86400
            ));
        } else if a.cert_validity_secs < 86400 {
            r.warn(format!(
                "agent.cert_validity_secs = {}: agent certificates live less than a day \
                 (testing only; an agent offline longer than that must re-enroll)",
                a.cert_validity_secs
            ));
        }
        if !(300..=7 * 86400).contains(&a.enroll_token_ttl_secs) {
            r.err(format!(
                "agent.enroll_token_ttl_secs = {} is outside 300..=604800 (5 minutes to 7 days)",
                a.enroll_token_ttl_secs
            ));
        }
        if a.enroll_rate_per_ip <= 0 || a.enroll_rate_global <= 0 {
            r.err("agent.enroll_rate_per_ip and agent.enroll_rate_global must be > 0");
        }
        if !(1..=86_400).contains(&a.enroll_rate_window_secs) {
            r.err(format!(
                "agent.enroll_rate_window_secs = {} is outside 1..=86400",
                a.enroll_rate_window_secs
            ));
        }
        let i = &self.install;
        if !(300..=7 * 86400).contains(&i.token_ttl_secs) {
            r.err(format!(
                "install.token_ttl_secs = {} is outside 300..=604800 (5 minutes to 7 days)",
                i.token_ttl_secs
            ));
        }
        if i.rate_per_ip <= 0 {
            r.err("install.rate_per_ip must be > 0");
        }
        if !(1..=86_400).contains(&i.rate_window_secs) {
            r.err(format!(
                "install.rate_window_secs = {} is outside 1..=86400",
                i.rate_window_secs
            ));
        }
        if !i.public_url.is_empty() {
            if let Err(e) = crate::nodeinstall::parse_origin(&i.public_url) {
                r.err(format!("install.public_url: {e}"));
            }
        }
        if !i.tls_pin.is_empty() && !crate::nodeinstall::valid_pin(&i.tls_pin) {
            r.err("install.tls_pin must be \"sha256//<base64 of the SHA-256 of the SPKI>\"");
        }
        if !i.fallback_binary_url.is_empty()
            && !crate::nodeinstall::fallback_url_ok(&i.fallback_binary_url)
        {
            r.err(
                "install.fallback_binary_url must be an https:// URL containing {arch}, \
                 without quotes, spaces or shell metacharacters",
            );
        }
        if self.audit.retention_days == 0 {
            r.warn("audit.retention_days = 0: the audit log is never pruned");
        } else if self.audit.retention_days < 30 {
            r.warn(format!(
                "audit.retention_days = {} keeps less than a month of audit history",
                self.audit.retention_days
            ));
        }
    }

    fn validate_urls(&self, r: &mut Report) {
        // Parse errors from these crates never echo the URL (no password).
        let pg_scheme = ["postgres://", "postgresql://"]
            .iter()
            .any(|p| self.database_url.starts_with(p));
        if !pg_scheme {
            r.err("database_url must start with postgres:// or postgresql://");
        } else if let Err(e) = sqlx::postgres::PgConnectOptions::from_str(&self.database_url) {
            r.err(format!("database_url is not a valid PostgreSQL URL: {e}"));
        }
        if let Err(e) = fred::types::config::Config::from_url(&self.valkey_url) {
            r.err(format!("valkey_url is not a valid Redis/Valkey URL: {e}"));
        }
    }

    fn validate_proxy_consistency(&self, r: &mut Report) {
        let w = &self.web;
        let loopback = w.bind.ip().is_loopback();
        if !w.cookie_secure && !loopback && w.trusted_proxies.is_empty() {
            r.warn(format!(
                "web.cookie_secure = false while web.bind {} is not loopback and \
                 web.trusted_proxies is empty: session cookies travel over plain HTTP. \
                 Terminate TLS in a reverse proxy (see docs/DEPLOY.md) and keep \
                 cookie_secure = true",
                w.bind
            ));
        }
        if w.trusted_proxies.is_empty() && !loopback {
            r.warn(format!(
                "web.bind {} is publicly reachable without trusted_proxies: the panel then \
                 serves clear HTTP directly. Production = loopback bind + TLS proxy",
                w.bind
            ));
        }
    }

    /// The effective configuration as TOML, credentials redacted.
    pub fn effective_toml(&self) -> anyhow::Result<String> {
        let mut c = self.clone();
        c.database_url = redact_url(&c.database_url);
        c.valkey_url = redact_url(&c.valkey_url);
        if !c.payments.alipay.notify_url.is_empty() {
            // Carries the secret route prefix.
            c.payments.alipay.notify_url = "***".into();
        }
        Ok(toml::to_string_pretty(&c)?)
    }
}

/// (scheme, host, path) of an absolute URL without query/fragment/userinfo.
fn url_parts(u: &str) -> Option<(String, String, String)> {
    let uri: axum::http::Uri = u.parse().ok()?;
    let scheme = uri.scheme_str()?.to_ascii_lowercase();
    let auth = uri.authority()?;
    if auth.as_str().contains('@') || uri.query().is_some() || u.contains('#') {
        return None;
    }
    Some((scheme, auth.host().to_string(), uri.path().to_string()))
}

/// Filesystem checks of `data_dir`: it must be (or be creatable as) a
/// directory this process can write. Does not create anything.
pub fn check_data_dir(dir: &Path) -> Result<(), String> {
    let probe_dir = if dir.exists() {
        if !dir.is_dir() {
            return Err(format!(
                "data_dir {} exists but is not a directory",
                dir.display()
            ));
        }
        dir
    } else {
        // Will be created by `install::ensure`: its nearest existing
        // ancestor must be a writable directory.
        let mut p = dir;
        loop {
            match p.parent() {
                Some(parent) if parent.as_os_str().is_empty() => break Path::new("."),
                Some(parent) if parent.exists() => break parent,
                Some(parent) => p = parent,
                None => break Path::new("."),
            }
        }
    };
    let probe = probe_dir.join(format!(".akari-write-test-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(format!(
            "data_dir {} is not writable ({}: {e}). The panel stores the route prefix, CA, \
             jwt.key and totp.key there; fix ownership/permissions (see docs/DEPLOY.md)",
            dir.display(),
            probe_dir.display()
        )),
    }
}

fn conflicts(a: SocketAddr, b: SocketAddr) -> bool {
    a.port() == b.port() && (a.ip() == b.ip() || a.ip().is_unspecified() || b.ip().is_unspecified())
}

/// `host:port` with an explicit port; IPv6 hosts in brackets.
fn split_host_port(s: &str) -> Result<(String, u16), String> {
    if let Ok(sa) = SocketAddr::from_str(s) {
        if sa.port() == 0 {
            return Err("port 0 is not allowed".into());
        }
        return Ok((sa.ip().to_string(), sa.port()));
    }
    let (host, port) = s.rsplit_once(':').ok_or("missing :port")?;
    let port: u16 = port.parse().map_err(|_| format!("invalid port {port:?}"))?;
    if port == 0 {
        return Err("port 0 is not allowed".into());
    }
    if host.contains(':') || host.starts_with('[') {
        return Err("malformed IPv6 address (use [addr]:port)".into());
    }
    if host.parse::<IpAddr>().is_ok() {
        // An IPv4 literal would have parsed as a SocketAddr above.
        return Err("invalid address".into());
    }
    check_name(host, false)?;
    Ok((host.to_string(), port))
}

/// An IP literal or an RFC 1123 hostname (with `wildcard`, also `*.example`).
fn check_name(n: &str, wildcard: bool) -> Result<(), String> {
    if n.is_empty() {
        return Err("empty".into());
    }
    if n.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let rest = match n.strip_prefix("*.") {
        Some(rest) if wildcard => rest,
        Some(_) => return Err("wildcards are only allowed in advertised_names".into()),
        None => n,
    };
    if rest.len() > 253 {
        return Err("longer than 253 characters".into());
    }
    for label in rest.trim_end_matches('.').split('.') {
        let ok = !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !ok {
            return Err(
                "not an IP address or a valid hostname (letters, digits, '-', dot-separated)"
                    .into(),
            );
        }
    }
    Ok(())
}

/// Is `host` (IP literal or name) covered by an entry of `names`? Names match
/// case-insensitively; `*.x` covers exactly one extra label.
fn covered(names: &[String], host: &str) -> bool {
    let ip = host.parse::<IpAddr>().ok();
    names.iter().any(|n| {
        if let (Some(a), Ok(b)) = (ip, n.parse::<IpAddr>()) {
            return a == b;
        }
        if ip.is_some() {
            return false;
        }
        let (n, h) = (n.trim_end_matches('.'), host.trim_end_matches('.'));
        match n.strip_prefix("*.") {
            Some(suffix) => h.split_once('.').is_some_and(|(label, rest)| {
                !label.is_empty() && rest.eq_ignore_ascii_case(suffix)
            }),
            None => n.eq_ignore_ascii_case(h),
        }
    })
}

/// Replace the password of `scheme://user:pass@host/...` with `***`.
fn redact_url(u: &str) -> String {
    let Some((scheme, rest)) = u.split_once("://") else {
        return "***".into();
    };
    let (auth_end, _) = rest.split_once('/').unwrap_or((rest, ""));
    match auth_end.rsplit_once('@') {
        Some((userinfo, _)) => match userinfo.split_once(':') {
            Some((user, _)) => u.replacen(userinfo, &format!("{user}:***"), 1),
            None => u.to_string(),
        },
        None => format!("{scheme}://{rest}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(toml_s: &str) -> PanelConfig {
        toml::from_str(toml_s).expect("test config parses")
    }

    fn errors(c: &PanelConfig) -> Vec<String> {
        c.validate().errors
    }

    fn has(v: &[String], needle: &str) -> bool {
        v.iter().any(|e| e.contains(needle))
    }

    #[test]
    fn defaults_are_valid() {
        let r = PanelConfig::default().validate();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    }

    #[test]
    fn production_shape_is_valid() {
        let c = cfg(r#"
            [web]
            bind = "127.0.0.1:8080"
            trusted_proxies = ["127.0.0.1/32"]
            advertised_names = ["panel.example.com"]
            [grpc]
            bind = "0.0.0.0:8443"
            advertise = "panel.example.com:8443"
            server_name = "panel.example.com"
        "#);
        let r = c.validate();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    }

    #[test]
    fn unknown_keys_and_bad_addresses_are_parse_errors() {
        assert!(toml::from_str::<PanelConfig>("[web]\nbnd = \"127.0.0.1:1\"").is_err());
        assert!(toml::from_str::<PanelConfig>("[web]\nbind = \"not-an-addr\"").is_err());
        assert!(toml::from_str::<PanelConfig>("[web]\nbind = \"127.0.0.1\"").is_err());
    }

    #[test]
    fn advertise_must_be_explicit_host_port() {
        for bad in [
            "panel.example.com",
            "127.0.0.1",
            "127.0.0.1:0",
            "bad_name:8443",
            ":8443",
            "[::1]",
            "a:b:8443",
        ] {
            let mut c = PanelConfig::default();
            c.grpc.advertise = bad.into();
            c.web.advertised_names.push("panel.example.com".into());
            assert!(has(&errors(&c), "grpc.advertise"), "{bad}");
        }
        for ok in ["127.0.0.1:8443", "[::1]:8443", "localhost:8443"] {
            let mut c = PanelConfig::default();
            c.web.advertised_names = vec!["localhost".into(), "127.0.0.1".into(), "::1".into()];
            c.grpc.advertise = ok.into();
            assert!(errors(&c).is_empty(), "{ok}: {:?}", errors(&c));
        }
    }

    #[test]
    fn advertised_names_must_exist_and_cover_advertise_and_server_name() {
        let mut c = PanelConfig::default();
        c.web.advertised_names.clear();
        assert!(has(&errors(&c), "advertised_names is empty"));

        let mut c = PanelConfig::default();
        c.grpc.advertise = "203.0.113.9:8443".into();
        assert!(has(&errors(&c), "not covered"), "IP missing from SAN");
        c.web.advertised_names.push("203.0.113.9".into());
        assert!(errors(&c).is_empty());

        let mut c = PanelConfig::default();
        c.grpc.server_name = "panel.example.com".into();
        assert!(has(&errors(&c), "server_name"));
        c.web.advertised_names = vec!["*.example.com".into(), "127.0.0.1".into()];
        assert!(errors(&c).is_empty(), "{:?}", errors(&c));
        c.grpc.server_name = "a.b.example.com".into();
        assert!(has(&errors(&c), "server_name"), "wildcard covers one label");

        let mut c = PanelConfig::default();
        c.web.advertised_names.push("bad name".into());
        assert!(has(&errors(&c), "advertised_names entry"));
    }

    #[test]
    fn numeric_ranges() {
        let mut c = PanelConfig::default();
        c.grpc.lease_seconds = 3599;
        assert!(has(&errors(&c), "lease_seconds"));
        c.grpc.lease_seconds = 30 * 86400 + 1;
        assert!(has(&errors(&c), "lease_seconds"));
        c.grpc.lease_seconds = 3600;
        assert!(errors(&c).is_empty());
        c.grpc.lease_seconds = 30 * 86400;
        assert!(errors(&c).is_empty());

        let mut c = PanelConfig::default();
        c.traffic.node_burst_secs = 0;
        c.traffic.max_rate_bytes_per_sec = 0;
        c.traffic.node_max_rate_bytes_per_sec = -5;
        c.traffic.departed_grace_secs = 0;
        let e = errors(&c);
        for k in [
            "node_burst_secs",
            "max_rate_bytes",
            "node_max_rate",
            "departed_grace",
        ] {
            assert!(has(&e, k), "{k}: {e:?}");
        }
        let mut c = PanelConfig::default();
        c.traffic.node_burst_secs = c.grpc.lease_seconds + 1;
        assert!(has(&errors(&c), "exceeds grpc.lease_seconds"));

        // R18-2 installer settings.
        for (f, field) in [
            (
                (|c: &mut PanelConfig| c.install.token_ttl_secs = 299) as fn(&mut PanelConfig),
                "install.token_ttl_secs",
            ),
            (|c| c.install.rate_per_ip = 0, "install.rate_per_ip"),
            (
                |c| c.install.rate_window_secs = 0,
                "install.rate_window_secs",
            ),
            (
                |c| c.install.public_url = "http://panel.example.com".into(),
                "install.public_url",
            ),
            (
                |c| c.install.public_url = "https://panel.example.com/x".into(),
                "install.public_url",
            ),
            (
                |c| c.install.tls_pin = "sha256//nope".into(),
                "install.tls_pin",
            ),
            (
                |c| c.install.fallback_binary_url = "https://x.com/agent".into(),
                "install.fallback_binary_url",
            ),
        ] {
            let mut c = PanelConfig::default();
            f(&mut c);
            assert!(has(&errors(&c), field), "{field}");
        }
        let mut c = PanelConfig::default();
        c.install.public_url = "https://203.0.113.7:8443".into();
        c.install.fallback_binary_url = String::new();
        assert!(!errors(&c).iter().any(|e| e.contains("install.")));

        let mut c = PanelConfig::default();
        c.sub.rate_per_ip = 0;
        assert!(has(&errors(&c), "sub.rate_per_ip"));
        let mut c = PanelConfig::default();
        c.sub.rate_window_secs = 0;
        assert!(has(&errors(&c), "sub.rate_window_secs"));
        // M1-8 enrollment / certificate settings.
        for (f, field) in [
            (
                (|c: &mut PanelConfig| c.agent.cert_validity_secs = 59) as fn(&mut PanelConfig),
                "cert_validity_secs",
            ),
            (
                |c| c.agent.cert_validity_secs = 826 * 86400,
                "cert_validity_secs",
            ),
            (
                |c| c.agent.enroll_token_ttl_secs = 299,
                "enroll_token_ttl_secs",
            ),
            (
                |c| c.agent.enroll_token_ttl_secs = 8 * 86400,
                "enroll_token_ttl_secs",
            ),
            (|c| c.agent.enroll_rate_per_ip = 0, "enroll_rate_per_ip"),
            (|c| c.agent.enroll_rate_global = -1, "enroll_rate_global"),
            (
                |c| c.agent.enroll_rate_window_secs = 0,
                "enroll_rate_window_secs",
            ),
        ] {
            let mut c = PanelConfig::default();
            f(&mut c);
            assert!(has(&errors(&c), field), "{field}");
        }
        let mut c = PanelConfig::default();
        c.agent.cert_validity_secs = 120;
        assert!(errors(&c).is_empty(), "short validity is a warning only");
        assert!(c
            .validate()
            .warnings
            .iter()
            .any(|w| w.contains("cert_validity_secs")));
        let mut c = PanelConfig::default();
        c.audit.retention_days = 0;
        assert!(
            errors(&c).is_empty(),
            "0 = keep forever is valid (warning only)"
        );
        assert!(c
            .validate()
            .warnings
            .iter()
            .any(|w| w.contains("never pruned")));
    }

    #[test]
    fn bind_conflicts_and_zero_ports() {
        let mut c = PanelConfig::default();
        c.web.bind = "0.0.0.0:8443".parse().unwrap();
        assert!(has(&errors(&c), "different ports"));
        let mut c = PanelConfig::default();
        c.web.bind = "127.0.0.1:0".parse().unwrap();
        assert!(has(&errors(&c), "web.bind: port 0"));
    }

    #[test]
    fn metrics_listener_rules() {
        let mut c = PanelConfig::default();
        c.metrics.bind = Some("127.0.0.1:9100".parse().unwrap());
        assert!(errors(&c).is_empty());
        c.metrics.bind = Some("127.0.0.1:8080".parse().unwrap());
        assert!(has(&errors(&c), "collides"), "never the public web port");
        c.metrics.bind = Some("0.0.0.0:8080".parse().unwrap());
        assert!(has(&errors(&c), "collides"));
        c.metrics.bind = Some("10.0.0.5:9100".parse().unwrap());
        assert!(has(&errors(&c), "not a loopback"));
        c.metrics.allow_non_loopback = true;
        assert!(errors(&c).is_empty());
    }

    #[test]
    fn insecure_cookie_off_loopback_warns() {
        let mut c = PanelConfig::default();
        c.web.cookie_secure = false;
        assert!(c.validate().warnings.is_empty(), "loopback dev is fine");
        c.web.bind = "0.0.0.0:8080".parse().unwrap();
        let w = c.validate().warnings;
        assert!(
            w.iter().any(|m| m.contains("cookie_secure = false")),
            "{w:?}"
        );
        c.web.trusted_proxies = vec![crate::client_ip::Cidr::parse("10.0.0.1").unwrap()];
        let w = c.validate().warnings;
        assert!(
            !w.iter().any(|m| m.contains("cookie_secure = false")),
            "{w:?}"
        );
    }

    #[test]
    fn urls_are_checked_without_leaking_secrets() {
        let c = PanelConfig {
            database_url: "mysql://u:hunter2@h/db".into(),
            valkey_url: "garbage".into(),
            ..Default::default()
        };
        let e = errors(&c);
        assert!(has(&e, "database_url") && has(&e, "valkey_url"), "{e:?}");
        let c = PanelConfig {
            database_url: "postgres://u:hunter2@h:notaport/db".into(),
            ..Default::default()
        };
        assert!(has(&errors(&c), "database_url"));
        assert!(!errors(&c).iter().any(|m| m.contains("hunter2")));
        assert!(!e.iter().any(|m| m.contains("hunter2")));
    }

    #[test]
    fn effective_config_redacts_credentials() {
        let mut c = PanelConfig {
            database_url: "postgres://akari:s3cr3t@db:5432/akari".into(),
            valkey_url: "redis://:valkeypw@cache:6379".into(),
            ..Default::default()
        };
        c.web.trusted_proxies = vec![crate::client_ip::Cidr::parse("10.0.0.0/8").unwrap()];
        let t = c.effective_toml().unwrap();
        assert!(!t.contains("s3cr3t") && !t.contains("valkeypw"), "{t}");
        assert!(t.contains("postgres://akari:***@db:5432/akari"), "{t}");
        assert!(t.contains("10.0.0.0/8"), "{t}");
        // The printed form is itself a loadable config.
        assert!(toml::from_str::<PanelConfig>(&t).is_ok(), "{t}");
    }

    #[test]
    fn data_dir_probe() {
        let base = std::env::temp_dir().join(format!("akari-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        assert!(check_data_dir(&base).is_ok());
        assert!(check_data_dir(&base.join("new/sub")).is_ok(), "creatable");
        let file = base.join("f");
        std::fs::write(&file, b"x").unwrap();
        assert!(check_data_dir(&file)
            .unwrap_err()
            .contains("not a directory"));
        assert!(check_data_dir(&file.join("sub")).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
