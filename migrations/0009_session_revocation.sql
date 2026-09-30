-- Sprint 4b (S4-2): session revocation and the last-admin guard.
--
-- 1. users.session_ver is embedded in every session JWT (claim `sv`); the
--    AuthUser extractor rejects a token whose sv differs from the row. It is
--    bumped by the trigger below on every password change, disable, role
--    change and expiry enforcement — whatever path writes the row (API, CLI,
--    enforcement passes, manual SQL) — and explicitly by logout and by the
--    admin "revoke sessions" action. `UPDATE OF` keeps the trigger off the
--    hot traffic-billing UPDATE (it only sets traffic_used_bytes).
ALTER TABLE users ADD COLUMN session_ver BIGINT NOT NULL DEFAULT 0;

CREATE FUNCTION users_bump_session_ver() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
       OR NEW.role IS DISTINCT FROM OLD.role
       OR (OLD.enabled AND NOT NEW.enabled)
       OR (NEW.expiry_enforced AND NOT OLD.expiry_enforced) THEN
        NEW.session_ver := OLD.session_ver + 1;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER users_bump_session_ver
    BEFORE UPDATE OF password_hash, role, enabled, expiry_enforced ON users
    FOR EACH ROW EXECUTE FUNCTION users_bump_session_ver();

-- 2. There is always at least one enabled admin. Any statement that turns
--    an enabled admin into something else (disable, demote, delete) checks,
--    under a transaction-scoped advisory lock, that another enabled admin
--    remains. The lock serializes every such check: two admins demoting
--    each other concurrently cannot both succeed (the second waits for the
--    first to commit, then its count — a fresh READ COMMITTED snapshot per
--    statement — sees the first demotion). The API maps SQLSTATE AK001 to
--    409. Nothing on the billing/enforcement paths touches admin rows
--    (admins are never proxy users), so they never take this lock.
CREATE FUNCTION users_keep_last_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('akari.last_enabled_admin', 0));
    IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND enabled) THEN
        RAISE EXCEPTION 'cannot remove the last enabled admin'
            USING ERRCODE = 'AK001';
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER users_keep_last_admin_update
    AFTER UPDATE OF role, enabled ON users
    FOR EACH ROW
    WHEN (OLD.role = 'admin' AND OLD.enabled AND NOT (NEW.role = 'admin' AND NEW.enabled))
    EXECUTE FUNCTION users_keep_last_admin();

CREATE TRIGGER users_keep_last_admin_delete
    AFTER DELETE ON users
    FOR EACH ROW
    WHEN (OLD.role = 'admin' AND OLD.enabled)
    EXECUTE FUNCTION users_keep_last_admin();
