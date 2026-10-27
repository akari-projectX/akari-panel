//! An order-preserving document value (YAML or JSON): what the structural
//! templates (Clash, sing-box) are parsed into, injected with the user's
//! proxies and written back. `serde_json::Value` would sort keys (the
//! crate does not enable `preserve_order`) and an operator's template reads
//! top to bottom in the order they wrote it.

use std::fmt;

use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Number;

#[derive(Debug, Clone, PartialEq)]
pub enum Doc {
    Null,
    Bool(bool),
    Num(Number),
    Str(String),
    Seq(Vec<Doc>),
    Map(Vec<(String, Doc)>),
}

impl From<&str> for Doc {
    fn from(s: &str) -> Self {
        Doc::Str(s.to_string())
    }
}

impl From<String> for Doc {
    fn from(s: String) -> Self {
        Doc::Str(s)
    }
}

impl From<bool> for Doc {
    fn from(b: bool) -> Self {
        Doc::Bool(b)
    }
}

impl From<u64> for Doc {
    fn from(n: u64) -> Self {
        Doc::Num(n.into())
    }
}

impl From<u16> for Doc {
    fn from(n: u16) -> Self {
        Doc::Num(n.into())
    }
}

impl Doc {
    pub fn map() -> Doc {
        Doc::Map(Vec::new())
    }

    /// Set `key` (replacing an existing entry in place, else appending).
    pub fn set(&mut self, key: &str, value: impl Into<Doc>) {
        if let Doc::Map(m) = self {
            let value = value.into();
            match m.iter_mut().find(|(k, _)| k == key) {
                Some((_, v)) => *v = value,
                None => m.push((key.to_string(), value)),
            }
        }
    }

    /// Builder form of [`Doc::set`].
    pub fn with(mut self, key: &str, value: impl Into<Doc>) -> Doc {
        self.set(key, value);
        self
    }

    pub fn get(&self, key: &str) -> Option<&Doc> {
        match self {
            Doc::Map(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Doc> {
        match self {
            Doc::Map(m) => m.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Doc::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_seq(&self) -> Option<&[Doc]> {
        match self {
            Doc::Seq(v) => Some(v),
            _ => None,
        }
    }

    pub fn seq_of_strs(v: impl IntoIterator<Item = String>) -> Doc {
        Doc::Seq(v.into_iter().map(Doc::Str).collect())
    }

    /// Apply `f` to every string value (not keys), depth first.
    pub fn each_string(&mut self, f: &mut impl FnMut(&mut String)) {
        match self {
            Doc::Str(s) => f(s),
            Doc::Seq(v) => v.iter_mut().for_each(|d| d.each_string(f)),
            Doc::Map(m) => m.iter_mut().for_each(|(_, d)| d.each_string(f)),
            _ => {}
        }
    }
}

struct DocVisitor;

impl<'de> Visitor<'de> for DocVisitor {
    type Value = Doc;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a YAML or JSON value")
    }

    fn visit_unit<E>(self) -> Result<Doc, E> {
        Ok(Doc::Null)
    }

    fn visit_none<E>(self) -> Result<Doc, E> {
        Ok(Doc::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Doc, D::Error> {
        d.deserialize_any(DocVisitor)
    }

    fn visit_bool<E>(self, v: bool) -> Result<Doc, E> {
        Ok(Doc::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Doc, E> {
        Ok(Doc::Num(v.into()))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Doc, E> {
        Ok(Doc::Num(v.into()))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Doc, E> {
        Number::from_f64(v)
            .map(Doc::Num)
            .ok_or_else(|| E::custom("a number that is not finite"))
    }

    fn visit_str<E>(self, v: &str) -> Result<Doc, E> {
        Ok(Doc::Str(v.to_string()))
    }

    fn visit_string<E>(self, v: String) -> Result<Doc, E> {
        Ok(Doc::Str(v))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Doc, A::Error> {
        let mut out = Vec::new();
        while let Some(d) = seq.next_element::<Doc>()? {
            out.push(d);
        }
        Ok(Doc::Seq(out))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Doc, A::Error> {
        let mut out: Vec<(String, Doc)> = Vec::new();
        while let Some(Key(k)) = map.next_key::<Key>()? {
            if out.iter().any(|(x, _)| *x == k) {
                return Err(de::Error::custom(format!("duplicate key {k:?}")));
            }
            out.push((k, map.next_value::<Doc>()?));
        }
        Ok(Doc::Map(out))
    }
}

impl<'de> Deserialize<'de> for Doc {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Doc, D::Error> {
        d.deserialize_any(DocVisitor)
    }
}

/// A mapping key: YAML allows scalars other than strings.
struct Key(String);

impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Key, D::Error> {
        struct KeyVisitor;
        impl Visitor<'_> for KeyVisitor {
            type Value = Key;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a scalar key")
            }
            fn visit_str<E>(self, v: &str) -> Result<Key, E> {
                Ok(Key(v.to_string()))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Key, E> {
                Ok(Key(v.to_string()))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Key, E> {
                Ok(Key(v.to_string()))
            }
            fn visit_bool<E>(self, v: bool) -> Result<Key, E> {
                Ok(Key(v.to_string()))
            }
        }
        d.deserialize_any(KeyVisitor)
    }
}

impl Serialize for Doc {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Doc::Null => s.serialize_unit(),
            Doc::Bool(b) => s.serialize_bool(*b),
            Doc::Num(n) => n.serialize(s),
            Doc::Str(v) => s.serialize_str(v),
            Doc::Seq(v) => {
                let mut q = s.serialize_seq(Some(v.len()))?;
                for d in v {
                    q.serialize_element(d)?;
                }
                q.end()
            }
            Doc::Map(m) => {
                let mut q = s.serialize_map(Some(m.len()))?;
                for (k, v) in m {
                    q.serialize_entry(k, v)?;
                }
                q.end()
            }
        }
    }
}

/// Block-style YAML with indented list items (`  - name: …`, the layout
/// operators and the smoke scripts know).
pub(crate) fn to_yaml(doc: &Doc) -> Result<String, String> {
    let mut options = serde_saphyr::SerializerOptions::default();
    options.compact_list_indent = false;
    serde_saphyr::to_string_with_options(doc, options).map_err(|e| e.to_string())
}
