-- next07: entrance multipliers — a manual change only ever under-bills,
-- optimistic concurrency for the entrance form, and the operator switch
-- for multipliers in subscription line names.
--
-- 1. Rate-change boundary. Bytes moved before a change of the base
--    multiplier (or of the time-window rules) reach the panel up to one
--    agent report (10 s) plus one flush (5 s) later. Settlement already
--    takes the lower of the rate now and 30 s ago (D9, 1038); a change now
--    records the lowest rate the old configuration had over that window
--    (`rate_prev_permille`, at `rate_changed_at`), and
--    `akari_entrance_rate(e, at)` answers it for `at` in the 30 s before
--    the change. So for 30 s after a change the settlement bills the lower
--    of the old and new rates: 1x -> 10x bills the straddling bytes at 1x,
--    10x -> 1x at 1x (never more than either rate alone). Base changes are
--    recorded by a trigger (every write path); rule changes by
--    `rates::apply_set_rules`. Changes within 30 s of each other compose:
--    the recorded rate is the minimum over the window, earlier record
--    included.
-- 2. `entrances.version`: +1 on every admin update (`entrances::
--    apply_update`); a PATCH carrying a stale version is refused (409
--    `entrance.version_conflict`).
-- 3. `panel_settings.sub_name_rate`: subscription line names carry the
--    base multiplier (NULL = off: names never change with the rate).

ALTER TABLE entrances
    ADD COLUMN version bigint DEFAULT 1 NOT NULL,
    ADD COLUMN rate_prev_permille integer,
    ADD COLUMN rate_changed_at timestamp with time zone,
    ADD CONSTRAINT entrances_version CHECK (version >= 1),
    ADD CONSTRAINT entrances_rate_prev CHECK ((rate_prev_permille IS NULL) = (rate_changed_at IS NULL)
        AND rate_prev_permille BETWEEN 0 AND 100000);

ALTER TABLE panel_settings ADD COLUMN sub_name_rate boolean;

-- The settlement window (D9): bytes are billed at the lowest rate the
-- entrance had over this long before the flush.
CREATE FUNCTION akari_rate_window() RETURNS interval
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT interval '30 seconds' $$;

-- The multiplier (permille) of an entrance at `at`; NULL = no such
-- entrance. In the window before a recorded change: the rate recorded
-- for it (the old configuration's lowest over the window).
CREATE OR REPLACE FUNCTION akari_entrance_rate(entrance uuid, at timestamp with time zone) RETURNS integer
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

-- Record a base change (every write path). In a BEFORE trigger the
-- function still reads the old row.
CREATE FUNCTION akari_entrance_rate_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.rate_prev_permille := akari_entrance_settle_rate(OLD.id);
    NEW.rate_changed_at := statement_timestamp();
    RETURN NEW;
END $$;

CREATE TRIGGER entrances_rate_changed BEFORE UPDATE OF rate_permille ON entrances
    FOR EACH ROW WHEN (OLD.rate_permille IS DISTINCT FROM NEW.rate_permille)
    EXECUTE FUNCTION akari_entrance_rate_changed();
