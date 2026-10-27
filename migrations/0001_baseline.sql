-- Baseline schema of the panel. One file: the schema is created from nothing
-- and every later change is a new numbered file after this one.
--
-- Per-table notes and invariants: migrations/CLAUDE.md. Generated from the
-- pg_dump of the migrated schema, then regrouped by domain.
--
-- No schema qualification and no search_path changes: tests migrate each into
-- its own schema (src/testdb.rs).

-- =========================================================================
-- Types
-- =========================================================================

CREATE TYPE user_plan_status AS ENUM (
    'active',
    'replaced',
    'cancelled',
    'expired'
);

-- =========================================================================
-- Functions (billing arithmetic, reset/period calendar, guard and NOTIFY triggers)
-- =========================================================================

-- SQL functions that read tables are created before those tables exist; the
-- setting lasts for this migration's transaction only.
SET LOCAL check_function_bodies = false;

CREATE FUNCTION akari_balance_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF current_setting('akari.ledger', true) IS DISTINCT FROM 'on' AND (
        (TG_OP = 'INSERT' AND NEW.balance_cents <> 0)
        OR (TG_OP = 'UPDATE' AND (NEW.balance_cents <> OLD.balance_cents
                                  OR NEW.user_id <> OLD.user_id))) THEN
        RAISE EXCEPTION 'balances change only through balance_ledger';
    END IF;
    RETURN NEW;
END $$;

-- The built-in sets exist exactly once and keep their kind on every write
-- path (API, CLI, hand-written SQL): they can be switched, never removed.
CREATE FUNCTION akari_block_rules_keep_builtin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.kind = 'builtin' THEN
            RAISE EXCEPTION 'built-in block rule sets cannot be deleted' USING ERRCODE = 'AK029';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.kind IS DISTINCT FROM NEW.kind OR OLD.builtin_key IS DISTINCT FROM NEW.builtin_key THEN
        RAISE EXCEPTION 'block rule kind cannot change' USING ERRCODE = 'AK029';
    END IF;
    RETURN NEW;
END $$;

-- Any change re-sends the compiled policy to every agent (notify.rs
-- `block-rules` → wake all sessions), in the writing transaction.
CREATE FUNCTION akari_block_rules_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('akari_change', 'block-rules');
    RETURN NULL;
END $$;

CREATE FUNCTION akari_check_timezone() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Full IANA names only: AT TIME ZONE would also take abbreviations and
    -- POSIX strings ("CST", "UTC+8"), whose meaning surprises.
    IF NEW.timezone IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
        RAISE EXCEPTION 'unknown time zone %', NEW.timezone USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION akari_coupon_discount(list_cents bigint, kind text, value bigint) RETURNS bigint
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT CASE
        WHEN list_cents IS NULL OR list_cents <= 0 OR value IS NULL OR value <= 0 THEN 0
        WHEN kind = 'percent' THEN (list_cents * LEAST(value, 100)) / 100
        WHEN kind = 'fixed' THEN LEAST(value, list_cents)
        ELSE 0
    END
$$;

-- Create the monthly partitions from `months_back` months before the
-- current site month to `months_ahead` after it (missing ones only). A
-- month whose rows already sit in the DEFAULT partition is skipped (they
-- stay there; the row-wise rollup handles them). Returns the partitions
-- created.
CREATE FUNCTION akari_ensure_traffic_partitions(months_back integer, months_ahead integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    ns name := (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.oid = 'traffic_daily'::regclass);
    first date := date_trunc('month', akari_site_day(now()))::date;
    m date;
    part text;
    made integer := 0;
BEGIN
    FOR i IN -months_back..months_ahead LOOP
        m := (first + make_interval(months => i))::date;
        part := 'traffic_daily_' || to_char(m, 'YYYYMM');
        IF to_regclass(format('%I.%I', ns, part)) IS NULL THEN
            BEGIN
                EXECUTE format(
                    'CREATE TABLE %I.%I PARTITION OF traffic_daily FOR VALUES FROM (%L) TO (%L) WITH (fillfactor=''80'')',
                    ns, part, m, (m + interval '1 month')::date);
                made := made + 1;
            EXCEPTION WHEN check_violation THEN
                RAISE NOTICE 'traffic_daily: % keeps its rows in the default partition', part;
            END;
        END IF;
    END LOOP;
    RETURN made;
END $$;

-- The time-weighted mean multiplier (permille, fractional) of an entrance
-- over [from_at, to_at]; NULL = no such entrance. The rate is piecewise
-- constant: it can only change at a site-local minute where some rule
-- starts or ends (any weekday: a superset of the real edges, extra pieces
-- are harmless), at local midnight, and at the edges of the recorded
-- change window. The walk goes from edge to edge, so a day costs at most
-- about 2 x rules + 3 rate lookups.
CREATE FUNCTION akari_entrance_mean_rate(entrance uuid, from_at timestamp with time zone, to_at timestamp with time zone) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    base integer;
    prev_rate integer;
    changed timestamp with time zone;
    edges smallint[];
    tz text;
    t timestamp with time zone;
    nxt timestamp with time zone;
    l timestamp;
    m smallint;
    acc numeric := 0;
    steps integer := 0;
    mean numeric;
BEGIN
    SELECT rate_permille, rate_prev_permille, rate_changed_at INTO base, prev_rate, changed
    FROM entrances WHERE id = entrance;
    IF base IS NULL THEN
        RETURN NULL;
    END IF;
    IF to_at <= from_at THEN
        RETURN akari_entrance_rate(entrance, to_at);
    END IF;
    SELECT array_agg(DISTINCT x ORDER BY x) INTO edges FROM (
        SELECT start_minute AS x FROM entrance_rate_rules WHERE entrance_id = entrance
        UNION SELECT end_minute % 1440 FROM entrance_rate_rules WHERE entrance_id = entrance
        UNION SELECT 0) s;
    tz := akari_site_tz();
    t := from_at;
    WHILE t < to_at LOOP
        steps := steps + 1;
        IF steps > 100000 THEN
            -- Unreachable for any interval a flush credits (at most the
            -- lease); never loop forever: the rest at the rate now.
            acc := acc + akari_entrance_rate(entrance, t) * extract(epoch FROM to_at - t);
            EXIT;
        END IF;
        IF array_length(edges, 1) = 1 THEN
            -- No rules: only the change window splits the interval.
            nxt := to_at;
        ELSE
            l := t AT TIME ZONE tz;
            m := (extract(hour FROM l) * 60 + extract(minute FROM l))::smallint;
            -- The first edge after l: a later minute today, else the first
            -- edge tomorrow (local), back to an absolute time.
            nxt := (date_trunc('day', l) + make_interval(mins => coalesce(
                        (SELECT min(e) FROM unnest(edges) e WHERE e > m),
                        edges[1] + 1440))) AT TIME ZONE tz;
            IF nxt <= t THEN
                -- A DST jump can map the local edge before t.
                nxt := t + interval '1 minute';
            END IF;
        END IF;
        IF changed IS NOT NULL THEN
            IF changed - akari_rate_window() > t AND changed - akari_rate_window() < nxt THEN
                nxt := changed - akari_rate_window();
            ELSIF changed > t AND changed < nxt THEN
                nxt := changed;
            END IF;
        END IF;
        nxt := LEAST(nxt, to_at);
        acc := acc + akari_entrance_rate(entrance, t) * extract(epoch FROM nxt - t);
        t := nxt;
    END LOOP;
    mean := acc / extract(epoch FROM to_at - from_at);
    IF changed IS NOT NULL AND changed > from_at THEN
        mean := LEAST(mean, prev_rate);
    END IF;
    RETURN mean;
END $$;

-- The multiplier (permille) of an entrance at `at`; NULL = no such
-- entrance. In the window before a recorded change: the rate recorded
-- for it (the old configuration's lowest over the window).
CREATE FUNCTION akari_entrance_rate(entrance uuid, at timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    base integer;
    prev_rate integer;
    changed timestamp with time zone;
    best integer;
    l timestamp;
    d smallint;
    prev smallint;
    m smallint;
BEGIN
    SELECT rate_permille, rate_prev_permille, rate_changed_at INTO base, prev_rate, changed
    FROM entrances WHERE id = entrance;
    IF base IS NULL THEN
        RETURN NULL;
    END IF;
    IF changed IS NOT NULL AND at < changed AND at >= changed - akari_rate_window() THEN
        RETURN prev_rate;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM entrance_rate_rules WHERE entrance_id = entrance) THEN
        RETURN base;
    END IF;
    l := at AT TIME ZONE akari_site_tz();
    d := extract(isodow FROM l)::smallint;
    prev := (d + 5) % 7 + 1;
    m := (extract(hour FROM l) * 60 + extract(minute FROM l))::smallint;
    SELECT max(r.rate_permille) INTO best FROM entrance_rate_rules r
    WHERE r.entrance_id = entrance AND (
        (r.start_minute < r.end_minute AND d = ANY (r.weekdays)
            AND m >= r.start_minute AND m < r.end_minute)
        OR (r.start_minute > r.end_minute AND (
            (d = ANY (r.weekdays) AND m >= r.start_minute)
            OR (prev = ANY (r.weekdays) AND m < r.end_minute))));
    RETURN coalesce(best, base);
END $$;

-- Record a base change (every write path). In a BEFORE trigger the
-- function still reads the old row. A rate set in the transaction that
-- created the entrance (POST /nodes with `direct.rate`: the built-in
-- direct entrance is inserted at 1x by nodes_direct_entrance, then set) is
-- its creation rate, not a change: no bytes were billed at the old one.
CREATE FUNCTION akari_entrance_rate_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.rate_prev_permille := akari_entrance_settle_rate(OLD.id);
    NEW.rate_changed_at := statement_timestamp();
    RETURN NEW;
END $$;

-- What a flush bills an entrance's bytes at (permille): the lower of the
-- rates now and one window ago. traffic::FLUSH_SQL reads the base rate
-- directly when the entrance has no rules and no change in the window
-- (the same value).
CREATE FUNCTION akari_entrance_settle_rate(entrance uuid) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
    SELECT LEAST(akari_entrance_rate(entrance, statement_timestamp()),
                 akari_entrance_rate(entrance, statement_timestamp() - akari_rate_window()))
$$;

CREATE FUNCTION akari_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
       AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'balance_ledger is append-only';
END $$;

CREATE FUNCTION akari_ledger_apply() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        RAISE EXCEPTION 'balance_ledger: user_id is required';
    END IF;
    INSERT INTO user_balances (user_id) VALUES (NEW.user_id) ON CONFLICT DO NOTHING;
    PERFORM set_config('akari.ledger', 'on', true);
    UPDATE user_balances SET balance_cents = balance_cents + NEW.amount_cents, updated_at = now()
        WHERE user_id = NEW.user_id AND balance_cents + NEW.amount_cents >= 0
        RETURNING balance_cents INTO NEW.balance_after_cents;
    -- (FOUND before the PERFORM below, which resets it.)
    IF NOT FOUND THEN
        RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'AK003';
    END IF;
    PERFORM set_config('akari.ledger', '', true);
    RETURN NEW;
END $$;

CREATE FUNCTION akari_next_reset(anchor timestamp with time zone, period text, days integer, after timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    tz TEXT := akari_site_tz();
    a TIMESTAMP := anchor AT TIME ZONE tz;
    f TIMESTAMP := after AT TIME ZONE tz;
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
            t := (a + make_interval(months => k::int)) AT TIME ZONE tz;
            EXIT WHEN t > after;
            k := k + 1;
        END LOOP;
        RETURN t;
    END IF;
    RAISE EXCEPTION 'akari_next_reset: bad period %', period;
END $$;

-- Bytes the interface moved since the baseline (see the header).
CREATE FUNCTION akari_nic_delta(same_nic boolean, last bigint, cur bigint, last_at timestamp with time zone) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
    SELECT CASE
        WHEN NOT coalesce(same_nic, false) OR last IS NULL OR cur IS NULL OR last_at IS NULL THEN 0
        ELSE LEAST(CASE WHEN cur >= last THEN cur - last ELSE cur END,
                   (GREATEST(extract(epoch FROM now() - last_at), 1) * 12500000000)::bigint)
    END
$$;

-- Every node has exactly one built-in direct entrance from its creation
-- on (whatever inserts the node); it goes away only with the node.
CREATE FUNCTION akari_node_direct_entrance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    n integer;
BEGIN
    UPDATE servers SET entrance_seq = entrance_seq + 1 WHERE id = NEW.server_id RETURNING entrance_seq INTO n;
    INSERT INTO entrances (id, node_id, server_id, kind, name, wire_no)
        VALUES (gen_random_uuid(), NEW.id, NEW.server_id, 'direct', '直连', n);
    RETURN NEW;
END;
$$;

-- A node never moves to another server (its entrances' numbers, ports and
-- traffic keys are the server's).
CREATE FUNCTION akari_node_keep_server() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.server_id IS DISTINCT FROM OLD.server_id THEN
        RAISE EXCEPTION 'a node cannot move to another server' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION akari_notify_node_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('akari_change', 'del:' || OLD.id::text);
        RETURN OLD;
    END IF;
    PERFORM pg_notify('akari_change', NEW.id::text);
    RETURN NEW;
END;
$$;

-- The per-node switch wakes the sessions of the node's server (they are
-- keyed by server id; still no version bump).
CREATE FUNCTION akari_notify_node_server() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('akari_change', NEW.server_id::text);
    RETURN NEW;
END;
$$;

CREATE FUNCTION akari_period_end(base timestamp with time zone, period text, days integer) RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    m INTEGER := CASE period
        WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 WHEN 'half_year' THEN 6
        WHEN 'year' THEN 12 WHEN 'two_year' THEN 24 WHEN 'three_year' THEN 36
        ELSE NULL END;
    tz TEXT;
BEGIN
    IF base IS NULL THEN
        RAISE EXCEPTION 'akari_period_end: NULL base';
    ELSIF m IS NOT NULL THEN
        tz := akari_site_tz();
        RETURN ((base AT TIME ZONE tz) + make_interval(months => m)) AT TIME ZONE tz;
    ELSIF period = 'onetime' AND days IS NULL THEN
        RETURN NULL;
    ELSIF period IN ('days', 'onetime') AND days BETWEEN 1 AND 3650 THEN
        RETURN base + make_interval(secs => days::bigint * 86400);
    END IF;
    RAISE EXCEPTION 'akari_period_end: bad period % (days %)', period, days;
END $$;

CREATE FUNCTION akari_period_nominal_days(period text, days integer) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT CASE period
        WHEN 'month' THEN 30 WHEN 'quarter' THEN 90 WHEN 'half_year' THEN 180
        WHEN 'year' THEN 365 WHEN 'two_year' THEN 730 WHEN 'three_year' THEN 1095
        WHEN 'days' THEN days WHEN 'onetime' THEN days
        ELSE NULL END
$$;

-- The next monthly reset on `day` (00:00 site time, clamped to the month's
-- end) after `after`.
CREATE FUNCTION akari_quota_next_reset(day smallint, after timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    AS $$
    SELECT CASE WHEN day IS NULL THEN NULL
        ELSE akari_next_reset(make_timestamptz(2000, 1, day, 0, 0, 0, akari_site_tz()), 'monthly', NULL, after) END
$$;

-- This period's usage by mode (numeric: rx + tx cannot overflow).
CREATE FUNCTION akari_quota_used(mode text, rx bigint, tx bigint) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT CASE mode WHEN 'up' THEN tx::numeric WHEN 'down' THEN rx::numeric
        ELSE rx::numeric + tx::numeric END
$$;

CREATE FUNCTION akari_rate_window() RETURNS interval
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT interval '30 seconds' $$;

CREATE FUNCTION akari_refuse_revoked_serial() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

-- Move the oldest monthly partition that ends on or before `cutoff` (all
-- its days < cutoff) into traffic_monthly and drop it. The caller holds the
-- history lock; one partition per transaction keeps the parent's
-- ACCESS EXCLUSIVE lock (taken by the DROP, at the end) short. Returns the
-- daily rows moved, NULL when no partition is due.
CREATE FUNCTION akari_rollup_traffic_partition(cutoff date) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    ns name;
    part name;
    upper date;
    n bigint;
BEGIN
    SELECT n2.nspname, c.relname,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([0-9-]+)''\)'))[1]::date
    INTO ns, part, upper
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
    WHERE i.inhparent = 'traffic_daily'::regclass
      AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
    ORDER BY 3
    LIMIT 1;
    IF part IS NULL OR upper > cutoff THEN
        RETURN NULL;
    END IF;
    EXECUTE format(
        'INSERT INTO traffic_monthly AS t (user_id, month, entrance_id, node_id, up_bytes, down_bytes, billed_bytes)
         SELECT user_id, date_trunc(''month'', day)::date, entrance_id, node_id,
                LEAST(sum(up_bytes), 9223372036854775807)::bigint,
                LEAST(sum(down_bytes), 9223372036854775807)::bigint,
                LEAST(sum(billed_bytes), 9223372036854775807)::bigint
         FROM %I.%I GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3
         ON CONFLICT (user_id, month, entrance_id) DO UPDATE
         SET up_bytes = LEAST(t.up_bytes::numeric + EXCLUDED.up_bytes, 9223372036854775807)::bigint,
             down_bytes = LEAST(t.down_bytes::numeric + EXCLUDED.down_bytes, 9223372036854775807)::bigint,
             billed_bytes = LEAST(t.billed_bytes::numeric + EXCLUDED.billed_bytes, 9223372036854775807)::bigint',
        ns, part);
    EXECUTE format('SELECT count(*) FROM %I.%I', ns, part) INTO n;
    EXECUTE format('DROP TABLE %I.%I', ns, part);
    RETURN n;
END $$;

CREATE FUNCTION akari_server_traffic_quota() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    over boolean := NEW.traffic_quota_bytes IS NOT NULL
        AND akari_quota_used(NEW.traffic_quota_mode, NEW.traffic_quota_rx_bytes, NEW.traffic_quota_tx_bytes)
            >= NEW.traffic_quota_bytes;
BEGIN
    IF over AND NEW.traffic_quota_exceeded_at IS NULL THEN
        NEW.traffic_quota_exceeded_at := now();
        NEW.config_version := NEW.config_version + 1;
    ELSIF NOT over AND NEW.traffic_quota_exceeded_at IS NOT NULL THEN
        NEW.traffic_quota_exceeded_at := NULL;
        NEW.config_version := NEW.config_version + 1;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION akari_settings_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('akari_change', 'settings');
    RETURN NULL;
END $$;

-- The calendar day of `ts` in the site time zone.
CREATE FUNCTION akari_site_day(ts timestamp with time zone) RETURNS date
    LANGUAGE sql STABLE
    AS $$
    SELECT (ts AT TIME ZONE akari_site_tz())::date
$$;

-- Seconds east of UTC of the site time zone at `ts` (the API presents
-- some instants with this offset, e.g. a plan's next reset).
CREATE FUNCTION akari_site_offset(ts timestamp with time zone) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
    SELECT extract(epoch FROM (ts AT TIME ZONE akari_site_tz()) - (ts AT TIME ZONE 'UTC'))::integer
$$;

-- The site time zone (one row by primary key; STABLE: one value per statement).
CREATE FUNCTION akari_site_tz() RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT coalesce((SELECT timezone FROM panel_settings WHERE id = 1), 'Asia/Shanghai')
$$;

CREATE FUNCTION akari_split(list_cents bigint, discount bigint, credit bigint, balance bigint, OUT discount_cents bigint, OUT credit_cents bigint, OUT balance_cents bigint, OUT amount_cents bigint) RETURNS record
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    IF list_cents IS NULL OR list_cents <= 0 THEN
        RAISE EXCEPTION 'akari_split: bad list price %', list_cents;
    END IF;
    discount_cents := LEAST(GREATEST(COALESCE(discount, 0), 0), list_cents);
    credit_cents := LEAST(GREATEST(COALESCE(credit, 0), 0), list_cents - discount_cents);
    balance_cents := LEAST(GREATEST(COALESCE(balance, 0), 0),
                           list_cents - discount_cents - credit_cents);
    amount_cents := list_cents - discount_cents - credit_cents - balance_cents;
END $$;

CREATE FUNCTION akari_user_plan_groups() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO user_plan_groups (user_plan_id, group_id)
        SELECT NEW.id, pg.group_id FROM plan_groups pg WHERE pg.plan_id = NEW.plan_id;
    RETURN NULL;
END $$;

-- Snapshot at creation: a new subscription without explicit terms takes the
-- plan's (BEFORE INSERT), and the plan's groups (AFTER INSERT).
CREATE FUNCTION akari_user_plan_terms() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.reset_period IS NULL THEN
        SELECT p.traffic_quota_bytes, p.reset_period, p.reset_days, p.speed_limit_mbps
            INTO NEW.quota_bytes, NEW.reset_period, NEW.reset_days, NEW.speed_limit_mbps
            FROM plans p WHERE p.id = NEW.plan_id;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION akari_users_inviter_acyclic() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

-- akari_withdrawable_part(user) replays the user's ledger in order and
-- keeps the balance in two parts: W (commission money, withdrawable) and
-- N (everything else, spendable only). Their sum is the balance.
--   commission            → W
--   withdrawal_reversal   → W (a withdrawal only ever takes W)
--   admin_adjust > 0      → N
--   refund_to_balance     → back to W up to what that order took from W
--                           (an unpaid order's released hold, the balance
--                           part of a refund), the rest (Alipay part) → N
--   order_payment         → from N first, then W (the user's favour); what
--                           came from W is remembered per order
--   admin_adjust < 0      → from N first, then W
--   withdrawal            → from W, then N (cannot happen: requests are
--                           checked against the withdrawable amount)
--   commission_clawback   → from W first, then N
-- The result is W (never more than the balance). billing::ledger::
-- WITHDRAWABLE_SQL still applies the older cap too (outstanding clawbacks
-- that are owed but not recovered are not in the ledger).
CREATE FUNCTION akari_withdrawable_part(uid uuid) RETURNS bigint
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    w bigint := 0;
    n bigint := 0;
    took jsonb := '{}';
    e record;
    a bigint;
    t bigint;
    k text;
BEGIN
    FOR e IN SELECT kind, amount_cents, order_id FROM balance_ledger
             WHERE user_id = uid ORDER BY id LOOP
        a := abs(e.amount_cents);
        IF e.kind IN ('commission', 'withdrawal_reversal') THEN
            w := w + a;
        ELSIF e.kind = 'admin_adjust' AND e.amount_cents > 0 THEN
            n := n + a;
        ELSIF e.kind = 'refund_to_balance' THEN
            k := e.order_id::text;
            t := LEAST(a, COALESCE((took ->> k)::bigint, 0));
            IF t > 0 THEN
                took := jsonb_set(took, ARRAY[k], to_jsonb((took ->> k)::bigint - t));
            END IF;
            w := w + t;
            n := n + (a - t);
        ELSIF e.kind IN ('order_payment', 'admin_adjust') THEN
            t := GREATEST(a - n, 0);
            n := n - (a - t);
            w := w - t;
            IF e.kind = 'order_payment' AND t > 0 THEN
                k := e.order_id::text;
                took := jsonb_set(took, ARRAY[k],
                                  to_jsonb(COALESCE((took ->> k)::bigint, 0) + t));
            END IF;
        ELSIF e.kind IN ('withdrawal', 'commission_clawback') THEN
            t := LEAST(a, GREATEST(w, 0));
            w := w - t;
            n := n - (a - t);
        END IF;
    END LOOP;
    RETURN GREATEST(LEAST(w, w + n), 0);
END
$$;

CREATE FUNCTION site_domains_preferred() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM site_domains GROUP BY kind HAVING NOT bool_or(preferred)) THEN
        RAISE EXCEPTION 'every domain kind with entries needs a preferred one'
            USING ERRCODE = 'AK030';
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION users_bump_session_ver() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
       OR NEW.role IS DISTINCT FROM OLD.role
       OR (OLD.enabled AND NOT NEW.enabled)
       OR (NEW.expiry_enforced AND NOT OLD.expiry_enforced) THEN
        NEW.session_ver := OLD.session_ver + 1;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION users_disabled_reason() RETURNS trigger
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

CREATE FUNCTION users_keep_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'the owner cannot be deleted'
        USING ERRCODE = 'AK001';
END $$;

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

-- =========================================================================
-- Servers, nodes, entrances, enrollment, certificates
-- =========================================================================

CREATE TABLE servers (
    id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    config_version bigint DEFAULT 1 NOT NULL,
    user_version bigint DEFAULT 0 NOT NULL,
    cert_serial text,
    prev_cert_serial text,
    cert_not_after timestamp with time zone,
    enrolled_at timestamp with time zone,
    server_name text,
    agent_version text,
    core_version text,
    agent_protocol integer,
    agent_os text,
    agent_arch text,
    agent_addr inet,
    agent_capabilities text[],
    agent_session text,
    agent_session_at timestamp with time zone,
    finals_drained_session text,
    finals_drained_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    online_session uuid,
    lease_expires_at timestamp with time zone,
    last_error text,
    last_error_at timestamp with time zone,
    failed_config_version bigint,
    failed_user_version bigint,
    failed_reason text,
    failed_held_config_version bigint,
    failed_held_user_version bigint,
    deleting_at timestamp with time zone,
    delete_acked_at timestamp with time zone,
    traffic_tat timestamp with time zone,
    traffic_max_rate_bytes_per_sec bigint,
    traffic_credit_floor timestamp with time zone,
    traffic_credit_until timestamp with time zone,
    probe_requested_at timestamp with time zone,
    panel_probe_next_at timestamp with time zone,
    tls_domain text,
    entrance_seq integer DEFAULT '-1'::integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    traffic_quota_bytes bigint,
    traffic_quota_mode text DEFAULT 'both'::text NOT NULL,
    traffic_quota_reset_day smallint,
    traffic_quota_next_reset_at timestamp with time zone,
    traffic_quota_rx_bytes bigint DEFAULT 0 NOT NULL,
    traffic_quota_tx_bytes bigint DEFAULT 0 NOT NULL,
    traffic_quota_period_start timestamp with time zone DEFAULT now() NOT NULL,
    traffic_quota_exceeded_at timestamp with time zone,
    nic_name text,
    nic_rx_last bigint,
    nic_tx_last bigint,
    nic_at timestamp with time zone,
    CONSTRAINT servers_entrance_seq CHECK (((entrance_seq >= '-1'::integer) AND (entrance_seq <= 32767))),
    CONSTRAINT servers_name CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64))),
    CONSTRAINT servers_nic CHECK ((((nic_rx_last IS NULL) OR (nic_rx_last >= 0)) AND ((nic_tx_last IS NULL) OR (nic_tx_last >= 0)) AND ((nic_name IS NULL) OR (char_length(nic_name) <= 32)))),
    CONSTRAINT servers_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'online'::text, 'offline'::text]))),
    CONSTRAINT servers_tls_domain CHECK (((tls_domain IS NULL) OR ((length(tls_domain) <= 253) AND (tls_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text) AND (tls_domain !~ '^[0-9.]+$'::text)))),
    CONSTRAINT servers_traffic_max_rate CHECK (((traffic_max_rate_bytes_per_sec IS NULL) OR (traffic_max_rate_bytes_per_sec > 0))),
    CONSTRAINT servers_traffic_quota CHECK (((traffic_quota_bytes IS NULL) OR (traffic_quota_bytes > 0))),
    CONSTRAINT servers_traffic_quota_counters CHECK (((traffic_quota_rx_bytes >= 0) AND (traffic_quota_tx_bytes >= 0))),
    CONSTRAINT servers_traffic_quota_mode CHECK ((traffic_quota_mode = ANY (ARRAY['both'::text, 'up'::text, 'down'::text]))),
    CONSTRAINT servers_traffic_quota_next_reset CHECK (((traffic_quota_next_reset_at IS NULL) = (traffic_quota_reset_day IS NULL))),
    CONSTRAINT servers_traffic_quota_reset_day CHECK (((traffic_quota_reset_day IS NULL) OR ((traffic_quota_reset_day >= 1) AND (traffic_quota_reset_day <= 31))))
)
WITH (fillfactor='70');

