-- R47 (PR ③): the owner (super admin).
--
-- users.is_owner: exactly one account — the one the installer creates
-- (`akari admin add` makes the first admin the owner) — may promote,
-- demote, ban or delete admins, change the admin prefix and its allowlist,
-- the payment channels' keys, and transfer ownership. It must always be an
-- enabled admin (CHECK users_owner_enabled_admin: demoting, disabling or
-- banning it fails), cannot be deleted (users_keep_owner, AK001) and stops
-- being the owner only by a transfer, which sets the new owner in the same
-- transaction (users_owner_exists, deferred, AK001). At most one owner:
-- users_one_owner.
--
-- This replaces the 0009 "at least one enabled admin" triggers: the owner
-- is that admin.
--
-- The user's report "deleting an account said an admin must be kept
-- although another admin existed": the other admin had been promoted while
-- disabled for traffic (`disabled_reason = 'quota'`; the promotion kept it
-- disabled, and since W28-c nothing re-enables an admin: admins have no
-- plan and unban only lifts admin bans), so it did not count. Promotion now
-- enables such an account and refuses banned ones (api::apply_update_user);
-- existing rows are repaired here.

UPDATE users SET enabled = true
WHERE role = 'admin' AND NOT enabled AND disabled_reason = 'quota';

ALTER TABLE users ADD COLUMN is_owner boolean DEFAULT false NOT NULL;

UPDATE users SET is_owner = true
WHERE id = (SELECT id FROM users WHERE role = 'admin' AND enabled
            ORDER BY created_at, id LIMIT 1);

CREATE UNIQUE INDEX users_one_owner ON users ((true)) WHERE is_owner;

ALTER TABLE users ADD CONSTRAINT users_owner_enabled_admin
    CHECK ((NOT is_owner) OR (role = 'admin' AND enabled));

DROP TRIGGER users_keep_last_admin_update ON users;
DROP TRIGGER users_keep_last_admin_delete ON users;
DROP FUNCTION users_keep_last_admin();

CREATE FUNCTION users_keep_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'the owner cannot be deleted'
        USING ERRCODE = 'AK001';
END $$;

CREATE TRIGGER users_keep_owner BEFORE DELETE ON users
    FOR EACH ROW WHEN (old.is_owner) EXECUTE FUNCTION users_keep_owner();

CREATE FUNCTION users_owner_exists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE is_owner) THEN
        RAISE EXCEPTION 'the owner can only be transferred'
            USING ERRCODE = 'AK001';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER users_owner_exists AFTER UPDATE OF is_owner ON users
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (old.is_owner AND NOT new.is_owner)
    EXECUTE FUNCTION users_owner_exists();
