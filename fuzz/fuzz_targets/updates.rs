//! Agent self-update (M6): release manifests and signature files uploaded
//! by an admin and offered to agents, `updates.release_keys`, and the
//! semver rules (`updates.rs`, same rules as akari-agent `release/`).
//!
//! Input mode (first byte % 4): 0 manifest bytes, 1 release-key lines,
//! 2 three versions (0xFF separated), 3 manifest signed with a fixed key.
//!
//! Invariants: no panic; an accepted manifest re-serializes to an equal
//! manifest; version comparison is a total order (reflexive,
//! antisymmetric, transitive) on accepted versions; a signature verifies
//! for its exact manifest bytes only.
#![no_main]

use std::cmp::Ordering;

use akari_panel::updates::{
    compare_versions, key_id, parse_manifest, parse_release_keys, parse_version, verify,
    ReleaseKey, Signature,
};
use akari_panel_fuzz::fields;
use base64::Engine as _;
use libfuzzer_sys::fuzz_target;
use ring::signature::{Ed25519KeyPair, KeyPair};

const CONTEXT: &[u8] = b"akari-agent-manifest-v1\n";

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    match mode % 4 {
        0 => {
            if let Ok(m) = parse_manifest(rest) {
                let again = serde_json::to_vec(&m).expect("serialize");
                assert_eq!(parse_manifest(&again).expect("re-parse"), m);
            }
        }
        1 => {
            let text = String::from_utf8_lossy(rest);
            let lines: Vec<String> = text.lines().take(16).map(str::to_string).collect();
            if let Ok(keys) = parse_release_keys(&lines) {
                assert_eq!(keys.len(), lines.len());
                for k in &keys {
                    assert_eq!(k.key.len(), 32);
                    assert_eq!(k.id, key_id(&k.key));
                }
            }
        }
        2 => {
            let f = fields(rest, 3);
            let vs: Vec<&str> = f.iter().map(String::as_str).collect();
            for v in &vs {
                if parse_version(v).is_some() {
                    assert_eq!(compare_versions(v, v), Some(Ordering::Equal), "{v}");
                }
            }
            if let [a, b, ..] = vs[..]
                && let (Some(x), Some(y)) = (compare_versions(a, b), compare_versions(b, a))
            {
                assert_eq!(x, y.reverse(), "antisymmetry {a} {b}");
            }
            if let [a, b, c] = vs[..]
                && let (Some(ab), Some(bc), Some(ac)) = (
                    compare_versions(a, b),
                    compare_versions(b, c),
                    compare_versions(a, c),
                )
                && ab != Ordering::Greater
                && bc != Ordering::Greater
            {
                assert_ne!(ac, Ordering::Greater, "transitivity {a} {b} {c}");
            }
        }
        _ => {
            let pair = Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).expect("seed");
            let pk = pair.public_key().as_ref().to_vec();
            let key = ReleaseKey {
                id: key_id(&pk),
                key: pk,
                label: String::new(),
            };
            let mut msg = CONTEXT.to_vec();
            msg.extend_from_slice(rest);
            let sig = Signature {
                key_id: key.id.clone(),
                sig: base64::engine::general_purpose::STANDARD.encode(pair.sign(&msg)),
            };
            let keys = [key];
            assert_eq!(
                verify(rest, std::slice::from_ref(&sig), &keys).as_deref(),
                Ok(keys[0].id.as_str())
            );
            let mut other = rest.to_vec();
            other.push(b' ');
            assert!(verify(&other, std::slice::from_ref(&sig), &keys).is_err());
            if !rest.is_empty() {
                assert!(verify(&rest[1..], std::slice::from_ref(&sig), &keys).is_err());
            }
            // A signature for another key id is ignored.
            let wrong = Signature {
                key_id: "0000000000000000".into(),
                sig: sig.sig.clone(),
            };
            assert!(verify(rest, &[wrong], &keys).is_err());
            let _ = parse_manifest(rest);
        }
    }
});