ALTER TABLE ONLY servers
    ADD CONSTRAINT servers_cert_serial_key UNIQUE (cert_serial);

ALTER TABLE ONLY servers
    ADD CONSTRAINT servers_name_key UNIQUE (name);

ALTER TABLE ONLY servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY servers
    ADD CONSTRAINT servers_prev_cert_serial_key UNIQUE (prev_cert_serial);

CREATE INDEX servers_traffic_quota_reset ON servers USING btree (traffic_quota_next_reset_at) WHERE (traffic_quota_next_reset_at IS NOT NULL);

-- Version changes and deletions wake the server's agent sessions (notify.rs).
CREATE TRIGGER servers_notify_delete AFTER DELETE ON servers
    FOR EACH ROW
    EXECUTE FUNCTION akari_notify_node_change();

CREATE TRIGGER servers_notify_versions AFTER UPDATE ON servers
    FOR EACH ROW
    WHEN (((old.config_version IS DISTINCT FROM new.config_version) OR (old.user_version IS DISTINCT FROM new.user_version)))
    EXECUTE FUNCTION akari_notify_node_change();

CREATE TRIGGER servers_refuse_revoked_serial BEFORE INSERT OR UPDATE OF cert_serial, prev_cert_serial ON servers
    FOR EACH ROW
    EXECUTE FUNCTION akari_refuse_revoked_serial();

CREATE TRIGGER servers_traffic_quota BEFORE UPDATE OF traffic_quota_bytes, traffic_quota_mode, traffic_quota_rx_bytes, traffic_quota_tx_bytes, traffic_quota_exceeded_at ON servers
    FOR EACH ROW
    EXECUTE FUNCTION akari_server_traffic_quota();

CREATE TABLE nodes (
    id uuid NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    region text,
    display_name text,
    sort integer DEFAULT 0 NOT NULL,
    visible boolean DEFAULT true NOT NULL,
    traffic_raw_bytes bigint DEFAULT 0 NOT NULL,
    traffic_billed_bytes bigint DEFAULT 0 NOT NULL,
    inbound jsonb,
    server_id uuid NOT NULL,
    block_rules_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT nodes_display_name_check CHECK (((display_name IS NULL) OR ((char_length(display_name) >= 1) AND (char_length(display_name) <= 64)))),
    CONSTRAINT nodes_inbound_object CHECK (((inbound IS NULL) OR (jsonb_typeof(inbound) = 'object'::text))),
    CONSTRAINT nodes_sort_check CHECK (((sort >= '-1000000'::integer) AND (sort <= 1000000))),
    CONSTRAINT nodes_traffic_billed_bytes_check CHECK ((traffic_billed_bytes >= 0)),
    CONSTRAINT nodes_traffic_raw_bytes_check CHECK ((traffic_raw_bytes >= 0))
);

-- Target of entrances' (node_id, server_id) key.
ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_id_server_key UNIQUE (id, server_id);

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_name_key UNIQUE (name);

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);

CREATE INDEX nodes_server ON nodes USING btree (server_id);

CREATE TRIGGER nodes_direct_entrance AFTER INSERT ON nodes
    FOR EACH ROW
    EXECUTE FUNCTION akari_node_direct_entrance();

CREATE TRIGGER nodes_keep_server BEFORE UPDATE OF server_id ON nodes
    FOR EACH ROW
    EXECUTE FUNCTION akari_node_keep_server();

CREATE TRIGGER nodes_notify_block_rules AFTER UPDATE OF block_rules_enabled ON nodes
    FOR EACH ROW
    WHEN ((old.block_rules_enabled IS DISTINCT FROM new.block_rules_enabled))
    EXECUTE FUNCTION akari_notify_node_server();

CREATE TABLE node_groups (
    id uuid NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY node_groups
    ADD CONSTRAINT node_groups_name_key UNIQUE (name);

ALTER TABLE ONLY node_groups
    ADD CONSTRAINT node_groups_pkey PRIMARY KEY (id);

CREATE TABLE entrances (
    id uuid NOT NULL,
    node_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    connect_host text,
    connect_port integer,
    rate_permille integer DEFAULT 1000 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    wire_no integer DEFAULT 0 NOT NULL,
    listen_port integer,
    source_cidrs cidr[] DEFAULT '{}'::cidr[] NOT NULL,
    health_next_at timestamp with time zone,
    health_at timestamp with time zone,
    health_ok boolean,
    health_failures integer DEFAULT 0 NOT NULL,
    health_error text,
    hidden_since timestamp with time zone,
    -- The agent runs every entrance of the server side by side: inbound tags
    -- (e<wire_no>), traffic keys (<user>#<wire_no>) and listening ports must be
    -- unique per server. server_id is the node's (composite key, the node
    -- never moves).
    server_id uuid NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    rate_prev_permille integer,
    rate_changed_at timestamp with time zone,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT entrances_connect_host CHECK (((connect_host IS NULL) OR ((char_length(connect_host) >= 1) AND (char_length(connect_host) <= 253)))),
    CONSTRAINT entrances_connect_port CHECK (((connect_port IS NULL) OR ((connect_port >= 1) AND (connect_port <= 65535)))),
    CONSTRAINT entrances_health_error CHECK (((health_error IS NULL) OR (char_length(health_error) <= 200))),
    CONSTRAINT entrances_health_failures CHECK ((health_failures >= 0)),
    CONSTRAINT entrances_health_relay CHECK (((kind = 'relay'::text) OR ((health_at IS NULL) AND (hidden_since IS NULL)))),
    CONSTRAINT entrances_kind CHECK ((kind = ANY (ARRAY['direct'::text, 'relay'::text]))),
    CONSTRAINT entrances_listen_port CHECK ((((kind = 'direct'::text) AND (listen_port IS NULL)) OR ((kind = 'relay'::text) AND ((listen_port >= 1) AND (listen_port <= 65535))))),
    CONSTRAINT entrances_name CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64))),
    CONSTRAINT entrances_rate CHECK (((rate_permille >= 0) AND (rate_permille <= 100000))),
    CONSTRAINT entrances_rate_prev CHECK ((((rate_prev_permille IS NULL) = (rate_changed_at IS NULL)) AND ((rate_prev_permille >= 0) AND (rate_prev_permille <= 100000)))),
    CONSTRAINT entrances_relay_address CHECK (((kind = 'direct'::text) OR ((connect_host IS NOT NULL) AND (connect_port IS NOT NULL)))),
    CONSTRAINT entrances_sort CHECK (((sort >= '-1000000'::integer) AND (sort <= 1000000))),
    CONSTRAINT entrances_source_cidrs CHECK ((((kind = 'direct'::text) AND (cardinality(source_cidrs) = 0)) OR ((kind = 'relay'::text) AND ((cardinality(source_cidrs) >= 1) AND (cardinality(source_cidrs) <= 64)) AND (array_position(source_cidrs, NULL::cidr) IS NULL)))),
    CONSTRAINT entrances_tags CHECK (((cardinality(tags) <= 8) AND (array_position(tags, NULL::text) IS NULL))),
    CONSTRAINT entrances_version CHECK ((version >= 1)),
    CONSTRAINT entrances_wire_no CHECK ((((kind = 'direct'::text) AND ((wire_no >= 0) AND (wire_no <= 32767))) OR ((kind = 'relay'::text) AND ((wire_no >= 1) AND (wire_no <= 32767)))))
);

ALTER TABLE ONLY entrances
    ADD CONSTRAINT entrances_listen_port_key UNIQUE (server_id, listen_port);

ALTER TABLE ONLY entrances
    ADD CONSTRAINT entrances_name_key UNIQUE (node_id, name);

ALTER TABLE ONLY entrances
    ADD CONSTRAINT entrances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY entrances
    ADD CONSTRAINT entrances_wire_no_key UNIQUE (server_id, wire_no);

CREATE INDEX entrances_health_due ON entrances USING btree (health_next_at) WHERE (kind = 'relay'::text);

CREATE INDEX entrances_node ON entrances USING btree (node_id);

CREATE UNIQUE INDEX entrances_one_direct ON entrances USING btree (node_id) WHERE (kind = 'direct'::text);

