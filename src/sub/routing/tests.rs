use serde_json::json;

use super::*;

fn it(kind: Match, value: &str) -> Item {
    item(kind, value)
}

fn with_direct(items: Vec<Item>) -> Config {
    Config {
        direct: items,
        ..recommended()
    }
}

#[test]
fn recommended_is_valid_and_stable() {
    let r = recommended();
    assert_eq!(r.clone().parse().unwrap(), r);
    assert_eq!(r.services.len(), 5);
    assert!(
        r.services
            .iter()
            .all(|s| s.primary.is_none() && s.backups.is_empty())
    );
    assert_eq!(r.dns, Dns::default());
    // The JSON shape the admin edits (and the migration writes).
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["block"], json!([{"type": "category", "value": "ads"}]));
    assert_eq!(v["services"][0]["key"], "netflix");
    assert_eq!(v["services"][0]["primary"], json!(null));
    assert_eq!(v["rest"], json!(null));
    assert_eq!(v["dns"]["mode"], "recommended");
    // Every field but the lists has a default: `{}` is a valid (empty) config.
    let empty: Config = serde_json::from_value(json!({})).unwrap();
    assert!(empty.block.is_empty() && empty.services.is_empty());
    assert_eq!(empty.mode, Mode::Rules);
}

#[test]
fn items_validate_and_normalize() {
    let ok = with_direct(vec![
        it(Match::Geosite, " CN "),
        it(Match::Geosite, "geolocation-!cn"),
        it(Match::DomainSuffix, "Example.COM"),
        it(Match::IpCidr, "10.1.2.3/8"),
        it(Match::IpCidr, "2001:db8::1/32"),
        it(Match::DomainKeyword, "ads"),
        it(Match::Category, "Netflix"),
        it(Match::RuleSet, " https://r.example/Claude.yaml "),
        it(Match::Geosite, "cn"), // duplicate: dropped
    ])
    .parse()
    .unwrap();
    let values: Vec<&str> = ok.direct.iter().map(|r| r.value.as_str()).collect();
    assert_eq!(
        values,
        [
            "cn",
            "geolocation-!cn",
            "example.com",
            "10.0.0.0/8",
            "2001:db8::/32",
            "ads",
            "netflix",
            "https://r.example/Claude.yaml"
        ]
    );
    for bad in [
        it(Match::Geosite, ""),
        it(Match::Geosite, "cn/../x"),
        it(Match::Geoip, "c n"),
        it(Match::Domain, "1.2.3.4"),
        it(Match::DomainSuffix, "-bad-.com"),
        it(Match::DomainKeyword, "a,b"),
        it(Match::IpCidr, "10.0.0.0/33"),
        it(Match::IpCidr, "example.com"),
        it(Match::Category, "nope"),
        it(Match::RuleSet, "http://r.example/x.list"),
        it(Match::RuleSet, "https://r.example/a b"),
        it(
            Match::RuleSet,
            &format!("https://r.example/{}", "x".repeat(600)),
        ),
        // A value cannot break out of a YAML line or a rule.
        it(Match::DomainSuffix, "a.com\n  - MATCH,DIRECT"),
    ] {
        let e = with_direct(vec![it(Match::Geosite, "cn"), bad.clone()])
            .parse()
            .unwrap_err();
        assert_eq!(e.code(), "settings.sub_rule_invalid", "{bad:?}");
        assert_eq!(e.params()["index"], 2);
        assert_eq!(e.params()["section"], "direct");
    }
    let many = with_direct(vec![it(Match::Geosite, "cn"); MAX_RULES + 1]);
    assert_eq!(
        many.parse().unwrap_err().code(),
        "settings.sub_rules_too_many"
    );
}

