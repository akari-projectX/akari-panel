//! R46: USDT withdrawal chains and their address formats.
//!
//! Commission withdrawals are paid in USDT only, by the admin on an
//! exchange (OKX) after checking the request. The user picks a chain the
//! admin enabled (`commission_settings.usdt_chains`) and gives an address;
//! the address is checked here before anything is stored, so a typo is
//! refused instead of paid to nowhere:
//!
//! - TRC20 (Tron): Base58Check, version byte 0x41, double-SHA-256 checksum.
//! - EVM chains (Plasma, Polygon, Arbitrum One, X Layer): `0x` + 40 hex;
//!   a mixed-case address must match its EIP-55 checksum (Keccak-256).
//! - Solana: Base58 of a 32-byte public key.
//! - TON: the user-friendly form (48 characters of base64 / base64url:
//!   tag, workchain 0 or −1, 32-byte hash, CRC16-XMODEM; testnet-only
//!   addresses refused) or the raw form `<workchain>:<64 hex>`; an optional
//!   memo (the exchange's deposit comment).

use crate::auth::{ApiError, bad_request};

/// Every chain: (id, name). The default set is all of them.
pub const CHAINS: &[(&str, &str)] = &[
    ("trc20", "TRC20 (Tron)"),
    ("plasma", "Plasma"),
    ("polygon", "Polygon"),
    ("arbitrum", "Arbitrum One"),
    ("solana", "Solana"),
    ("xlayer", "X Layer"),
    ("ton", "TON"),
];

pub fn default_chains() -> Vec<String> {
    CHAINS.iter().map(|(c, _)| c.to_string()).collect()
}

pub fn known(chain: &str) -> bool {
    CHAINS.iter().any(|(c, _)| *c == chain)
}

/// Longest memo (TON comment).
pub const MAX_MEMO: usize = 120;

fn invalid(chain: &str) -> ApiError {
    bad_request!(
        "withdrawal.address_invalid",
        "not a valid {chain} address",
        chain = chain.to_string()
    )
}

/// Check `address` (and `memo`) for `chain`; returns the stored forms.
pub fn check_address(
    chain: &str,
    address: &str,
    memo: Option<&str>,
) -> Result<(String, Option<String>), ApiError> {
    let a = address.trim();
    let memo = memo.map(str::trim).filter(|m| !m.is_empty());
    if memo.is_some() && chain != "ton" {
        return Err(bad_request!(
            "withdrawal.memo_unexpected",
            "a memo is only for TON"
        ));
    }
    if let Some(m) = memo
        && (m.chars().count() > MAX_MEMO || m.chars().any(char::is_control))
    {
        return Err(bad_request!(
            "withdrawal.memo_invalid",
            "the memo must be 1-{max} characters without control characters",
            max = MAX_MEMO
        ));
    }
    let ok = match chain {
        "trc20" => tron_ok(a),
        "plasma" | "polygon" | "arbitrum" | "xlayer" => evm_ok(a),
        "solana" => base58(a).is_some_and(|b| b.len() == 32) && (32..=44).contains(&a.len()),
        "ton" => ton_ok(a),
        _ => {
            return Err(bad_request!(
                "withdrawal.chain_invalid",
                "unknown chain {chain}",
                chain = chain.chars().take(32).collect::<String>()
            ));
        }
    };
    if !ok {
        return Err(invalid(chain));
    }
    Ok((a.to_string(), memo.map(str::to_string)))
}

fn tron_ok(a: &str) -> bool {
    use sha2::{Digest, Sha256};
    if a.len() != 34 || !a.starts_with('T') {
        return false;
    }
    let Some(b) = base58(a) else {
        return false;
    };
    if b.len() != 25 || b[0] != 0x41 {
        return false;
    }
    let sum = Sha256::digest(Sha256::digest(&b[..21]));
    sum[..4] == b[21..]
}

