-- M1c (M1-8): CSR enrollment, certificate rotation, admin 2FA enrollment
-- codes.

-- 1. One-time node enrollment tokens. One row per node (re-issuing replaces
--    it). Only the SHA-256 of the 256-bit token is stored. Burned by a
--    conditional UPDATE (used_at IS NULL AND expires_at > now()), so two
--    concurrent enrollments with the same token cannot both succeed, on any
--    number of panel instances.
CREATE TABLE node_enrollments (
    node_id    UUID PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);

-- 2. Certificate rotation. cert_serial = the newest certificate issued to
--    the node (NULL until it enrolls); prev_cert_serial = the one it renewed
--    from, still accepted until cert_serial is first seen on a connection
--    (then tombstoned with reason 'rotated') or until it expires.
--    cert_not_after: expiry of cert_serial (NULL for certificates issued
--    before this migration until their agent next connects).
ALTER TABLE nodes
    ADD COLUMN prev_cert_serial TEXT UNIQUE,
    ADD COLUMN cert_not_after TIMESTAMPTZ;

-- Tombstone reasons: 'deleted' (node deleted: the agent is accepted, served
-- the empty state, closed) and 'rotated' (superseded by a renewal: refused
-- like an unknown certificate — the node lives on, its agent must keep its
-- configuration and use its newer certificate).
ALTER TABLE revoked_certs
    ADD COLUMN reason TEXT NOT NULL DEFAULT 'deleted'
        CHECK (reason IN ('deleted', 'rotated'));

CREATE OR REPLACE FUNCTION akari_refuse_revoked_serial() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.cert_serial IS NOT NULL
        AND EXISTS (SELECT 1 FROM revoked_certs WHERE cert_serial = NEW.cert_serial))
       OR (NEW.prev_cert_serial IS NOT NULL
        AND EXISTS (SELECT 1 FROM revoked_certs WHERE cert_serial = NEW.prev_cert_serial)) THEN
        RAISE EXCEPTION 'certificate serial is revoked'
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER nodes_refuse_revoked_serial ON nodes;
CREATE TRIGGER nodes_refuse_revoked_serial
    BEFORE INSERT OR UPDATE OF cert_serial, prev_cert_serial ON nodes
    FOR EACH ROW
    EXECUTE FUNCTION akari_refuse_revoked_serial();

-- 3. Admin 2FA enrollment codes (M1b residual): an admin's first TOTP
--    activation requires a one-time code printed by `akari admin add` /
--    `admin reset-2fa` (or returned once by the admin API), so a leaked
--    password alone cannot bind an attacker's authenticator. Only the
--    SHA-256 of the 100-bit code is stored; consumed in the activation
--    transaction.
CREATE TABLE totp_enroll_codes (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash  BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
