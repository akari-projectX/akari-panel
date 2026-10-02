-- W16 (M7): inviter attribution for invite commissions.
--
-- W15 (registration, invite codes) owns how users.inviter_id is set; this
-- migration only guarantees the column exists (whichever of the two
-- migrations runs first creates it; ADD COLUMN IF NOT EXISTS keeps the
-- other a no-op) and that it can never express a self-referral or a cycle,
-- whatever writes it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS inviter_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_inviter ON users (inviter_id) WHERE inviter_id IS NOT NULL;

-- No self-referral and no cycle (A invited by B invited by A). Only
-- runs when inviter_id is written (UPDATE OF inviter_id: the billing
-- UPDATEs of traffic counters never fire it). A transaction-level
-- advisory lock serialises concurrent inviter writes, so two writers
-- cannot each close half of a cycle. SQLSTATE AK002 -> HTTP 409.
CREATE FUNCTION akari_users_inviter_acyclic() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    cur UUID := NEW.inviter_id;
    depth INTEGER := 0;
BEGIN
    IF NEW.inviter_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.inviter_id = NEW.id THEN
        RAISE EXCEPTION 'a user cannot be their own inviter' USING ERRCODE = 'AK002';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('akari.inviter'));
    WHILE cur IS NOT NULL AND depth < 100000 LOOP
        SELECT inviter_id INTO cur FROM users WHERE id = cur;
        IF cur = NEW.id THEN
            RAISE EXCEPTION 'inviter chain would form a cycle' USING ERRCODE = 'AK002';
        END IF;
        depth := depth + 1;
    END LOOP;
    RETURN NEW;
END $$;

CREATE TRIGGER users_inviter_acyclic
    BEFORE INSERT OR UPDATE OF inviter_id ON users
    FOR EACH ROW EXECUTE FUNCTION akari_users_inviter_acyclic();
