-- W20 (B1): the subscription link stays retrievable. The token is stored
-- encrypted next to its hash: `sub_token_enc` = 0x01 ‖ nonce ‖
-- AES-256-GCM(token), AAD = user id, key derived from data/totp.key
-- ("akari/sub-token-aead/v1", totp::Keys::seal_sub_token). Lookup stays on
-- `sub_token_hash` (SHA-256); the ciphertext is only ever opened to show
-- the owner (or an admin, audited) the link.
--
-- Accounts from before this migration have only the hash: their link keeps
-- working and is NOT rotated; the portal offers "reset" to get a link it can
-- show (sub::ensure_token). Accounts with no token at all get one lazily.
ALTER TABLE users
    ADD COLUMN sub_token_enc BYTEA,
    ADD CONSTRAINT users_sub_token_enc_has_hash
        CHECK (sub_token_enc IS NULL OR sub_token_hash IS NOT NULL);

-- Any write that changes the hash without writing a new ciphertext (a
-- hand-written UPDATE, an older code path) drops the ciphertext, so the
-- portal never shows a link that no longer works.
CREATE FUNCTION akari_sub_token_enc_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.sub_token_hash IS DISTINCT FROM OLD.sub_token_hash
       AND NEW.sub_token_enc IS NOT DISTINCT FROM OLD.sub_token_enc THEN
        NEW.sub_token_enc := NULL;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER users_sub_token_enc_guard
    BEFORE UPDATE OF sub_token_hash, sub_token_enc ON users
    FOR EACH ROW EXECUTE FUNCTION akari_sub_token_enc_guard();

-- W20 (Minor 6): the first invite code is created for the account
-- automatically, once (signup::invite::list_codes); a user who deletes it
-- does not get it back.
ALTER TABLE users ADD COLUMN invite_autocreated BOOLEAN NOT NULL DEFAULT false;
