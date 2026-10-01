-- M2-5: traffic_counters retention (traffic.rs `retention_pass`).
--
-- traffic_counters is the billing baseline: deleting a row whose session
-- still reports re-bills that session's whole cumulative. Rows are only
-- deleted when provably dead:
--   1. their node no longer exists (node ids are never reused; nothing
--      can be billed without node_users), or
--   2. their (node, session) is RETIRED: a tombstone in traffic_sessions
--      that FLUSH_SQL honours (a late report of a retired session is
--      dropped — under-billing at worst, never re-billing), set only once
--      the agent provably can no longer send that session (see below).

-- The agent's traffic session from its latest Hello on the stream that
-- owns the node (written together with online_session), and the drain
-- proof: a stream whose Hello carried finals_drained_session at
-- finals_drained_at stayed up >= 60 s. The agent sends every queued final
-- report right after Hello and drops it once a stream survived a traffic
-- interval (10 s) after sending it, so every session superseded before
-- that Hello has delivered its last report.
ALTER TABLE nodes
    ADD COLUMN agent_session TEXT,
    ADD COLUMN agent_session_at TIMESTAMPTZ,
    ADD COLUMN finals_drained_session TEXT,
    ADD COLUMN finals_drained_at TIMESTAMPTZ;

-- Every (node, agent session) billing has seen. retired_at = tombstone
-- (permanent; FLUSH_SQL drops reports of retired sessions); purged_at =
-- its traffic_counters rows are gone.
CREATE TABLE traffic_sessions (
    node_id       UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL,
    retired_at    TIMESTAMPTZ,
    purged_at     TIMESTAMPTZ,
    PRIMARY KEY (node_id, session_id)
);

INSERT INTO traffic_sessions (node_id, session_id, first_seen_at)
SELECT t.node_id, t.session_id, min(COALESCE(t.first_seen_at, t.updated_at))
FROM traffic_counters t JOIN nodes n ON n.id = t.node_id
GROUP BY t.node_id, t.session_id;
