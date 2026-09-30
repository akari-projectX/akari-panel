-- R13 (Sprint 3b Phase B).
--
-- 1. Billing caps credit at most a short burst window of elapsed time
--    (traffic.node_burst_secs), except once per real disconnection: when an
--    agent session goes online, the time since the node was last seen
--    (min lease) becomes a credit floor, valid for one burst window from
--    that reconnect and not extended by further reconnects while valid
--    (last_seen_at moves forward with every reconnect, so a gap can only be
--    claimed once).
ALTER TABLE nodes
    ADD COLUMN traffic_credit_floor TIMESTAMPTZ,
    ADD COLUMN traffic_credit_until TIMESTAMPTZ;

-- 2. What a departed pair was billed since its departure: the departure
--    window caps it cumulatively across flushes. Reset on re-departure.
ALTER TABLE node_users_departed
    ADD COLUMN billed_bytes BIGINT NOT NULL DEFAULT 0;