CREATE TRIGGER entrances_rate_changed BEFORE UPDATE OF rate_permille ON entrances
    FOR EACH ROW
    WHEN (((old.rate_permille IS DISTINCT FROM new.rate_permille) AND (old.created_at <> now())))
    EXECUTE FUNCTION akari_entrance_rate_changed();

CREATE TABLE entrance_group_members (
    group_id uuid NOT NULL,
    entrance_id uuid NOT NULL
);

ALTER TABLE ONLY entrance_group_members
    ADD CONSTRAINT entrance_group_members_pkey PRIMARY KEY (group_id, entrance_id);

CREATE INDEX entrance_group_members_entrance ON entrance_group_members USING btree (entrance_id);

-- `akari_entrance_rate(entrance, at)` is the one definition: traffic::
-- FLUSH_SQL settles with LEAST(rate now, rate 30 s ago) (bytes reported
-- just after a cheaper window ends are still billed at the cheaper rate:
-- only ever under-bills; windows are whole minutes, so 30 s cross at most
-- one boundary), subscriptions, the portal and the admin views show the
-- rate now.
CREATE TABLE entrance_rate_rules (
    id bigint NOT NULL,
    entrance_id uuid NOT NULL,
    ord smallint NOT NULL,
    weekdays smallint[] NOT NULL,
    start_minute smallint NOT NULL,
    end_minute smallint NOT NULL,
    rate_permille integer NOT NULL,
    CONSTRAINT entrance_rate_rules_ord_range CHECK (((ord >= 0) AND (ord <= 23))),
    CONSTRAINT entrance_rate_rules_rate CHECK (((rate_permille >= 0) AND (rate_permille <= 100000))),
    CONSTRAINT entrance_rate_rules_weekdays CHECK ((((cardinality(weekdays) >= 1) AND (cardinality(weekdays) <= 7)) AND (weekdays <@ ARRAY[(1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint, (7)::smallint]) AND (array_position(weekdays, NULL::smallint) IS NULL))),
    CONSTRAINT entrance_rate_rules_window CHECK ((((start_minute >= 0) AND (start_minute <= 1439)) AND ((end_minute >= 1) AND (end_minute <= 1440)) AND (start_minute <> end_minute)))
);

ALTER TABLE entrance_rate_rules ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME entrance_rate_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY entrance_rate_rules
    ADD CONSTRAINT entrance_rate_rules_ord UNIQUE (entrance_id, ord);

ALTER TABLE ONLY entrance_rate_rules
    ADD CONSTRAINT entrance_rate_rules_pkey PRIMARY KEY (id);

CREATE TABLE server_enrollments (
    server_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    install_origin text,
    install_pin text,
    panel_addr text NOT NULL,
    server_name text NOT NULL,
    CONSTRAINT server_enrollments_pin_needs_origin CHECK (((install_pin IS NULL) OR (install_origin IS NOT NULL)))
);

ALTER TABLE ONLY server_enrollments
    ADD CONSTRAINT server_enrollments_pkey PRIMARY KEY (server_id);

ALTER TABLE ONLY server_enrollments
    ADD CONSTRAINT server_enrollments_token_hash_key UNIQUE (token_hash);

CREATE TABLE revoked_certs (
    cert_serial text NOT NULL,
    server_id uuid NOT NULL,
    revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text DEFAULT 'deleted'::text NOT NULL,
    CONSTRAINT revoked_certs_reason_check CHECK ((reason = ANY (ARRAY['deleted'::text, 'rotated'::text])))
);

ALTER TABLE ONLY revoked_certs
    ADD CONSTRAINT revoked_certs_pkey PRIMARY KEY (cert_serial);

CREATE TABLE grpc_server_names (
    name text NOT NULL,
    source text NOT NULL,
    first_used_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grpc_server_names_source_check CHECK ((source = ANY (ARRAY['settings'::text, 'enrollment'::text])))
);

ALTER TABLE ONLY grpc_server_names
    ADD CONSTRAINT grpc_server_names_pkey PRIMARY KEY (name);

CREATE TRIGGER grpc_server_names_notify AFTER INSERT OR DELETE OR UPDATE ON grpc_server_names
    FOR EACH ROW
    EXECUTE FUNCTION akari_settings_notify();

-- =========================================================================
-- Users and authentication
-- =========================================================================

CREATE TABLE users (
    id uuid NOT NULL,
    password_hash text,
    role text DEFAULT 'user'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    traffic_limit_bytes bigint,
    traffic_used_bytes bigint DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sub_token_hash text,
    expiry_enforced boolean DEFAULT false NOT NULL,
    session_ver bigint DEFAULT 0 NOT NULL,
    disabled_reason text,
    inviter_id uuid,
    email text NOT NULL,
    email_verified_at timestamp with time zone,
    locale text DEFAULT 'zh'::text NOT NULL,
    sub_token_enc bytea,
    password_login_disabled_at timestamp with time zone,
    is_owner boolean DEFAULT false NOT NULL,
    erased_at timestamp with time zone,
    last_login_at timestamp with time zone,
    cleanup_warned_at timestamp with time zone,
    disabled_note text,
    disabled_at timestamp with time zone,
    disabled_by uuid,
    signup_method text DEFAULT 'password'::text NOT NULL,
    email_pending boolean DEFAULT false NOT NULL,
    CONSTRAINT users_disabled_at_matches CHECK (((disabled_at IS NULL) = enabled)),
    CONSTRAINT users_disabled_by_admin CHECK (((disabled_by IS NULL) OR (disabled_reason = 'admin'::text))),
    CONSTRAINT users_disabled_note CHECK (((disabled_note IS NULL) OR ((disabled_reason = 'admin'::text) AND ((char_length(disabled_note) >= 1) AND (char_length(disabled_note) <= 500))))),
    CONSTRAINT users_disabled_reason_matches CHECK ((enabled = (disabled_reason IS NULL))),
    CONSTRAINT users_disabled_reason_valid CHECK ((disabled_reason = ANY (ARRAY['admin'::text, 'quota'::text]))),
    CONSTRAINT users_email_check CHECK (((email = lower(email)) AND ((length(email) >= 3) AND (length(email) <= 254)))),
    CONSTRAINT users_email_pending CHECK (((NOT email_pending) OR ((role = 'user'::text) AND (signup_method = 'passkey'::text) AND (email_verified_at IS NULL) AND (email = (('pending-'::text || (id)::text) || '@pending.invalid'::text))))),
    CONSTRAINT users_erased CHECK (((erased_at IS NULL) OR (NOT enabled))),
    CONSTRAINT users_locale_check CHECK ((locale = ANY (ARRAY['zh'::text, 'en'::text]))),
    CONSTRAINT users_owner_enabled_admin CHECK (((NOT is_owner) OR ((role = 'admin'::text) AND enabled))),
    CONSTRAINT users_role_valid CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text]))),
    CONSTRAINT users_signup_method CHECK ((signup_method = ANY (ARRAY['password'::text, 'passkey'::text]))),
    CONSTRAINT users_sub_token_pair CHECK (((sub_token_hash IS NULL) = (sub_token_enc IS NULL))),
    CONSTRAINT users_traffic_limit_nonneg CHECK (((traffic_limit_bytes IS NULL) OR (traffic_limit_bytes >= 0))),
    CONSTRAINT users_traffic_used_nonneg CHECK ((traffic_used_bytes >= 0)),
    CONSTRAINT users_verified_email CHECK (((email_verified_at IS NULL) OR (email IS NOT NULL)))
)
WITH (fillfactor='85');

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_sub_token_hash_key UNIQUE (sub_token_hash);

CREATE INDEX users_cleanup_warned ON users USING btree (cleanup_warned_at) WHERE (cleanup_warned_at IS NOT NULL);

CREATE INDEX users_created_at ON users USING btree (created_at, id);

CREATE INDEX users_disabled_by ON users USING btree (disabled_by) WHERE (disabled_by IS NOT NULL);

CREATE INDEX users_email_pending_created ON users USING btree (created_at) WHERE email_pending;

-- Prefix search of the admin user list (`lower(email) LIKE 'x%'`; emails
-- are stored lower-case, CHECK users_email_check).
CREATE INDEX users_email_prefix ON users USING btree (email text_pattern_ops);

-- The index holds only the unenforced expiries. None of its columns is
-- written by the traffic flush, so billing UPDATEs of traffic_used_bytes
-- stay HOT. The over-limit pass (traffic_used_bytes > traffic_limit_bytes)
-- gets NO index on purpose: a predicate on traffic_used_bytes would turn
-- every flush update into a non-HOT update (measured: 70% HOT without it,
-- 0% with a partial index on the predicate).
CREATE INDEX users_expiry_due ON users USING btree (expires_at) WHERE ((role = 'user'::text) AND (expires_at IS NOT NULL) AND (NOT expiry_enforced));

CREATE INDEX users_inviter ON users USING btree (inviter_id) WHERE (inviter_id IS NOT NULL);

CREATE UNIQUE INDEX users_one_owner ON users USING btree ((true)) WHERE is_owner;

CREATE TRIGGER users_bump_session_ver BEFORE UPDATE OF password_hash, role, enabled, expiry_enforced ON users
    FOR EACH ROW
    EXECUTE FUNCTION users_bump_session_ver();

CREATE TRIGGER users_disabled_reason BEFORE INSERT OR UPDATE OF enabled, disabled_reason, disabled_note, disabled_at, disabled_by ON users
    FOR EACH ROW
    EXECUTE FUNCTION users_disabled_reason();

CREATE TRIGGER users_inviter_acyclic BEFORE INSERT OR UPDATE OF inviter_id ON users
    FOR EACH ROW
    EXECUTE FUNCTION akari_users_inviter_acyclic();

CREATE TRIGGER users_keep_owner BEFORE DELETE ON users
    FOR EACH ROW
    WHEN (old.is_owner)
    EXECUTE FUNCTION users_keep_owner();

CREATE CONSTRAINT TRIGGER users_owner_exists AFTER UPDATE OF is_owner ON users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.is_owner AND (NOT new.is_owner))) EXECUTE FUNCTION users_owner_exists();

CREATE TABLE password_resets (
    token_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT password_resets_token_hash_check CHECK ((length(token_hash) = 32))
);

ALTER TABLE ONLY password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (token_hash);

CREATE INDEX password_resets_expires ON password_resets USING btree (expires_at);

CREATE INDEX password_resets_user ON password_resets USING btree (user_id);

CREATE TABLE email_codes (
    purpose text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    user_id uuid,
    code_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT email_codes_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT email_codes_purpose_check CHECK ((purpose = ANY (ARRAY['register'::text, 'change_email'::text, 'login_fallback'::text]))),
    CONSTRAINT email_codes_user_iff_account_code CHECK (((purpose = ANY (ARRAY['change_email'::text, 'login_fallback'::text])) = (user_id IS NOT NULL)))
);

ALTER TABLE ONLY email_codes
    ADD CONSTRAINT email_codes_pkey PRIMARY KEY (purpose, subject);

CREATE INDEX email_codes_expires ON email_codes USING btree (expires_at);

-- auth_settings: passkey-only per role (same "while a current passkey
-- exists" rule) and the prompt to bind a passkey after a password login.
CREATE TABLE webauthn_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    rp_id text NOT NULL,
    cred_id bytea NOT NULL,
    passkey jsonb NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT webauthn_credentials_cred_id CHECK (((octet_length(cred_id) >= 16) AND (octet_length(cred_id) <= 1023))),
    CONSTRAINT webauthn_credentials_name CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64))),
    CONSTRAINT webauthn_credentials_rp_id CHECK (((char_length(rp_id) >= 1) AND (char_length(rp_id) <= 253)))
);

ALTER TABLE ONLY webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_key UNIQUE (rp_id, cred_id);

ALTER TABLE ONLY webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_pkey PRIMARY KEY (id);

CREATE INDEX webauthn_credentials_user ON webauthn_credentials USING btree (user_id);

CREATE TABLE invite_codes (
    code text NOT NULL,
    user_id uuid NOT NULL,
    uses integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invite_codes_code_check CHECK ((code ~ '^[a-z2-9]{8,32}$'::text)),
    CONSTRAINT invite_codes_uses_check CHECK ((uses >= 0))
);

ALTER TABLE ONLY invite_codes
    ADD CONSTRAINT invite_codes_pkey PRIMARY KEY (code);

CREATE UNIQUE INDEX invite_codes_user ON invite_codes USING btree (user_id);

-- =========================================================================
-- Access (who may use which entrance) and live traffic
-- =========================================================================

CREATE TABLE entrance_users (
    entrance_id uuid NOT NULL,
    user_id uuid NOT NULL,
    protocol text NOT NULL,
    account jsonb NOT NULL,
    CONSTRAINT entrance_users_account_object CHECK ((jsonb_typeof(account) = 'object'::text)),
    CONSTRAINT entrance_users_account_size CHECK ((pg_column_size(account) <= 1024))
)
WITH (autovacuum_vacuum_scale_factor='0.01', autovacuum_vacuum_insert_scale_factor='0.01');

ALTER TABLE ONLY entrance_users
    ADD CONSTRAINT entrance_users_pkey PRIMARY KEY (entrance_id, user_id) INCLUDE (protocol, account);

CREATE INDEX entrance_users_user ON entrance_users USING btree (user_id);

-- The user still exists but lost this entrance: its final counters
-- (reported after the removal) stay billable for the departed grace.
CREATE TABLE entrance_users_departed (
    entrance_id uuid NOT NULL,
    user_id uuid NOT NULL,
    departed_at timestamp with time zone DEFAULT now() NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT entrance_users_departed_billed_nonneg CHECK ((billed_bytes >= 0))
);

ALTER TABLE ONLY entrance_users_departed
    ADD CONSTRAINT entrance_users_departed_pkey PRIMARY KEY (entrance_id, user_id);

CREATE INDEX entrance_users_departed_at ON entrance_users_departed USING btree (departed_at);

CREATE INDEX entrance_users_departed_user ON entrance_users_departed USING btree (user_id);

CREATE TABLE traffic_counters (
    server_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id text NOT NULL,
    up_bytes bigint NOT NULL,
    down_bytes bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    first_seen_at timestamp with time zone,
    entrance_id uuid NOT NULL,
    CONSTRAINT traffic_counters_nonneg CHECK (((up_bytes >= 0) AND (down_bytes >= 0)))
)
WITH (fillfactor='80');

ALTER TABLE ONLY traffic_counters
    ADD CONSTRAINT traffic_counters_pkey PRIMARY KEY (server_id, entrance_id, user_id, session_id);

CREATE TABLE traffic_sessions (
    server_id uuid NOT NULL,
    session_id text NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    retired_at timestamp with time zone,
    purged_at timestamp with time zone
);

ALTER TABLE ONLY traffic_sessions
    ADD CONSTRAINT traffic_sessions_pkey PRIMARY KEY (server_id, session_id);

-- =========================================================================
-- Traffic history
-- =========================================================================

CREATE TABLE traffic_daily (
    user_id uuid NOT NULL,
    day date NOT NULL,
    node_id uuid NOT NULL,
    up_bytes bigint DEFAULT 0 NOT NULL,
    down_bytes bigint DEFAULT 0 NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    entrance_id uuid NOT NULL,
    CONSTRAINT traffic_daily_billed_bytes_check CHECK ((billed_bytes >= 0)),
    CONSTRAINT traffic_daily_down_bytes_check CHECK ((down_bytes >= 0)),
    CONSTRAINT traffic_daily_up_bytes_check CHECK ((up_bytes >= 0))
)
PARTITION BY RANGE (day);

ALTER TABLE ONLY traffic_daily
    ADD CONSTRAINT traffic_daily_pkey PRIMARY KEY (user_id, day, entrance_id);

CREATE INDEX traffic_daily_node_cov ON ONLY traffic_daily USING btree (node_id, day) INCLUDE (user_id, up_bytes, down_bytes, billed_bytes);

-- Month partitions traffic_daily_YYYYMM are created by the reaper
-- (akari_ensure_traffic_partitions); rows outside every month land in the
-- DEFAULT partition and are rolled up from there.
CREATE TABLE traffic_daily_default PARTITION OF traffic_daily DEFAULT
WITH (fillfactor = 80);

CREATE TABLE traffic_daily_pending (
    day date NOT NULL,
    user_id uuid NOT NULL,
    node_id uuid NOT NULL,
    up_bytes bigint NOT NULL,
    down_bytes bigint NOT NULL,
    billed_bytes bigint NOT NULL,
    entrance_id uuid NOT NULL,
    CONSTRAINT traffic_daily_pending_billed_bytes_check CHECK ((billed_bytes >= 0)),
    CONSTRAINT traffic_daily_pending_down_bytes_check CHECK ((down_bytes >= 0)),
    CONSTRAINT traffic_daily_pending_up_bytes_check CHECK ((up_bytes >= 0))
)
WITH (autovacuum_vacuum_scale_factor='0', autovacuum_vacuum_threshold='20000');

-- Per entrance and day (node = the entrance's node then, kept so a node's
-- total is a sum over its rows even after the entrance is gone). No
-- foreign keys, like the rest of the history.
CREATE TABLE traffic_entrance_daily (
    entrance_id uuid NOT NULL,
    day date NOT NULL,
    node_id uuid NOT NULL,
    up_bytes bigint DEFAULT 0 NOT NULL,
    down_bytes bigint DEFAULT 0 NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    users integer DEFAULT 0 NOT NULL,
    CONSTRAINT traffic_entrance_daily_billed_bytes_check CHECK ((billed_bytes >= 0)),
    CONSTRAINT traffic_entrance_daily_down_bytes_check CHECK ((down_bytes >= 0)),
    CONSTRAINT traffic_entrance_daily_up_bytes_check CHECK ((up_bytes >= 0)),
    CONSTRAINT traffic_entrance_daily_users_check CHECK ((users >= 0))
)
WITH (fillfactor='70');

ALTER TABLE ONLY traffic_entrance_daily
    ADD CONSTRAINT traffic_entrance_daily_pkey PRIMARY KEY (entrance_id, day);

CREATE INDEX traffic_entrance_daily_day ON traffic_entrance_daily USING btree (day);

CREATE INDEX traffic_entrance_daily_node ON traffic_entrance_daily USING btree (node_id, day);

