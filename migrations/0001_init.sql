CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Nodes (agents). Identity = client certificate serial issued by the panel CA.
CREATE TABLE nodes (
    id              UUID PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    status          TEXT NOT NULL DEFAULT 'offline',
    -- xray "inbounds" array JSON as pushed to the agent
    xray_inbounds   JSONB NOT NULL DEFAULT '[]'::jsonb,
    config_version  BIGINT NOT NULL DEFAULT 1,
    user_version    BIGINT NOT NULL DEFAULT 0,
    cert_serial     TEXT UNIQUE,
    agent_version   TEXT,
    core_version    TEXT,
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Panel users. id doubles as the xray user "email" field on every node.
CREATE TABLE users (
    id                  UUID PRIMARY KEY,
    login               TEXT NOT NULL UNIQUE,
    password_hash       TEXT,
    role                TEXT NOT NULL DEFAULT 'user',
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    traffic_limit_bytes BIGINT,
    traffic_used_bytes  BIGINT NOT NULL DEFAULT 0,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User enablement per node with per-inbound protocol accounts.
-- credentials: [{"inbound_tag": "...", "account": {...xray account json...}}]
CREATE TABLE node_users (
    node_id     UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credentials JSONB NOT NULL,
    PRIMARY KEY (node_id, user_id)
);

CREATE INDEX idx_node_users_user ON node_users(user_id);

-- Latest cumulative counters per (node, user, agent session) for
-- observability and reconciliation. Deltas are applied to users on ingest.
CREATE TABLE traffic_counters (
    node_id     UUID NOT NULL,
    user_id     UUID NOT NULL,
    session_id  TEXT NOT NULL,
    up_bytes    BIGINT NOT NULL,
    down_bytes  BIGINT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, user_id, session_id)
);
