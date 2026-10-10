//! W11: xboard-style node fields of the admin node form — validation and
//! normalization for `api::UpdateNodeReq`/`CreateNodeReq` (display name,
//! sort, visibility, tags) and the public name built from them. None of the
//! fields changes what an agent runs (no version bump). W28-a: the
//! client-facing address/port, the multiplier and group membership moved to
//! the node's entrances (`entrances.rs`).

use crate::auth::{ApiError, bad_request};

pub const MAX_TAGS: usize = 8;
pub const MAX_TAG_CHARS: usize = 24;
pub const MAX_DISPLAY_CHARS: usize = 64;
pub const SORT_LIMIT: i32 = 1_000_000;

fn printable(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// "" / whitespace = cleared (None).
pub fn display_name(v: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(v) = v.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if v.chars().count() > MAX_DISPLAY_CHARS || !printable(v) {
        return Err(bad_request!(
            "node.display_name_invalid",
            "display_name must be at most {max_display_chars} printable characters",
            max_display_chars = MAX_DISPLAY_CHARS
        ));
    }
    Ok(Some(v.to_string()))
}

pub fn sort(v: i32) -> Result<i32, ApiError> {
    if !(-SORT_LIMIT..=SORT_LIMIT).contains(&v) {
        return Err(bad_request!(
            "node.sort_range",
            "sort must be between -{sort_limit} and {sort_limit}",
            sort_limit = SORT_LIMIT
        ));
    }
    Ok(v)
}

/// Trimmed, non-empty, deduplicated (first wins), order kept.
pub fn tags(v: &[String]) -> Result<Vec<String>, ApiError> {
    let mut out: Vec<String> = Vec::new();
    for t in v {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > MAX_TAG_CHARS || !printable(t) || t.contains('|') {
            return Err(bad_request!(
                "node.tag_invalid",
                "each tag must be at most {max_tag_chars} printable characters without '|'",
                max_tag_chars = MAX_TAG_CHARS
            ));
        }
        if !out.iter().any(|o| o == t) {
            out.push(t.to_string());
        }
    }
    if out.len() > MAX_TAGS {
        return Err(bad_request!(
            "node.too_many_tags",
            "at most {max_tags} tags",
            max_tags = MAX_TAGS
        ));
    }
    Ok(out)
}

/// The subscription name of an entrance: its name, then its tags
/// ("直连 | IPLC | 0.5x"). Users never see the node's or the server's name
/// (next-version, lam 2026-10-10): those are the operator's.
pub fn public_name(entrance: &str, tags: &[String]) -> String {
    let mut s = entrance.to_string();
    for t in tags {
        s.push_str(" | ");
        s.push_str(t);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_and_names() {
        assert_eq!(
            tags(&[" 香港 ".into(), "".into(), "0.5x".into(), "香港".into()]).unwrap(),
            vec!["香港".to_string(), "0.5x".to_string()]
        );
        assert!(tags(&["a|b".into()]).is_err());
        assert!(tags(&["x".repeat(25)]).is_err());
        assert!(tags(&(0..9).map(|i| i.to_string()).collect::<Vec<_>>()).is_err());
        assert!(tags(&["a\nb".into()]).is_err());
        assert_eq!(display_name(Some("  ")).unwrap(), None);
        assert_eq!(display_name(Some(" 东京 ")).unwrap(), Some("东京".into()));
        assert!(display_name(Some(&"x".repeat(65))).is_err());
        assert_eq!(public_name("直连", &[]), "直连");
        assert_eq!(
            public_name("直连", &["IPLC".into(), "0.5x".into()]),
            "直连 | IPLC | 0.5x"
        );
        assert!(sort(1_000_001).is_err());
        assert_eq!(sort(-5).unwrap(), -5);
    }
}