#[test]
fn services_validate() {
    let base = recommended();
    let mut c = base.clone();
    c.services[0].primary = Some(Uuid::from_u128(1));
    c.services[0].backups = vec![
        Ref::Entrance(Uuid::from_u128(1)), // = the primary: dropped
        Ref::Region(" 日本 ".into()),
        Ref::Region("日本".into()), // duplicate: dropped
        Ref::Tag(" 解锁 ".into()),
    ];
    c.rest = Some(Ref::Entrance(Uuid::from_u128(2)));
    c.tag_groups = vec!["IPLC".into(), " IPLC ".into()];
    let p = c.parse().unwrap();
    assert_eq!(
        p.services[0].backups,
        [Ref::Region("日本".into()), Ref::Tag("解锁".into())]
    );
    assert_eq!(p.tag_groups, ["IPLC"]);
    assert_eq!(p.entrances(), [Uuid::from_u128(1), Uuid::from_u128(2)]);
    let svc = |f: &dyn Fn(&mut Service)| {
        let mut c = base.clone();
        f(&mut c.services[1]);
        c.parse().unwrap_err()
    };
    for (e, code) in [
        (
            svc(&|s| s.key = "Bad Key".into()),
            "settings.sub_service_invalid",
        ),
        (
            svc(&|s| s.name = String::new()),
            "settings.sub_service_invalid",
        ),
        (
            svc(&|s| s.name = "a,b".into()),
            "settings.sub_service_invalid",
        ),
        (
            svc(&|s| s.name = "x".repeat(33)),
            "settings.sub_service_invalid",
        ),
        (
            svc(&|s| s.emoji = "a b".into()),
            "settings.sub_service_invalid",
        ),
        (
            svc(&|s| s.name = "Netflix".into()),
            "settings.sub_service_duplicate",
        ),
        (
            svc(&|s| s.key = "netflix".into()),
            "settings.sub_service_duplicate",
        ),
        (
            svc(&|s| s.backups = vec![Ref::Region("x".into()); MAX_BACKUPS + 1]),
            "settings.sub_service_invalid",
        ),
        (
            svc(&|s| s.backups = vec![Ref::Tag("a|b".into())]),
            "settings.sub_line_invalid",
        ),
        (
            svc(&|s| s.backups = vec![Ref::Region(" ".into())]),
            "settings.sub_line_invalid",
        ),
        (
            svc(&|s| s.items = vec![it(Match::Category, "nope")]),
            "settings.sub_rule_invalid",
        ),
    ] {
        assert_eq!(e.code(), code, "{e:?}");
    }
    let mut c = base.clone();
    c.services = (0..=MAX_SERVICES)
        .map(|i| Service {
            key: format!("s{i}"),
            name: format!("S{i}"),
            emoji: String::new(),
            items: vec![],
            primary: None,
            backups: vec![],
        })
        .collect();
    assert_eq!(
        c.parse().unwrap_err().code(),
        "settings.sub_services_too_many"
    );
    let mut c = base;
    c.tag_groups = (0..=MAX_TAG_GROUPS).map(|i| format!("t{i}")).collect();
    assert_eq!(c.parse().unwrap_err().code(), "settings.sub_line_invalid");
}

#[test]
fn url_templates() {
    assert!(url_template("https://m.example/{kind}/{name}.list").is_ok());
    assert!(url_template(" https://m.example/x/{name}.srs ").is_ok());
    assert!(url_template("http://127.0.0.1:8080/{name}").is_ok());
    for bad in [
        "https://m.example/static.list",
        "http://m.example/{name}",
        "ftp://m.example/{name}",
        "https://m.example/{name} x",
        "https://m.example/\"{name}",
    ] {
        assert_eq!(
            url_template(bad).unwrap_err().code(),
            "settings.sub_rule_set_url_invalid",
            "{bad}"
        );
    }
}

#[test]
fn stored_values_fall_back_to_the_default() {
    let mut s = crate::settings::Stored::default();
    assert_eq!(Routing::of(&s), Routing::default());
    s.sub_routing = Some(json!({"mode": "global"}));
    s.sub_rule_set_clash_url = Some("https://m.example/{name}".into());
    let r = Routing::of(&s);
    assert_eq!(r.config.mode, Mode::Global);
    assert!(r.config.services.is_empty());
    assert_eq!(r.clash_url, "https://m.example/{name}");
    assert_eq!(r.singbox_url, DEFAULT_SINGBOX_URL);
    // Unusable stored routing (impossible through the API): the default.
    s.sub_routing = Some(json!({"direct": [{"type": "geosite", "value": "x y"}]}));
    assert_eq!(Routing::of(&s).config, recommended());
    s.sub_routing = Some(json!({"bogus": 1}));
    assert_eq!(Routing::of(&s).config, recommended());
}

#[test]
fn sections_lists_and_matchers() {
    let r = Routing::default();
    let lists: Vec<String> = r
        .lists()
        .into_iter()
        .map(|(k, n)| format!("{}-{n}", k.id()))
        .collect();
    assert_eq!(
        lists,
        [
            "geosite-category-ads-all",
            "geosite-private",
            "geoip-private",
            "geosite-cn",
            "geoip-cn",
            "geosite-netflix",
            "geosite-google",
            "geosite-youtube",
            "geosite-telegram",
            "geoip-telegram",
            "geosite-category-ai-!cn"
        ]
    );
    assert_eq!(r.direct_geosites(), ["geosite-private", "geosite-cn"]);
    let global = Routing {
        config: Config {
            mode: Mode::Global,
            ..recommended()
        },
        ..Routing::default()
    };
    let s = global.sections();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].1, Target::Direct);
    assert_eq!(global.direct_geosites(), ["geosite-private"]);
    let a = remote_name("https://r.example/a.yaml");
    assert_eq!(a, remote_name("https://r.example/a.yaml"));
    assert_ne!(a, remote_name("https://r.example/b.yaml"));
    assert!(a.starts_with("rs-") && a.len() == 13);
}
