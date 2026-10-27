-- Money rules (audit panel-billing P3-5, P3-9).

-- P3-5: calendar-month periods keep the anchor day of the subscription's
-- first purchase. `anchor` (the subscription's `period_anchor`, set once at
-- purchase) matters when `base` is itself an anchored date: a plan bought
-- on the 31st renews 31 Jan -> 28 Feb -> 31 Mar instead of drifting to the
-- 28th for good. A `base` that is not on the (clamped) anchor day — a
-- renewal after a lapse starts from now — keeps its own day, as before.
-- Without `anchor` the behaviour is unchanged (the day of `base`, clamped
-- to the target month's end). Days are counted in the site time zone.
DROP FUNCTION akari_period_end(timestamp with time zone, text, integer);

CREATE FUNCTION akari_period_end(base timestamp with time zone, period text, days integer,
                                 anchor timestamp with time zone DEFAULT NULL)
    RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    m INTEGER := CASE period
        WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 WHEN 'half_year' THEN 6
        WHEN 'year' THEN 12 WHEN 'two_year' THEN 24 WHEN 'three_year' THEN 36
        ELSE NULL END;
    tz TEXT;
    local TIMESTAMP;
    base_day INTEGER;
    base_last INTEGER;
    want INTEGER;
    target TIMESTAMP;
    target_last INTEGER;
BEGIN
    IF base IS NULL THEN
        RAISE EXCEPTION 'akari_period_end: NULL base';
    ELSIF m IS NOT NULL THEN
        tz := akari_site_tz();
        local := base AT TIME ZONE tz;
        base_day := EXTRACT(day FROM local)::int;
        base_last := EXTRACT(day FROM date_trunc('month', local) + interval '1 month'
                                      - interval '1 day')::int;
        want := base_day;
        IF anchor IS NOT NULL
           AND base_day = LEAST(EXTRACT(day FROM anchor AT TIME ZONE tz)::int, base_last) THEN
            want := EXTRACT(day FROM anchor AT TIME ZONE tz)::int;
        END IF;
        target := date_trunc('month', local) + make_interval(months => m);
        target_last := EXTRACT(day FROM target + interval '1 month' - interval '1 day')::int;
        RETURN (target + make_interval(days => LEAST(want, target_last) - 1)
                + (local - date_trunc('day', local))) AT TIME ZONE tz;
    ELSIF period = 'onetime' AND days IS NULL THEN
        RETURN NULL;
    ELSIF period IN ('days', 'onetime') AND days BETWEEN 1 AND 3650 THEN
        RETURN base + make_interval(secs => days::bigint * 86400);
    END IF;
    RAISE EXCEPTION 'akari_period_end: bad period % (days %)', period, days;
END $$;

-- P3-9: a partial refund claws back a share of the commission. A credited
-- commission is owed `clawback_cents` (<= its amount); a PENDING one keeps
-- the reduction until it is credited (credit_due credits amount - clawback).
ALTER TABLE commissions DROP CONSTRAINT commissions_clawback;
ALTER TABLE commissions ADD CONSTRAINT commissions_clawback CHECK (
    ((clawback_cents IS NULL) = (clawed_back_at IS NULL))
    AND (clawback_cents IS NULL OR (
        clawback_cents > 0 AND clawback_cents <= amount_cents
        AND status IN ('pending', 'credited')
        AND (status = 'credited' OR clawback_cents < amount_cents)))
    AND clawback_recovered_cents >= 0
    AND clawback_recovered_cents <= COALESCE(clawback_cents, 0));