CREATE TABLE traffic_monthly (
    user_id uuid NOT NULL,
    month date NOT NULL,
    node_id uuid NOT NULL,
    up_bytes bigint DEFAULT 0 NOT NULL,
    down_bytes bigint DEFAULT 0 NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    entrance_id uuid NOT NULL,
    CONSTRAINT traffic_monthly_billed_bytes_check CHECK ((billed_bytes >= 0)),
    CONSTRAINT traffic_monthly_down_bytes_check CHECK ((down_bytes >= 0)),
    CONSTRAINT traffic_monthly_month_check CHECK ((EXTRACT(day FROM month) = (1)::numeric)),
    CONSTRAINT traffic_monthly_up_bytes_check CHECK ((up_bytes >= 0))
);

ALTER TABLE ONLY traffic_monthly
    ADD CONSTRAINT traffic_monthly_pkey PRIMARY KEY (user_id, month, entrance_id);

CREATE INDEX traffic_monthly_node ON traffic_monthly USING btree (node_id, month);

-- =========================================================================
-- Plans and subscriptions
-- =========================================================================

CREATE TABLE plans (
    id uuid NOT NULL,
    name text NOT NULL,
    traffic_quota_bytes bigint,
    reset_period text NOT NULL,
    reset_days integer,
    speed_limit_mbps integer,
    device_seats integer,
    sort integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    on_sale boolean DEFAULT false NOT NULL,
    capacity integer,
    renewal_only boolean DEFAULT false NOT NULL,
    allow_switch_in boolean DEFAULT true NOT NULL,
    renew_off_sale boolean DEFAULT true NOT NULL,
    recommended boolean DEFAULT false NOT NULL,
    CONSTRAINT plans_capacity_check CHECK ((capacity >= 0)),
    CONSTRAINT plans_description_check CHECK ((char_length(description) <= 4000)),
    CONSTRAINT plans_device_seats_check CHECK ((device_seats >= 0)),
    CONSTRAINT plans_reset_days_check CHECK (((reset_days >= 1) AND (reset_days <= 3650))),
    CONSTRAINT plans_reset_days_iff_days CHECK (((reset_period = 'days'::text) = (reset_days IS NOT NULL))),
    CONSTRAINT plans_reset_period_check CHECK ((reset_period = ANY (ARRAY['monthly'::text, 'days'::text, 'none'::text]))),
    CONSTRAINT plans_speed_limit_mbps_check CHECK ((speed_limit_mbps > 0)),
    CONSTRAINT plans_traffic_quota_bytes_check CHECK ((traffic_quota_bytes >= 0))
);

ALTER TABLE ONLY plans
    ADD CONSTRAINT plans_name_key UNIQUE (name);

ALTER TABLE ONLY plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);

CREATE TABLE plan_groups (
    plan_id uuid NOT NULL,
    group_id uuid NOT NULL
);

ALTER TABLE ONLY plan_groups
    ADD CONSTRAINT plan_groups_pkey PRIMARY KEY (plan_id, group_id);

CREATE INDEX plan_groups_group ON plan_groups USING btree (group_id);

CREATE TABLE plan_period_prices (
    plan_id uuid NOT NULL,
    period text NOT NULL,
    days integer,
    price_cents bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plan_period_prices_days_allowed CHECK (((period = ANY (ARRAY['days'::text, 'onetime'::text])) OR (days IS NULL))),
    CONSTRAINT plan_period_prices_days_check CHECK (((days >= 1) AND (days <= 3650))),
    CONSTRAINT plan_period_prices_days_required CHECK (((period <> 'days'::text) OR (days IS NOT NULL))),
    CONSTRAINT plan_period_prices_period_check CHECK ((period = ANY (ARRAY['month'::text, 'quarter'::text, 'half_year'::text, 'year'::text, 'two_year'::text, 'three_year'::text, 'days'::text, 'onetime'::text, 'reset'::text]))),
    CONSTRAINT plan_period_prices_price_cents_check CHECK (((price_cents >= 1) AND (price_cents <= 100000000)))
);

ALTER TABLE ONLY plan_period_prices
    ADD CONSTRAINT plan_period_prices_pkey PRIMARY KEY (plan_id, period);

CREATE TABLE user_plans (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status user_plan_status DEFAULT 'active'::user_plan_status NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    period_anchor timestamp with time zone NOT NULL,
    last_reset_at timestamp with time zone,
    next_reset_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    term_kind text NOT NULL,
    term_days integer,
    quota_bytes bigint,
    reset_period text NOT NULL,
    reset_days integer,
    speed_limit_mbps integer,
    CONSTRAINT user_plans_active_iff_open CHECK (((status = 'active'::user_plan_status) = (ended_at IS NULL))),
    CONSTRAINT user_plans_quota_bytes CHECK ((quota_bytes >= 0)),
    CONSTRAINT user_plans_reset_days CHECK ((((reset_period = 'days'::text) = (reset_days IS NOT NULL)) AND ((reset_days >= 1) AND (reset_days <= 3650)))),
    CONSTRAINT user_plans_reset_period CHECK ((reset_period = ANY (ARRAY['monthly'::text, 'days'::text, 'none'::text]))),
    CONSTRAINT user_plans_speed_limit_mbps CHECK ((speed_limit_mbps > 0)),
    CONSTRAINT user_plans_term_days CHECK (
CASE term_kind
    WHEN 'days'::text THEN ((term_days >= 1) AND (term_days <= 3650))
    WHEN 'onetime'::text THEN ((term_days IS NULL) OR ((term_days >= 1) AND (term_days <= 3650)))
    ELSE (term_days IS NULL)
END),
    CONSTRAINT user_plans_term_kind CHECK ((term_kind = ANY (ARRAY['month'::text, 'quarter'::text, 'half_year'::text, 'year'::text, 'two_year'::text, 'three_year'::text, 'days'::text, 'onetime'::text])))
);

ALTER TABLE ONLY user_plans
    ADD CONSTRAINT user_plans_pkey PRIMARY KEY (id);

CREATE INDEX user_plans_expiry ON user_plans USING btree (expires_at) WHERE ((status = 'active'::user_plan_status) AND (expires_at IS NOT NULL));

CREATE INDEX user_plans_next_reset ON user_plans USING btree (next_reset_at) WHERE ((status = 'active'::user_plan_status) AND (next_reset_at IS NOT NULL));

CREATE UNIQUE INDEX user_plans_one_active ON user_plans USING btree (user_id) WHERE (status = 'active'::user_plan_status);

CREATE INDEX user_plans_plan_active ON user_plans USING btree (plan_id) WHERE (status = 'active'::user_plan_status);

CREATE INDEX user_plans_user ON user_plans USING btree (user_id, created_at);

CREATE TRIGGER user_plans_groups AFTER INSERT ON user_plans
    FOR EACH ROW
    EXECUTE FUNCTION akari_user_plan_groups();

CREATE TRIGGER user_plans_terms BEFORE INSERT ON user_plans
    FOR EACH ROW
    EXECUTE FUNCTION akari_user_plan_terms();

-- The node groups a subscription grants (the reconcile reads these, not
-- plan_groups). A deleted group goes from every snapshot.
CREATE TABLE user_plan_groups (
    user_plan_id uuid NOT NULL,
    group_id uuid NOT NULL
);

ALTER TABLE ONLY user_plan_groups
    ADD CONSTRAINT user_plan_groups_pkey PRIMARY KEY (user_plan_id, group_id);

CREATE INDEX user_plan_groups_group ON user_plan_groups USING btree (group_id);

-- =========================================================================
-- Payments, orders, coupons
-- =========================================================================

CREATE TABLE payment_methods (
    id uuid NOT NULL,
    kind text NOT NULL,
    display_name text NOT NULL,
    icon text,
    sort integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secrets_enc bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_methods_config_check CHECK ((jsonb_typeof(config) = 'object'::text)),
    CONSTRAINT payment_methods_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 64))),
    CONSTRAINT payment_methods_enabled_has_secrets CHECK (((NOT enabled) OR (secrets_enc IS NOT NULL))),
    CONSTRAINT payment_methods_icon_check CHECK ((icon ~ '^[a-z0-9_-]{1,32}$'::text)),
    CONSTRAINT payment_methods_kind_check CHECK ((kind = ANY (ARRAY['alipay_f2f'::text, 'epay'::text, 'coinpayments'::text, 'coinbase'::text]))),
    CONSTRAINT payment_methods_sort_check CHECK (((sort >= '-1000000'::integer) AND (sort <= 1000000))),
    CONSTRAINT payment_methods_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);

CREATE INDEX payment_methods_order ON payment_methods USING btree (sort, created_at);

CREATE TRIGGER payment_methods_notify AFTER INSERT OR DELETE OR UPDATE ON payment_methods
    FOR EACH STATEMENT
    EXECUTE FUNCTION akari_settings_notify();

CREATE TABLE coupon_batches (
    id uuid NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    prefix text NOT NULL,
    count integer NOT NULL,
    template jsonb NOT NULL,
    actor_label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT coupon_batches_count_check CHECK (((count >= 1) AND (count <= 5000))),
    CONSTRAINT coupon_batches_name_check CHECK ((char_length(name) <= 100)),
    CONSTRAINT coupon_batches_prefix_check CHECK ((prefix ~ '^[A-Za-z0-9_-]{0,16}$'::text))
);

ALTER TABLE ONLY coupon_batches
    ADD CONSTRAINT coupon_batches_pkey PRIMARY KEY (id);

CREATE TABLE coupons (
    id uuid NOT NULL,
    code text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    kind text NOT NULL,
    value bigint NOT NULL,
    plan_ids uuid[],
    periods text[],
    min_amount_cents bigint DEFAULT 0 NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    max_uses integer,
    per_user_limit integer,
    new_users_only boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    used integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id uuid,
    CONSTRAINT coupons_code_check CHECK ((code ~ '^[A-Za-z0-9_-]{3,32}$'::text)),
    CONSTRAINT coupons_kind_check CHECK ((kind = ANY (ARRAY['percent'::text, 'fixed'::text]))),
    CONSTRAINT coupons_max_uses_check CHECK (((max_uses >= 1) AND (max_uses <= 100000000))),
    CONSTRAINT coupons_min_amount_cents_check CHECK (((min_amount_cents >= 0) AND (min_amount_cents <= 100000000))),
    CONSTRAINT coupons_name_check CHECK ((char_length(name) <= 100)),
    CONSTRAINT coupons_per_user_limit_check CHECK (((per_user_limit >= 1) AND (per_user_limit <= 100000000))),
    CONSTRAINT coupons_periods_check CHECK ((((cardinality(periods) >= 1) AND (cardinality(periods) <= 9)) AND (array_position(periods, NULL::text) IS NULL) AND (periods <@ ARRAY['month'::text, 'quarter'::text, 'half_year'::text, 'year'::text, 'two_year'::text, 'three_year'::text, 'days'::text, 'onetime'::text, 'reset'::text]))),
    CONSTRAINT coupons_plan_ids_check CHECK ((((cardinality(plan_ids) >= 1) AND (cardinality(plan_ids) <= 200)) AND (array_position(plan_ids, NULL::uuid) IS NULL))),
    CONSTRAINT coupons_used_check CHECK ((used >= 0)),
    CONSTRAINT coupons_used_le_max CHECK (((max_uses IS NULL) OR (used <= max_uses))),
    CONSTRAINT coupons_value_range CHECK ((((kind = 'percent'::text) AND ((value >= 1) AND (value <= 100))) OR ((kind = 'fixed'::text) AND ((value >= 1) AND (value <= 100000000))))),
    CONSTRAINT coupons_window CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at)))
);

ALTER TABLE ONLY coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);

CREATE INDEX coupons_batch ON coupons USING btree (batch_id) WHERE (batch_id IS NOT NULL);

CREATE UNIQUE INDEX coupons_code ON coupons USING btree (lower(code));

CREATE TABLE orders (
    id uuid NOT NULL,
    out_trade_no text NOT NULL,
    user_id uuid,
    user_label text NOT NULL,
    plan_id uuid,
    plan_name text NOT NULL,
    amount_cents bigint NOT NULL,
    period_days integer,
    subject text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    qr_code text,
    trade_no text,
    paid_via text,
    paid_amount_cents bigint,
    manual_reason text,
    fulfilled_at timestamp with time zone,
    fulfil_result jsonb,
    fulfil_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    paid_at timestamp with time zone,
    ended_at timestamp with time zone,
    close_state text,
    last_query_at timestamp with time zone,
    period text NOT NULL,
    list_price_cents bigint NOT NULL,
    credit_cents bigint DEFAULT 0 NOT NULL,
    credit_order_id uuid,
    discount_cents bigint DEFAULT 0 NOT NULL,
    coupon_id uuid,
    coupon_code text,
    balance_cents bigint DEFAULT 0 NOT NULL,
    balance_state text DEFAULT 'none'::text NOT NULL,
    refunded_at timestamp with time zone,
    refund_cents bigint,
    refund_reason text,
    payment_method_id uuid,
    pay_url text,
    gift_cents bigint DEFAULT 0 NOT NULL,
    -- orders.refund_request: the refund the admin asked the provider for
    -- (`refund::OriginalRequest`): its idempotent request number
    -- (`out_request_no`), amount, state (pending = asked or unknown: the
    -- reconcile loop queries and retries with the same number until the
    -- provider confirms; done = refunded and recorded; failed = the provider
    -- refused: nothing moved), attempts, last error, and what the refund
    -- records when it completes (reason, keep_plan, the admin). The order's
    -- refund columns are written once, when the provider confirms.
    refund_request jsonb,
    prior_user_plan_id uuid,
    -- `refund_effect` records what the refund did to the subscription (shown in
    -- the console; the audit row has the same object). NULL until refunded.
    refund_effect jsonb,
    refund_balance_cents bigint,
    refund_external_cents bigint,
    action text NOT NULL,
    -- refund_gateway_cents: the part of the refund that was channel money
    -- (to_balance: the whole amount_cents; otherwise refund_external_cents).
    -- Same-null as refunded_at, 0..amount_cents, ≤ refund_cents.
    refund_gateway_cents bigint,
    CONSTRAINT orders_action CHECK (((action = ANY (ARRAY['new'::text, 'renew'::text, 'switch'::text, 'reset'::text])) AND ((action = 'reset'::text) = (period = 'reset'::text)))),
    CONSTRAINT orders_amount_cents_check CHECK (((amount_cents >= 0) AND (amount_cents = ((((list_price_cents - credit_cents) - discount_cents) - balance_cents) - gift_cents)) AND ((amount_cents > 0) OR ((((credit_cents + discount_cents) + balance_cents) + gift_cents) > 0)))),
    CONSTRAINT orders_balance_cents_check CHECK ((balance_cents >= 0)),
    CONSTRAINT orders_balance_state CHECK (((balance_cents = 0) = (balance_state = 'none'::text))),
    CONSTRAINT orders_balance_state_check CHECK ((balance_state = ANY (ARRAY['none'::text, 'held'::text, 'refunded'::text]))),
    CONSTRAINT orders_coupon CHECK (((discount_cents > 0) <= (coupon_code IS NOT NULL))),
    CONSTRAINT orders_credit_cents_check CHECK ((credit_cents >= 0)),
    CONSTRAINT orders_discount_cents_check CHECK ((discount_cents >= 0)),
    CONSTRAINT orders_ended_at CHECK (((status = ANY (ARRAY['expired'::text, 'cancelled'::text])) = (ended_at IS NOT NULL))),
    CONSTRAINT orders_fulfilled_paid CHECK (((fulfilled_at IS NULL) OR (status = 'paid'::text))),
    CONSTRAINT orders_gift_cents_check CHECK ((gift_cents >= 0)),
    CONSTRAINT orders_list_price_cents_check CHECK ((list_price_cents > 0)),
    CONSTRAINT orders_out_trade_no_check CHECK ((out_trade_no ~ '^[A-Za-z0-9_]{1,64}$'::text)),
    CONSTRAINT orders_paid_at CHECK (((status = 'paid'::text) = (paid_at IS NOT NULL))),
    CONSTRAINT orders_paid_via CHECK (((status <> 'paid'::text) OR (paid_via IS NOT NULL))),
    CONSTRAINT orders_paid_via_check CHECK ((paid_via = ANY (ARRAY['notify'::text, 'query'::text, 'manual'::text, 'credit'::text, 'balance'::text, 'coupon'::text]))),
    CONSTRAINT orders_pay_url_check CHECK ((length(pay_url) <= 2048)),
    CONSTRAINT orders_period_check CHECK ((period = ANY (ARRAY['month'::text, 'quarter'::text, 'half_year'::text, 'year'::text, 'two_year'::text, 'three_year'::text, 'days'::text, 'onetime'::text, 'reset'::text]))),
    CONSTRAINT orders_period_days_check CHECK (((period_days >= 1) AND (period_days <= 3650))),
    CONSTRAINT orders_period_days_kind CHECK ((((period = 'days'::text) <= (period_days IS NOT NULL)) AND ((period = ANY (ARRAY['days'::text, 'onetime'::text])) OR (period_days IS NULL)))),
    CONSTRAINT orders_refund CHECK ((((refunded_at IS NULL) = (refund_cents IS NULL)) AND ((refunded_at IS NULL) OR (status = 'paid'::text)))),
    CONSTRAINT orders_refund_cents_check CHECK ((refund_cents >= 0)),
    CONSTRAINT orders_refund_effect CHECK (((refund_effect IS NULL) = (refunded_at IS NULL))),
    CONSTRAINT orders_refund_gateway CHECK ((((refunded_at IS NULL) = (refund_gateway_cents IS NULL)) AND ((refunded_at IS NULL) OR ((refund_gateway_cents >= 0) AND (refund_gateway_cents <= LEAST(amount_cents, refund_cents)))))),
    CONSTRAINT orders_refund_request CHECK (((refund_request IS NULL) OR (jsonb_typeof(refund_request) = 'object'::text))),
    CONSTRAINT orders_refund_split CHECK ((((refunded_at IS NULL) = (refund_balance_cents IS NULL)) AND ((refunded_at IS NULL) = (refund_external_cents IS NULL)) AND ((refunded_at IS NULL) OR ((refund_balance_cents >= 0) AND ((refund_external_cents >= 0) AND (refund_external_cents <= amount_cents)) AND (refund_cents = (refund_balance_cents + refund_external_cents)))))),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'expired'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_out_trade_no_key UNIQUE (out_trade_no);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

CREATE INDEX orders_capacity_hold ON orders USING btree (plan_id, expires_at) WHERE ((status = 'pending'::text) AND (action = ANY (ARRAY['new'::text, 'switch'::text])));

CREATE INDEX orders_coupon ON orders USING btree (coupon_id) WHERE (coupon_id IS NOT NULL);

CREATE INDEX orders_created ON orders USING btree (created_at DESC, id DESC);

CREATE UNIQUE INDEX orders_one_pending ON orders USING btree (user_id) WHERE (status = 'pending'::text);

CREATE INDEX orders_paid_at ON orders USING btree (paid_at) INCLUDE (amount_cents) WHERE (status = 'paid'::text);

CREATE INDEX orders_paid_via_paid_at ON orders USING btree (paid_via, paid_at) WHERE (status = 'paid'::text);

CREATE INDEX orders_payment_method ON orders USING btree (payment_method_id) WHERE (payment_method_id IS NOT NULL);

CREATE INDEX orders_pending ON orders USING btree (expires_at) WHERE (status = 'pending'::text);

CREATE INDEX orders_prior_user_plan ON orders USING btree (prior_user_plan_id) WHERE (prior_user_plan_id IS NOT NULL);

CREATE INDEX orders_refund_pending ON orders USING btree (id) WHERE ((refund_request ->> 'state'::text) = 'pending'::text);

CREATE INDEX orders_refunded_at ON orders USING btree (refunded_at) INCLUDE (refund_cents, refund_gateway_cents) WHERE (refunded_at IS NOT NULL);

CREATE INDEX orders_unfulfilled ON orders USING btree (paid_at) WHERE ((status = 'paid'::text) AND (fulfilled_at IS NULL));

CREATE INDEX orders_user ON orders USING btree (user_id, created_at DESC);

CREATE INDEX orders_user_plan_paid ON orders USING btree (user_id, plan_id, fulfilled_at DESC) WHERE (status = 'paid'::text);

CREATE TABLE payment_events (
    id bigint NOT NULL,
    order_id uuid,
    out_trade_no text,
    source text NOT NULL,
    verified boolean NOT NULL,
    outcome text NOT NULL,
    trade_status text,
    params jsonb,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    payment_method_id uuid,
    CONSTRAINT payment_events_source_check CHECK ((source = ANY (ARRAY['notify'::text, 'query'::text, 'precreate'::text, 'close'::text, 'manual'::text, 'expire'::text])))
);

ALTER TABLE payment_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME payment_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);

