//! Template tests: the built-in templates render for every format, the
//! structural injection (Clash / sing-box), the INI substitution, hostile
//! credentials, validation positions, the API and the subscription
//! endpoint (real database).

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

fn sample(f: TemplateFormat) -> String {
    render_sample(f, f.default_body()).unwrap_or_else(|e| panic!("{f:?}: {e:?}"))
}

fn proxies_of(rows: &[crate::sub::NodeRow]) -> Vec<Proxy> {
    collect_proxies(rows)
}

fn ctx(f: TemplateFormat) -> Ctx<'static> {
    Ctx {
        subs_link: "https://sub.example.com/s/T?format=x",
        subs_domain: "sub.example.com",
        site_name: "Akari",
        info: Info {
            upload: 1,
            download: 2,
            total: 3,
            expire: 4,
        },
        format_id: f.id(),
    }
}

fn lenient(f: TemplateFormat, body: &str, p: &[Proxy]) -> String {
    render(f, body, p, &ctx(f), false).unwrap()
}

fn strict_err(f: TemplateFormat, body: &str) -> TemplateError {
    render_sample(f, body).unwrap_err()
}

/// Rendered default templates, for the external validators below.
fn dump(dir: &std::path::Path) {
    for f in TemplateFormat::ALL {
        let ext = match f {
            TemplateFormat::SingBox => "json",
            TemplateFormat::Clash => "yaml",
            _ => "conf",
        };
        std::fs::write(dir.join(format!("{}.{ext}", f.id())), sample(f)).unwrap();
    }
}

