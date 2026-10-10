-- Backlogged traffic is settled at the time-weighted mean multiplier of
-- the period it covers (decision 2026-10-10).
--
-- A flush settles each row's delta = what the agent counted since the
-- row was last written. Normally that is the last report interval and
-- D9's settle rate (the lower of now and 30 s ago) applies. After an agent
-- or panel outage (a reconnect gap or flush-outage credit lowers the
-- server's floor below the burst window: traffic::FLUSH_SQL `nf`) a single
-- delta covers the whole outage: billing all of it at the multiplier of the
-- moment of reconnection under- or over-bills whenever the outage crossed
-- a time-window rule (an evening 2x window missed entirely, or a cheap
-- night billed at the day rate). Such rows are now billed at
-- akari_entrance_mean_rate(entrance, start, now): the mean of
-- akari_entrance_rate over the interval, weighted by time. Where the bytes
-- actually fell inside the interval is unknown to the panel; the mean is
-- the estimate.
--
-- A manual change of the base rate or of the rules inside the interval:
-- only the configuration in force now is known for earlier times (plus the
-- recorded lowest old rate of the 30 s before the last change, 1100), so
-- the mean is capped at that recorded rate: such an interval never bills
-- more than either configuration would (only under-bills, like 1100).

-- The time-weighted mean multiplier (permille, fractional) of an entrance
-- over [from_at, to_at]; NULL = no such entrance. The rate is piecewise
-- constant: it can only change at a site-local minute where some rule
-- starts or ends (any weekday: a superset of the real edges, extra pieces
-- are harmless), at local midnight, and at the edges of the recorded
-- change window. The walk goes from edge to edge, so a day costs at most
-- about 2 x rules + 3 rate lookups.
CREATE FUNCTION akari_entrance_mean_rate(entrance uuid, from_at timestamp with time zone,
                                         to_at timestamp with time zone) RETURNS numeric
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
