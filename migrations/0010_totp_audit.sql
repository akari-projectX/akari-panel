-- M1b (M1-6, M1-7): TOTP second factor, recovery codes, audit log.

-- 1. TOTP (RFC 6238: SHA-1, 6 digits, 30 s). One row per account.
--    secret_enc: AES-256-GCM under a key derived from data/totp.key, with the
--    user id as associated data (a ciphertext copied onto another account's
--    row does not decrypt). Layout: version byte 0x01 || 12-byte nonce ||
--    ciphertext || tag. The plaintext secret never leaves the panel after
--    the enrollment response.
--    enabled_at NULL = enrollment pending (secret shown, not yet confirmed
--    with a valid code); only rows with enabled_at set are a second factor.
--    last_step: highest accepted time step (unix time / 30). A code is only
--    accepted for a step strictly above it, so a code (or an older one from
--    the ±1 window) can never be used twice — on any panel instance, since
--    the check is a conditional UPDATE of this row.
CREATE TABLE user_totp (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc BYTEA NOT NULL,
    enabled_at TIMESTAMPTZ,
    last_step  BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Recovery codes: 10 per enrollment, single use. Stored as hex
--    HMAC-SHA256 (key derived from data/totp.key) over user id || code. The
--    codes are 60-bit random, so a keyed fast hash is enough (no offline
--    guessing without the key) and keeps the login check constant-cost.
--    Consumed by a conditional UPDATE (used_at IS NULL), so each code works
--    exactly once across instances.
CREATE TABLE user_recovery_codes (
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   TIMESTAMPTZ,
    PRIMARY KEY (user_id, code_hash)
);

-- 3. Audit log. Written in the same transaction as the change it records
--    (rollback = no row). `at` is now() = transaction start. No foreign
--    keys: the history outlives deleted actors and targets. actor_login is
--    'cli' for CLI actions (actor_id NULL). before/after hold redacted
--    snapshots: never password hashes, tokens, TOTP secrets, recovery codes
--    or proxy credentials (only the fact that they changed). Pruned after
--    audit.retention_days.
CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id    UUID,
    actor_login TEXT NOT NULL,
    ip          TEXT,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    before      JSONB,
    after       JSONB
);

CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_actor ON audit_log (actor_login, id);
CREATE INDEX audit_log_action ON audit_log (action, id);
