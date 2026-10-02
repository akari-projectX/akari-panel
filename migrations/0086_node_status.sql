-- W11: node machine status history and latency tests (nodestat.rs).
--
-- Latest heartbeat values live in Valkey (akari:node:hb:<id>, any instance
-- serves them); PostgreSQL keeps downsampled history: one row per node and
-- minute (written by the instance holding the node's stream, an upsert per
-- heartbeat that adds to sums), rolled up into hours by any instance.
-- Retention (reaper loop): minutes 48 h, hours 90 days. Averages are
-- sum / samples at read time, so merging two writers is exact.
CREATE TABLE node_metrics_1m (
    node_id      UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    bucket       TIMESTAMPTZ NOT NULL,
    samples      INTEGER NOT NULL CHECK (samples > 0),
    cpu_sum      DOUBLE PRECISION NOT NULL DEFAULT 0,
    cpu_max      REAL NOT NULL DEFAULT 0,
    load1_sum    DOUBLE PRECISION NOT NULL DEFAULT 0,
    mem_used_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
    mem_total    BIGINT NOT NULL DEFAULT 0,
    swap_used_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
    swap_total   BIGINT NOT NULL DEFAULT 0,
    disk_used    BIGINT NOT NULL DEFAULT 0,
    disk_total   BIGINT NOT NULL DEFAULT 0,
    rx_bps_sum   DOUBLE PRECISION NOT NULL DEFAULT 0,
    tx_bps_sum   DOUBLE PRECISION NOT NULL DEFAULT 0,
    rx_bps_max   BIGINT NOT NULL DEFAULT 0,
    tx_bps_max   BIGINT NOT NULL DEFAULT 0,
    tcp_sum      DOUBLE PRECISION NOT NULL DEFAULT 0,
    udp_sum      DOUBLE PRECISION NOT NULL DEFAULT 0,
    conns_sum    DOUBLE PRECISION NOT NULL DEFAULT 0,
    conns_max    BIGINT NOT NULL DEFAULT 0,
    users_sum    DOUBLE PRECISION NOT NULL DEFAULT 0,
    users_max    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, bucket)
) WITH (fillfactor = 70);
-- Retention deletes by time across all nodes.
CREATE INDEX node_metrics_1m_bucket ON node_metrics_1m (bucket);

CREATE TABLE node_metrics_1h (LIKE node_metrics_1m INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE node_metrics_1h
    ADD PRIMARY KEY (node_id, bucket),
    ADD FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
CREATE INDEX node_metrics_1h_bucket ON node_metrics_1h (bucket);

-- Latest latency results per node: source 'agent' = the agent's url-test
-- from its own egress (target = URL; every URL the run tried), 'panel' =
-- TCP connect from the panel to an inbound's client-facing address
-- (target = inbound tag). delay_ms NULL = failed (error says why; 'udp' =
-- not measurable over TCP, e.g. Hysteria 2). A new result set for a
-- (node, source) replaces the old one.
CREATE TABLE node_latency (
    node_id     UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    source      TEXT NOT NULL CHECK (source IN ('agent', 'panel')),
    target      TEXT NOT NULL CHECK (char_length(target) BETWEEN 1 AND 512),
    delay_ms    INTEGER CHECK (delay_ms IS NULL OR delay_ms >= 0),
    error       TEXT CHECK (error IS NULL OR char_length(error) <= 200),
    -- Position in the run (agent: URL order; panel: inbound order).
    ord         SMALLINT NOT NULL DEFAULT 0,
    measured_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (node_id, source, target)
);

ALTER TABLE nodes
    -- "立即测速": the newest request (its epoch microseconds are the
    -- LatencyProbeConfig.run_token sent to the agent).
    ADD COLUMN probe_requested_at TIMESTAMPTZ,
    -- When the panel's TCP test of this node is due next (claimed by any
    -- instance with a conditional UPDATE; NULL = due now).
    ADD COLUMN panel_probe_next_at TIMESTAMPTZ;