CREATE INDEX payment_events_created ON payment_events USING btree (created_at);

CREATE INDEX payment_events_order ON payment_events USING btree (order_id, id);

CREATE TABLE coupon_redemptions (
    order_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    user_id uuid,
    status text NOT NULL,
    over_limit boolean DEFAULT false NOT NULL,
    discount_cents bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupon_redemptions_discount_cents_check CHECK ((discount_cents > 0)),
    CONSTRAINT coupon_redemptions_over_limit_redeemed CHECK (((NOT over_limit) OR (status = 'redeemed'::text))),
    CONSTRAINT coupon_redemptions_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'redeemed'::text, 'released'::text])))
);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_pkey PRIMARY KEY (order_id);

CREATE INDEX coupon_redemptions_user ON coupon_redemptions USING btree (coupon_id, user_id);

CREATE INDEX coupon_redemptions_user_id ON coupon_redemptions USING btree (user_id) WHERE (user_id IS NOT NULL);

-- =========================================================================
-- Balance, commissions, withdrawals
-- =========================================================================

CREATE TABLE user_balances (
    user_id uuid NOT NULL,
    balance_cents bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_balances_balance_cents_check CHECK ((balance_cents >= 0))
);

ALTER TABLE ONLY user_balances
    ADD CONSTRAINT user_balances_pkey PRIMARY KEY (user_id);

CREATE TRIGGER user_balances_guard BEFORE INSERT OR UPDATE ON user_balances
    FOR EACH ROW
    EXECUTE FUNCTION akari_balance_guard();

CREATE TABLE balance_ledger (
    id bigint NOT NULL,
    user_id uuid,
    user_label text NOT NULL,
    kind text NOT NULL,
    amount_cents bigint NOT NULL,
    balance_after_cents bigint DEFAULT 0 NOT NULL,
    order_id uuid,
    commission_id uuid,
    withdrawal_id uuid,
    reason text,
    actor_label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT balance_ledger_amount_cents_check CHECK (((amount_cents <> 0) AND ((amount_cents >= '-10000000000'::bigint) AND (amount_cents <= '10000000000'::bigint)))),
    CONSTRAINT balance_ledger_balance_after_cents_check CHECK ((balance_after_cents >= 0)),
    CONSTRAINT balance_ledger_kind_check CHECK ((kind = ANY (ARRAY['commission'::text, 'admin_adjust'::text, 'order_payment'::text, 'refund_to_balance'::text, 'withdrawal'::text, 'withdrawal_reversal'::text, 'commission_clawback'::text]))),
    CONSTRAINT balance_ledger_kind_shape CHECK (
CASE kind
    WHEN 'admin_adjust'::text THEN (reason IS NOT NULL)
    WHEN 'commission'::text THEN ((amount_cents > 0) AND (commission_id IS NOT NULL))
    WHEN 'commission_clawback'::text THEN ((amount_cents < 0) AND (commission_id IS NOT NULL))
    WHEN 'order_payment'::text THEN ((amount_cents < 0) AND (order_id IS NOT NULL))
    WHEN 'refund_to_balance'::text THEN ((amount_cents > 0) AND (order_id IS NOT NULL))
    WHEN 'withdrawal'::text THEN ((amount_cents < 0) AND (withdrawal_id IS NOT NULL))
    WHEN 'withdrawal_reversal'::text THEN ((amount_cents > 0) AND (withdrawal_id IS NOT NULL))
    ELSE NULL::boolean
END),
    CONSTRAINT balance_ledger_reason_check CHECK ((char_length(reason) <= 500))
);

ALTER TABLE balance_ledger ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME balance_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY balance_ledger
    ADD CONSTRAINT balance_ledger_pkey PRIMARY KEY (id);

CREATE INDEX balance_ledger_order ON balance_ledger USING btree (order_id) WHERE (order_id IS NOT NULL);

CREATE INDEX balance_ledger_user ON balance_ledger USING btree (user_id, id DESC);

CREATE TRIGGER balance_ledger_append_only BEFORE DELETE OR UPDATE ON balance_ledger
    FOR EACH ROW
    EXECUTE FUNCTION akari_ledger_append_only();

CREATE TRIGGER balance_ledger_apply BEFORE INSERT ON balance_ledger
    FOR EACH ROW
    EXECUTE FUNCTION akari_ledger_apply();

CREATE TABLE commissions (
    id uuid NOT NULL,
    order_id uuid NOT NULL,
    inviter_id uuid,
    inviter_label text NOT NULL,
    invitee_id uuid,
    invitee_label text NOT NULL,
    base_cents bigint NOT NULL,
    rate_percent integer NOT NULL,
    amount_cents bigint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone NOT NULL,
    credited_at timestamp with time zone,
    ledger_id bigint,
    reversed_at timestamp with time zone,
    reverse_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    clawback_cents bigint,
    clawback_recovered_cents bigint DEFAULT 0 NOT NULL,
    clawed_back_at timestamp with time zone,
    CONSTRAINT commissions_amount_le_base CHECK (((amount_cents > 0) AND (amount_cents <= base_cents))),
    CONSTRAINT commissions_amount_rate CHECK ((amount_cents = ((base_cents * rate_percent) / 100))),
    CONSTRAINT commissions_base_cents_check CHECK ((base_cents > 0)),
    CONSTRAINT commissions_clawback CHECK ((((clawback_cents IS NULL) = (clawed_back_at IS NULL)) AND ((clawback_cents IS NULL) OR ((status = 'credited'::text) AND (clawback_cents = amount_cents))) AND ((clawback_recovered_cents >= 0) AND (clawback_recovered_cents <= COALESCE(clawback_cents, (0)::bigint))))),
    CONSTRAINT commissions_credited_state CHECK (((status = 'credited'::text) = ((credited_at IS NOT NULL) AND (ledger_id IS NOT NULL)))),
    CONSTRAINT commissions_rate_percent_check CHECK (((rate_percent >= 1) AND (rate_percent <= 100))),
    CONSTRAINT commissions_reversed_state CHECK (((status = 'reversed'::text) = (reversed_at IS NOT NULL))),
    CONSTRAINT commissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'credited'::text, 'reversed'::text])))
);

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_pkey PRIMARY KEY (id);

-- Outstanding clawbacks of an inviter (credit_due nets them first).
CREATE INDEX commissions_clawback_due ON commissions USING btree (inviter_id, id) WHERE (clawback_cents > clawback_recovered_cents);

CREATE INDEX commissions_due ON commissions USING btree (available_at) WHERE (status = 'pending'::text);

CREATE INDEX commissions_invitee ON commissions USING btree (invitee_id) WHERE (invitee_id IS NOT NULL);

CREATE INDEX commissions_inviter ON commissions USING btree (inviter_id, created_at DESC);

CREATE TABLE withdrawals (
    id uuid NOT NULL,
    user_id uuid,
    user_label text NOT NULL,
    amount_cents bigint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    note text,
    decided_at timestamp with time zone,
    decided_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    chain text NOT NULL,
    address text NOT NULL,
    memo text,
    usdt_micros bigint,
    txid text,
    CONSTRAINT withdrawals_address CHECK (((char_length(address) >= 1) AND (char_length(address) <= 128))),
    CONSTRAINT withdrawals_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT withdrawals_approved_payout CHECK (((status = 'approved'::text) = ((usdt_micros IS NOT NULL) AND (txid IS NOT NULL)))),
    CONSTRAINT withdrawals_chain CHECK ((chain = ANY (ARRAY['trc20'::text, 'plasma'::text, 'polygon'::text, 'arbitrum'::text, 'solana'::text, 'xlayer'::text, 'ton'::text]))),
    CONSTRAINT withdrawals_decided_at CHECK (((status = 'pending'::text) = (decided_at IS NULL))),
    CONSTRAINT withdrawals_memo CHECK (((memo IS NULL) OR ((chain = 'ton'::text) AND (char_length(memo) >= 1) AND (char_length(memo) <= 120)))),
    CONSTRAINT withdrawals_note_check CHECK ((char_length(note) <= 500)),
    CONSTRAINT withdrawals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT withdrawals_txid CHECK (((txid IS NULL) OR ((char_length(txid) >= 8) AND (char_length(txid) <= 128)))),
    CONSTRAINT withdrawals_usdt_micros CHECK (((usdt_micros IS NULL) OR ((usdt_micros > 0) AND (usdt_micros <= '1000000000000000'::bigint))))
);

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_pkey PRIMARY KEY (id);

CREATE INDEX withdrawals_created ON withdrawals USING btree (created_at DESC, id DESC);

CREATE UNIQUE INDEX withdrawals_one_pending ON withdrawals USING btree (user_id) WHERE (status = 'pending'::text);

CREATE INDEX withdrawals_user ON withdrawals USING btree (user_id) WHERE (user_id IS NOT NULL);

-- =========================================================================
-- Monitoring and alerts
-- =========================================================================

CREATE TABLE server_metrics_1m (
    server_id uuid NOT NULL,
    bucket timestamp with time zone NOT NULL,
    samples integer NOT NULL,
    cpu_sum double precision,
    cpu_max real,
    load1_sum double precision,
    mem_used_sum double precision,
    mem_total bigint,
    swap_used_sum double precision,
    swap_total bigint,
    disk_used bigint,
    disk_total bigint,
    rx_bps_sum double precision,
    tx_bps_sum double precision,
    rx_bps_max bigint,
    tx_bps_max bigint,
    tcp_sum double precision,
    udp_sum double precision,
    conns_sum double precision DEFAULT 0 NOT NULL,
    conns_max bigint DEFAULT 0 NOT NULL,
    users_sum double precision DEFAULT 0 NOT NULL,
    users_max bigint DEFAULT 0 NOT NULL,
    CONSTRAINT server_metrics_1m_samples_check CHECK ((samples > 0))
)
WITH (fillfactor='70');

ALTER TABLE ONLY server_metrics_1m
    ADD CONSTRAINT server_metrics_1m_pkey PRIMARY KEY (server_id, bucket);

CREATE INDEX server_metrics_1m_bucket ON server_metrics_1m USING btree (bucket);

CREATE TABLE server_metrics_1h (
    server_id uuid NOT NULL,
    bucket timestamp with time zone NOT NULL,
    samples integer NOT NULL,
    cpu_sum double precision,
    cpu_max real,
    load1_sum double precision,
    mem_used_sum double precision,
    mem_total bigint,
    swap_used_sum double precision,
    swap_total bigint,
    disk_used bigint,
    disk_total bigint,
    rx_bps_sum double precision,
    tx_bps_sum double precision,
    rx_bps_max bigint,
    tx_bps_max bigint,
    tcp_sum double precision,
    udp_sum double precision,
    conns_sum double precision DEFAULT 0 NOT NULL,
    conns_max bigint DEFAULT 0 NOT NULL,
    users_sum double precision DEFAULT 0 NOT NULL,
    users_max bigint DEFAULT 0 NOT NULL,
    CONSTRAINT server_metrics_1m_samples_check CHECK ((samples > 0))
);

ALTER TABLE ONLY server_metrics_1h
    ADD CONSTRAINT server_metrics_1h_pkey PRIMARY KEY (server_id, bucket);

CREATE INDEX server_metrics_1h_bucket ON server_metrics_1h USING btree (bucket);

CREATE TABLE server_latency (
    server_id uuid NOT NULL,
    source text NOT NULL,
    target text NOT NULL,
    delay_ms integer,
    error text,
    ord smallint DEFAULT 0 NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    CONSTRAINT server_latency_delay_ms_check CHECK (((delay_ms IS NULL) OR (delay_ms >= 0))),
    CONSTRAINT server_latency_error_check CHECK (((error IS NULL) OR (char_length(error) <= 200))),
    CONSTRAINT server_latency_source_check CHECK ((source = ANY (ARRAY['agent'::text, 'panel'::text]))),
    CONSTRAINT server_latency_target_check CHECK (((char_length(target) >= 1) AND (char_length(target) <= 512)))
);

ALTER TABLE ONLY server_latency
    ADD CONSTRAINT server_latency_pkey PRIMARY KEY (server_id, source, target);

CREATE TABLE server_alerts (
    id bigint NOT NULL,
    server_id uuid NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    fired_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    value text DEFAULT ''::text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    notified boolean DEFAULT false NOT NULL,
    acked_at timestamp with time zone,
    acked_by text,
    CONSTRAINT server_alerts_acked_pair CHECK (((acked_at IS NULL) = (acked_by IS NULL))),
    CONSTRAINT server_alerts_detail_check CHECK ((char_length(detail) <= 600)),
    CONSTRAINT server_alerts_resolved_at CHECK (((status = 'resolved'::text) = (resolved_at IS NOT NULL))),
    CONSTRAINT server_alerts_status_check CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text]))),
    CONSTRAINT server_alerts_value_check CHECK ((char_length(value) <= 200)),
    CONSTRAINT server_alerts_kind_check CHECK ((kind = ANY (ARRAY['offline'::text, 'cpu'::text, 'memory'::text, 'disk'::text, 'latency'::text, 'cert'::text, 'agent_cert'::text, 'last_error'::text, 'entrance_down'::text, 'traffic_quota'::text])))
);

ALTER TABLE server_alerts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME server_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY server_alerts
    ADD CONSTRAINT server_alerts_pkey PRIMARY KEY (id);

CREATE INDEX server_alerts_last ON server_alerts USING btree (server_id, kind, fired_at DESC);

CREATE UNIQUE INDEX server_alerts_one_firing ON server_alerts USING btree (server_id, kind) WHERE (status = 'firing'::text);

CREATE INDEX server_alerts_resolved ON server_alerts USING btree (resolved_at) WHERE (status = 'resolved'::text);

CREATE TABLE server_alert_rules (
    server_id uuid NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    disabled text[] DEFAULT '{}'::text[] NOT NULL,
    offline_secs integer,
    cpu_percent integer,
    cpu_minutes integer,
    mem_percent integer,
    mem_minutes integer,
    disk_percent integer,
    cert_days integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT node_alert_rules_cert_days_check CHECK (((cert_days >= 1) AND (cert_days <= 90))),
    CONSTRAINT node_alert_rules_cpu_minutes_check CHECK (((cpu_minutes >= 1) AND (cpu_minutes <= 60))),
    CONSTRAINT node_alert_rules_cpu_percent_check CHECK (((cpu_percent >= 1) AND (cpu_percent <= 100))),
    CONSTRAINT node_alert_rules_disabled_check CHECK (((cardinality(disabled) <= 16) AND (array_position(disabled, NULL::text) IS NULL))),
    CONSTRAINT node_alert_rules_disk_percent_check CHECK (((disk_percent >= 1) AND (disk_percent <= 100))),
    CONSTRAINT node_alert_rules_mem_minutes_check CHECK (((mem_minutes >= 1) AND (mem_minutes <= 60))),
    CONSTRAINT node_alert_rules_mem_percent_check CHECK (((mem_percent >= 1) AND (mem_percent <= 100))),
    CONSTRAINT node_alert_rules_offline_secs_check CHECK (((offline_secs >= 30) AND (offline_secs <= 86400)))
);

ALTER TABLE ONLY server_alert_rules
    ADD CONSTRAINT server_alert_rules_pkey PRIMARY KEY (server_id);

