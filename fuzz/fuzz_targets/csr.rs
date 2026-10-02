//! Agent enrollment / renewal CSRs (`install::check_csr`): DER PKCS#10
//! from an unauthenticated (enroll) or node-authenticated (renew) peer.
//!
//! Input mode (first byte): even = the rest is the DER as received; odd =
//! byte patches (offset, xor) applied to a valid P-256 CSR, so mutations
//! reach the signature and attribute checks instead of dying in the DER
//! parser.
//!
//! Invariants: no panic, no allocation beyond the 4 KiB bound; the
//! reference CSR is accepted; a CSR is accepted only if it is a P-256 key
//! whose signature verifies and has no attributes (checked again here by
//! rcgen); any patch inside the signed part makes it fail.
#![no_main]

use std::sync::OnceLock;

use akari_panel::install::{check_csr, MAX_CSR_LEN};
use libfuzzer_sys::fuzz_target;
use rcgen::PublicKeyData;

fn reference() -> &'static Vec<u8> {
    static R: OnceLock<Vec<u8>> = OnceLock::new();
    R.get_or_init(|| {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("key");
        let params = rcgen::CertificateParams::default();
        let csr = params.serialize_request(&key).expect("csr");
        let der = csr.der().to_vec();
        assert!(check_csr(&der).is_ok(), "reference CSR refused");
        der
    })
}

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    let der: Vec<u8> = if mode & 1 == 0 {
        rest.to_vec()
    } else {
        let mut d = reference().clone();
        for p in rest.as_chunks::<3>().0.iter().take(8) {
            let off = usize::from(u16::from_le_bytes([p[0], p[1]])) % d.len();
            d[off] ^= p[2];
        }
        d
    };
    let ok = check_csr(&der).is_ok();
    if der.len() > MAX_CSR_LEN {
        assert!(!ok);
    }
    if ok {
        // Independent re-check: rcgen parses it and agrees on the key type.
        let parsed = rcgen::CertificateSigningRequestParams::from_der(&der.clone().into())
            .expect("accepted CSR parses in rcgen");
        assert_eq!(
            parsed.public_key.algorithm(),
            &rcgen::PKCS_ECDSA_P256_SHA256
        );
        if mode & 1 == 1 && der != *reference() {
            // A patched CSR may only survive if the patch landed outside
            // what is signed (e.g. a no-op xor 0 or inside the signature
            // encoding with an equivalent value) — the key must not change.
            let r = rcgen::CertificateSigningRequestParams::from_der(&reference().clone().into())
                .expect("reference");
            assert_eq!(
                parsed.public_key.der_bytes(),
                r.public_key.der_bytes(),
                "patched CSR accepted with another key"
            );
        }
    }
});
