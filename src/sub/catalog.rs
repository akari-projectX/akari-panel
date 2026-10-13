//! Subscription routing catalog (2026-10-13, `sub-service-groups`): the
//! built-in categories (an id the operator picks, its Chinese name and the
//! MetaCubeX meta-rules-dat geosite/geoip lists it stands for) and the
//! common services (a ready-made service group: name, emoji, categories).
//! The single source of truth: subscriptions expand categories from here,
//! the admin reads both through `GET /settings/subscription/catalog`.

use serde::Serialize;

/// A built-in category: what clients download (`geosite`/`geoip` list
/// names, as rule-providers / rule sets).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Category {
    pub id: &'static str,
    /// Chinese name shown to the operator.
    pub name: &'static str,
    pub geosite: &'static [&'static str],
    pub geoip: &'static [&'static str],
}

const fn cat(
    id: &'static str,
    name: &'static str,
    geosite: &'static [&'static str],
    geoip: &'static [&'static str],
) -> Category {
    Category {
        id,
        name,
        geosite,
        geoip,
    }
}

pub const CATEGORIES: &[Category] = &[
    cat("ads", "广告与跟踪", &["category-ads-all"], &[]),
    cat("private", "局域网 / 路由器", &["private"], &["private"]),
    cat("cn", "中国大陆网站", &["cn"], &[]),
    cat("cnip", "中国大陆 IP", &[], &["cn"]),
    cat("netflix", "Netflix", &["netflix"], &[]),
    cat("google", "Google", &["google"], &[]),
    cat("youtube", "YouTube", &["youtube"], &[]),
    cat("telegram", "Telegram", &["telegram"], &["telegram"]),
    cat(
        "ai",
        "AI 服务（ChatGPT / Claude / Gemini）",
        &["category-ai-!cn"],
        &[],
    ),
    cat("disney", "Disney+", &["disney"], &[]),
    cat("spotify", "Spotify", &["spotify"], &[]),
    cat("tiktok", "TikTok", &["tiktok"], &[]),
    cat("apple", "Apple", &["apple"], &[]),
    cat("microsoft", "Microsoft", &["microsoft"], &[]),
    cat("steam", "Steam", &["steam"], &[]),
    cat("github", "GitHub", &["github"], &[]),
    cat("twitter", "X / Twitter", &["twitter"], &[]),
];

pub fn category(id: &str) -> Option<&'static Category> {
    CATEGORIES.iter().find(|c| c.id == id)
}

/// A common service: the group a subscription gets when the operator adds it.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ServiceDef {
    pub key: &'static str,
    pub name: &'static str,
    pub emoji: &'static str,
    /// Category ids (`CATEGORIES`).
    pub categories: &'static [&'static str],
}

const fn svc(
    key: &'static str,
    name: &'static str,
    emoji: &'static str,
    categories: &'static [&'static str],
) -> ServiceDef {
    ServiceDef {
        key,
        name,
        emoji,
        categories,
    }
}

pub const SERVICES: &[ServiceDef] = &[
    svc("netflix", "Netflix", "🎬", &["netflix"]),
    svc("google", "Google", "🔍", &["google"]),
    svc("youtube", "YouTube", "📺", &["youtube"]),
    svc("telegram", "Telegram", "✈️", &["telegram"]),
    svc("ai", "AI 服务", "🤖", &["ai"]),
    svc("disney", "Disney+", "🏰", &["disney"]),
    svc("spotify", "Spotify", "🎵", &["spotify"]),
    svc("tiktok", "TikTok", "🎶", &["tiktok"]),
    svc("apple", "Apple", "🍎", &["apple"]),
    svc("microsoft", "Microsoft", "🪟", &["microsoft"]),
    svc("steam", "Steam", "🎮", &["steam"]),
    svc("github", "GitHub", "🐙", &["github"]),
    svc("twitter", "X / Twitter", "🐦", &["twitter"]),
];

pub fn service(key: &str) -> Option<&'static ServiceDef> {
    SERVICES.iter().find(|s| s.key == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_consistent() {
        let mut ids = std::collections::HashSet::new();
        for c in CATEGORIES {
            assert!(ids.insert(c.id), "duplicate category {}", c.id);
            assert!(!c.geosite.is_empty() || !c.geoip.is_empty(), "{}", c.id);
            for l in c.geosite.iter().chain(c.geoip) {
                assert!(super::super::routing::list_name(l), "{l}");
            }
        }
        let mut keys = std::collections::HashSet::new();
        let mut names = std::collections::HashSet::new();
        for s in SERVICES {
            assert!(keys.insert(s.key) && names.insert(s.name), "{}", s.key);
            for c in s.categories {
                assert!(category(c).is_some(), "{} -> {c}", s.key);
            }
        }
    }
}