fn evm_ok(a: &str) -> bool {
    let Some(hex) = a.strip_prefix("0x") else {
        return false;
    };
    if hex.len() != 40 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let lower = hex.to_ascii_lowercase();
    if hex == lower || hex == hex.to_ascii_uppercase() {
        return true;
    }
    // EIP-55: the i-th letter is upper case iff the i-th nibble of
    // keccak256(lowercase hex) is >= 8.
    let h = keccak256(lower.as_bytes());
    hex.bytes().enumerate().all(|(i, c)| {
        let nibble = (h[i / 2] >> if i % 2 == 0 { 4 } else { 0 }) & 0x0f;
        !c.is_ascii_alphabetic() || c.is_ascii_uppercase() == (nibble >= 8)
    })
}

fn ton_ok(a: &str) -> bool {
    if let Some((wc, hash)) = a.split_once(':') {
        return matches!(wc, "0" | "-1")
            && hash.len() == 64
            && hash.bytes().all(|c| c.is_ascii_hexdigit());
    }
    use base64::Engine as _;
    if a.len() != 48 {
        return false;
    }
    let b = if a.contains(['-', '_']) {
        base64::engine::general_purpose::URL_SAFE.decode(a)
    } else {
        base64::engine::general_purpose::STANDARD.decode(a)
    };
    let Ok(b) = b else {
        return false;
    };
    // tag: 0x11 bounceable / 0x51 non-bounceable (0x80 = testnet only).
    b.len() == 36
        && matches!(b[0], 0x11 | 0x51)
        && matches!(b[1], 0x00 | 0xff)
        && crc16_xmodem(&b[..34]) == u16::from_be_bytes([b[34], b[35]])
}

const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Base58 (Bitcoin alphabet) decode; None on a foreign character.
fn base58(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    // Big-endian base-256 accumulator.
    let mut out: Vec<u8> = Vec::new();
    for c in s.bytes() {
        let mut carry = B58.iter().position(|&b| b == c)? as u32;
        for byte in out.iter_mut().rev() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            out.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    let mut v = vec![0u8; zeros];
    v.extend(out.into_iter().skip_while(|&b| b == 0));
    Some(v)
}

fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut reg: u16 = 0;
    for &b in data {
        reg ^= u16::from(b) << 8;
        for _ in 0..8 {
            reg = if reg & 0x8000 != 0 {
                (reg << 1) ^ 0x1021
            } else {
                reg << 1
            };
        }
    }
    reg
}

/// Keccak-256 (the original Keccak padding, as Ethereum uses it).
fn keccak256(data: &[u8]) -> [u8; 32] {
    sponge256(data, 0x01)
}

/// The Keccak sponge with a 256-bit output and `pad` as the domain byte
/// (0x01 Keccak, 0x06 SHA3: the tests check the permutation against SHA3).
fn sponge256(data: &[u8], pad: u8) -> [u8; 32] {
    const RATE: usize = 136;
    let mut st = [0u64; 25];
    let mut block = [0u8; RATE];
    let (blocks, rest) = data.as_chunks::<RATE>();
    for c in blocks {
        absorb(&mut st, c);
    }
    block[..rest.len()].copy_from_slice(rest);
    block[rest.len()] ^= pad;
    block[RATE - 1] ^= 0x80;
    absorb(&mut st, &block);
    let mut out = [0u8; 32];
    for (i, w) in st.iter().take(4).enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&w.to_le_bytes());
    }
    out
}

fn absorb(st: &mut [u64; 25], block: &[u8]) {
    for (i, lane) in block.as_chunks::<8>().0.iter().enumerate() {
        st[i] ^= u64::from_le_bytes(*lane);
    }
    keccak_f(st);
}

