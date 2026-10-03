//! Startup validation of `panel.toml` (M1-3) and the redacted effective
//! config shown by `akari config check`.
//!
//! Validation is split in two: `validate` is pure (no I/O, unit-tested) and
//! `check_data_dir` probes the filesystem. Every problem is collected, so the
//! operator fixes the file once instead of once per restart. Errors stop
//! `serve`; warnings are logged and printed but never stop it.

use std::net::SocketAddr;
use std::path::Path;
use std::str::FromStr;

use crate::config::{Fate, PanelConfig};

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
        self.validate_ask(&mut r);
        self.validate_urls(&mut r);
        self.validate_proxy_consistency(&mut r);
        if !self.limits.test_overrides.is_empty() {
            r.warn(format!(
                "{} is set ({}): TEST timers, never in production",
                crate::config::TEST_LIMITS_ENV,
                self.limits.test_overrides.join(", ")
            ));
        }
        r
    }

    /// W24/W25 (R39): keys of older releases (`config check`; `serve` logs
    /// what the import did with each instead). Never an error (an old file
    /// keeps starting): moved settings are imported once into 系统设置 on
    /// the first start that sees them (when the database has no value),
    /// then ignored; built-in constants are ignored.
    pub fn obsolete_warnings(&self) -> Vec<String> {
        let mut r = Report::default();
        for key in self.legacy.names() {
            let shown = key
                .strip_suffix(".*")
                .map_or(key.to_string(), |s| format!("[{s}]"));
            match crate::config::fate(key) {
                Some(Fate::Moved(place)) => r.warn(format!(
                    "{shown} is obsolete: it is set in 系统设置 → {place} (database). The first \
                     start imports it once if that setting is empty; afterwards it is ignored. \
                     Delete it from panel.toml"
                )),
                Some(Fate::Constant) => r.warn(format!(
                    "{shown} is obsolete: the value is built in now and the key is ignored. \
                     Delete it from panel.toml"
                )),
                None => {}
            }
        }
        r.warnings
    }

    /// `[tls_ask]` listener (R22).
    fn validate_ask(&self, r: &mut Report) {
        let a = &self.tls_ask;
        if let Some(b) = a.bind {
            if b.port() == 0 {
                r.err("tls_ask.bind: port 0 is not allowed");
            }
            let others = [Some(self.web.bind), Some(self.grpc.bind), self.metrics.bind];
            if others.into_iter().flatten().any(|o| conflicts(b, o)) {
                r.err(format!(
                    "tls_ask.bind {b} collides with web/grpc/metrics: the ask endpoint needs its \
                     own listener, never the public web port"
                ));
            }
            if !b.ip().is_loopback() && !a.allow_non_loopback {
                r.err(format!(
                    "tls_ask.bind {b} is not a loopback address: only the reverse proxy may \
                     reach it. Bind 127.0.0.1, or set tls_ask.allow_non_loopback = true on a \
                     private network (compose) and never publish the port"
                ));
            }
        } else if a.allow_non_loopback {
            r.warn("tls_ask.allow_non_loopback is set but tls_ask.bind is not: ask is disabled");
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
        Ok(toml::to_string_pretty(&c)?)
    }
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

    fn errors(c: &PanelConfig) -> Vec<String> {
        c.validate().errors
    }

    fn has(v: &[String], needle: &str) -> bool {
        v.iter().any(|e| e.contains(needle))
    }

    /// W25: obsolete keys are warnings (never errors), one per key, naming
    /// where the value lives now.
    #[test]
    fn obsolete_keys_are_warnings() {
        let c = PanelConfig::parse(
            "[web]\nsub_domain = \"s.example.com\"\n[grpc]\nlease_seconds = 5\n\
             [payments.alipay]\napp_id = \"1\"\n[alerts]\neval_interval_secs = 5\n",
        )
        .unwrap();
        let rep = c.validate();
        assert!(rep.errors.is_empty(), "{:?}", rep.errors);
        assert!(
            rep.warnings.is_empty(),
            "serve logs the import outcome instead"
        );
        let w = c.obsolete_warnings();
        assert!(
            has(
                &w,
                "web.sub_domain is obsolete: it is set in 系统设置 → 站点 → 订阅域名"
            ),
            "{w:?}"
        );
        assert!(
            has(
                &w,
                "grpc.lease_seconds is obsolete: the value is built in now"
            ),
            "{w:?}"
        );
        assert!(has(&w, "alerts.eval_interval_secs is obsolete"), "{w:?}");
        assert!(
            has(&w, "[payments] is obsolete: it is set in 系统设置 → 支付"),
            "{w:?}"
        );
        assert_eq!(w.len(), 4, "{w:?}");
        // The minimal file has nothing obsolete and nothing to warn about.
        assert!(PanelConfig::default().validate().warnings.is_empty());
        assert!(PanelConfig::default().obsolete_warnings().is_empty());
    }

    #[test]
    fn test_limits_are_announced() {
        let mut c = PanelConfig::default();
        c.limits
            .apply_test_overrides("cert_validity_secs=60")
            .unwrap();
        assert!(has(&c.validate().warnings, "TEST timers"));
    }

    #[test]
    fn ask_listener_rules() {
        let mut c = PanelConfig::default();
        c.tls_ask.bind = Some("127.0.0.1:8082".parse().unwrap());
        assert!(errors(&c).is_empty());
        c.tls_ask.bind = Some("127.0.0.1:8080".parse().unwrap());
        assert!(has(&errors(&c), "collides"));
        c.tls_ask.bind = Some("10.0.0.5:8082".parse().unwrap());
        assert!(has(&errors(&c), "not a loopback"));
        c.tls_ask.allow_non_loopback = true;
        assert!(errors(&c).is_empty());
        c.tls_ask.bind = None;
        assert!(has(&c.validate().warnings, "ask is disabled"));
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
        // The printed form is itself a loadable config, with nothing
        // obsolete in it.
        let back = PanelConfig::parse(&t).unwrap();
        assert!(back.legacy.is_empty(), "{t}");
    }

    #[test]
    fn data_dir_probe() {
        let base = std::env::temp_dir().join(format!("akari-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        assert!(check_data_dir(&base).is_ok());
        assert!(check_data_dir(&base.join("new/sub")).is_ok(), "creatable");
        let file = base.join("f");
        std::fs::write(&file, b"x").unwrap();
        assert!(
            check_data_dir(&file)
                .unwrap_err()
                .contains("not a directory")
        );
        assert!(check_data_dir(&file.join("sub")).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