CREATE TABLE alert_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    offline_secs integer DEFAULT 300,
    cpu_percent integer DEFAULT 90,
    cpu_minutes integer DEFAULT 5 NOT NULL,
    mem_percent integer DEFAULT 90,
    mem_minutes integer DEFAULT 5 NOT NULL,
    disk_percent integer DEFAULT 90,
    cert_days integer DEFAULT 14,
    latency_failures boolean DEFAULT true NOT NULL,
    last_error boolean DEFAULT true NOT NULL,
    cooldown_minutes integer DEFAULT 30 NOT NULL,
    notify_resolved boolean DEFAULT true NOT NULL,
    telegram_enabled boolean DEFAULT false NOT NULL,
    telegram_chat_id text,
    telegram_token_enc bytea,
    webhook_enabled boolean DEFAULT false NOT NULL,
    webhook_url text,
    webhook_secret_enc bytea,
    email_enabled boolean DEFAULT false NOT NULL,
    email_to text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    telegram_api_url text,
    CONSTRAINT alert_settings_cert_days_check CHECK (((cert_days >= 1) AND (cert_days <= 90))),
    CONSTRAINT alert_settings_cooldown_minutes_check CHECK (((cooldown_minutes >= 0) AND (cooldown_minutes <= 1440))),
    CONSTRAINT alert_settings_cpu_minutes_check CHECK (((cpu_minutes >= 1) AND (cpu_minutes <= 60))),
    CONSTRAINT alert_settings_cpu_percent_check CHECK (((cpu_percent >= 1) AND (cpu_percent <= 100))),
    CONSTRAINT alert_settings_disk_percent_check CHECK (((disk_percent >= 1) AND (disk_percent <= 100))),
    CONSTRAINT alert_settings_email_recipients CHECK (((NOT email_enabled) OR (cardinality(email_to) > 0))),
    CONSTRAINT alert_settings_email_to_check CHECK (((cardinality(email_to) <= 5) AND (array_position(email_to, NULL::text) IS NULL))),
    CONSTRAINT alert_settings_id_check CHECK ((id = 1)),
    CONSTRAINT alert_settings_mem_minutes_check CHECK (((mem_minutes >= 1) AND (mem_minutes <= 60))),
    CONSTRAINT alert_settings_mem_percent_check CHECK (((mem_percent >= 1) AND (mem_percent <= 100))),
    CONSTRAINT alert_settings_offline_secs_check CHECK (((offline_secs >= 30) AND (offline_secs <= 86400))),
    CONSTRAINT alert_settings_telegram_api_url_check CHECK (((length(telegram_api_url) >= 9) AND (length(telegram_api_url) <= 2048))),
    CONSTRAINT alert_settings_telegram_chat_id_check CHECK (((char_length(telegram_chat_id) >= 1) AND (char_length(telegram_chat_id) <= 64))),
    CONSTRAINT alert_settings_telegram_complete CHECK (((NOT telegram_enabled) OR ((telegram_chat_id IS NOT NULL) AND (telegram_token_enc IS NOT NULL)))),
    CONSTRAINT alert_settings_webhook_complete CHECK (((NOT webhook_enabled) OR ((webhook_url IS NOT NULL) AND (webhook_secret_enc IS NOT NULL)))),
    CONSTRAINT alert_settings_webhook_url_check CHECK (((char_length(webhook_url) >= 1) AND (char_length(webhook_url) <= 512)))
);

ALTER TABLE ONLY alert_settings
    ADD CONSTRAINT alert_settings_pkey PRIMARY KEY (id);

CREATE TABLE alert_notifications (
    id bigint NOT NULL,
    alert_id bigint,
    channel text NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_until timestamp with time zone,
    claim uuid,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT alert_notifications_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT alert_notifications_channel_check CHECK ((channel = ANY (ARRAY['telegram'::text, 'webhook'::text, 'email'::text]))),
    CONSTRAINT alert_notifications_event_check CHECK ((event = ANY (ARRAY['firing'::text, 'resolved'::text, 'billing'::text]))),
    CONSTRAINT alert_notifications_last_error_check CHECK ((char_length(last_error) <= 300)),
    CONSTRAINT alert_notifications_sent_at CHECK (((status = 'sent'::text) = (sent_at IS NOT NULL))),
    CONSTRAINT alert_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'dead'::text])))
);

ALTER TABLE alert_notifications ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME alert_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY alert_notifications
    ADD CONSTRAINT alert_notifications_pkey PRIMARY KEY (id);

CREATE INDEX alert_notifications_alert ON alert_notifications USING btree (alert_id);

CREATE INDEX alert_notifications_due ON alert_notifications USING btree (next_attempt_at, id) WHERE (status = 'pending'::text);

CREATE INDEX alert_notifications_recent ON alert_notifications USING btree (created_at DESC, id DESC);

-- The panel compiles the enabled rules into one BlockPolicy per agent
-- (blockrules.rs); the agent only installs them into xray routing
-- (sniffing + blackhole). Only aggregate per-node hit counts are kept —
-- never per-user access records.
CREATE TABLE block_rules (
    id bigint NOT NULL,
    kind text NOT NULL,
    builtin_key text,
    name text NOT NULL,
    pattern text,
    enabled boolean DEFAULT false NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT block_rules_builtin_key CHECK ((builtin_key = ANY (ARRAY['bittorrent'::text, 'bt_tracker'::text, 'xunlei_pt'::text]))),
    CONSTRAINT block_rules_builtin_shape CHECK ((((kind = 'builtin'::text) = (builtin_key IS NOT NULL)) AND ((kind = 'builtin'::text) = (pattern IS NULL)))),
    CONSTRAINT block_rules_kind CHECK ((kind = ANY (ARRAY['builtin'::text, 'domain'::text, 'ip'::text, 'protocol'::text]))),
    CONSTRAINT block_rules_name CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64))),
    CONSTRAINT block_rules_pattern CHECK (((pattern IS NULL) OR ((octet_length(pattern) >= 1) AND (octet_length(pattern) <= 65536)))),
    CONSTRAINT block_rules_sort CHECK (((sort >= '-1000000'::integer) AND (sort <= 1000000)))
);

ALTER TABLE block_rules ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME block_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY block_rules
    ADD CONSTRAINT block_rules_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX block_rules_builtin ON block_rules USING btree (builtin_key) WHERE (kind = 'builtin'::text);

CREATE TRIGGER block_rules_keep_builtin BEFORE DELETE OR UPDATE ON block_rules
    FOR EACH ROW
    EXECUTE FUNCTION akari_block_rules_keep_builtin();

CREATE TRIGGER block_rules_notify AFTER INSERT OR DELETE OR UPDATE ON block_rules
    FOR EACH STATEMENT
    EXECUTE FUNCTION akari_block_rules_notify();

-- Highest cumulative hit count an agent process (epoch) reported per rule.
-- Like traffic_counters, this is the baseline the daily delta is computed
-- against in SQL (GREATEST + RETURNING old/new), so replays never count
-- twice. rule_id has no foreign key: rows are pruned with their epoch.
CREATE TABLE server_block_counters (
    server_id uuid NOT NULL,
    epoch text NOT NULL,
    rule_id bigint NOT NULL,
    hits bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT server_block_counters_epoch CHECK (((char_length(epoch) >= 1) AND (char_length(epoch) <= 64))),
    CONSTRAINT server_block_counters_hits CHECK ((hits >= 0))
);

ALTER TABLE ONLY server_block_counters
    ADD CONSTRAINT server_block_counters_pkey PRIMARY KEY (server_id, epoch, rule_id);

CREATE INDEX server_block_counters_updated ON server_block_counters USING btree (updated_at);

-- Blocked connections per node, rule and UTC day (90 days, reaper).
CREATE TABLE server_block_daily (
    server_id uuid NOT NULL,
    day date NOT NULL,
    rule_id bigint NOT NULL,
    hits bigint NOT NULL,
    CONSTRAINT server_block_daily_hits CHECK ((hits >= 0))
);

ALTER TABLE ONLY server_block_daily
    ADD CONSTRAINT server_block_daily_pkey PRIMARY KEY (server_id, day, rule_id);

CREATE INDEX server_block_daily_day ON server_block_daily USING btree (day);

CREATE INDEX server_block_daily_rule ON server_block_daily USING btree (rule_id);

-- =========================================================================
-- Agent releases and rollouts
-- =========================================================================

CREATE TABLE agent_releases (
    id uuid NOT NULL,
    version text NOT NULL,
    os text NOT NULL,
    arch text NOT NULL,
    sha256 text NOT NULL,
    size bigint NOT NULL,
    manifest bytea NOT NULL,
    signatures jsonb NOT NULL,
    key_id text NOT NULL,
    min_panel_protocol integer NOT NULL,
    rollback boolean DEFAULT false NOT NULL,
    complete_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_releases_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_releases_size_check CHECK ((size > 0))
);

ALTER TABLE ONLY agent_releases
    ADD CONSTRAINT agent_releases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_releases
    ADD CONSTRAINT agent_releases_sha256_key UNIQUE (sha256);

ALTER TABLE ONLY agent_releases
    ADD CONSTRAINT agent_releases_version_os_arch_key UNIQUE (version, os, arch);

CREATE TABLE agent_release_chunks (
    release_id uuid NOT NULL,
    idx integer NOT NULL,
    data bytea NOT NULL,
    CONSTRAINT agent_release_chunks_idx_check CHECK ((idx >= 0))
);

ALTER TABLE ONLY agent_release_chunks
    ADD CONSTRAINT agent_release_chunks_pkey PRIMARY KEY (release_id, idx);

CREATE TABLE agent_update_settings (
    id boolean DEFAULT true NOT NULL,
    source_url text,
    auto_check boolean DEFAULT false NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    next_auto_check_at timestamp with time zone,
    check_started_at timestamp with time zone,
    last_check_at timestamp with time zone,
    last_check_ok boolean,
    last_check_result text,
    last_check_version text,
    last_check_code text,
    last_check_params jsonb,
    last_check_message text,
    last_check_stored text[],
    CONSTRAINT agent_update_settings_failed_code CHECK (((last_check_result = 'failed'::text) = (last_check_code IS NOT NULL))),
    CONSTRAINT agent_update_settings_id_check CHECK (id),
    CONSTRAINT agent_update_settings_last_check_pair CHECK (((last_check_at IS NULL) = (last_check_result IS NULL))),
    CONSTRAINT agent_update_settings_last_check_result_check CHECK ((last_check_result = ANY (ARRAY['stored'::text, 'up_to_date'::text, 'failed'::text]))),
    CONSTRAINT agent_update_settings_source_url_check CHECK (((source_url IS NULL) OR ((length(source_url) >= 8) AND (length(source_url) <= 512))))
);

ALTER TABLE ONLY agent_update_settings
    ADD CONSTRAINT agent_update_settings_pkey PRIMARY KEY (id);

CREATE TABLE rollouts (
    id uuid NOT NULL,
    version text NOT NULL,
    status text NOT NULL,
    waves integer[] NOT NULL,
    percentage integer NOT NULL,
    explicit_servers boolean NOT NULL,
    current_wave integer DEFAULT 0 NOT NULL,
    wave_started_at timestamp with time zone DEFAULT now() NOT NULL,
    health_timeout_secs integer NOT NULL,
    max_failure_ratio double precision NOT NULL,
    seed bigint NOT NULL,
    halted_reason text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT rollouts_current_wave_check CHECK ((current_wave >= 0)),
    CONSTRAINT rollouts_health_timeout_secs_check CHECK (((health_timeout_secs >= 30) AND (health_timeout_secs <= 86400))),
    CONSTRAINT rollouts_max_failure_ratio_check CHECK (((max_failure_ratio >= (0)::double precision) AND (max_failure_ratio <= (1)::double precision))),
    CONSTRAINT rollouts_percentage_check CHECK (((percentage >= 1) AND (percentage <= 100))),
    CONSTRAINT rollouts_status_check CHECK ((status = ANY (ARRAY['running'::text, 'paused'::text, 'halted'::text, 'aborted'::text, 'completed'::text]))),
    CONSTRAINT rollouts_waves_check CHECK (((cardinality(waves) >= 1) AND (cardinality(waves) <= 10)))
);

ALTER TABLE ONLY rollouts
    ADD CONSTRAINT rollouts_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX rollouts_one_open ON rollouts USING btree ((true)) WHERE (status = ANY (ARRAY['running'::text, 'paused'::text, 'halted'::text]));

CREATE TABLE rollout_servers (
    rollout_id uuid NOT NULL,
    server_id uuid NOT NULL,
    wave integer NOT NULL,
    "position" integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    from_version text,
    offered_at timestamp with time zone,
    finished_at timestamp with time zone,
    detail text,
    CONSTRAINT rollout_servers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'offered'::text, 'updating'::text, 'healthy'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT rollout_servers_wave_check CHECK ((wave >= 0))
);

ALTER TABLE ONLY rollout_servers
    ADD CONSTRAINT rollout_servers_pkey PRIMARY KEY (rollout_id, server_id);

CREATE INDEX rollout_servers_server ON rollout_servers USING btree (server_id);

-- =========================================================================
-- Site settings
-- =========================================================================