fn keccak_f(a: &mut [u64; 25]) {
    const RC: [u64; 24] = [
        0x0000000000000001,
        0x0000000000008082,
        0x800000000000808a,
        0x8000000080008000,
        0x000000000000808b,
        0x0000000080000001,
        0x8000000080008081,
        0x8000000000008009,
        0x000000000000008a,
        0x0000000000000088,
        0x0000000080008009,
        0x000000008000000a,
        0x000000008000808b,
        0x800000000000008b,
        0x8000000000008089,
        0x8000000000008003,
        0x8000000000008002,
        0x8000000000000080,
        0x000000000000800a,
        0x800000008000000a,
        0x8000000080008081,
        0x8000000000008080,
        0x0000000080000001,
        0x8000000080008008,
    ];
    const ROT: [u32; 25] = [
        0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56,
        14,
    ];
    for rc in RC {
        // θ
        let mut c = [0u64; 5];
        for x in 0..5 {
            c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
        }
        for x in 0..5 {
            let d = c[(x + 4) % 5] ^ c[(x + 1) % 5].rotate_left(1);
            for y in 0..5 {
                a[x + 5 * y] ^= d;
            }
        }
        // ρ and π
        let mut b = [0u64; 25];
        for x in 0..5 {
            for y in 0..5 {
                b[y + 5 * ((2 * x + 3 * y) % 5)] = a[x + 5 * y].rotate_left(ROT[x + 5 * y]);
            }
        }
        // χ
        for x in 0..5 {
            for y in 0..5 {
                a[x + 5 * y] = b[x + 5 * y] ^ (!b[(x + 1) % 5 + 5 * y] & b[(x + 2) % 5 + 5 * y]);
            }
        }
        // ι
        a[0] ^= rc;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_vectors() {
        assert_eq!(
            hex::encode(keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        assert_eq!(
            hex::encode(keccak256(b"abc")),
            "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        );
        // The permutation over several blocks, against SHA3-256 (same
        // sponge, another domain byte).
        assert_eq!(
            hex::encode(sponge256(&[b'a'; 200], 0x06)),
            "cce34485baf2bf2aca99b94833892a4f52896d3d153f7b840cc4f9fe695f1387"
        );
        assert_eq!(
            hex::encode(sponge256(&[b'a'; 136], 0x06)),
            "3fc5559f14db8e453a0a3091edbd2bc25e11528d81c66fa570a4efdcc2695ee1"
        );
    }

    #[test]
    fn addresses() {
        let ok = |c: &str, a: &str, m: Option<&str>| check_address(c, a, m).is_ok();
        let code = |c: &str, a: &str, m: Option<&str>| check_address(c, a, m).unwrap_err().code();
        // Tron: the USDT contract address.
        assert!(ok("trc20", " TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t ", None));
        assert!(
            !ok("trc20", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u", None),
            "checksum"
        );
        assert!(!ok(
            "trc20",
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
            None
        ));
        // EVM: EIP-55 examples; lower case accepted; a wrong case refused.
        for c in ["plasma", "polygon", "arbitrum", "xlayer"] {
            assert!(
                ok(c, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", None),
                "{c}"
            );
            assert!(
                ok(c, "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", None),
                "{c}"
            );
            assert!(
                ok(c, "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", None),
                "{c}"
            );
            assert!(
                !ok(c, "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", None),
                "{c}"
            );
            assert!(
                !ok(c, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA", None),
                "{c}"
            );
        }
        // Solana: a 32-byte key.
        assert!(ok(
            "solana",
            "So11111111111111111111111111111111111111112",
            None
        ));
        assert!(!ok(
            "solana",
            "So1111111111111111111111111111111111111111",
            None
        ));
        assert!(!ok("solana", "0OIl", None));
        // TON: friendly (both tags, base64url), raw; memo only for TON.
        assert!(ok(
            "ton",
            "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
            Some("12345")
        ));
        assert!(ok(
            "ton",
            "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI",
            None
        ));
        assert!(
            !ok(
                "ton",
                "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2M",
                None
            ),
            "crc"
        );
        assert!(ok(
            "ton",
            "0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8",
            None
        ));
        assert_eq!(
            code("trc20", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", Some("m")),
            "withdrawal.memo_unexpected"
        );
        assert_eq!(
            code(
                "ton",
                "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI",
                Some(&"x".repeat(121))
            ),
            "withdrawal.memo_invalid"
        );
        assert_eq!(code("btc", "x", None), "withdrawal.chain_invalid");
        assert_eq!(code("solana", "x", None), "withdrawal.address_invalid");
        assert_eq!(default_chains().len(), 7);
        assert!(known("ton") && !known("erc20"));
    }
}
