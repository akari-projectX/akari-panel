//! Shared helpers for the fuzz targets.

use akari_panel::billing::alipay::Keys;

pub const APP_KEY: &str = include_str!("../../src/billing/testdata/app-key.pem");
pub const APP_PUB: &str = include_str!("../../src/billing/testdata/app-pub.pem");
pub const ALIPAY_KEY: &str = include_str!("../../src/billing/testdata/alipay-key.pem");
pub const ALIPAY_PUB: &str = include_str!("../../src/billing/testdata/alipay-pub.pem");

/// The panel's keys (app private key + the test "Alipay" public key).
pub fn panel_keys() -> &'static Keys {
    static K: std::sync::OnceLock<Keys> = std::sync::OnceLock::new();
    K.get_or_init(|| Keys::from_texts(APP_KEY, ALIPAY_PUB).expect("test keys"))
}

/// The test "Alipay" side: signs what the panel verifies.
pub fn alipay_keys() -> &'static Keys {
    static K: std::sync::OnceLock<Keys> = std::sync::OnceLock::new();
    K.get_or_init(|| Keys::from_texts(ALIPAY_KEY, APP_PUB).expect("test keys"))
}

/// Split `data` at 0xFF bytes into at most `n` lossily decoded strings.
pub fn fields(data: &[u8], n: usize) -> Vec<String> {
    data.splitn(n, |b| *b == 0xFF)
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect()
}

/// Every string in a JSON value (keys included), recursively.
pub fn strings(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
        serde_json::Value::Object(o) => {
            for (k, x) in o {
                out.push(k.clone());
                strings(x, out);
            }
        }
        _ => {}
    }
}