CREATE TABLE panel_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    trust_cloudflare boolean,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    probe_interval_secs integer,
    probe_urls text[],
    probe_panel_tcp boolean,
    site_name text,
    cloudflare_ranges text[],
    install_tls_pin text,
    install_fallback_url text,
    acme_directory_url text,
    acme_email text,
    audit_retention_days integer,
    traffic_daily_retention_days integer,
    remove_mode text,
    extra_release_keys text[],
    sub_domain_per_user boolean,
    timezone text,
    sub_formats text[],
    sub_import_clients text[],
    sub_name_rate boolean,
    passkey_domain text,
    -- `panel_settings.sub_own_client_only` (NULL = off): while on, every
    -- third-party subscription format and one-click import button is off (the
    -- stored `sub_formats` / `sub_import_clients` lists are kept untouched, so
    -- turning the mode off restores the operator's choice), the subscription
    -- URL answers only the Akari client (User-Agent `akari-client/…`), and the
    -- portal never shows the link (only the client download: the client will
    -- sign in with the user's account and fetch its profile).
    sub_own_client_only boolean,
    public_ipv4 text,
    public_ipv6 text,
    CONSTRAINT panel_settings_acme_directory_url_check CHECK (((length(acme_directory_url) >= 9) AND (length(acme_directory_url) <= 2048))),
    CONSTRAINT panel_settings_acme_email_check CHECK (((length(acme_email) >= 3) AND (length(acme_email) <= 254))),
    CONSTRAINT panel_settings_audit_retention_days_check CHECK (((audit_retention_days = 0) OR ((audit_retention_days >= 90) AND (audit_retention_days <= 36500)))),
    CONSTRAINT panel_settings_cloudflare_ranges_check CHECK ((((cardinality(cloudflare_ranges) >= 1) AND (cardinality(cloudflare_ranges) <= 256)) AND (array_position(cloudflare_ranges, NULL::text) IS NULL))),
    CONSTRAINT panel_settings_extra_release_keys_check CHECK ((((cardinality(extra_release_keys) >= 1) AND (cardinality(extra_release_keys) <= 16)) AND (array_position(extra_release_keys, NULL::text) IS NULL))),
    CONSTRAINT panel_settings_id_check CHECK ((id = 1)),
    CONSTRAINT panel_settings_install_fallback_url_check CHECK ((length(install_fallback_url) <= 2048)),
    CONSTRAINT panel_settings_install_tls_pin_check CHECK ((install_tls_pin ~ '^sha256//[A-Za-z0-9+/]{43}=$'::text)),
    CONSTRAINT panel_settings_passkey_domain CHECK (((passkey_domain IS NULL) OR ((char_length(passkey_domain) >= 1) AND (char_length(passkey_domain) <= 300)))),
    CONSTRAINT panel_settings_probe_interval_secs_check CHECK (((probe_interval_secs >= 600) AND (probe_interval_secs <= 604800))),
    CONSTRAINT panel_settings_probe_urls_check CHECK ((((cardinality(probe_urls) >= 1) AND (cardinality(probe_urls) <= 4)) AND (array_position(probe_urls, NULL::text) IS NULL))),
    CONSTRAINT panel_settings_public_ipv4 CHECK (((public_ipv4 IS NULL) OR (public_ipv4 ~ '^[0-9.]{7,15}$'::text))),
    CONSTRAINT panel_settings_public_ipv6 CHECK (((public_ipv6 IS NULL) OR ((public_ipv6 ~ '^[0-9a-f:.]{2,45}$'::text) AND (POSITION((':'::text) IN (public_ipv6)) > 0)))),
    CONSTRAINT panel_settings_remove_mode_check CHECK ((remove_mode = ANY (ARRAY['gate'::text, 'rebuild'::text]))),
    CONSTRAINT panel_settings_site_name_check CHECK (((site_name IS NULL) OR (((length(site_name) >= 1) AND (length(site_name) <= 64)) AND (site_name !~ '[[:cntrl:]]'::text)))),
    CONSTRAINT panel_settings_sub_formats CHECK (((sub_formats IS NULL) OR ((sub_formats <@ ARRAY['clash'::text, 'sing-box'::text, 'links'::text, 'surge'::text, 'surfboard'::text]) AND (array_position(sub_formats, NULL::text) IS NULL)))),
    CONSTRAINT panel_settings_sub_import_clients CHECK (((sub_import_clients IS NULL) OR ((sub_import_clients <@ ARRAY['clash'::text, 'stash'::text, 'shadowrocket'::text, 'sing-box'::text, 'hiddify'::text, 'surge'::text, 'surfboard'::text]) AND (array_position(sub_import_clients, NULL::text) IS NULL)))),
    CONSTRAINT panel_settings_timezone_check CHECK (((timezone IS NULL) OR ((char_length(timezone) >= 1) AND (char_length(timezone) <= 64)))),
    CONSTRAINT panel_settings_traffic_daily_retention_days_check CHECK (((traffic_daily_retention_days = 0) OR ((traffic_daily_retention_days >= 32) AND (traffic_daily_retention_days <= 36500)))),
    CONSTRAINT panel_settings_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY panel_settings
    ADD CONSTRAINT panel_settings_pkey PRIMARY KEY (id);

CREATE TRIGGER panel_settings_notify AFTER INSERT OR DELETE OR UPDATE ON panel_settings
    FOR EACH STATEMENT
    EXECUTE FUNCTION akari_settings_notify();

CREATE TRIGGER panel_settings_timezone BEFORE INSERT OR UPDATE OF timezone ON panel_settings
    FOR EACH ROW
    EXECUTE FUNCTION akari_check_timezone();

CREATE TABLE access_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    admin_prefix text,
    admin_allow_cidrs text[] DEFAULT '{}'::text[] NOT NULL,
    sub_path text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT access_settings_admin_prefix CHECK (((admin_prefix IS NULL) OR (admin_prefix ~ '^[A-Za-z0-9_-]{4,64}$'::text))),
    CONSTRAINT access_settings_allow_count CHECK ((cardinality(admin_allow_cidrs) <= 64)),
    CONSTRAINT access_settings_distinct CHECK (((admin_prefix IS NULL) OR (sub_path IS NULL) OR (admin_prefix <> sub_path))),
    CONSTRAINT access_settings_id_check CHECK ((id = 1)),
    CONSTRAINT access_settings_sub_path CHECK (((sub_path IS NULL) OR (sub_path ~ '^[A-Za-z0-9_-]{4,64}$'::text))),
    CONSTRAINT access_settings_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY access_settings
    ADD CONSTRAINT access_settings_pkey PRIMARY KEY (id);

CREATE TRIGGER access_settings_notify AFTER INSERT OR DELETE OR UPDATE ON access_settings
    FOR EACH STATEMENT
    EXECUTE FUNCTION akari_settings_notify();

-- What uses the preferred entries: main = install links, mail links,
-- payment notify URLs, passkeys' RP ID; subscription = subscription links
-- (or, with panel_settings.sub_domain_per_user, each user's own choice
-- among all subscription domains by rendezvous hashing); node = new
-- bootstrap files and install scripts (every node name ever written into
-- one stays in grpc_server_names: the certificate's SAN set only grows).
-- Changes notify every instance like the other settings.
CREATE TABLE site_domains (
    id bigint NOT NULL,
    kind text NOT NULL,
    domain text NOT NULL,
    host text NOT NULL,
    preferred boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_domains_domain CHECK (((char_length(domain) >= 1) AND (char_length(domain) <= 300))),
    CONSTRAINT site_domains_host CHECK (((char_length(host) >= 1) AND (char_length(host) <= 253))),
    CONSTRAINT site_domains_kind CHECK ((kind = ANY (ARRAY['main'::text, 'sub'::text, 'node'::text])))
);

ALTER TABLE site_domains ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME site_domains_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY site_domains
    ADD CONSTRAINT site_domains_kind_host_key UNIQUE (kind, host);

ALTER TABLE ONLY site_domains
    ADD CONSTRAINT site_domains_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX site_domains_http_host ON site_domains USING btree (host) WHERE (kind = ANY (ARRAY['main'::text, 'sub'::text]));

CREATE UNIQUE INDEX site_domains_one_preferred ON site_domains USING btree (kind) WHERE preferred;

CREATE TRIGGER site_domains_notify AFTER INSERT OR DELETE OR UPDATE ON site_domains
    FOR EACH STATEMENT
    EXECUTE FUNCTION akari_settings_notify();

CREATE CONSTRAINT TRIGGER site_domains_preferred AFTER INSERT OR DELETE OR UPDATE ON site_domains DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION site_domains_preferred();

CREATE TABLE auth_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    turnstile_site_key text,
    turnstile_secret_enc bytea,
    turnstile_login boolean DEFAULT false NOT NULL,
    turnstile_register boolean DEFAULT false NOT NULL,
    turnstile_reset boolean DEFAULT false NOT NULL,
    honeypot boolean DEFAULT true NOT NULL,
    min_submit_secs integer DEFAULT 2 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    passkey_only_admins boolean DEFAULT false NOT NULL,
    passkey_only_users boolean DEFAULT false NOT NULL,
    passkey_prompt boolean DEFAULT false NOT NULL,
    CONSTRAINT auth_settings_id_check CHECK ((id = 1)),
    CONSTRAINT auth_settings_min_submit_secs CHECK (((min_submit_secs >= 0) AND (min_submit_secs <= 60))),
    CONSTRAINT auth_settings_site_key CHECK (((turnstile_site_key IS NULL) OR (turnstile_site_key ~ '^[A-Za-z0-9_-]{1,128}$'::text))),
    CONSTRAINT auth_settings_turnstile_keys CHECK (((NOT (turnstile_login OR turnstile_register OR turnstile_reset)) OR ((turnstile_site_key IS NOT NULL) AND (turnstile_secret_enc IS NOT NULL)))),
    CONSTRAINT auth_settings_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY auth_settings
    ADD CONSTRAINT auth_settings_pkey PRIMARY KEY (id);

CREATE TABLE signup_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    register_enabled boolean DEFAULT false NOT NULL,
    invite_required boolean DEFAULT false NOT NULL,
    invite_single_use boolean DEFAULT false NOT NULL,
    email_domains text[] DEFAULT '{}'::text[] NOT NULL,
    trial_plan_id uuid,
    trial_days integer DEFAULT 1 NOT NULL,
    reset_enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email_verify boolean DEFAULT false NOT NULL,
    passkey_register boolean DEFAULT false NOT NULL,
    user_invites boolean DEFAULT true NOT NULL,
    CONSTRAINT signup_settings_email_domains_check CHECK (((cardinality(email_domains) <= 100) AND (array_position(email_domains, NULL::text) IS NULL))),
    CONSTRAINT signup_settings_id_check CHECK ((id = 1)),
    CONSTRAINT signup_settings_trial_days_check CHECK (((trial_days >= 1) AND (trial_days <= 3650))),
    CONSTRAINT signup_settings_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY signup_settings
    ADD CONSTRAINT signup_settings_pkey PRIMARY KEY (id);

CREATE TABLE site_branding (
    id smallint NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    logo bytea,
    logo_sha256 bytea,
    favicon bytea,
    favicon_sha256 bytea,
    footer_text text,
    footer_links jsonb DEFAULT '[]'::jsonb NOT NULL,
    tos_url text,
    privacy_url text,
    client_downloads jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_branding_client_downloads_check CHECK ((jsonb_typeof(client_downloads) = 'array'::text)),
    CONSTRAINT site_branding_favicon_check CHECK (((favicon IS NULL) OR ((octet_length(favicon) >= 8) AND (octet_length(favicon) <= 65536)))),
    CONSTRAINT site_branding_favicon_pair CHECK (((favicon IS NULL) = (favicon_sha256 IS NULL))),
    CONSTRAINT site_branding_footer_links_check CHECK ((jsonb_typeof(footer_links) = 'array'::text)),
    CONSTRAINT site_branding_footer_text_check CHECK (((footer_text IS NULL) OR ((char_length(footer_text) >= 1) AND (char_length(footer_text) <= 500)))),
    CONSTRAINT site_branding_id_check CHECK ((id = 1)),
    CONSTRAINT site_branding_logo_check CHECK (((logo IS NULL) OR ((octet_length(logo) >= 8) AND (octet_length(logo) <= 262144)))),
    CONSTRAINT site_branding_logo_pair CHECK (((logo IS NULL) = (logo_sha256 IS NULL))),
    CONSTRAINT site_branding_privacy_url_check CHECK (((privacy_url IS NULL) OR ((char_length(privacy_url) >= 1) AND (char_length(privacy_url) <= 2048)))),
    CONSTRAINT site_branding_tos_url_check CHECK (((tos_url IS NULL) OR ((char_length(tos_url) >= 1) AND (char_length(tos_url) <= 2048)))),
    CONSTRAINT site_branding_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY site_branding
    ADD CONSTRAINT site_branding_pkey PRIMARY KEY (id);

CREATE TABLE commission_settings (
    id integer DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    rate_percent integer DEFAULT 10 NOT NULL,
    first_order_only boolean DEFAULT true NOT NULL,
    hold_days integer DEFAULT 7 NOT NULL,
    min_withdrawal_cents bigint DEFAULT 10000 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    usdt_chains text[] DEFAULT ARRAY['trc20'::text, 'plasma'::text, 'polygon'::text, 'arbitrum'::text, 'solana'::text, 'xlayer'::text, 'ton'::text] NOT NULL,
    usdt_rate_cents bigint,
    CONSTRAINT commission_settings_hold_days_check CHECK (((hold_days >= 0) AND (hold_days <= 365))),
    CONSTRAINT commission_settings_id_check CHECK ((id = 1)),
    CONSTRAINT commission_settings_min_withdrawal_cents_check CHECK (((min_withdrawal_cents >= 1) AND (min_withdrawal_cents <= 100000000))),
    CONSTRAINT commission_settings_rate_percent_check CHECK (((rate_percent >= 0) AND (rate_percent <= 100))),
    CONSTRAINT commission_settings_usdt_chains CHECK ((usdt_chains <@ ARRAY['trc20'::text, 'plasma'::text, 'polygon'::text, 'arbitrum'::text, 'solana'::text, 'xlayer'::text, 'ton'::text])),
    CONSTRAINT commission_settings_usdt_rate CHECK (((usdt_rate_cents IS NULL) OR ((usdt_rate_cents >= 1) AND (usdt_rate_cents <= 1000000))))
);

ALTER TABLE ONLY commission_settings
    ADD CONSTRAINT commission_settings_pkey PRIMARY KEY (id);

CREATE TABLE cleanup_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    auto boolean DEFAULT false NOT NULL,
    after_days integer DEFAULT 30 NOT NULL,
    warn boolean DEFAULT false NOT NULL,
    warn_days integer DEFAULT 7 NOT NULL,
    last_run_at timestamp with time zone,
    last_deleted integer DEFAULT 0 NOT NULL,
    last_warned integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cleanup_settings_after_days CHECK (((after_days >= 1) AND (after_days <= 3650))),
    CONSTRAINT cleanup_settings_counts CHECK (((last_deleted >= 0) AND (last_warned >= 0))),
    CONSTRAINT cleanup_settings_id_check CHECK ((id = 1)),
    CONSTRAINT cleanup_settings_version_check CHECK ((version >= 0)),
    CONSTRAINT cleanup_settings_warn_days CHECK (((warn_days >= 1) AND (warn_days <= 90)))
);

ALTER TABLE ONLY cleanup_settings
    ADD CONSTRAINT cleanup_settings_pkey PRIMARY KEY (id);

-- `sub_templates`: one row per client format; no row = the built-in
-- default (src/sub/templates/<format>.tmpl). Body checked by the API
-- (`sub::templates::apply_set`), not here, except for size.
CREATE TABLE sub_templates (
    format text NOT NULL,
    body text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT sub_templates_body CHECK (((length(body) >= 1) AND (length(body) <= 262144))),
    CONSTRAINT sub_templates_format CHECK ((format = ANY (ARRAY['sing-box'::text, 'clash'::text, 'surge'::text, 'surfboard'::text]))),
    CONSTRAINT sub_templates_version CHECK ((version >= 1))
);

ALTER TABLE ONLY sub_templates
    ADD CONSTRAINT sub_templates_pkey PRIMARY KEY (format);

-- Cloudflare is the only source of truth for zones and records — nothing
-- of them is stored here. A row is one token (one Cloudflare account or a
-- token limited to some zones): `token_enc` is the token sealed with
-- data/master.key (`masterkey::Keys::seal`, AAD = the row id), the API only
-- ever shows that it is set plus `token_fingerprint` (first 12 hex digits of
-- its SHA-256), the audit log records it as "changed". Written by the owner
-- only (`dns::accounts`); `version` is the optimistic-concurrency counter.
CREATE TABLE dns_accounts (
    id uuid NOT NULL,
    name text NOT NULL,
    token_enc bytea NOT NULL,
    token_fingerprint text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dns_accounts_fingerprint CHECK ((token_fingerprint ~ '^[0-9a-f]{12}$'::text)),
    CONSTRAINT dns_accounts_name CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64))),
    CONSTRAINT dns_accounts_version CHECK ((version >= 1))
);

ALTER TABLE ONLY dns_accounts
    ADD CONSTRAINT dns_accounts_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX dns_accounts_name_key ON dns_accounts USING btree (lower(name));

-- =========================================================================
-- Mail
-- =========================================================================

CREATE TABLE mail_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    host text,
    port integer DEFAULT 587 NOT NULL,
    security text DEFAULT 'starttls'::text NOT NULL,
    username text,
    password_enc bytea,
    from_addr text,
    from_name text,
    notify_order_paid boolean DEFAULT true NOT NULL,
    notify_expiry_days integer DEFAULT 3 NOT NULL,
    notify_expired boolean DEFAULT true NOT NULL,
    notify_quota boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notify_refund boolean DEFAULT true NOT NULL,
    provider text DEFAULT 'smtp'::text NOT NULL,
    api_key_enc bytea,
    CONSTRAINT mail_settings_enabled_complete CHECK (((NOT enabled) OR ((from_addr IS NOT NULL) AND
CASE provider
    WHEN 'smtp'::text THEN (host IS NOT NULL)
    WHEN 'resend'::text THEN (api_key_enc IS NOT NULL)
    ELSE NULL::boolean
END))),
    CONSTRAINT mail_settings_from_name CHECK ((length(from_name) <= 64)),
    CONSTRAINT mail_settings_notify_expiry_days CHECK (((notify_expiry_days >= 0) AND (notify_expiry_days <= 30))),
    CONSTRAINT mail_settings_plain_no_auth CHECK (((security <> 'none'::text) OR (username IS NULL))),
    CONSTRAINT mail_settings_port CHECK (((port >= 1) AND (port <= 65535))),
    CONSTRAINT mail_settings_provider CHECK ((provider = ANY (ARRAY['smtp'::text, 'resend'::text]))),
    CONSTRAINT mail_settings_security CHECK ((security = ANY (ARRAY['starttls'::text, 'tls'::text, 'none'::text]))),
    CONSTRAINT mail_settings_single_row CHECK ((id = 1)),
    CONSTRAINT mail_settings_version CHECK ((version >= 0))
);

ALTER TABLE ONLY mail_settings
    ADD CONSTRAINT mail_settings_pkey PRIMARY KEY (id);

CREATE TABLE mail_outbox (
    id bigint NOT NULL,
    kind text NOT NULL,
    user_id uuid,
    to_addr text NOT NULL,
    subject text NOT NULL,
    body_text text NOT NULL,
    body_html text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_until timestamp with time zone,
    claim_token uuid,
    discard_after timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT mail_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT mail_outbox_kind_check CHECK ((kind = ANY (ARRAY['register_code'::text, 'register_exists'::text, 'email_code'::text, 'password_reset'::text, 'order_paid'::text, 'expiry_soon'::text, 'expired'::text, 'quota_80'::text, 'quota_100'::text, 'test'::text, 'ticket_reply'::text, 'ticket_new'::text, 'node_alert'::text, 'announcement'::text, 'admin_notice'::text, 'refund'::text, 'security_notice'::text, 'login_code'::text]))),
    CONSTRAINT mail_outbox_settled_at CHECK (((status = 'pending'::text) = (settled_at IS NULL))),
    CONSTRAINT mail_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'dead'::text])))
);

ALTER TABLE mail_outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mail_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY mail_outbox
    ADD CONSTRAINT mail_outbox_pkey PRIMARY KEY (id);

CREATE INDEX mail_outbox_due ON mail_outbox USING btree (next_attempt_at, id) WHERE (status = 'pending'::text);

CREATE INDEX mail_outbox_settled ON mail_outbox USING btree (status, settled_at) WHERE (status <> 'pending'::text);

CREATE INDEX mail_outbox_user ON mail_outbox USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE TABLE mail_templates (
    kind text NOT NULL,
    locale text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    html_source text,
    CONSTRAINT mail_templates_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 20000))),
    CONSTRAINT mail_templates_html_check CHECK (((html_source IS NULL) OR ((char_length(html_source) >= 1) AND (char_length(html_source) <= 100000)))),
    CONSTRAINT mail_templates_kind_check CHECK ((kind = ANY (ARRAY['register_code'::text, 'register_exists'::text, 'email_code'::text, 'password_reset'::text, 'order_paid'::text, 'expiry_soon'::text, 'expired'::text, 'quota_80'::text, 'quota_100'::text, 'test'::text, 'ticket_reply'::text, 'ticket_new'::text, 'node_alert'::text, 'announcement'::text, 'admin_notice'::text, 'refund'::text, 'security_notice'::text, 'login_code'::text]))),
    CONSTRAINT mail_templates_locale_check CHECK ((locale = ANY (ARRAY['zh'::text, 'en'::text]))),
    CONSTRAINT mail_templates_subject_check CHECK ((((char_length(subject) >= 1) AND (char_length(subject) <= 200)) AND (subject !~ '[[:cntrl:]]'::text))),
    CONSTRAINT mail_templates_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY mail_templates
    ADD CONSTRAINT mail_templates_pkey PRIMARY KEY (kind, locale);

CREATE TABLE user_notices (
    user_id uuid NOT NULL,
    kind text NOT NULL,
    key text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_notices_kind_check CHECK ((kind = ANY (ARRAY['expiry_soon'::text, 'expired'::text, 'quota_80'::text, 'quota_100'::text])))
);

ALTER TABLE ONLY user_notices
    ADD CONSTRAINT user_notices_pkey PRIMARY KEY (user_id, kind);

-- =========================================================================
-- Tickets, announcements, knowledge base
-- =========================================================================

CREATE TABLE tickets (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    subject text NOT NULL,
    category text NOT NULL,
    priority text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    order_id uuid,
    node_id uuid,
    assignee_id uuid,
    messages integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_user_at timestamp with time zone,
    last_staff_at timestamp with time zone,
    user_read_at timestamp with time zone,
    staff_read_at timestamp with time zone,
    closed_at timestamp with time zone,
    closed_by text,
    CONSTRAINT tickets_category_check CHECK ((category = ANY (ARRAY['general'::text, 'billing'::text, 'technical'::text, 'account'::text, 'other'::text]))),
    CONSTRAINT tickets_closed_at CHECK (((status = 'closed'::text) = (closed_at IS NOT NULL))),
    CONSTRAINT tickets_closed_by_check CHECK ((closed_by = ANY (ARRAY['user'::text, 'staff'::text]))),
    CONSTRAINT tickets_closed_by_pair CHECK (((closed_at IS NULL) = (closed_by IS NULL))),
    CONSTRAINT tickets_messages_check CHECK (((messages >= 0) AND (messages <= 200))),
    CONSTRAINT tickets_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'answered'::text, 'closed'::text]))),
    CONSTRAINT tickets_subject_check CHECK (((char_length(subject) >= 1) AND (char_length(subject) <= 120)))
);

