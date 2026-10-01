-- M2 performance (docs/PERF.md).
--
-- Admin user list: ORDER BY created_at, id with LIMIT/OFFSET was a full
-- sort of users on every page.
CREATE INDEX users_created_at ON users (created_at, id);

-- Billing rewrites users.traffic_used_bytes and traffic_counters'
-- counters/updated_at on every flush. None of those columns is indexed, so
-- with free space in the page the new row version is a HOT update (no
-- index insertions, no index bloat). Applies to pages written from now on;
-- a `VACUUM FULL` in a maintenance window applies it to existing pages.
-- Do NOT index traffic_counters.updated_at (or the counters): that would
-- make every billing update non-HOT.
ALTER TABLE users SET (fillfactor = 85);
ALTER TABLE traffic_counters SET (fillfactor = 80);
