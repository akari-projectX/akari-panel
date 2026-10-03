-- Ops (T1 money): batch operations on users from the admin console.
--
-- A job targets a fixed set of users (snapshot taken when the job is
-- created: the selected ids, or every user matching the list filter at
-- that moment) and applies ONE action through the existing apply_*
-- functions, one user at a time, in bounded chunks (one transaction per
-- chunk). admin_batch_items is the per-user ledger of the job and the
-- idempotency record: a user's item row flips from 'pending' in the SAME
-- transaction as the apply, so a crash between chunks resumes with the
-- pending items and never applies twice. Any instance may run a job
-- (claim lease + token, like the mail outbox).
CREATE TABLE admin_batch_jobs (
    id            UUID PRIMARY KEY,
    actor_id      UUID,
    actor_login   TEXT NOT NULL,
    action        TEXT NOT NULL CHECK (action IN ('extend_expiry', 'reset_traffic', 'enable',
                        'disable', 'set_plan', 'cancel_plan', 'add_balance', 'send_email')),
    -- The action's validated parameters (no secrets).
    params        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- How the users were chosen: 'ids' or 'filter' (+ the filter itself).
    selection     TEXT NOT NULL CHECK (selection IN ('ids', 'filter')),
    filter        JSONB,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'done', 'cancelled', 'failed')),
    total         INTEGER NOT NULL CHECK (total >= 0),
    done          INTEGER NOT NULL DEFAULT 0 CHECK (done >= 0),
    failed        INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
    skipped       INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
    last_error    TEXT,
    claimed_until TIMESTAMPTZ,
    claim_token   UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    CHECK (done + failed + skipped <= total),
    CHECK ((status IN ('done', 'cancelled', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX admin_batch_jobs_open ON admin_batch_jobs (created_at)
    WHERE status IN ('pending', 'running');
CREATE INDEX admin_batch_jobs_recent ON admin_batch_jobs (created_at DESC);

CREATE TABLE admin_batch_items (
    job_id     UUID NOT NULL REFERENCES admin_batch_jobs(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL,
    -- Snapshot: the login at job creation (the user may be deleted later).
    user_login TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
    -- Why it failed / was skipped (a short message, no secrets).
    detail     TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, user_id)
);
CREATE INDEX admin_batch_items_pending ON admin_batch_items (job_id, user_id)
    WHERE status = 'pending';
