//! Randomness for generated protocol material (W26): REALITY keys, short
//! ids, default transport paths/service names, per-user credentials.
//!
//! Always the OS-seeded thread RNG in the binary. Tests can run a closure
//! with a fixed seed (`seeded`), so the golden snapshots of what the
//! templates and credential generators produce (`w26_golden_tests`) are
//! byte-for-byte reproducible.

use rand::RngCore;

#[cfg(test)]
thread_local! {
    static SEEDED: std::cell::RefCell<Option<rand::rngs::StdRng>> =
        const { std::cell::RefCell::new(None) };
}

/// Fill `buf` with random bytes.
pub fn fill(buf: &mut [u8]) {
    #[cfg(test)]
    {
        let done = SEEDED.with(|s| match s.borrow_mut().as_mut() {
            Some(rng) => {
                rng.fill_bytes(buf);
                true
            }
            None => false,
        });
        if done {
            return;
        }
    }
    rand::rng().fill_bytes(buf);
}

/// `n` random bytes.
pub fn bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    fill(&mut b);
    b
}

/// A random (version 4) UUID.
pub fn uuid_v4() -> uuid::Uuid {
    let mut b = [0u8; 16];
    fill(&mut b);
    uuid::Builder::from_random_bytes(b).into_uuid()
}

/// Run `f` with this thread's randomness drawn from a fixed seed.
#[cfg(test)]
pub fn seeded<T>(seed: u64, f: impl FnOnce() -> T) -> T {
    use rand::SeedableRng;
    SEEDED.with(|s| *s.borrow_mut() = Some(rand::rngs::StdRng::seed_from_u64(seed)));
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            SEEDED.with(|s| *s.borrow_mut() = None);
        }
    }
    let _reset = Reset;
    f()
}

#[cfg(test)]
mod tests {
    #[test]
    fn seeded_is_reproducible_and_scoped() {
        let a = super::seeded(7, || (super::bytes(8), super::uuid_v4()));
        let b = super::seeded(7, || (super::bytes(8), super::uuid_v4()));
        assert_eq!(a, b);
        assert_eq!(a.1.get_version_num(), 4);
        assert_ne!(super::bytes(8), a.0, "outside `seeded` the OS-seeded RNG");
    }
}
