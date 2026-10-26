-- Audit 2026-10 batch 4 P3-3: the enforcement pass (enforce::apply_expiry)
-- looks for users whose expiry has passed and is not yet pushed to the
-- nodes every 5 seconds on every instance; without an index that is a
-- sequential scan of `users` (about 50 ms at 200 000 users, measured; 2 ms
-- with this index).
--
-- The index holds only the unenforced expiries. None of its columns is
-- written by the traffic flush, so billing UPDATEs of traffic_used_bytes
-- stay HOT. The over-limit pass (traffic_used_bytes > traffic_limit_bytes)
-- gets NO index on purpose: a predicate on traffic_used_bytes would turn
-- every flush update into a non-HOT update (measured: 70% HOT without it,
-- 0% with a partial index on the predicate).
CREATE INDEX users_expiry_due ON users (expires_at)
    WHERE role = 'user' AND expires_at IS NOT NULL AND NOT expiry_enforced;
