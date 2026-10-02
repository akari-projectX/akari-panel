-- W22: durable traffic history. traffic::FLUSH_SQL appends the accepted
-- deltas to traffic_daily_pending in the same statement that bills users
-- (same deltas, so exactly as idempotent as the settlement: a
-- replayed/duplicate report adds nothing to either); traffic::compact_pass
-- folds the staged rows into traffic_daily / traffic_node_daily (one
-- statement per batch: DELETE ... RETURNING feeds the upserts, so every
-- staged row is counted exactly once).
--
-- Days are UTC calendar days of the flush (statement_timestamp()). The UI
-- labels them "UTC".
--
-- No foreign keys, on purpose: money/usage records outlive the users and
-- nodes they describe (finance), ids are never reused (UUIDs), deleting a
-- user or node must not scan or rewrite this table, and the primary keys
-- stay NOT NULL. Names are joined at read time ("deleted" when gone).
--
-- up_bytes + down_bytes = the raw bytes accepted after every plausibility
-- cap (what nodes.traffic_raw_bytes adds); billed_bytes = the
-- multiplier-applied charge added to users.traffic_used_bytes.

-- Staging: append-only from the flush (no index, no key: the cheapest
-- write on the billing path), emptied by compact_pass every ~30 s.
CREATE TABLE traffic_daily_pending (
    day          DATE   NOT NULL,
    user_id      UUID   NOT NULL,
    node_id      UUID   NOT NULL,
    up_bytes     BIGINT NOT NULL CHECK (up_bytes >= 0),
    down_bytes   BIGINT NOT NULL CHECK (down_bytes >= 0),
    billed_bytes BIGINT NOT NULL CHECK (billed_bytes >= 0)
) WITH (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 20000);

CREATE TABLE traffic_daily (
    user_id      UUID   NOT NULL,
    day          DATE   NOT NULL,
    node_id      UUID   NOT NULL,
    up_bytes     BIGINT NOT NULL DEFAULT 0 CHECK (up_bytes >= 0),
    down_bytes   BIGINT NOT NULL DEFAULT 0 CHECK (down_bytes >= 0),
    billed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (billed_bytes >= 0),
    PRIMARY KEY (user_id, day, node_id)
) WITH (fillfactor = 80);
-- Node top users. Neither index covers a counter column, so compaction's
-- additive updates stay HOT.
CREATE INDEX traffic_daily_node ON traffic_daily (node_id, day);
-- Retention rollup (rows are appended roughly in day order).
CREATE INDEX traffic_daily_day ON traffic_daily USING brin (day);

-- Per node per day (same compaction statement; the fleet summary and node charts read
-- this small table). `users` = distinct users with traffic on the node that
-- day. Kept indefinitely (nodes x days rows).
CREATE TABLE traffic_node_daily (
    node_id      UUID    NOT NULL,
    day          DATE    NOT NULL,
    up_bytes     BIGINT  NOT NULL DEFAULT 0 CHECK (up_bytes >= 0),
    down_bytes   BIGINT  NOT NULL DEFAULT 0 CHECK (down_bytes >= 0),
    billed_bytes BIGINT  NOT NULL DEFAULT 0 CHECK (billed_bytes >= 0),
    users        INTEGER NOT NULL DEFAULT 0 CHECK (users >= 0),
    PRIMARY KEY (node_id, day)
) WITH (fillfactor = 70);
CREATE INDEX traffic_node_daily_day ON traffic_node_daily (day);

-- traffic_daily rows older than traffic.daily_retention_days are moved
-- here (summed per UTC calendar month; `month` = its first day) by
-- traffic::rollup_pass, in one statement per batch (exact, never twice).
CREATE TABLE traffic_monthly (
    user_id      UUID   NOT NULL,
    month        DATE   NOT NULL CHECK (extract(day FROM month) = 1),
    node_id      UUID   NOT NULL,
    up_bytes     BIGINT NOT NULL DEFAULT 0 CHECK (up_bytes >= 0),
    down_bytes   BIGINT NOT NULL DEFAULT 0 CHECK (down_bytes >= 0),
    billed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (billed_bytes >= 0),
    PRIMARY KEY (user_id, month, node_id)
);
CREATE INDEX traffic_monthly_node ON traffic_monthly (node_id, month);
