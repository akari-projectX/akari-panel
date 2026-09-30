-- Context of a recorded failed apply (Sprint 2 Phase C N3), so the next
-- session can tell "agent never answered" and "agent state changed since"
-- from a genuine repeat failure and not back off on them.
-- failed_reason: 'nack' (agent Ack ok=false) or 'no_ack' (stream/timeout).
ALTER TABLE nodes ADD COLUMN failed_reason TEXT;
-- The versions the agent held when the failure was recorded.
ALTER TABLE nodes ADD COLUMN failed_held_config_version BIGINT;
ALTER TABLE nodes ADD COLUMN failed_held_user_version BIGINT;
