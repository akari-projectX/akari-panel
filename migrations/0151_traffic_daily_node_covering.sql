-- Admin node page, top users (trafficlog::node_top_users): the 30-day
-- range of one busy node is ~15k traffic_daily rows spread over ~9k heap
-- pages (the table is clustered by its primary key, user first), so the
-- bitmap heap scan was most of the request (p99 55 ms at 16 clients on the
-- bench set). The counters in the index make it an index-only scan
-- (PERF.md "Node top users").
--
-- Cost: compaction's additive day-row UPDATEs are no longer HOT (an indexed
-- column changes), i.e. one more index insert per updated row, off the
-- billing path (compact_pass, reaper, every 30 s; measured in PERF.md).
CREATE INDEX traffic_daily_node_cov ON traffic_daily (node_id, day)
    INCLUDE (user_id, up_bytes, down_bytes, billed_bytes);
DROP INDEX traffic_daily_node;
