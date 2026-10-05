-- W28-a (Q3, research/db-schema-review.md §6): the site time zone, and
-- traffic_daily partitioned by month.
--
-- 1. `panel_settings.timezone` (IANA name; NULL = Asia/Shanghai). SQL reads
--    it through `akari_site_tz()`; `akari_site_day(ts)` is the calendar day
--    of an instant in it. Days of the traffic history (`traffic::FLUSH_SQL`,
--    hence traffic_daily / traffic_entrance_daily / traffic_monthly), of
--    the block rule hit counts (`node_block_daily`), plan monthly resets
--    (`akari_next_reset`) and calendar-month plan terms
--    (`akari_period_end`) follow it. A trigger refuses a name that is not
--    in `pg_timezone_names` (an unknown zone would stop the billing flush).
-- 2. `traffic_daily` is RANGE-partitioned by month: partitions
--    `traffic_daily_YYYYMM` (fillfactor 80) are created ahead of time by
--    `akari_ensure_traffic_partitions` (reaper), a DEFAULT partition takes
--    anything else. The retention moves a whole month past the cutoff into
--    traffic_monthly and drops its partition
--    (`akari_rollup_traffic_partition`, one month per transaction): no
--    dead tuples, no index bloat. The row-wise rollup only sees the
--    boundary month and the DEFAULT partition. The BRIN index on `day` is
--    gone (partition pruning does its job). Partitions are created in the
--    schema of `traffic_daily` (testdb: one schema per test).

ALTER TABLE panel_settings ADD COLUMN timezone text;
ALTER TABLE panel_settings ADD CONSTRAINT panel_settings_timezone_check
    CHECK (timezone IS NULL OR char_length(timezone) BETWEEN 1 AND 64);

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

CREATE TRIGGER panel_settings_timezone BEFORE INSERT OR UPDATE OF timezone ON panel_settings
    FOR EACH ROW EXECUTE FUNCTION akari_check_timezone();

-- The site time zone (one row by primary key; STABLE: one value per statement).
CREATE FUNCTION akari_site_tz() RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT coalesce((SELECT timezone FROM panel_settings WHERE id = 1), 'Asia/Shanghai')
$$;

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

-- Monthly resets fall on the anchor's day and wall-clock time in the site
-- time zone (day clamped to the month's end); N-day periods are exact
-- seconds. STABLE (it reads the setting), was IMMUTABLE.
DROP FUNCTION akari_next_reset(timestamp with time zone, text, integer, timestamp with time zone);
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

-- Calendar-month terms end on the same wall-clock day and time in the site
-- time zone (clamped to the month's end), so a month bought on the 1st
-- (local) ends on the 1st (local), and term ends line up with the monthly
-- resets. STABLE (it reads the setting), was IMMUTABLE.
DROP FUNCTION akari_period_end(timestamp with time zone, text, integer);
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

-- traffic_daily by month. Rows of a development database that already ran
-- 1030 are carried over (a fresh install has none).
ALTER TABLE traffic_daily RENAME TO traffic_daily_unpartitioned;
ALTER TABLE traffic_daily_unpartitioned RENAME CONSTRAINT traffic_daily_pkey TO traffic_daily_unpartitioned_pkey;
ALTER INDEX traffic_daily_node_cov RENAME TO traffic_daily_unpartitioned_node_cov;

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
) PARTITION BY RANGE (day);

ALTER TABLE ONLY traffic_daily ADD CONSTRAINT traffic_daily_pkey PRIMARY KEY (user_id, day, entrance_id);
CREATE INDEX traffic_daily_node_cov ON traffic_daily USING btree (node_id, day) INCLUDE (user_id, up_bytes, down_bytes, billed_bytes);

CREATE TABLE traffic_daily_default PARTITION OF traffic_daily DEFAULT WITH (fillfactor='80');

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

-- Partitions for the rows carried over, then the default window.
DO $$
DECLARE
    m date;
BEGIN
    FOR m IN SELECT DISTINCT date_trunc('month', day)::date FROM traffic_daily_unpartitioned LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF traffic_daily FOR VALUES FROM (%L) TO (%L) WITH (fillfactor=''80'')',
            'traffic_daily_' || to_char(m, 'YYYYMM'), m, (m + interval '1 month')::date);
    END LOOP;
END $$;
SELECT akari_ensure_traffic_partitions(1, 2);

INSERT INTO traffic_daily (user_id, day, node_id, up_bytes, down_bytes, billed_bytes, entrance_id)
SELECT user_id, day, node_id, up_bytes, down_bytes, billed_bytes, entrance_id
FROM traffic_daily_unpartitioned;
DROP TABLE traffic_daily_unpartitioned;
