-- W12: W11 latency-test settings in 系统设置 (settings.rs, like R22's
-- domains): NULL = panel.toml's [probe] value applies. Same row, same
-- `version` (optimistic concurrency) and the same 0060 trigger (every
-- instance reloads; sessions re-send LatencyProbeConfig to their agents).
-- Bounds mirror config_check::validate_probe.
ALTER TABLE panel_settings
    ADD COLUMN probe_interval_secs INTEGER
        CHECK (probe_interval_secs BETWEEN 600 AND 604800),
    ADD COLUMN probe_urls TEXT[]
        CHECK (cardinality(probe_urls) BETWEEN 1 AND 4 AND array_position(probe_urls, NULL) IS NULL),
    ADD COLUMN probe_panel_tcp BOOLEAN;
