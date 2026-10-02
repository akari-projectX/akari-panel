-- W11: xboard-style node fields (admin node form) and per-node traffic
-- totals. None of these changes what an agent runs: no config bump.
ALTER TABLE nodes
    -- User-facing name (portal, subscription proxy names); NULL = `name`.
    -- `name` stays the unique internal name.
    ADD COLUMN display_name TEXT
        CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 64),
    -- Display order (ascending, then name) in the portal, the subscription
    -- and the admin list.
    ADD COLUMN sort INTEGER NOT NULL DEFAULT 0 CHECK (sort BETWEEN -1000000 AND 1000000),
    -- Shown to users (portal, subscription). A hidden node keeps serving
    -- the users it is assigned to (access is unchanged): it is only left
    -- out of what users see (xboard "show").
    ADD COLUMN visible BOOLEAN NOT NULL DEFAULT true,
    -- Short labels shown next to the name ("香港", "0.5x", "IPLC"); the
    -- subscription names the proxy "<display name> | <tag> | ...".
    ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(tags) <= 8 AND array_position(tags, NULL) IS NULL),
    -- Traffic multiplier (倍率) in permille: billed = raw x permille / 1000,
    -- applied only inside traffic::FLUSH_SQL (floor per row: never more
    -- than raw x rate). The value in effect when a report is flushed
    -- applies to that report's delta.
    ADD COLUMN traffic_rate_permille INTEGER NOT NULL DEFAULT 1000
        CHECK (traffic_rate_permille BETWEEN 0 AND 100000),
    -- Per-inbound client-facing address/port overrides (连接地址/连接端口,
    -- for NAT, port forwarding, relays): {"<inbound tag>": {"host": "...",
    -- "port": 12345}}, either key optional. Used by every subscription
    -- format and the panel's TCP latency test; the agent never sees it.
    ADD COLUMN connect_overrides JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(connect_overrides) = 'object'),
    -- Bytes accepted for billing on this node (after the plausibility
    -- caps; before the multiplier) and bytes billed to users (after it).
    -- Maintained by FLUSH_SQL in its existing per-node UPDATE.
    ADD COLUMN traffic_raw_bytes BIGINT NOT NULL DEFAULT 0 CHECK (traffic_raw_bytes >= 0),
    ADD COLUMN traffic_billed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (traffic_billed_bytes >= 0);
