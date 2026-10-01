-- M6: signed agent self-update with staged rollout.
--
-- agent_releases: one signed release binary per (version, os, arch). The
-- manifest bytes are stored VERBATIM (they are what the release key
-- signed; agents verify them again). The binary lives in
-- agent_release_chunks (1 MiB rows) so every panel instance can serve it;
-- complete_at is set in the same transaction as the last chunk, after the
-- panel checked size and SHA-256 against the manifest.
CREATE TABLE agent_releases (
    id                 UUID PRIMARY KEY,
    version            TEXT NOT NULL,
    os                 TEXT NOT NULL,
    arch               TEXT NOT NULL,
    sha256             TEXT NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size               BIGINT NOT NULL CHECK (size > 0),
    manifest           BYTEA NOT NULL,
    signatures         JSONB NOT NULL,
    key_id             TEXT NOT NULL,
    min_panel_protocol INT NOT NULL,
    rollback           BOOLEAN NOT NULL DEFAULT FALSE,
    complete_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (version, os, arch)
);

CREATE TABLE agent_release_chunks (
    release_id UUID NOT NULL REFERENCES agent_releases(id) ON DELETE CASCADE,
    idx        INT NOT NULL CHECK (idx >= 0),
    data       BYTEA NOT NULL,
    PRIMARY KEY (release_id, idx)
);

-- A rollout of one version to a fixed, deterministic node selection,
-- in cumulative waves (percent of the selection, ascending, last = 100).
-- Open = running | paused | halted; at most one open rollout at a time.
-- halted (failure ratio over the threshold) can only be aborted.
CREATE TABLE rollouts (
    id                  UUID PRIMARY KEY,
    version             TEXT NOT NULL,
    status              TEXT NOT NULL
        CHECK (status IN ('running', 'paused', 'halted', 'aborted', 'completed')),
    waves               INT[] NOT NULL CHECK (cardinality(waves) BETWEEN 1 AND 10),
    percentage          INT NOT NULL CHECK (percentage BETWEEN 1 AND 100),
    explicit_nodes      BOOLEAN NOT NULL,
    current_wave        INT NOT NULL DEFAULT 0 CHECK (current_wave >= 0),
    wave_started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    health_timeout_secs INT NOT NULL CHECK (health_timeout_secs BETWEEN 30 AND 86400),
    max_failure_ratio   DOUBLE PRECISION NOT NULL CHECK (max_failure_ratio >= 0 AND max_failure_ratio <= 1),
    seed                BIGINT NOT NULL,
    halted_reason       TEXT,
    created_by          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX rollouts_one_open ON rollouts ((true))
    WHERE status IN ('running', 'paused', 'halted');

-- Per-node progress. pending -> offered (UpdateOffer sent) -> updating
-- (Hello with the target version) -> healthy (ok Ack on that stream);
-- failed (agent REJECTED/FAILED/ROLLED_BACK, or no health within
-- health_timeout_secs of the first offer); skipped (never offerable:
-- protocol < 3, no artifact for its platform, offline for the whole
-- timeout). Already at/above the target = healthy at once.
CREATE TABLE rollout_nodes (
    rollout_id   UUID NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    node_id      UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    wave         INT NOT NULL CHECK (wave >= 0),
    position     INT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'offered', 'updating', 'healthy', 'failed', 'skipped')),
    from_version TEXT,
    offered_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    detail       TEXT,
    PRIMARY KEY (rollout_id, node_id)
);
CREATE INDEX rollout_nodes_node ON rollout_nodes (node_id);

-- Platform of the connected agent (Hello.info), for artifact selection.
ALTER TABLE nodes ADD COLUMN agent_os TEXT, ADD COLUMN agent_arch TEXT;
