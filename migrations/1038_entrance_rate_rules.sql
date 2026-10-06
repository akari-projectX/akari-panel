-- D9 (W28-b): time-window multipliers on entrances.
--
-- An entrance has its base multiplier (entrances.rate_permille) and up to
-- 24 rules: a set of ISO weekdays (1 = Monday .. 7 = Sunday), a window in
-- minutes of the day [start_minute, end_minute) in the site time zone, and
-- a multiplier. end_minute < start_minute = the window crosses midnight (it
-- starts on a listed weekday and ends the next day); 1440 = midnight at the
-- end of the day. Where rules overlap the highest multiplier applies (the
-- API warns about overlaps); outside every rule the base applies.
--
-- `akari_entrance_rate(entrance, at)` is the one definition: traffic::
-- FLUSH_SQL settles with LEAST(rate now, rate 30 s ago) (bytes reported
-- just after a cheaper window ends are still billed at the cheaper rate:
-- only ever under-bills; windows are whole minutes, so 30 s cross at most
-- one boundary), subscriptions, the portal and the admin views show the
-- rate now.

CREATE TABLE entrance_rate_rules (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entrance_id uuid NOT NULL REFERENCES entrances(id) ON DELETE CASCADE,
    ord smallint NOT NULL,
    weekdays smallint[] NOT NULL,
    start_minute smallint NOT NULL,
    end_minute smallint NOT NULL,
    rate_permille integer NOT NULL,
    CONSTRAINT entrance_rate_rules_ord UNIQUE (entrance_id, ord),
    CONSTRAINT entrance_rate_rules_ord_range CHECK (ord BETWEEN 0 AND 23),
    CONSTRAINT entrance_rate_rules_weekdays CHECK (cardinality(weekdays) BETWEEN 1 AND 7
        AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[] AND array_position(weekdays, NULL) IS NULL),
    CONSTRAINT entrance_rate_rules_window CHECK (start_minute BETWEEN 0 AND 1439
        AND end_minute BETWEEN 1 AND 1440 AND start_minute <> end_minute),
    CONSTRAINT entrance_rate_rules_rate CHECK (rate_permille BETWEEN 0 AND 100000)
);

-- The multiplier (permille) of an entrance at `at`; NULL = no such
-- entrance.
CREATE FUNCTION akari_entrance_rate(entrance uuid, at timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    base integer;
    best integer;
    l timestamp;
    d smallint;
    prev smallint;
    m smallint;
BEGIN
    SELECT rate_permille INTO base FROM entrances WHERE id = entrance;
    IF base IS NULL OR NOT EXISTS (SELECT 1 FROM entrance_rate_rules WHERE entrance_id = entrance) THEN
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
