-- W28-c (v0.4 D12 + admin ban; research/db-schema-review.md §3 D12, §4.4,
-- §5; SPRINT W33-a rulings ③④).
--
-- 1. `users.disabled_reason` becomes TEXT + CHECK (admin | quota). The enum
--    value 'expiry' was never written (expiry is enforced by a predicate,
--    `enforce::EXPIRED`), and TEXT + CHECK is the schema's enum style.
-- 2. Admin ban = disabled_reason 'admin' + a reason shown to the user in the
--    portal (`disabled_note`), when (`disabled_at`) and by whom
--    (`disabled_by`; the console shows the admin by joining users, Q4).
--    The trigger keeps the three in step with `enabled` on every write path
--    (API, CLI, hand-written SQL): enabling clears them, a new disable
--    stamps `disabled_at`, a non-admin reason never carries a note/actor.
-- 3. `user_plans.term_kind` / `term_days`: the duration the subscription
--    was assigned, bought or last renewed with (catalog period kinds, without
--    `reset`). D12: admins assign a plan only as plan + term; "extend N days"
--    is refused for one-time purchases (`onetime`), ruling ④.
-- 4. Admin batch actions: `enable`/`disable` become `ban` (with the reason)
--    and `unban`.

-- The trigger names the column (UPDATE OF): drop it for the type change,
-- recreated below with the new function body.
DROP TRIGGER users_disabled_reason ON users;
ALTER TABLE users ALTER COLUMN disabled_reason TYPE text USING disabled_reason::text;
DROP TYPE user_disabled_reason;
ALTER TABLE users ADD CONSTRAINT users_disabled_reason_valid
    CHECK (disabled_reason IN ('admin', 'quota'));

ALTER TABLE users ADD COLUMN disabled_note text;
ALTER TABLE users ADD COLUMN disabled_at timestamp with time zone;
ALTER TABLE users ADD COLUMN disabled_by uuid REFERENCES users (id) ON DELETE SET NULL;
UPDATE users SET disabled_at = now() WHERE NOT enabled;
ALTER TABLE users ADD CONSTRAINT users_disabled_note
    CHECK (disabled_note IS NULL
           OR (disabled_reason = 'admin' AND char_length(disabled_note) BETWEEN 1 AND 500));
ALTER TABLE users ADD CONSTRAINT users_disabled_by_admin
    CHECK (disabled_by IS NULL OR disabled_reason = 'admin');
ALTER TABLE users ADD CONSTRAINT users_disabled_at_matches
    CHECK ((disabled_at IS NULL) = enabled);
CREATE INDEX users_disabled_by ON users USING btree (disabled_by) WHERE (disabled_by IS NOT NULL);

CREATE OR REPLACE FUNCTION users_disabled_reason() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.enabled THEN
        NEW.disabled_reason := NULL;
        NEW.disabled_note := NULL;
        NEW.disabled_at := NULL;
        NEW.disabled_by := NULL;
        RETURN NEW;
    END IF;
    IF NEW.disabled_reason IS NULL THEN
        NEW.disabled_reason := 'admin';
    END IF;
    IF NEW.disabled_reason <> 'admin' THEN
        NEW.disabled_note := NULL;
        NEW.disabled_by := NULL;
    END IF;
    IF TG_OP = 'INSERT' OR OLD.enabled THEN
        NEW.disabled_at := now();
    ELSIF NEW.disabled_at IS NULL THEN
        NEW.disabled_at := OLD.disabled_at;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER users_disabled_reason
    BEFORE INSERT OR UPDATE OF enabled, disabled_reason, disabled_note, disabled_at, disabled_by
    ON users FOR EACH ROW EXECUTE FUNCTION users_disabled_reason();

ALTER TABLE user_plans ADD COLUMN term_kind text NOT NULL;
ALTER TABLE user_plans ADD COLUMN term_days integer;
ALTER TABLE user_plans ADD CONSTRAINT user_plans_term_kind
    CHECK (term_kind IN ('month', 'quarter', 'half_year', 'year', 'two_year', 'three_year',
                         'days', 'onetime'));
ALTER TABLE user_plans ADD CONSTRAINT user_plans_term_days
    CHECK (CASE term_kind
               WHEN 'days' THEN term_days BETWEEN 1 AND 3650
               WHEN 'onetime' THEN term_days IS NULL OR term_days BETWEEN 1 AND 3650
               ELSE term_days IS NULL
           END);

ALTER TABLE admin_batch_jobs DROP CONSTRAINT admin_batch_jobs_action_check;
ALTER TABLE admin_batch_jobs ADD CONSTRAINT admin_batch_jobs_action_valid
    CHECK (action IN ('extend_expiry', 'reset_traffic', 'ban', 'unban', 'set_plan',
                      'cancel_plan', 'add_balance', 'send_email'));
