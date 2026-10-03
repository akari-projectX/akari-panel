//! W26: the kernel-neutral inbound model.
//!
//! Protocol, transport and security modules (`protocol/`, `transport.rs`,
//! `security.rs`) compose an [`Inbound`]; a kernel adapter renders it
//! (`xray::render`, the only adapter today) and parses the kernel's stored
//! configuration back into it (`xray::parse`: subscriptions and validation
//! work on this model, never on kernel JSON). Names here are the manifest's
//! (proto/protocols.toml): no kernel field name may appear in this file
//! (`model_has_no_kernel_field_names`, CI).
//!
//! The model also carries what a stored, possibly hand-written and invalid,
//! configuration holds (`Raw` fields: absent, present but not text, text),
//! so validation reports exactly what is wrong and subscriptions render
//! exactly what is there.

use serde::Serialize;

/// A stored field: `None` absent, `Some(None)` present but not text,
/// `Some(Some(text))`.
pub type Raw = Option<Option<String>>;

/// The text of a `Raw` field, "" when absent or not text.
pub fn text(r: &Raw) -> &str {
    r.as_ref().and_then(Option::as_deref).unwrap_or("")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Inbound {
    pub tag: Option<String>,
    /// The listening port as stored (`Some(None)`: present, not a
    /// non-negative integer).
    pub port: Option<Option<u64>>,
    pub protocol: Protocol,
    pub transport: Transport,
    pub security: Security,
}

/// The protocol layer and its inbound-level options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "id")]
pub enum Protocol {
    Vless {
        /// The flow every user of the inbound gets (absent = none).
        flow: Option<String>,
        /// VLESS Encryption ("none" only).
        encryption: Raw,
    },
    Vmess,
    Trojan,
    Ss2022 {
        method: Option<String>,
        /// The server pre-shared key.
        psk: Option<String>,
        /// The L4 list (comma-separated tcp/udp).
        l4: Raw,
        /// The inline user list: the panel manages users, so it must be
        /// declared and empty.
        users: Users,
    },
    Hysteria2 {
        /// The protocol version the inbound declares (2 for Hysteria 2).
        version: Option<i64>,
    },
    /// Not a managed protocol: its kernel name.
    Unmanaged {
        name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Users {
    /// Declared and empty.
    Empty,
    /// Absent, not a list, or holding users.
    Other,
}

impl Protocol {
    /// Manifest protocol id (unmanaged: its kernel name).
    pub fn id(&self) -> &str {
        match self {
            Protocol::Vless { .. } => "vless",
            Protocol::Vmess => "vmess",
            Protocol::Trojan => "trojan",
            Protocol::Ss2022 { .. } => "ss2022",
            Protocol::Hysteria2 { .. } => "hysteria2",
            Protocol::Unmanaged { name } => name,
        }
    }

    pub fn is_managed(&self) -> bool {
        !matches!(self, Protocol::Unmanaged { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Transport {
    pub kind: TransportKind,
    /// The transport's settings, when the configuration has them.
    pub fields: Option<TransportFields>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportKind {
    Tcp,
    Ws,
    HttpUpgrade,
    Xhttp,
    Grpc,
    /// The protocol's own transport (Shadowsocks: TCP+UDP itself;
    /// Hysteria 2: QUIC).
    Native,
    /// Anything else: its kernel name (lower case).
    Other(String),
}

impl TransportKind {
    /// Manifest transport id (other: the kernel's name).
    pub fn id(&self) -> &str {
        match self {
            TransportKind::Tcp => "tcp",
            TransportKind::Ws => "ws",
            TransportKind::HttpUpgrade => "httpupgrade",
            TransportKind::Xhttp => "xhttp",
            TransportKind::Grpc => "grpc",
            TransportKind::Native => "native",
            TransportKind::Other(n) => n,
        }
    }
}

/// Transport settings (manifest transport fields, plus the QUIC
/// transport's own version and shared auth).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TransportFields {
    pub path: Raw,
    /// The Host clients send.
    pub host: Raw,
    pub mode: Raw,
    pub service_name: Raw,
    /// Hysteria 2: the version the transport declares.
    pub version: Option<i64>,
    /// Hysteria 2: an inbound-wide password (never allowed: the panel
    /// manages per-user auth).
    pub shared_auth: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "id")]
pub enum Security {
    None,
    Tls(Tls),
    Reality(Reality),
    /// Anything else: its kernel name (lower case).
    Other {
        name: String,
    },
}

impl Security {
    /// Manifest security id (other: the kernel's name).
    pub fn id(&self) -> &str {
        match self {
            Security::None => "none",
            Security::Tls(_) => "tls",
            Security::Reality(_) => "reality",
            Security::Other { name } => name,
        }
    }

    /// The SNI clients send (TLS: the certificate's name; REALITY: the
    /// first server name).
    pub fn sni(&self) -> &str {
        match self {
            Security::Tls(t) => t.server_name.as_deref().unwrap_or(""),
            Security::Reality(r) => r
                .server_names
                .first()
                .and_then(Option::as_deref)
                .unwrap_or(""),
            _ => "",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Tls {
    pub server_name: Option<String>,
    pub alpn: Vec<String>,
    /// Where the certificate comes from (templates only; stored
    /// configurations are not parsed for it).
    pub certificate: Option<Certificate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Certificate {
    /// The node's own certificate (automatic over ACME with 节点域名, or
    /// the files the admin installs).
    Node,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reality {
    /// The target site borrowed for the handshake ("host:port").
    pub dest: Option<String>,
    /// Accepted SNIs (`None`: an entry that is not text).
    pub server_names: Vec<Option<String>>,
    pub private_key: Option<String>,
    pub short_ids: Vec<String>,
    /// Client side: the public key, the short id and the uTLS fingerprint
    /// subscriptions hand out.
    pub public_key: Option<String>,
    pub short_id: Option<String>,
    pub fingerprint: Option<String>,
}

/// Why an inbound is refused. Kernel-neutral; the kernel adapter explains
/// it in terms of its own configuration (`xray::explain`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fault {
    /// Two keys equal under the kernel's key matching.
    DuplicateKey(String),
    /// A protocol's own transport used by another protocol.
    ForeignNativeTransport,
    Port,
    /// A security layer no protocol has.
    SecurityUnknown(String),
    /// A transport no stackable protocol has.
    TransportUnsupported(String),
    /// The protocol runs only on its own transport.
    NativeTransportRequired {
        protocol: &'static str,
    },
    /// A manifest rule is broken.
    Rule(String),
    Path,
    Host,
    Mode,
    ServiceName,
    Encryption,
    FlowUnsupported(String),
    MethodUnsupported,
    Psk {
        len: usize,
        method: String,
    },
    InlineUsers,
    L4,
    /// The protocol does not take this security layer.
    SecurityNotAllowed {
        protocol: &'static str,
    },
    ProtocolVersion,
    TransportVersion,
    SharedAuth,
}
