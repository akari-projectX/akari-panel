//! The client-side groups of one user's subscription (2026-10-13
//! `sub-service-groups`), format-neutral: built from the lines (proxies)
//! this user's plan grants and the format can carry, so a line the user
//! cannot use never appears.
//!
//! - one url-test group per node region (`🌐 <region>`) and per enabled or
//!   referenced entrance tag (`🏷 <tag>`); empty ones are omitted;
//! - `♻️ 全部节点`: url-test over every line;
//! - `🚀 默认代理`: select, preselected on the routing's `rest` (else all
//!   lines), then the region and tag groups, all lines, each line;
//! - per service (rules mode): select [`♻️ <name> 推荐` (fallback over the
//!   service's chain: the primary, then the backups that exist for this
//!   user), the chain, the other region groups, all lines, DIRECT]; a
//!   service whose chain is empty for this user points at the default
//!   proxy instead: [`🚀 默认代理`, region groups, all lines, DIRECT].
//!
//! Group names are stable (clients remember the user's choice by name);
//! a name that collides with a line or another group gets ` #2`.

use std::collections::HashSet;

use uuid::Uuid;

use super::proxy::Proxy;
use super::routing::{Mode, Ref, Routing, Service};

pub(crate) const DEFAULT_GROUP: &str = "🚀 默认代理";
pub(crate) const ALL_GROUP: &str = "♻️ 全部节点";
/// What clients probe for url-test / fallback groups.
pub(crate) const TEST_URL: &str = "https://www.gstatic.com/generate_204";
pub(crate) const TEST_INTERVAL: u32 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Select,
    UrlTest,
    /// Clash `fallback` (sing-box has none: rendered as url-test).
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Member {
    /// A line or a group, by name.
    Name(String),
    Direct,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Group {
    pub name: String,
    pub kind: Kind,
    /// Hidden from the client's group list (the services' 推荐 groups).
    pub hidden: bool,
    pub members: Vec<Member>,
}

/// A user's groups and where each routed target points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Plan {
    pub groups: Vec<Group>,
    /// The default proxy group's name (the final rule).
    pub default: String,
    /// Each service's group name (None in global mode).
    pub services: Vec<Option<String>>,
}

/// A line as the plan needs it.
pub(crate) struct Line<'a> {
    pub name: &'a str,
    pub entrance: Option<Uuid>,
    pub region: Option<&'a str>,
    pub tags: &'a [String],
}

impl<'a> From<&'a Proxy> for Line<'a> {
    fn from(p: &'a Proxy) -> Self {
        Line {
            name: &p.name,
            entrance: p.entrance,
            region: p.region.as_deref(),
            tags: &p.tags,
        }
    }
}

struct Names(HashSet<String>);

impl Names {
    fn take(&mut self, want: String) -> String {
        if self.0.insert(want.clone()) {
            return want;
        }
        let mut i = 2;
        loop {
            let n = format!("{want} #{i}");
            if self.0.insert(n.clone()) {
                return n;
            }
            i += 1;
        }
    }
}

fn push_unique(v: &mut Vec<Member>, m: Member) {
    if !v.contains(&m) {
        v.push(m);
    }
}

pub(crate) fn service_name(s: &Service) -> String {
    if s.emoji.is_empty() {
        s.name.clone()
    } else {
        format!("{} {}", s.emoji, s.name)
    }
}

