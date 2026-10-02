//! W22 traffic history query strings (`trafficlog::parse_query`, the
//! `?from&to&group&limit` of /users/{id}/traffic, /nodes/{id}/traffic,
//! /traffic/summary and /me/traffic).
//!
//! Input: first byte selects the endpoint's parameter set and the "today"
//! offset; the rest is the raw query string.
//!
//! Invariants: no panic; an accepted query has 2000-01-01 <= from <= to <=
//! 2999-12-31, a span within the endpoint's limit (366 days, 3660 for
//! month grouping), a limit in 1..=100, a group other than day only where
//! the endpoint takes `group`, and parsing is deterministic.
#![no_main]

use akari_panel::trafficlog::{self, Group, Params};
use chrono::{Duration, NaiveDate};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&sel, rest)) = data.split_first() else {
        return;
    };
    let params = match sel % 3 {
        0 => Params::User,
        1 => Params::Top,
        _ => Params::Me,
    };
    let today =
        NaiveDate::from_ymd_opt(2026, 10, 2).unwrap() + Duration::days((sel / 3) as i64 * 97);
    let raw = String::from_utf8_lossy(rest);
    let got = trafficlog::parse_query(Some(&raw), today, params);
    assert_eq!(got, trafficlog::parse_query(Some(&raw), today, params));
    let Ok(r) = got else {
        return;
    };
    let lo = NaiveDate::from_ymd_opt(2000, 1, 1).unwrap();
    let hi = NaiveDate::from_ymd_opt(2999, 12, 31).unwrap();
    assert!(
        lo <= r.from && r.from <= r.to && r.to <= hi.max(today),
        "{r:?}"
    );
    let span = (r.to - r.from).num_days() + 1;
    let max = if r.group == Group::Month {
        trafficlog::MAX_MONTH_SPAN_DAYS
    } else {
        trafficlog::MAX_SPAN_DAYS
    };
    assert!(span <= max, "{r:?}");
    assert!((1..=trafficlog::MAX_LIMIT).contains(&r.limit));
    if params != Params::User {
        assert_eq!(r.group, Group::Day);
    }
    if params != Params::Top {
        assert_eq!(r.limit, trafficlog::DEFAULT_LIMIT);
    }
});
