-- One-click agent update check: where the panel looks for new akari-agent
-- releases and whether it looks by itself. One row, edited from the
-- Updates view (PUT /agent-updates/settings, `version` optimistic
-- concurrency, audited as agent_update.settings.update). Read from the
-- database on every request and every auto-check tick (no cache, so no
-- notification is needed). No panel.toml key (R39).
--
-- source_url: the GitHub "latest release" API URL (or a compatible
--   mirror); NULL = the project's own
--   https://api.github.com/repos/akari-projectX/akari-agent/releases/latest.
-- auto_check: check every 6 h (never starts a rollout); default off.
-- next_auto_check_at: claimed by one instance with a conditional UPDATE.
-- check_started_at: a check is running (status display; the mutex is the
--   transaction-level advisory lock the check holds while it runs).
-- last_check_*: the outcome of the latest check (written by the checker,
--   not by the form, so it does not bump `version`).
CREATE TABLE agent_update_settings (
    id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    source_url         TEXT CHECK (source_url IS NULL OR length(source_url) BETWEEN 8 AND 512),
    auto_check         BOOLEAN NOT NULL DEFAULT FALSE,
    version            BIGINT NOT NULL DEFAULT 1,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_auto_check_at TIMESTAMPTZ,
    check_started_at   TIMESTAMPTZ,
    last_check_at      TIMESTAMPTZ,
    last_check_ok      BOOLEAN,
    last_check_result  TEXT CHECK (last_check_result IN ('stored', 'up_to_date', 'failed')),
    last_check_version TEXT,
    last_check_code    TEXT,
    last_check_params  JSONB,
    last_check_message TEXT,
    last_check_stored  TEXT[],
    CHECK ((last_check_at IS NULL) = (last_check_result IS NULL)),
    CHECK ((last_check_result = 'failed') = (last_check_code IS NOT NULL))
);
INSERT INTO agent_update_settings DEFAULT VALUES;
