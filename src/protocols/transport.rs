//! W26: transport modules (manifest `[[transport]]`): building a transport
//! for the templates and checking a stored one's fields. Kernel-neutral.

use super::manifest;
use super::model::{Fault, Transport, TransportFields, TransportKind};

/// XHTTP modes (manifest transport `xhttp`, field `mode`).
pub const XHTTP_MODES: [&str; 4] = manifest::TRANSPORT_XHTTP_MODE;

/// Paths of HTTP-based transports: start with '/', printable ASCII without
/// space, quotes, backslash or '#' (subscriptions embed them in URLs/YAML).
pub fn valid_path(p: &str) -> bool {
    p.starts_with('/')
        && p.len() <= 256
        && p.bytes()
            .all(|b| b.is_ascii_graphic() && !b"\"'\\#`<>{}|^".contains(&b))
}

/// Host header values: a DNS-ish name (optionally :port).
pub fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-.:[]".contains(&b))
}

/// gRPC service names (may hold '/' for custom paths).
pub fn valid_service_name(s: &str) -> bool {
    s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
}

/// The ALPN a TLS layer advertises on this transport (manifest `alpn`).
pub fn alpn(kind: &TransportKind) -> Vec<String> {
    manifest::get()
        .transport(kind.id())
        .map(|t| t.alpn.clone())
        .unwrap_or_default()
}

/// The transport's fields, as far as they are set.
pub fn check(t: &Transport) -> Result<(), Fault> {
    let Some(f) = &t.fields else {
        return Ok(());
    };
    if let Some(p) = &f.path
        && !p.as_deref().is_some_and(valid_path)
    {
        return Err(Fault::Path);
    }
    if let Some(Some(h)) = &f.host
        && !h.is_empty()
        && !valid_host(h)
    {
        return Err(Fault::Host);
    }
    if t.kind == TransportKind::Xhttp
        && let Some(m) = &f.mode
        && !m
            .as_deref()
            .is_some_and(|m| m.is_empty() || XHTTP_MODES.contains(&m))
    {
        return Err(Fault::Mode);
    }
    if t.kind == TransportKind::Grpc
        && let Some(s) = &f.service_name
        && !s.as_deref().is_some_and(valid_service_name)
    {
        return Err(Fault::ServiceName);
    }
    Ok(())
}

fn set(v: &str) -> Option<Option<String>> {
    Some(Some(v.to_string()))
}

fn with(kind: TransportKind, fields: TransportFields) -> Transport {
    Transport {
        kind,
        fields: Some(fields),
    }
}

/// Raw TCP.
pub fn tcp() -> Transport {
    Transport {
        kind: TransportKind::Tcp,
        fields: None,
    }
}

/// The protocol's own transport (`version`: what a versioned one declares).
pub fn native(version: Option<i64>) -> Transport {
    Transport {
        kind: TransportKind::Native,
        fields: version.map(|v| TransportFields {
            version: Some(v),
            ..Default::default()
        }),
    }
}

pub fn ws(path: &str, host: Option<&str>) -> Transport {
    with(
        TransportKind::Ws,
        TransportFields {
            path: set(path),
            host: host.map(|h| Some(h.to_string())),
            ..Default::default()
        },
    )
}

pub fn httpupgrade(path: &str, host: Option<&str>) -> Transport {
    with(
        TransportKind::HttpUpgrade,
        TransportFields {
            path: set(path),
            host: host.map(|h| Some(h.to_string())),
            ..Default::default()
        },
    )
}

pub fn xhttp(path: &str, mode: &str, host: Option<&str>) -> Transport {
    with(
        TransportKind::Xhttp,
        TransportFields {
            path: set(path),
            mode: set(mode),
            host: host.map(|h| Some(h.to_string())),
            ..Default::default()
        },
    )
}

pub fn grpc(service_name: &str) -> Transport {
    with(
        TransportKind::Grpc,
        TransportFields {
            service_name: set(service_name),
            ..Default::default()
        },
    )
}