#[test]
fn defaults_render_for_the_sample_user_in_every_format() {
    // Clash: the five sample lines, groups expanded, still valid YAML.
    let clash: Doc = serde_saphyr::from_str(&sample(TemplateFormat::Clash)).unwrap();
    let proxies = clash.get("proxies").and_then(Doc::as_seq).unwrap();
    assert_eq!(proxies.len(), 5, "{clash:?}");
    let groups = clash.get("proxy-groups").and_then(Doc::as_seq).unwrap();
    let default = &groups[0];
    assert_eq!(default.get("name").and_then(Doc::as_str), Some("🚀 默认代理"));
    let members: Vec<&str> = default
        .get("proxies")
        .and_then(Doc::as_seq)
        .unwrap()
        .iter()
        .filter_map(Doc::as_str)
        .collect();
    assert!(members.contains(&"香港 01") && members.contains(&"DIRECT"), "{members:?}");
    // sing-box: lines after the template's groups, {all} expanded.
    let sb: Value = serde_json::from_str(&sample(TemplateFormat::SingBox)).unwrap();
    let tags: Vec<&str> = sb["outbounds"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|o| o["tag"].as_str())
        .collect();
    assert!(tags.contains(&"香港 01") && tags.contains(&"direct"), "{tags:?}");
    let hk = sb["outbounds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["tag"] == "🇭🇰 香港")
        .unwrap();
    assert_eq!(hk["outbounds"], json!(["香港 01"]), "the region filter picks the Hong Kong line");
    // Surge / Surfboard: sections, lines, the managed-config link.
    let surge = sample(TemplateFormat::Surge);
    assert!(surge.starts_with("#!MANAGED-CONFIG https://sub.example.com/sample/SAMPLE-TOKEN?format=surge "), "{surge}");
    assert!(surge.contains("\n[Proxy]\n"), "{surge}");
    assert!(surge.contains("日本 01 = vmess, jp.example.com, 8443, username="), "{surge}");
    assert!(surge.contains("新加坡 01 = ss, sg.example.com, 8388, encrypt-method=2022-blake3-aes-128-gcm, password=AAAAAAAAAAAAAAAAAAAAAA==:AQEBAQEBAQEBAQEBAQEBAQ==, udp-relay=true"), "{surge}");
    assert!(surge.contains("台湾 01 = hysteria2, tw.example.com, 443, password="), "{surge}");
    assert!(!surge.contains("香港 01 ="), "VLESS/REALITY is not a Surge line:\n{surge}");
    assert!(surge.contains("Subscription = title=\"Akari\",content=\"upload=0, download=1073741824"), "{surge}");
    let board = sample(TemplateFormat::Surfboard);
    assert!(board.contains("美国 01 = trojan, us.example.com, 9443, password=sample-password, udp-relay=true, sni=us.example.com"), "{board}");
    assert!(!board.contains("新加坡 01 ="), "multi-user SS2022 is not documented for Surfboard");
}

/// Optional: validate the rendered defaults with the real clients
/// (`MIHOMO_BIN=… SINGBOX_BIN=… cargo test defaults_pass_the_clients`).
#[test]
fn defaults_pass_the_clients() {
    let dir = std::env::temp_dir().join(format!("akari-tpl-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dump(&dir);
    if let Ok(bin) = std::env::var("MIHOMO_BIN") {
        let out = std::process::Command::new(bin)
            .args(["-t", "-d"])
            .arg(&dir)
            .arg("-f")
            .arg(dir.join("clash.yaml"))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success() && text.contains("successful"), "mihomo -t:\n{text}");
    }
    if let Ok(bin) = std::env::var("SINGBOX_BIN") {
        let out = std::process::Command::new(bin)
            .args(["check", "-c"])
            .arg(dir.join("sing-box.json"))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "sing-box check:\n{text}");
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn clash_expansion_and_empty_groups() {
    let body = r#"
proxies: []
proxy-groups:
  - name: A
    type: select
    proxies: [$proxies, DIRECT]
  - name: Only
    type: select
    proxies: [$proxies]
  - name: Region
    type: url-test
    url: https://example.com
    interval: 300
    include-all-proxies: true
    filter: "HK"
rules:
  - MATCH,A
"#;
    let rows = sample_rows();
    let p = proxies_of(&rows);
    let out: Doc = serde_saphyr::from_str(&lenient(TemplateFormat::Clash, body, &p)).unwrap();
    let g = |n: &str| {
        out.get("proxy-groups")
            .and_then(Doc::as_seq)
            .unwrap()
            .iter()
            .find(|g| g.get("name").and_then(Doc::as_str) == Some(n))
            .unwrap()
            .clone()
    };
    assert_eq!(g("A").get("proxies").and_then(Doc::as_seq).unwrap().len(), 6);
    assert!(g("Region").get("proxies").is_none(), "include-all groups keep no list");
    // No lines at all: the groups that would be empty point at DIRECT.
    let out: Doc = serde_saphyr::from_str(&lenient(TemplateFormat::Clash, body, &[])).unwrap();
    let only = out.get("proxy-groups").and_then(Doc::as_seq).unwrap()[1].clone();
    assert_eq!(only.get("proxies"), Some(&Doc::seq_of_strs(["DIRECT".to_string()])));
    // A rule or member naming something that is not there is dropped for a
    // user, an error when saving.
    let dangling = "proxy-groups:\n  - {name: G, type: select, proxies: [Gone, DIRECT]}\nrules:\n  - DOMAIN,x,Gone\n  - MATCH,G\n";
    let out = lenient(TemplateFormat::Clash, dangling, &p);
    assert!(!out.contains("Gone"), "{out}");
    let e = strict_err(TemplateFormat::Clash, dangling);
    assert!(e.message.contains("\"Gone\""), "{e:?}");
    assert_eq!((e.line, e.column), (Some(2), Some(39)), "{e:?}");
    // Duplicate group names and cycles.
    let e = strict_err(TemplateFormat::Clash, "proxy-groups:\n  - {name: G, type: select, proxies: [DIRECT]}\n  - {name: G, type: select, proxies: [DIRECT]}\n");
    assert!(e.message.contains("two proxy groups"), "{e:?}");
    let e = strict_err(TemplateFormat::Clash, "proxy-groups:\n  - {name: A, type: select, proxies: [B]}\n  - {name: B, type: select, proxies: [A]}\n");
    assert!(e.message.contains("contains itself"), "{e:?}");
    // Syntax errors carry the parser's position.
    let e = strict_err(TemplateFormat::Clash, "a: [1\nb: 2\n");
    assert!(e.line.is_some() && e.message.starts_with("YAML"), "{e:?}");
    assert!(strict_err(TemplateFormat::Clash, "- a\n- b\n").message.contains("mapping"));
}

#[test]
fn singbox_expansion_filters_and_references() {
    let body = r#"{
  "outbounds": [
    {"type": "selector", "tag": "all", "outbounds": ["{all}", "direct"]},
    {"type": "urltest", "tag": "jp", "outbounds": ["{all:^日本}"]},
    {"type": "urltest", "tag": "none", "outbounds": ["{all:nomatch}"]},
    {"type": "direct", "tag": "direct"}
  ],
  "route": {"rules": [{"domain": ["x"], "outbound": "jp"}], "final": "all"}
}"#;
    let p = proxies_of(&sample_rows());
    let v: Value = serde_json::from_str(&lenient(TemplateFormat::SingBox, body, &p)).unwrap();
    let ob = |t: &str| v["outbounds"].as_array().unwrap().iter().find(|o| o["tag"] == t).unwrap().clone();
    assert_eq!(ob("all")["outbounds"].as_array().unwrap().len(), 6);
    assert_eq!(ob("jp")["outbounds"], json!(["日本 01"]));
    assert_eq!(ob("none")["outbounds"], json!(["direct"]), "an empty expansion falls back to direct");
    assert_eq!(v["outbounds"].as_array().unwrap().len(), 4 + 5, "lines come last");
    // Errors: unknown member, unknown route target, bad regex, unknown key, duplicate tag.
    let e = strict_err(TemplateFormat::SingBox, r#"{"outbounds": [{"type": "selector", "tag": "a", "outbounds": ["ghost"]}, {"type": "direct", "tag": "direct"}]}"#);
    assert!(e.message.contains("ghost"), "{e:?}");
    let e = strict_err(TemplateFormat::SingBox, r#"{"outbounds": [{"type": "direct", "tag": "direct"}], "route": {"final": "ghost"}}"#);
    assert!(e.message.contains("route.final"), "{e:?}");
    let e = strict_err(TemplateFormat::SingBox, r#"{"outbounds": [{"type": "selector", "tag": "a", "outbounds": ["{all:(}"]}, {"type": "direct", "tag": "direct"}]}"#);
    assert!(e.message.contains("not a valid expression"), "{e:?}");
    let e = strict_err(TemplateFormat::SingBox, r#"{"nope": 1}"#);
    assert!(e.message.contains("not a sing-box configuration key"), "{e:?}");
    let e = strict_err(TemplateFormat::SingBox, r#"{"outbounds": [{"type": "direct", "tag": "d"}, {"type": "block", "tag": "d"}]}"#);
    assert!(e.message.contains("two outbounds"), "{e:?}");
    let e = strict_err(TemplateFormat::SingBox, "{\n  \"log\": ,\n}");
    assert_eq!(e.line, Some(2), "{e:?}");
    // Lenient: a dangling route rule is dropped, a dangling final becomes direct.
    let lenient_body = r#"{"outbounds": [{"type": "direct", "tag": "direct"}], "route": {"rules": [{"domain": ["x"], "outbound": "ghost"}], "final": "ghost"}}"#;
    let v: Value = serde_json::from_str(&lenient(TemplateFormat::SingBox, lenient_body, &p)).unwrap();
    assert_eq!(v["route"]["rules"], json!([]));
    assert_eq!(v["route"]["final"], "direct");
}

/// A line's name, password or host can hold anything the owner of a node
/// typed: none of it may become structure in any format.
#[test]
fn hostile_values_stay_values() {
    let mut rows = sample_rows();
    rows[2].entrance = "bad, name = x\n[Rule]\nFINAL,DIRECT".into();
    rows[2].account = json!({"password": "p\"w,$proxies\nFINAL,DIRECT"});
    rows[1].entrance = "$site_name \"quoted\" $proxies".into();
    rows[0].entrance = "DIRECT".into();
    let p = proxies_of(&rows);
    // INI: every proxy line is one line; the password that cannot be
    // written is left out, not mangled.
    for f in [TemplateFormat::Surge, TemplateFormat::Surfboard] {
        let out = lenient(f, f.default_body(), &p);
        let proxy_section = out.split("[Proxy Group]").next().unwrap();
        assert!(!out.contains("p\"w"), "{out}");
        assert!(!proxy_section.contains("FINAL,DIRECT"), "{proxy_section}");
        assert_eq!(out.matches("\n[Rule]\n").count(), 1, "{out}");
        assert!(out.contains("$site_name ＂") || !out.contains("title=$site_name"), "{out}");
    }
    // Structural formats: the values survive a round trip unchanged.
    let clash: Doc = serde_saphyr::from_str(&lenient(TemplateFormat::Clash, TemplateFormat::Clash.default_body(), &p)).unwrap();
    let list = clash.get("proxies").and_then(Doc::as_seq).unwrap();
    let names: Vec<&str> = list.iter().filter_map(|x| x.get("name")?.as_str()).collect();
    assert!(names.contains(&"bad, name = x\n[Rule]\nFINAL,DIRECT"), "{names:?}");
    assert!(names.contains(&"DIRECT #2"), "a line named like a built-in policy is renamed: {names:?}");
    let trojan = list.iter().find(|x| x.get("type").and_then(Doc::as_str) == Some("trojan")).unwrap();
    assert_eq!(trojan.get("password").and_then(Doc::as_str), Some("p\"w,$proxies\nFINAL,DIRECT"));
    let sb: Value = serde_json::from_str(&lenient(TemplateFormat::SingBox, TemplateFormat::SingBox.default_body(), &p)).unwrap();
    assert!(sb["outbounds"].as_array().unwrap().iter().any(|o| o["password"] == "p\"w,$proxies\nFINAL,DIRECT"));
}

#[test]
fn scalars_survive_yaml() {
    // Short ids, passwords and names that look like numbers, booleans or
    // YAML syntax stay strings.
    let mut rows = sample_rows();
    rows[0].inbound["streamSettings"]["realitySettings"]["shortId"] = json!("12345678");
    for (i, v) in ["123", "true", "null", "1e5", "0x1f", "~", "a: b", "- x", "# c", "'q'", "yes", "on", "0o17", ".inf"].iter().enumerate() {
        let mut r = rows[2].clone();
        r.entrance = format!("t{i}");
        r.account = json!({"password": v});
        rows.push(r);
    }
    let out = lenient(TemplateFormat::Clash, TemplateFormat::Clash.default_body(), &proxies_of(&rows));
    let clash: Doc = serde_saphyr::from_str(&out).unwrap();
    let list = clash.get("proxies").and_then(Doc::as_seq).unwrap();
    let pw: Vec<String> = list
        .iter()
        .filter(|x| x.get("name").and_then(Doc::as_str).is_some_and(|n| n.starts_with('t')))
        .map(|x| x.get("password").and_then(Doc::as_str).unwrap().to_string())
        .collect();
    assert_eq!(pw, ["123", "true", "null", "1e5", "0x1f", "~", "a: b", "- x", "# c", "'q'", "yes", "on", "0o17", ".inf"]);
    let reality = list[0].get("reality-opts").unwrap();
    assert_eq!(reality.get("short-id").and_then(Doc::as_str), Some("12345678"));
}

#[test]
fn ini_validation_and_pruning() {
    let e = strict_err(TemplateFormat::Surge, "[Proxy]\n$proxies\n");
    assert!(e.message.contains("[Proxy Group]"), "{e:?}");
    let base = "[Proxy]\n$proxies\n[Proxy Group]\nG = select, Ghost, DIRECT\n[Rule]\nFINAL,G\n";
    let e = strict_err(TemplateFormat::Surge, base);
    assert!(e.message.contains("Ghost") && e.line == Some(4), "{e:?}");
    let e = strict_err(
        TemplateFormat::Surfboard,
        "[Proxy]\n$proxies\n[Proxy Group]\nG = select, DIRECT\n[Rule]\nDOMAIN,x,Ghost\nFINAL,G\n",
    );
    assert!(e.message.contains("Ghost"), "{e:?}");
    // For a user the dangling member goes; a group left empty gets DIRECT.
    let p = proxies_of(&sample_rows());
    let out = lenient(TemplateFormat::Surge, base, &p);
    assert!(out.contains("G = select, DIRECT\n"), "{out}");
    let out = lenient(TemplateFormat::Surge, "[Proxy]\n[Proxy Group]\nG = select, Ghost\n[Rule]\nFINAL,G\n", &p);
    assert!(out.contains("G = select, DIRECT\n"), "{out}");
    // include-all-proxies groups may list nothing.
    strict_ok("[Proxy]\n$proxies\n[Proxy Group]\nR = select, include-all-proxies=true\n[Rule]\nFINAL,R\n");
    // Logical rules are not checked; $proxy_group is DIRECT without lines.
    let out = lenient(TemplateFormat::Surge, "[Proxy]\n$proxies\n[Proxy Group]\nG = select, $proxy_group\n[Rule]\nAND,((DOMAIN,a),(DEST-PORT,1)),Whatever\nFINAL,G\n", &[]);
    assert!(out.contains("G = select, DIRECT\n") && out.contains("AND,"), "{out}");
}

fn strict_ok(body: &str) {
    render_sample(TemplateFormat::Surge, body).unwrap();
}

#[test]
fn rule_targets() {
    assert_eq!(rule_target("DOMAIN,x.com,Proxy", "MATCH"), Some("Proxy"));
    assert_eq!(rule_target("IP-CIDR,1.0.0.0/8,Proxy,no-resolve", "MATCH"), Some("Proxy"));
    assert_eq!(rule_target("MATCH,Proxy", "MATCH"), Some("Proxy"));
    assert_eq!(rule_target("FINAL,Proxy,dns-failed", "FINAL"), Some("Proxy"));
    assert_eq!(rule_target("AND,((A,b),(C,d)),Proxy", "MATCH"), None);
    assert_eq!(rule_target("MATCH", "MATCH"), None);
}

#[test]
fn names_are_made_unique() {
    let mut taken: HashSet<String> = ["a".to_string()].into();
    assert_eq!(unique_names(["a", "a", "b", "a"].into_iter(), &mut taken), ["a #2", "a #3", "b", "a #4"]);
    assert_eq!(crate::sub::surge::safe_name("a, b=c"), "a， b＝c");
    assert_eq!(crate::sub::surge::safe_name("#x"), "_#x");
    assert_eq!(crate::sub::surge::safe_name("  "), "_");
}

// ---------------------------------------------------------------------------
// Storage and API
// ---------------------------------------------------------------------------

async fn admin_client(state: &AppState, db: &TestDb) -> Client {
    client_for(state, db.admin().await).await
}

#[tokio::test]
async fn templates_api_versions_audit_and_preview() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&state, &db).await;
    let user = client_for(&state, db.user().await).await;
    assert_eq!(user.get("/test/api/v1/sub-templates").await.status, StatusCode::FORBIDDEN);

    let list = admin.get("/test/api/v1/sub-templates").await.json();
    let rows = list["templates"].as_array().unwrap();
    assert_eq!(rows.iter().map(|r| r["format"].as_str().unwrap()).collect::<Vec<_>>(), ["sing-box", "clash", "surge", "surfboard"]);
    for r in rows {
        assert_eq!(r["is_default"], true);
        assert_eq!(r["version"], 0);
        assert_eq!(r["body"], r["default_body"]);
        assert!(r["placeholders"].as_array().unwrap().iter().any(|p| p["token"] == "$subs_link"));
    }

    let put = |format: &str, body: Value| {
        let path = format!("/test/api/v1/sub-templates/{format}");
        let admin = &admin;
        async move { admin.req(Method::PUT, &path, Some(body)).await }
    };
    // Validation: position params; bad format; unknown field; too long.
    let r = put("clash", json!({"version": 0, "body": "proxy-groups:\n  - {name: G, type: select, proxies: [Ghost]}\n"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let j = r.json();
    assert_eq!(j["code"], "sub_template.invalid");
    assert_eq!((j["params"]["field"].as_str(), j["params"]["line"].as_i64()), (Some("body"), Some(2)));
    assert!(j["params"]["column"].as_i64().unwrap() > 1);
    assert_eq!(put("nope", json!({"version": 0, "body": "x"})).await.json()["code"], "sub_template.format_unknown");
    assert_eq!(put("clash", json!({"version": 0, "body": "a: b", "x": 1})).await.status, StatusCode::BAD_REQUEST);
    let long = format!("a: {}", "x".repeat(MAX_BODY));
    assert_eq!(put("clash", json!({"version": 0, "body": long})).await.json()["code"], "sub_template.invalid");

    let good = "mixed-port: 7890\nproxy-groups:\n  - {name: G, type: select, proxies: [$proxies, DIRECT]}\nrules:\n  - MATCH,G\n";
    let r = put("clash", json!({"version": 0, "body": good.replace('\n', "\r\n")})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
    let v = r.json();
    assert_eq!((v["version"].as_i64(), v["is_default"].as_bool(), v["body"].as_str()), (Some(1), Some(false), Some(good)));
    // Stale version.
    assert_eq!(put("clash", json!({"version": 0, "body": good})).await.status, StatusCode::CONFLICT);
    assert_eq!(put("clash", json!({"version": 1, "body": "mixed-port: 1\nrules: []\n"})).await.json()["version"], 2);

    // Preview: the draft, the stored template, a real user's lines.
    let pv = |body: Value| {
        let admin = &admin;
        async move { admin.req(Method::POST, "/test/api/v1/sub-templates/clash/preview", Some(body)).await }
    };
    let r = pv(json!({"body": good})).await.json();
    assert!(r["body"].as_str().unwrap().contains("香港 01"), "{r}");
    assert_eq!(r["content_type"], "text/yaml; charset=utf-8");
    assert!(pv(json!({})).await.json()["body"].as_str().unwrap().starts_with("mixed-port: 1\nrules: []\nproxies:\n"));
    let u = db.user().await;
    let r = pv(json!({"user_id": u})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(pv(json!({"user_id": Uuid::new_v4()})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(pv(json!({"body": "x: [", "user_id": null})).await.status, StatusCode::BAD_REQUEST);

    // Reset.
    let r = admin.req(Method::DELETE, "/test/api/v1/sub-templates/clash", None).await;
    assert_eq!((r.status, r.json()["is_default"].as_bool()), (StatusCode::OK, Some(true)));
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM sub_templates").fetch_one(&db.pool).await.unwrap();
    assert_eq!(after, 0);

    // Audit rows: update ×2, preview of a user, reset; never the body.
    let rows: Vec<(String, Option<Value>)> = sqlx::query_as(
        "SELECT action, after FROM audit_log WHERE action LIKE 'settings.sub_template.%' OR action = 'sub_template.preview' ORDER BY id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(rows.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["settings.sub_template.update", "settings.sub_template.update", "sub_template.preview", "settings.sub_template.reset"]);
    let a = rows[0].1.as_ref().unwrap();
    assert_eq!(a["body_length"], good.len());
    assert_eq!(a["body_sha256"].as_str().unwrap().len(), 64);
    assert!(!format!("{rows:?}").contains("mixed-port"));
    db.drop().await;
}

/// The subscription endpoint answers with the stored template, Surge and
/// Surfboard by UA and `?format=`, and the format switches reject them like
/// any other off format.
#[tokio::test]
async fn subscription_uses_templates_and_new_formats() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (_, token) = {
        let u = db.user().await;
        let token = crate::sub::generate_token();
        sqlx::query("UPDATE users SET sub_token_hash = $2, traffic_limit_bytes = 1000, expires_at = '2030-01-01T00:00:00Z' WHERE id = $1")
            .bind(u)
            .bind(crate::sub::hash_token(&token))
            .execute(&db.pool)
            .await
            .unwrap();
        (u, token)
    };
    let mut c = Client::new(&state, rand_ip());
    let get = |c: &Client, ua: &str, q: &str| {
        let mut c2 = Client::new(&state, c.ip);
        c2.headers.push(("user-agent".into(), ua.into()));
        let path = format!("/sub/{token}{q}");
        async move { c2.get(&path).await }
    };
    let surge = get(&c, "Surge iOS/3000", "").await;
    assert_eq!(surge.status, StatusCode::OK);
    assert_eq!(surge.headers["content-type"], "text/plain; charset=utf-8");
    let body = String::from_utf8(surge.body.clone()).unwrap();
    assert!(body.starts_with("#!MANAGED-CONFIG /"), "no domain configured: the relative link\n{body}");
    assert!(body.contains("?format=surge interval=86400"), "{body}");
    assert!(body.contains("download=0, total=1000, expire=1893456000"), "{body}");
    assert!(surge.body.len() >= 8192 && surge.body.len() % 4096 == 0);
    let board = get(&c, "Surfboard/2.30.0", "").await;
    assert!(String::from_utf8(board.body).unwrap().contains("interval=1440"));
    let stash = get(&c, "Stash/2.7.5 Clash/1.11.0", "").await;
    assert_eq!(stash.headers["content-type"], "text/yaml; charset=utf-8");
    assert!(get(&c, "curl", "?format=surge").await.status.is_success());

    // A stored template is what is served; a template that no longer
    // renders falls back to the built-in one.
    sqlx::query("INSERT INTO sub_templates (format, body) VALUES ('clash', 'mixed-port: 1234\nrules: []\n')")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = get(&c, "clash-verge/2", "").await;
    assert!(String::from_utf8(r.body).unwrap().starts_with("mixed-port: 1234\nrules: []\nproxies: []"));
    sqlx::query("UPDATE sub_templates SET body = 'rules: [' WHERE format = 'clash'")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = get(&c, "clash-verge/2", "").await;
    assert!(String::from_utf8(r.body).unwrap().contains("mixed-port: 7890"));

    // Switches: only the listed formats answer; the rest is the uniform 404.
    sqlx::query("UPDATE panel_settings SET sub_formats = ARRAY['clash'] WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    crate::settings::reload(&state).await.unwrap();
    let off = get(&c, "Surge iOS/3000", "").await;
    let junk = c.get("/nothing-here").await;
    assert_eq!(off.fingerprint().0, StatusCode::NOT_FOUND);
    assert!(off.body.is_empty() && junk.body.is_empty());
    assert_eq!(get(&c, "x", "?format=surfboard").await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&c, "clash.meta", "").await.status, StatusCode::OK);
    c.cookie = None;
    db.drop().await;
}
