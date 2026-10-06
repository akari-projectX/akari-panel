-- D5 (W28-b, Q2): a traffic quota per server, counted from the machine's
-- network interface (what the hosting provider bills: SPRINT W33-a ruling
-- ②), not from the users' proxied bytes.
--
-- The agent reports the interface's counters since boot
-- (NodeMetrics.net_rx_bytes_total / net_tx_bytes_total + net_interface) in
-- every heartbeat. The panel keeps the last value as a baseline and adds the
-- difference to this period's counters (`akari_nic_delta`): a counter that
-- went down (reboot) counts from 0, a new interface name or a first sample
-- only sets the baseline, and a step larger than 100 Gbit/s over the time
-- since the previous sample is capped (agent input; only ever under-counts).
-- Heartbeats skipped by the panel lose nothing: the counters are cumulative.
--
-- Mode: both = rx + tx, up = tx (bytes the server sends: most providers'
-- "outbound"), down = rx. The trigger `servers_traffic_quota` keeps
-- `traffic_quota_exceeded_at` equal to "a quota is set and used >= quota" on
-- every write path (heartbeat, period reset, admin change) and bumps
-- config_version when that flips: the agent then gets the empty state
-- (grpc::SERVER_SERVES), like a disabled node, without touching
-- `nodes.enabled` (an admin-disabled node stays disabled on restore).
--
-- Period: `traffic_quota_reset_day` (1–31, clamped to the month's end) =
-- monthly at 00:00 on that day in the site time zone (akari_next_reset);
-- NULL = never resets. The reset pass (enforce) zeroes the counters at
-- `traffic_quota_next_reset_at`.

ALTER TABLE servers
    ADD COLUMN traffic_quota_bytes bigint,
    ADD COLUMN traffic_quota_mode text DEFAULT 'both' NOT NULL,
    ADD COLUMN traffic_quota_reset_day smallint,
    ADD COLUMN traffic_quota_next_reset_at timestamp with time zone,
    ADD COLUMN traffic_quota_rx_bytes bigint DEFAULT 0 NOT NULL,
    ADD COLUMN traffic_quota_tx_bytes bigint DEFAULT 0 NOT NULL,
    ADD COLUMN traffic_quota_period_start timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN traffic_quota_exceeded_at timestamp with time zone,
    -- The interface baseline (the last counters seen).
    ADD COLUMN nic_name text,
    ADD COLUMN nic_rx_last bigint,
    ADD COLUMN nic_tx_last bigint,
    ADD COLUMN nic_at timestamp with time zone,
    ADD CONSTRAINT servers_traffic_quota CHECK (traffic_quota_bytes IS NULL OR traffic_quota_bytes > 0),
    ADD CONSTRAINT servers_traffic_quota_mode CHECK (traffic_quota_mode = ANY (ARRAY['both'::text, 'up'::text, 'down'::text])),
    ADD CONSTRAINT servers_traffic_quota_reset_day CHECK (traffic_quota_reset_day IS NULL OR traffic_quota_reset_day BETWEEN 1 AND 31),
    ADD CONSTRAINT servers_traffic_quota_next_reset CHECK ((traffic_quota_next_reset_at IS NULL) = (traffic_quota_reset_day IS NULL)),
    ADD CONSTRAINT servers_traffic_quota_counters CHECK (traffic_quota_rx_bytes >= 0 AND traffic_quota_tx_bytes >= 0),
    ADD CONSTRAINT servers_nic CHECK ((nic_rx_last IS NULL OR nic_rx_last >= 0) AND (nic_tx_last IS NULL OR nic_tx_last >= 0)
        AND (nic_name IS NULL OR char_length(nic_name) <= 32));

CREATE INDEX servers_traffic_quota_reset ON servers (traffic_quota_next_reset_at)
    WHERE traffic_quota_next_reset_at IS NOT NULL;

-- Bytes the interface moved since the baseline (see the header).
CREATE FUNCTION akari_nic_delta(same_nic boolean, last bigint, cur bigint, last_at timestamp with time zone)
    RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
    SELECT CASE
        WHEN NOT coalesce(same_nic, false) OR last IS NULL OR cur IS NULL OR last_at IS NULL THEN 0
        ELSE LEAST(CASE WHEN cur >= last THEN cur - last ELSE cur END,
                   (GREATEST(extract(epoch FROM now() - last_at), 1) * 12500000000)::bigint)
    END
$$;

-- This period's usage by mode (numeric: rx + tx cannot overflow).
CREATE FUNCTION akari_quota_used(mode text, rx bigint, tx bigint) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT CASE mode WHEN 'up' THEN tx::numeric WHEN 'down' THEN rx::numeric
        ELSE rx::numeric + tx::numeric END
$$;

-- The next monthly reset on `day` (00:00 site time, clamped to the month's
-- end) after `after`.
CREATE FUNCTION akari_quota_next_reset(day smallint, after timestamp with time zone)
    RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    AS $$
    SELECT CASE WHEN day IS NULL THEN NULL
        ELSE akari_next_reset(make_timestamptz(2000, 1, day, 0, 0, 0, akari_site_tz()), 'monthly', NULL, after) END
$$;

CREATE FUNCTION akari_server_traffic_quota() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    over boolean := NEW.traffic_quota_bytes IS NOT NULL
        AND akari_quota_used(NEW.traffic_quota_mode, NEW.traffic_quota_rx_bytes, NEW.traffic_quota_tx_bytes)
            >= NEW.traffic_quota_bytes;
BEGIN
    IF over AND NEW.traffic_quota_exceeded_at IS NULL THEN
        NEW.traffic_quota_exceeded_at := now();
        NEW.config_version := NEW.config_version + 1;
    ELSIF NOT over AND NEW.traffic_quota_exceeded_at IS NOT NULL THEN
        NEW.traffic_quota_exceeded_at := NULL;
        NEW.config_version := NEW.config_version + 1;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER servers_traffic_quota BEFORE UPDATE OF traffic_quota_bytes, traffic_quota_mode,
    traffic_quota_rx_bytes, traffic_quota_tx_bytes, traffic_quota_exceeded_at ON servers
    FOR EACH ROW EXECUTE FUNCTION akari_server_traffic_quota();

-- W17 alert kind: the quota is used up.
ALTER TABLE server_alerts DROP CONSTRAINT server_alerts_kind_check;
ALTER TABLE server_alerts ADD CONSTRAINT server_alerts_kind_check CHECK ((kind = ANY (ARRAY['offline'::text, 'cpu'::text,
    'memory'::text, 'disk'::text, 'latency'::text, 'cert'::text, 'agent_cert'::text, 'last_error'::text,
    'entrance_down'::text, 'traffic_quota'::text])));