ALTER TABLE ONLY tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);

CREATE INDEX tickets_assignee ON tickets USING btree (assignee_id) WHERE (assignee_id IS NOT NULL);

CREATE INDEX tickets_node ON tickets USING btree (node_id) WHERE (node_id IS NOT NULL);

CREATE INDEX tickets_open ON tickets USING btree (status) WHERE (status <> 'closed'::text);

CREATE INDEX tickets_order ON tickets USING btree (order_id) WHERE (order_id IS NOT NULL);

CREATE INDEX tickets_queue ON tickets USING btree (updated_at DESC, id);

CREATE INDEX tickets_user ON tickets USING btree (user_id, updated_at DESC, id);

CREATE TABLE ticket_messages (
    id bigint NOT NULL,
    ticket_id uuid NOT NULL,
    author_id uuid,
    author_label text NOT NULL,
    staff boolean NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_messages_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 5000)))
);

ALTER TABLE ticket_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ticket_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY ticket_messages
    ADD CONSTRAINT ticket_messages_pkey PRIMARY KEY (id);

CREATE INDEX ticket_messages_author ON ticket_messages USING btree (author_id) WHERE (author_id IS NOT NULL);

CREATE INDEX ticket_messages_ticket ON ticket_messages USING btree (ticket_id, id);

-- A tag used by an announcement cannot be deleted (ON DELETE RESTRICT; the
-- API answers 409 with the count first), only disabled: a disabled tag stays
-- on the announcements that have it but cannot be picked for new ones.
CREATE TABLE announcement_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name_zh text NOT NULL,
    name_en text,
    color text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcement_tags_color CHECK ((color = ANY (ARRAY['red'::text, 'orange'::text, 'amber'::text, 'green'::text, 'teal'::text, 'cyan'::text, 'blue'::text, 'indigo'::text, 'violet'::text, 'pink'::text, 'slate'::text]))),
    CONSTRAINT announcement_tags_name_en CHECK (((name_en IS NULL) OR ((char_length(name_en) >= 1) AND (char_length(name_en) <= 12)))),
    CONSTRAINT announcement_tags_name_zh CHECK (((char_length(name_zh) >= 1) AND (char_length(name_zh) <= 12))),
    CONSTRAINT announcement_tags_sort CHECK (((sort >= '-1000000'::integer) AND (sort <= 1000000)))
);

ALTER TABLE ONLY announcement_tags
    ADD CONSTRAINT announcement_tags_pkey PRIMARY KEY (id);

CREATE INDEX announcement_tags_order ON announcement_tags USING btree (sort, created_at, id);

CREATE TABLE announcements (
    id uuid NOT NULL,
    title_zh text NOT NULL,
    title_en text,
    body_zh text NOT NULL,
    body_en text,
    pinned boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    visible_from timestamp with time zone,
    visible_until timestamp with time zone,
    audience text DEFAULT 'all'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mail_requested_at timestamp with time zone,
    mail_cursor uuid,
    mail_sent integer DEFAULT 0 NOT NULL,
    mail_done_at timestamp with time zone,
    tag_id uuid,
    CONSTRAINT announcements_audience_check CHECK ((audience = ANY (ARRAY['all'::text, 'with_plan'::text, 'without_plan'::text]))),
    CONSTRAINT announcements_body_en_check CHECK (((body_en IS NULL) OR ((char_length(body_en) >= 1) AND (char_length(body_en) <= 65536)))),
    CONSTRAINT announcements_body_zh_check CHECK (((char_length(body_zh) >= 1) AND (char_length(body_zh) <= 65536))),
    CONSTRAINT announcements_mail_done_after_request CHECK (((mail_done_at IS NULL) OR (mail_requested_at IS NOT NULL))),
    CONSTRAINT announcements_mail_sent_check CHECK ((mail_sent >= 0)),
    CONSTRAINT announcements_title_en_check CHECK (((title_en IS NULL) OR ((char_length(title_en) >= 1) AND (char_length(title_en) <= 120)))),
    CONSTRAINT announcements_title_zh_check CHECK (((char_length(title_zh) >= 1) AND (char_length(title_zh) <= 120))),
    CONSTRAINT announcements_visible_window CHECK (((visible_from IS NULL) OR (visible_until IS NULL) OR (visible_from < visible_until)))
);

ALTER TABLE ONLY announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);

CREATE INDEX announcements_mail_due ON announcements USING btree (mail_requested_at) WHERE ((mail_requested_at IS NOT NULL) AND (mail_done_at IS NULL));

CREATE INDEX announcements_order ON announcements USING btree (pinned DESC, created_at DESC, id);

CREATE INDEX announcements_tag ON announcements USING btree (tag_id) WHERE (tag_id IS NOT NULL);

CREATE TABLE announcement_reads (
    announcement_id uuid NOT NULL,
    user_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY announcement_reads
    ADD CONSTRAINT announcement_reads_pkey PRIMARY KEY (announcement_id, user_id);

CREATE INDEX announcement_reads_user ON announcement_reads USING btree (user_id);

CREATE TABLE kb_categories (
    id uuid NOT NULL,
    name_zh text NOT NULL,
    name_en text,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_categories_name_en_check CHECK (((name_en IS NULL) OR ((char_length(name_en) >= 1) AND (char_length(name_en) <= 64)))),
    CONSTRAINT kb_categories_name_zh_check CHECK (((char_length(name_zh) >= 1) AND (char_length(name_zh) <= 64))),
    CONSTRAINT kb_categories_sort_check CHECK (((sort >= '-1000000'::integer) AND (sort <= 1000000)))
);

ALTER TABLE ONLY kb_categories
    ADD CONSTRAINT kb_categories_pkey PRIMARY KEY (id);

CREATE TABLE kb_articles (
    id uuid NOT NULL,
    category_id uuid,
    title_zh text NOT NULL,
    title_en text,
    body_zh text NOT NULL,
    body_en text,
    sort integer DEFAULT 0 NOT NULL,
    published boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    slug text,
    CONSTRAINT kb_articles_body_en_check CHECK (((body_en IS NULL) OR ((char_length(body_en) >= 1) AND (char_length(body_en) <= 65536)))),
    CONSTRAINT kb_articles_body_zh_check CHECK (((char_length(body_zh) >= 1) AND (char_length(body_zh) <= 65536))),
    CONSTRAINT kb_articles_slug_format CHECK (((slug IS NULL) OR (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'::text))),
    CONSTRAINT kb_articles_sort_check CHECK (((sort >= '-1000000'::integer) AND (sort <= 1000000))),
    CONSTRAINT kb_articles_title_en_check CHECK (((title_en IS NULL) OR ((char_length(title_en) >= 1) AND (char_length(title_en) <= 120)))),
    CONSTRAINT kb_articles_title_zh_check CHECK (((char_length(title_zh) >= 1) AND (char_length(title_zh) <= 120)))
);

ALTER TABLE ONLY kb_articles
    ADD CONSTRAINT kb_articles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY kb_articles
    ADD CONSTRAINT kb_articles_slug_key UNIQUE (slug);

CREATE INDEX kb_articles_category ON kb_articles USING btree (category_id, sort, created_at);

CREATE INDEX kb_articles_published ON kb_articles USING btree (sort, created_at) WHERE published;

-- =========================================================================
-- Audit and admin batch jobs
-- =========================================================================

CREATE TABLE audit_log (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    actor_label text NOT NULL,
    ip text,
    action text NOT NULL,
    target_type text,
    target_id text,
    before jsonb,
    after jsonb
);

ALTER TABLE audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

CREATE INDEX audit_log_action ON audit_log USING btree (action, id);

CREATE INDEX audit_log_actor_label ON audit_log USING btree (actor_label, id);

CREATE INDEX audit_log_at ON audit_log USING btree (at);

CREATE TABLE admin_batch_jobs (
    id uuid NOT NULL,
    actor_id uuid,
    actor_label text NOT NULL,
    action text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    selection text NOT NULL,
    filter jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    total integer NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    last_error text,
    claimed_until timestamp with time zone,
    claim_token uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT admin_batch_jobs_action_valid CHECK ((action = ANY (ARRAY['extend_expiry'::text, 'reset_traffic'::text, 'ban'::text, 'unban'::text, 'set_plan'::text, 'cancel_plan'::text, 'add_balance'::text, 'send_email'::text]))),
    CONSTRAINT admin_batch_jobs_done_check CHECK ((done >= 0)),
    CONSTRAINT admin_batch_jobs_failed_check CHECK ((failed >= 0)),
    CONSTRAINT admin_batch_jobs_finished_at CHECK (((status = ANY (ARRAY['done'::text, 'cancelled'::text, 'failed'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT admin_batch_jobs_progress_le_total CHECK ((((done + failed) + skipped) <= total)),
    CONSTRAINT admin_batch_jobs_selection_check CHECK ((selection = ANY (ARRAY['ids'::text, 'filter'::text]))),
    CONSTRAINT admin_batch_jobs_skipped_check CHECK ((skipped >= 0)),
    CONSTRAINT admin_batch_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT admin_batch_jobs_total_check CHECK ((total >= 0))
);

ALTER TABLE ONLY admin_batch_jobs
    ADD CONSTRAINT admin_batch_jobs_pkey PRIMARY KEY (id);

CREATE INDEX admin_batch_jobs_open ON admin_batch_jobs USING btree (created_at) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));

CREATE INDEX admin_batch_jobs_recent ON admin_batch_jobs USING btree (created_at DESC);

CREATE TABLE admin_batch_items (
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    user_label text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    detail text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_batch_items_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text, 'skipped'::text])))
);

ALTER TABLE ONLY admin_batch_items
    ADD CONSTRAINT admin_batch_items_pkey PRIMARY KEY (job_id, user_id);

CREATE INDEX admin_batch_items_pending ON admin_batch_items USING btree (job_id, user_id) WHERE (status = 'pending'::text);

-- =========================================================================
-- Foreign keys (after all tables: some reference each other)
-- =========================================================================

ALTER TABLE ONLY admin_batch_items
    ADD CONSTRAINT admin_batch_items_job_id_fkey FOREIGN KEY (job_id) REFERENCES admin_batch_jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_release_chunks
    ADD CONSTRAINT agent_release_chunks_release_id_fkey FOREIGN KEY (release_id) REFERENCES agent_releases(id) ON DELETE CASCADE;

ALTER TABLE ONLY alert_notifications
    ADD CONSTRAINT alert_notifications_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES server_alerts(id) ON DELETE CASCADE;

ALTER TABLE ONLY announcement_reads
    ADD CONSTRAINT announcement_reads_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE;

ALTER TABLE ONLY announcement_reads
    ADD CONSTRAINT announcement_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY announcements
    ADD CONSTRAINT announcements_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES announcement_tags(id) ON DELETE RESTRICT;

ALTER TABLE ONLY balance_ledger
    ADD CONSTRAINT balance_ledger_commission FOREIGN KEY (commission_id) REFERENCES commissions(id);

ALTER TABLE ONLY balance_ledger
    ADD CONSTRAINT balance_ledger_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY balance_ledger
    ADD CONSTRAINT balance_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY balance_ledger
    ADD CONSTRAINT balance_ledger_withdrawal FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(id);

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_invitee_id_fkey FOREIGN KEY (invitee_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES balance_ledger(id);

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES coupons(id);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY coupons
    ADD CONSTRAINT coupons_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES coupon_batches(id) ON DELETE SET NULL;

ALTER TABLE ONLY email_codes
    ADD CONSTRAINT email_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY entrance_group_members
    ADD CONSTRAINT entrance_group_members_entrance_id_fkey FOREIGN KEY (entrance_id) REFERENCES entrances(id) ON DELETE CASCADE;

ALTER TABLE ONLY entrance_group_members
    ADD CONSTRAINT entrance_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES node_groups(id) ON DELETE CASCADE;

ALTER TABLE ONLY entrance_rate_rules
    ADD CONSTRAINT entrance_rate_rules_entrance_id_fkey FOREIGN KEY (entrance_id) REFERENCES entrances(id) ON DELETE CASCADE;

ALTER TABLE ONLY entrance_users
    ADD CONSTRAINT entrance_users_entrance_id_fkey FOREIGN KEY (entrance_id) REFERENCES entrances(id) ON DELETE CASCADE;

ALTER TABLE ONLY entrance_users
    ADD CONSTRAINT entrance_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY entrance_users_departed
    ADD CONSTRAINT entrance_users_departed_entrance_id_fkey FOREIGN KEY (entrance_id) REFERENCES entrances(id) ON DELETE CASCADE;

ALTER TABLE ONLY entrance_users_departed
    ADD CONSTRAINT entrance_users_departed_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY entrances
    ADD CONSTRAINT entrances_node_id_fkey FOREIGN KEY (node_id, server_id) REFERENCES nodes(id, server_id) ON DELETE CASCADE;

ALTER TABLE ONLY invite_codes
    ADD CONSTRAINT invite_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY kb_articles
    ADD CONSTRAINT kb_articles_category_id_fkey FOREIGN KEY (category_id) REFERENCES kb_categories(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail_outbox
    ADD CONSTRAINT mail_outbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL;

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_credit_order_id_fkey FOREIGN KEY (credit_order_id) REFERENCES orders(id) ON DELETE SET NULL;

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_prior_user_plan_id_fkey FOREIGN KEY (prior_user_plan_id) REFERENCES user_plans(id) ON DELETE SET NULL;

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY password_resets
    ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY payment_events
    ADD CONSTRAINT payment_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

ALTER TABLE ONLY payment_events
    ADD CONSTRAINT payment_events_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id) ON DELETE SET NULL;

ALTER TABLE ONLY plan_groups
    ADD CONSTRAINT plan_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES node_groups(id) ON DELETE CASCADE;

ALTER TABLE ONLY plan_groups
    ADD CONSTRAINT plan_groups_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE;

ALTER TABLE ONLY plan_period_prices
    ADD CONSTRAINT plan_period_prices_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE;

ALTER TABLE ONLY rollout_servers
    ADD CONSTRAINT rollout_servers_rollout_id_fkey FOREIGN KEY (rollout_id) REFERENCES rollouts(id) ON DELETE CASCADE;

ALTER TABLE ONLY rollout_servers
    ADD CONSTRAINT rollout_servers_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_alert_rules
    ADD CONSTRAINT server_alert_rules_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_alerts
    ADD CONSTRAINT server_alerts_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_block_counters
    ADD CONSTRAINT server_block_counters_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_block_daily
    ADD CONSTRAINT server_block_daily_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES block_rules(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_block_daily
    ADD CONSTRAINT server_block_daily_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_enrollments
    ADD CONSTRAINT server_enrollments_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_latency
    ADD CONSTRAINT server_latency_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_metrics_1h
    ADD CONSTRAINT server_metrics_1h_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY server_metrics_1m
    ADD CONSTRAINT server_metrics_1m_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY signup_settings
    ADD CONSTRAINT signup_settings_trial_plan_id_fkey FOREIGN KEY (trial_plan_id) REFERENCES plans(id) ON DELETE SET NULL;

ALTER TABLE ONLY ticket_messages
    ADD CONSTRAINT ticket_messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY ticket_messages
    ADD CONSTRAINT ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;

ALTER TABLE ONLY tickets
    ADD CONSTRAINT tickets_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY tickets
    ADD CONSTRAINT tickets_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL;

ALTER TABLE ONLY tickets
    ADD CONSTRAINT tickets_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

ALTER TABLE ONLY tickets
    ADD CONSTRAINT tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY traffic_sessions
    ADD CONSTRAINT traffic_sessions_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_balances
    ADD CONSTRAINT user_balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_notices
    ADD CONSTRAINT user_notices_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_plan_groups
    ADD CONSTRAINT user_plan_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES node_groups(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_plan_groups
    ADD CONSTRAINT user_plan_groups_user_plan_id_fkey FOREIGN KEY (user_plan_id) REFERENCES user_plans(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_plans
    ADD CONSTRAINT user_plans_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_plans
    ADD CONSTRAINT user_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY users
    ADD CONSTRAINT users_disabled_by_fkey FOREIGN KEY (disabled_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY users
    ADD CONSTRAINT users_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- =========================================================================
-- Seed rows: the single-row settings tables (code expects id = 1 / TRUE) and presets
-- =========================================================================

INSERT INTO access_settings (id) VALUES (1);
INSERT INTO agent_update_settings (id) VALUES (true);
INSERT INTO alert_settings (id) VALUES (1);
INSERT INTO auth_settings (id) VALUES (1);
INSERT INTO cleanup_settings (id) VALUES (1);
INSERT INTO commission_settings (id) VALUES (1);
INSERT INTO mail_settings (id) VALUES (1);
INSERT INTO panel_settings (id) VALUES (1);
INSERT INTO signup_settings (id) VALUES (1);
INSERT INTO site_branding (id) VALUES (1);

-- The built-in audit rule sets: only switched on or off and ordered by the
-- operator, never created or deleted.
INSERT INTO block_rules (kind, builtin_key, name, enabled, sort) VALUES
    ('builtin', 'bittorrent', 'BitTorrent 协议识别', true, -30),
    ('builtin', 'bt_tracker', 'BT Tracker 域名', true, -20),
    ('builtin', 'xunlei_pt', '迅雷 / PT 站域名', false, -10);

-- Announcement tag presets.
INSERT INTO announcement_tags (name_zh, name_en, color, sort) VALUES
    ('活动', 'Event', 'pink', 0),
    ('维护', 'Maintenance', 'amber', 1),
    ('调整', 'Change', 'blue', 2),
    ('新功能', 'New feature', 'violet', 3),
    ('优惠', 'Offer', 'green', 4),
    ('重要', 'Important', 'red', 5),
    ('新线路', 'New route', 'teal', 6),
    ('通知', 'Notice', 'slate', 7);

-- The month partitions of traffic_daily from last month to two months ahead.
SELECT akari_ensure_traffic_partitions(1, 2);
