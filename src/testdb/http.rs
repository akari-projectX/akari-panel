//! Router-level test client: requests go through `web::router` (prefix
//! gate, extractors, security headers, canonical rejection) exactly as in
//! production. The test state's route prefix is "test".

use std::net::{IpAddr, SocketAddr};

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;

use crate::state::AppState;

/// What a client observes: status, sorted headers, body.
pub type Fingerprint = (StatusCode, Vec<(String, Vec<u8>)>, Vec<u8>);

pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    /// The session cookie value this response sets, if any.
    pub fn session_cookie(&self) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .find_map(|kv| kv.strip_prefix(&format!("{}=", crate::auth::COOKIE_NAME)))
            .map(String::from)
    }
    /// Everything a client can observe except Date (no Date in oneshot).
    pub fn fingerprint(&self) -> Fingerprint {
        let mut h: Vec<(String, Vec<u8>)> = self
            .headers
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), v.as_bytes().to_vec()))
            .collect();
        h.sort();
        (self.status, h, self.body.clone())
    }
}

pub struct Client {
    router: axum::Router,
    pub ip: IpAddr,
    pub cookie: Option<String>,
    /// Extra request headers (Host, X-Forwarded-For, CF-Connecting-IP…).
    pub headers: Vec<(String, String)>,
}

impl Client {
    pub fn new(state: &AppState, ip: IpAddr) -> Self {
        Self {
            router: crate::web::router(state.clone()),
            ip,
            cookie: None,
            headers: Vec::new(),
        }
    }

    pub async fn req(&self, method: Method, path: &str, body: Option<Value>) -> Resp {
        let mut b = Request::builder().method(method).uri(path);
        for (k, v) in &self.headers {
            b = b.header(k.as_str(), v.as_str());
        }
        if let Some(c) = &self.cookie {
            b = b.header(header::COOKIE, format!("{}={c}", crate::auth::COOKIE_NAME));
        }
        let body = match body {
            Some(v) => {
                b = b.header(header::CONTENT_TYPE, "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let mut req = b.body(body).unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(self.ip, 40000)));
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec();
        Resp {
            status,
            headers,
            body,
        }
    }

    /// A raw (octet-stream) request body.
    pub async fn put_raw(&self, path: &str, body: Vec<u8>) -> Resp {
        let mut b = Request::builder()
            .method(Method::PUT)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/octet-stream");
        if let Some(c) = &self.cookie {
            b = b.header(header::COOKIE, format!("{}={c}", crate::auth::COOKIE_NAME));
        }
        let mut req = b.body(Body::from(body)).unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(self.ip, 40000)));
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        Resp {
            status,
            headers,
            body,
        }
    }

    pub async fn get(&self, path: &str) -> Resp {
        self.req(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Resp {
        self.req(Method::POST, path, Some(body)).await
    }

    /// POST /test/auth/login; keeps the session cookie on success.
    pub async fn login(&mut self, login: &str, password: &str, code: Option<&str>) -> Resp {
        let mut body = serde_json::json!({ "login": login, "password": password });
        if let Some(c) = code {
            body["code"] = Value::String(c.into());
        }
        let r = self.post("/test/auth/login", body).await;
        if let Some(c) = r.session_cookie() {
            self.cookie = Some(c);
        }
        r
    }
}

/// A random public-looking IPv4 address (tests must not share Valkey
/// buckets across runs or with each other).
pub fn rand_ip() -> IpAddr {
    let x: u32 = rand::random();
    IpAddr::V4(std::net::Ipv4Addr::from(0x2e00_0000 | (x & 0x00ff_ffff)))
}
