-- R10 F1: pairs whose node_users row was removed while the user still
-- exists (unassign; set_inbounds pruning a user to no credentials). The
-- agent reports the user's final counters AFTER the REMOVE delta; billing
-- still admits the pair for traffic.departed_grace_secs after departed_at.
-- Re-assigning deletes the row; the flush loop prunes expired rows. User or
-- node deletion cascades (nothing left to bill).
CREATE TABLE node_users_departed (
    node_id     UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    departed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, user_id)
);
CREATE INDEX node_users_departed_at ON node_users_departed (departed_at);