pub(crate) fn plan(lines: &[Line<'_>], routing: &Routing) -> Plan {
    let c = &routing.config;
    let mut names = Names(lines.iter().map(|l| l.name.to_string()).collect());
    let default = names.take(DEFAULT_GROUP.into());
    let all = names.take(ALL_GROUP.into());

    // Region groups in first-seen order (lines come in the operator's sort).
    let mut regions: Vec<(&str, String, Vec<Member>)> = Vec::new();
    for l in lines {
        let Some(r) = l.region.map(str::trim).filter(|r| !r.is_empty()) else {
            continue;
        };
        match regions.iter_mut().find(|(k, _, _)| *k == r) {
            Some((_, _, m)) => m.push(Member::Name(l.name.into())),
            None => regions.push((
                r,
                names.take(format!("🌐 {r}")),
                vec![Member::Name(l.name.into())],
            )),
        }
    }
    // Tag groups: the enabled ones, then any a chain or `rest` names.
    let mut tag_keys: Vec<&str> = c.tag_groups.iter().map(String::as_str).collect();
    for r in c
        .services
        .iter()
        .flat_map(|s| s.backups.iter())
        .chain(c.rest.iter())
    {
        if let Ref::Tag(t) = r
            && !tag_keys.contains(&t.as_str())
        {
            tag_keys.push(t);
        }
    }
    let mut tags: Vec<(&str, String, Vec<Member>)> = Vec::new();
    for t in tag_keys {
        let members: Vec<Member> = lines
            .iter()
            .filter(|l| l.tags.iter().any(|x| x == t))
            .map(|l| Member::Name(l.name.into()))
            .collect();
        if !members.is_empty() {
            tags.push((t, names.take(format!("🏷 {t}")), members));
        }
    }

    let resolve = |r: &Ref| -> Option<String> {
        match r {
            Ref::Entrance(id) => lines
                .iter()
                .find(|l| l.entrance == Some(*id))
                .map(|l| l.name.to_string()),
            Ref::Region(k) => regions
                .iter()
                .find(|(x, _, _)| x == k)
                .map(|(_, n, _)| n.clone()),
            Ref::Tag(k) => tags
                .iter()
                .find(|(x, _, _)| x == k)
                .map(|(_, n, _)| n.clone()),
        }
    };
    let region_members: Vec<Member> = regions
        .iter()
        .map(|(_, n, _)| Member::Name(n.clone()))
        .collect();
    let tag_members: Vec<Member> = tags
        .iter()
        .map(|(_, n, _)| Member::Name(n.clone()))
        .collect();

    let mut groups = Vec::new();
    // The default proxy.
    let mut members = Vec::new();
    match c.rest.as_ref().and_then(resolve) {
        Some(t) => push_unique(&mut members, Member::Name(t)),
        None => push_unique(&mut members, Member::Name(all.clone())),
    }
    for m in region_members.iter().chain(&tag_members) {
        push_unique(&mut members, m.clone());
    }
    push_unique(&mut members, Member::Name(all.clone()));
    for l in lines {
        push_unique(&mut members, Member::Name(l.name.into()));
    }
    groups.push(Group {
        name: default.clone(),
        kind: Kind::Select,
        hidden: false,
        members,
    });

    // Services.
    let mut services = Vec::new();
    for s in &c.services {
        if c.mode == Mode::Global {
            services.push(None);
            continue;
        }
        let name = names.take(service_name(s));
        let mut chain: Vec<Member> = Vec::new();
        for r in s.primary.map(Ref::Entrance).iter().chain(&s.backups) {
            if let Some(n) = resolve(r) {
                push_unique(&mut chain, Member::Name(n));
            }
        }
        let mut members = Vec::new();
        let fallback = if chain.is_empty() {
            members.push(Member::Name(default.clone()));
            None
        } else {
            let f = names.take(format!("♻️ {} 推荐", s.name));
            members.push(Member::Name(f.clone()));
            members.extend(chain.iter().cloned());
            Some(Group {
                name: f,
                kind: Kind::Fallback,
                hidden: true,
                members: chain,
            })
        };
        for m in &region_members {
            push_unique(&mut members, m.clone());
        }
        push_unique(&mut members, Member::Name(all.clone()));
        members.push(Member::Direct);
        groups.push(Group {
            name: name.clone(),
            kind: Kind::Select,
            hidden: false,
            members,
        });
        groups.extend(fallback);
        services.push(Some(name));
    }

    for (_, name, members) in regions.into_iter().chain(tags) {
        groups.push(Group {
            name,
            kind: Kind::UrlTest,
            hidden: false,
            members,
        });
    }
    groups.push(if lines.is_empty() {
        // No line: a select over DIRECT keeps the profile valid.
        Group {
            name: all,
            kind: Kind::Select,
            hidden: false,
            members: vec![Member::Direct],
        }
    } else {
        Group {
            name: all,
            kind: Kind::UrlTest,
            hidden: false,
            members: lines.iter().map(|l| Member::Name(l.name.into())).collect(),
        }
    });
    Plan {
        groups,
        default,
        services,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sub::routing::{Config, recommended};

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    fn names(g: &Group) -> Vec<String> {
        g.members
            .iter()
            .map(|m| match m {
                Member::Name(n) => n.clone(),
                Member::Direct => "DIRECT".into(),
            })
            .collect()
    }

    fn lines() -> Vec<(String, Uuid, Option<String>, Vec<String>)> {
        vec![
            (
                "香港 HKT".into(),
                id(1),
                Some("香港".into()),
                vec!["IPLC".into()],
            ),
            (
                "东京 01".into(),
                id(3),
                Some("日本".into()),
                vec!["解锁".into()],
            ),
            ("大阪 02".into(), id(4), Some("日本".into()), vec![]),
            ("无地区".into(), id(9), None, vec![]),
        ]
    }

    fn run(config: Config, data: &[(String, Uuid, Option<String>, Vec<String>)]) -> Plan {
        let ls: Vec<Line<'_>> = data
            .iter()
            .map(|(n, e, r, t)| Line {
                name: n,
                entrance: Some(*e),
                region: r.as_deref(),
                tags: t,
            })
            .collect();
        plan(
            &ls,
            &Routing {
                config,
                ..Routing::default()
            },
        )
    }

    fn group<'a>(p: &'a Plan, name: &str) -> &'a Group {
        p.groups.iter().find(|g| g.name == name).unwrap()
    }

    #[test]
    fn pinned_lines_fail_over_and_unavailable_ones_are_skipped() {
        let mut c = recommended();
        c.services.truncate(2);
        c.services[0].primary = Some(id(3)); // 东京 01
        c.services[0].backups = vec![
            Ref::Entrance(id(42)), // not this user's: skipped
            Ref::Entrance(id(4)),
            Ref::Region("日本".into()),
            Ref::Region("美国".into()), // no such region here: skipped
        ];
        // Nothing usable: points at the default proxy.
        c.services[1].primary = Some(id(77));
        c.services[1].backups = vec![Ref::Tag("没有".into())];
        c.rest = Some(Ref::Region("香港".into()));
        c.tag_groups = vec!["解锁".into()];
        let data = lines();
        let p = run(c, &data);
        let order: Vec<&str> = p.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(
            order,
            [
                DEFAULT_GROUP,
                "🎬 Netflix",
                "♻️ Netflix 推荐",
                "🔍 Google",
                "🌐 香港",
                "🌐 日本",
                "🏷 解锁",
                ALL_GROUP
            ]
        );
        assert_eq!(
            names(group(&p, DEFAULT_GROUP)),
            [
                "🌐 香港",
                "🌐 日本",
                "🏷 解锁",
                ALL_GROUP,
                "香港 HKT",
                "东京 01",
                "大阪 02",
                "无地区"
            ]
        );
        let nf = group(&p, "🎬 Netflix");
        assert_eq!(
            names(nf),
            [
                "♻️ Netflix 推荐",
                "东京 01",
                "大阪 02",
                "🌐 日本",
                "🌐 香港",
                ALL_GROUP,
                "DIRECT"
            ]
        );
        let rec = group(&p, "♻️ Netflix 推荐");
        assert_eq!((rec.kind, rec.hidden), (Kind::Fallback, true));
        assert_eq!(names(rec), ["东京 01", "大阪 02", "🌐 日本"]);
        assert_eq!(
            names(group(&p, "🔍 Google")),
            [DEFAULT_GROUP, "🌐 香港", "🌐 日本", ALL_GROUP, "DIRECT"]
        );
        assert_eq!(group(&p, "🌐 日本").kind, Kind::UrlTest);
        assert_eq!(names(group(&p, "🌐 日本")), ["东京 01", "大阪 02"]);
        assert_eq!(
            p.services,
            [Some("🎬 Netflix".into()), Some("🔍 Google".into())]
        );
        assert_eq!(p.default, DEFAULT_GROUP);
    }

    #[test]
    fn empty_groups_global_mode_and_name_collisions() {
        // A line named like a group keeps its name; the group moves aside.
        let data = vec![("🌐 香港".into(), id(1), Some("香港".into()), vec![])];
        let mut c = recommended();
        c.tag_groups = vec!["IPLC".into()]; // no line has it: omitted
        let p = run(c.clone(), &data);
        assert!(p.groups.iter().any(|g| g.name == "🌐 香港 #2"));
        assert!(!p.groups.iter().any(|g| g.name.starts_with("🏷")));
        // Global: no service groups.
        c.mode = Mode::Global;
        let p = run(c, &data);
        assert!(p.services.iter().all(Option::is_none));
        assert_eq!(p.groups.len(), 3);
        // No line at all: the profile still names valid groups.
        let p = run(recommended(), &[]);
        let all = group(&p, ALL_GROUP);
        assert_eq!(
            (all.kind, names(all)),
            (Kind::Select, vec!["DIRECT".to_string()])
        );
        assert_eq!(names(group(&p, DEFAULT_GROUP)), [ALL_GROUP]);
    }
}
