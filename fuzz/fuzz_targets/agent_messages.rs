//! Agent -> panel messages (`AgentUp`, protobuf over the mTLS stream): a
//! compromised or buggy node controls every byte. Exercised: traffic
//! reports into the traffic buffer (`traffic::TrafficBuffer::update`, the
//! billing input), heartbeats into the Valkey blob / history sample
//! (`nodestat`, `grpc::cert_status_json`).
//!
//! Input: a sequence of ops. Op byte % 6: 0..=2 a length-prefixed
//! (u16 LE) protobuf `AgentUp` (session id chosen by the op byte), 3 mark
//! everything flushed, 4 prune (idle eviction + index rebuild), 5 change
//! the node's member set.
//!
//! Invariants: no panic; the buffer's index always equals its entries
//! (check_invariants); a buffered counter never decreases while its
//! session holds unpersisted values; a member-less node and
//! unknown users never get entries; the heartbeat blob is JSON with
//! clamped numbers and bounded, control-free agent text.
#![no_main]

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use akari_panel::fuzzing::{cert_status_json, traffic_check, traffic_members, traffic_peek};
use akari_panel::nodestat::{Sample, heartbeat_blob};
use akari_panel::pb::AgentUp;
use akari_panel::pb::agent_up::Msg;
use akari_panel::traffic::TrafficBuffer;
use akari_panel_fuzz::strings;
use libfuzzer_sys::fuzz_target;
use prost::Message;
use uuid::Uuid;

const SESSIONS: [&str; 3] = ["s-a", "s-b", "s-c"];
/// Longest agent string the heartbeat blob may hold.
const MAX_TEXT: usize = 512;

fn users() -> [Uuid; 4] {
    [1u128, 2, 3, 4].map(Uuid::from_u128)
}

fn check_heartbeat(hb: &akari_panel::pb::Heartbeat) {
    let mut blob = heartbeat_blob(hb);
    if let Some(c) = &hb.cert {
        blob["cert"] = cert_status_json(c);
    }
    let text = blob.to_string();
    serde_json::from_str::<serde_json::Value>(&text).expect("blob is JSON");
    // W23: null = unknown (unset or non-finite), else 0..=100.
    match &blob["cpu_percent"] {
        serde_json::Value::Null => {}
        v => assert!((0.0..=100.0).contains(&v.as_f64().expect("cpu"))),
    }
    let mut all = Vec::new();
    strings(&blob, &mut all);
    for s in all {
        assert!(
            s.chars().count() <= MAX_TEXT,
            "unbounded agent text in blob"
        );
        assert!(
            !s.chars().any(char::is_control),
            "control characters in blob: {s:?}"
        );
    }
    let s = Sample::from_heartbeat(hb);
    assert!(
        s.cpu
            .is_none_or(|c| c.is_finite() && (0.0..=100.0).contains(&c))
    );
    assert!(s.load1.is_none_or(|l| l.is_finite() && l >= 0.0));
    for v in [
        s.mem_used,
        s.mem_total,
        s.swap_used,
        s.disk_used,
        s.rx_bps,
        Some(s.conns),
    ]
    .into_iter()
    .flatten()
    {
        assert!(v >= 0);
    }
}

fuzz_target!(|data: &[u8]| {
    let node = Uuid::from_u128(0xA);
    let entrance = Uuid::from_u128(0xE);
    let buf = TrafficBuffer::new();
    let mut members: Vec<Uuid> = users()[..2].to_vec();
    let mut ever: HashSet<Uuid> = members.iter().copied().collect();
    buf.set_members(node, traffic_members(entrance, &members));
    let mut last: HashMap<(Uuid, &str), (i64, i64)> = HashMap::new();
    let mut flushed = false;
    let mut i = 0;
    let mut steps = 0;
    while i < data.len() && steps < 64 {
        steps += 1;
        let op = data[i];
        i += 1;
        match op % 6 {
            0..=2 => {
                if i + 2 > data.len() {
                    break;
                }
                let n = usize::from(u16::from_le_bytes([data[i], data[i + 1]]));
                i += 2;
                let end = (i + n).min(data.len());
                let chunk = &data[i..end];
                i = end;
                let Ok(up) = AgentUp::decode(chunk) else {
                    continue;
                };
                match up.msg {
                    Some(Msg::Traffic(r)) => {
                        let session = SESSIONS[usize::from(op % 6)];
                        buf.update(node, session, &r);
                        // A session id from the report itself (agent-chosen).
                        if !r.session_id.is_empty() {
                            buf.update(node, &r.session_id, &r);
                        }
                    }
                    Some(Msg::Heartbeat(hb)) => check_heartbeat(&hb),
                    _ => {}
                }
            }
            3 => {
                // Clean sessions may now be evicted and re-created lower
                // (safe: the database keeps the high-water mark).
                buf.bench_mark_all_flushed();
                flushed = true;
            }
            4 => buf.prune(Instant::now() + Duration::from_secs(3600)),
            _ => {
                let mask = data.get(i).copied().unwrap_or(0);
                i += 1;
                members = users()
                    .iter()
                    .enumerate()
                    .filter(|(k, _)| mask & (1 << k) != 0)
                    .map(|(_, u)| *u)
                    .collect();
                ever.extend(members.iter().copied());
                buf.set_members(node, traffic_members(entrance, &members));
            }
        }
        if let Err(e) = traffic_check(&buf) {
            panic!("traffic buffer invariant: {e}");
        }
        for u in users() {
            for s in SESSIONS {
                match traffic_peek(&buf, node, entrance, u, s) {
                    Some(v) => {
                        if let Some(prev) = last.get(&(u, s)).filter(|_| !flushed) {
                            assert!(v.0 >= prev.0 && v.1 >= prev.1, "counter went backwards");
                        }
                        last.insert((u, s), v);
                    }
                    None => {
                        last.remove(&(u, s));
                    }
                }
            }
        }
    }
    // Users never in the member set have no entries.
    for u in users() {
        if !ever.contains(&u) {
            for s in SESSIONS {
                assert_eq!(
                    traffic_peek(&buf, node, entrance, u, s),
                    None,
                    "non-member buffered"
                );
            }
        }
    }
    // A node without loaded membership never buffers anything.
    let stranger = Uuid::from_u128(0xB);
    let r = akari_panel::pb::TrafficReport {
        users: vec![akari_panel::pb::UserTraffic {
            user_id: users()[0].to_string(),
            up_bytes: 1,
            down_bytes: 1,
        }],
        ..Default::default()
    };
    buf.update(stranger, "s-a", &r);
    assert_eq!(
        traffic_peek(&buf, stranger, entrance, users()[0], "s-a"),
        None
    );
});
