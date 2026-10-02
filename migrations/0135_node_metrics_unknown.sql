-- W23: a machine metric the agent could not read is unknown (NULL), never 0.
--
-- node_metrics_1m / _1h: every metric column may be NULL (and defaults to
-- it: a column nobody wrote is unknown). A minute whose
-- samples include one without the value has a NULL sum (unknown for that
-- minute); maxima and the "latest" columns keep the known values. Averages
-- divide by the samples of the rows that have the value (nodestat.rs), and
-- the hour rollup rescales the sums of partly unknown hours the same way.
ALTER TABLE node_metrics_1m
    ALTER COLUMN cpu_sum DROP NOT NULL, ALTER COLUMN cpu_sum DROP DEFAULT,
    ALTER COLUMN cpu_max DROP NOT NULL, ALTER COLUMN cpu_max DROP DEFAULT,
    ALTER COLUMN load1_sum DROP NOT NULL, ALTER COLUMN load1_sum DROP DEFAULT,
    ALTER COLUMN mem_used_sum DROP NOT NULL, ALTER COLUMN mem_used_sum DROP DEFAULT,
    ALTER COLUMN mem_total DROP NOT NULL, ALTER COLUMN mem_total DROP DEFAULT,
    ALTER COLUMN swap_used_sum DROP NOT NULL, ALTER COLUMN swap_used_sum DROP DEFAULT,
    ALTER COLUMN swap_total DROP NOT NULL, ALTER COLUMN swap_total DROP DEFAULT,
    ALTER COLUMN disk_used DROP NOT NULL, ALTER COLUMN disk_used DROP DEFAULT,
    ALTER COLUMN disk_total DROP NOT NULL, ALTER COLUMN disk_total DROP DEFAULT,
    ALTER COLUMN rx_bps_sum DROP NOT NULL, ALTER COLUMN rx_bps_sum DROP DEFAULT,
    ALTER COLUMN tx_bps_sum DROP NOT NULL, ALTER COLUMN tx_bps_sum DROP DEFAULT,
    ALTER COLUMN rx_bps_max DROP NOT NULL, ALTER COLUMN rx_bps_max DROP DEFAULT,
    ALTER COLUMN tx_bps_max DROP NOT NULL, ALTER COLUMN tx_bps_max DROP DEFAULT,
    ALTER COLUMN tcp_sum DROP NOT NULL, ALTER COLUMN tcp_sum DROP DEFAULT,
    ALTER COLUMN udp_sum DROP NOT NULL, ALTER COLUMN udp_sum DROP DEFAULT;
ALTER TABLE node_metrics_1h
    ALTER COLUMN cpu_sum DROP NOT NULL, ALTER COLUMN cpu_sum DROP DEFAULT,
    ALTER COLUMN cpu_max DROP NOT NULL, ALTER COLUMN cpu_max DROP DEFAULT,
    ALTER COLUMN load1_sum DROP NOT NULL, ALTER COLUMN load1_sum DROP DEFAULT,
    ALTER COLUMN mem_used_sum DROP NOT NULL, ALTER COLUMN mem_used_sum DROP DEFAULT,
    ALTER COLUMN mem_total DROP NOT NULL, ALTER COLUMN mem_total DROP DEFAULT,
    ALTER COLUMN swap_used_sum DROP NOT NULL, ALTER COLUMN swap_used_sum DROP DEFAULT,
    ALTER COLUMN swap_total DROP NOT NULL, ALTER COLUMN swap_total DROP DEFAULT,
    ALTER COLUMN disk_used DROP NOT NULL, ALTER COLUMN disk_used DROP DEFAULT,
    ALTER COLUMN disk_total DROP NOT NULL, ALTER COLUMN disk_total DROP DEFAULT,
    ALTER COLUMN rx_bps_sum DROP NOT NULL, ALTER COLUMN rx_bps_sum DROP DEFAULT,
    ALTER COLUMN tx_bps_sum DROP NOT NULL, ALTER COLUMN tx_bps_sum DROP DEFAULT,
    ALTER COLUMN rx_bps_max DROP NOT NULL, ALTER COLUMN rx_bps_max DROP DEFAULT,
    ALTER COLUMN tx_bps_max DROP NOT NULL, ALTER COLUMN tx_bps_max DROP DEFAULT,
    ALTER COLUMN tcp_sum DROP NOT NULL, ALTER COLUMN tcp_sum DROP DEFAULT,
    ALTER COLUMN udp_sum DROP NOT NULL, ALTER COLUMN udp_sum DROP DEFAULT;

-- When the node last enrolled (a new install / 重装命令 burns a fresh
-- token). An update status from a finished rollout that predates it is
-- history, not the node's current state (NodeView `update_status.superseded`).
-- Backfill: the node's enrollment row, when its token was used.
ALTER TABLE nodes ADD COLUMN enrolled_at TIMESTAMPTZ;
UPDATE nodes n SET enrolled_at = e.used_at
FROM node_enrollments e WHERE e.node_id = n.id AND e.used_at IS NOT NULL;
