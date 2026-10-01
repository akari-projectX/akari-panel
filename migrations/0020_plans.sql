-- M3: operations model — node groups, plans, user plans, entitlement.
--
-- Access model (src/entitle.rs): a user's plan-granted access is every node
-- in the groups of their active plan; node_users rows for those pairs carry
-- one auto-issued credential per eligible inbound (vless/vmess/trojan) and
-- are maintained by `entitle::apply_reconcile` inside the transaction of
-- every change to these tables or to a node's inbounds. Rows created by the
-- admin assignment endpoint are manual overrides (`node_users.manual`) the
-- reconcile never touches.
--
-- Writers of node_groups, node_group_members, plans, plan_groups and
-- user_plans take the entitlement advisory lock (entitle::LOCK_KEY) first,
-- before any row lock; see src/entitle.rs.

-- 1. Why a user is disabled. enabled = (disabled_reason IS NULL), kept by a
--    trigger for every path (API, CLI, enforcement, hand-written SQL):
--    disabling without a reason means 'admin'; enabling clears it. The
--    traffic-limit pass sets 'quota'; only 'quota' is ever re-enabled
--    automatically (period reset, plan quota raised). 'expiry' is reserved:
--    expiry is enforced by predicate (enforce::EXPIRED), not by disabling,
--    so a renewal needs no re-enable.
CREATE TYPE user_disabled_reason AS ENUM ('admin', 'quota', 'expiry');
ALTER TABLE users ADD COLUMN disabled_reason user_disabled_reason;
UPDATE users SET disabled_reason = 'admin' WHERE NOT enabled;

CREATE FUNCTION users_disabled_reason() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.enabled THEN
        NEW.disabled_reason := NULL;
    ELSIF NEW.disabled_reason IS NULL THEN
        NEW.disabled_reason := 'admin';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER users_disabled_reason
    BEFORE INSERT OR UPDATE OF enabled, disabled_reason ON users
    FOR EACH ROW EXECUTE FUNCTION users_disabled_reason();

ALTER TABLE users ADD CONSTRAINT users_disabled_reason_matches
    CHECK (enabled = (disabled_reason IS NULL));

-- 2. Nodes: a free-text region shown to users (portal node list).
ALTER TABLE nodes ADD COLUMN region TEXT;

-- 3. Manual overrides. Every pre-M3 assignment is manual (kept exactly as it
--    is); rows the reconcile creates say manual = false explicitly. The
--    default stays TRUE so any other writer (CLI, hand SQL) creates a pin
--    the reconcile never removes.
ALTER TABLE node_users ADD COLUMN manual BOOLEAN NOT NULL DEFAULT true;

-- 4. Node groups and membership (a node can be in any number of groups).
CREATE TABLE node_groups (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE node_group_members (
    group_id UUID NOT NULL REFERENCES node_groups(id) ON DELETE CASCADE,
    node_id  UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, node_id)
);
CREATE INDEX node_group_members_node ON node_group_members (node_id);

-- 5. Plans. traffic_quota_bytes NULL = unlimited. Period: 'monthly' (on the
--    anchor's day of month, clamped to the month's end, UTC), 'days' (every
--    reset_days days from the anchor) or 'none'. speed_limit_mbps is a hint
--    shown to users and NOT enforced (no agent support yet); device_seats is
--    stored for M5 (seat binding) and NOT enforced. enabled = offered for
--    new assignments; existing subscribers keep their plan when disabled.
CREATE TABLE plans (
    id                  UUID PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    traffic_quota_bytes BIGINT CHECK (traffic_quota_bytes >= 0),
    reset_period        TEXT NOT NULL CHECK (reset_period IN ('monthly', 'days', 'none')),
    reset_days          INTEGER CHECK (reset_days BETWEEN 1 AND 3650),
    speed_limit_mbps    INTEGER CHECK (speed_limit_mbps > 0),
    device_seats        INTEGER CHECK (device_seats >= 0),
    sort                INTEGER NOT NULL DEFAULT 0,
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((reset_period = 'days') = (reset_days IS NOT NULL))
);

CREATE TABLE plan_groups (
    plan_id  UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES node_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (plan_id, group_id)
);
CREATE INDEX plan_groups_group ON plan_groups (group_id);

-- 6. A user's plans (history kept). At most one 'active' per user. users'
--    traffic_limit_bytes / expires_at are the ENFORCED values and are
--    written from the active plan in the same transaction as any plan
--    change. next_reset_at is the restart-safe reset marker: the reset pass
--    handles rows with next_reset_at <= now() (DB clock) and advances it
--    past now() in the same UPDATE, so a pass that is repeated, crashes or
--    runs after downtime resets at most once.
CREATE TYPE user_plan_status AS ENUM ('active', 'replaced', 'cancelled', 'expired');

CREATE TABLE user_plans (
    id            UUID PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id       UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    status        user_plan_status NOT NULL DEFAULT 'active',
    starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ,
    period_anchor TIMESTAMPTZ NOT NULL,
    last_reset_at TIMESTAMPTZ,
    next_reset_at TIMESTAMPTZ,
    ended_at      TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX user_plans_one_active ON user_plans (user_id) WHERE status = 'active';
CREATE INDEX user_plans_user ON user_plans (user_id, created_at);
CREATE INDEX user_plans_plan_active ON user_plans (plan_id) WHERE status = 'active';
CREATE INDEX user_plans_next_reset ON user_plans (next_reset_at)
    WHERE status = 'active' AND next_reset_at IS NOT NULL;
CREATE INDEX user_plans_expiry ON user_plans (expires_at)
    WHERE status = 'active' AND expires_at IS NOT NULL;

-- 7. The first period boundary strictly after `after`, for a period that
--    started at `anchor` (NULL for 'none'). Monthly boundaries are
--    anchor + k months computed in UTC (PostgreSQL clamps the day to the
--    month's end: an anchor on Jan 31 resets on Feb 28/29, Mar 31, ...),
--    never chained, so they do not drift. 'days' boundaries are exact
--    multiples of reset_days * 86400 s (no DST effects).
CREATE FUNCTION akari_next_reset(anchor TIMESTAMPTZ, period TEXT, days INTEGER, after TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    a TIMESTAMP := anchor AT TIME ZONE 'UTC';
    f TIMESTAMP := after AT TIME ZONE 'UTC';
    k BIGINT;
    t TIMESTAMPTZ;
BEGIN
    IF period = 'none' OR anchor IS NULL OR after IS NULL THEN
        RETURN NULL;
    ELSIF period = 'days' THEN
        IF days IS NULL OR days < 1 THEN
            RAISE EXCEPTION 'akari_next_reset: bad days %', days;
        END IF;
        IF after < anchor THEN
            RETURN anchor;
        END IF;
        k := floor(extract(epoch FROM after - anchor) / (days::numeric * 86400))::bigint + 1;
        RETURN anchor + make_interval(secs => k * days::bigint * 86400);
    ELSIF period = 'monthly' THEN
        IF after < anchor THEN
            RETURN anchor;
        END IF;
        k := GREATEST(1, (extract(year FROM f)::bigint - extract(year FROM a)::bigint) * 12
                         + extract(month FROM f)::bigint - extract(month FROM a)::bigint - 1);
        LOOP
            t := (a + make_interval(months => k::int)) AT TIME ZONE 'UTC';
            EXIT WHEN t > after;
            k := k + 1;
        END LOOP;
        RETURN t;
    END IF;
    RAISE EXCEPTION 'akari_next_reset: bad period %', period;
END $$;
