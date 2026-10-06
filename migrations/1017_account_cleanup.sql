-- PR ③ (v0.4 D10): never-used account cleanup.
--
-- users.last_login_at: the last successful sign-in (password or passkey;
-- NULL = never since this column exists). users.cleanup_warned_at: when the
-- cleanup's warning was sent (or, without a verified address to send it
-- to, recorded); a sign-in clears it — "a login keeps the account".
--
-- cleanup_settings (single row, optimistic `version`, read on every run):
-- the automatic cleanup (default off) deletes role=user accounts that were
-- never used (cleanup.rs NEVER_USED: no plan ever, no finance record, no
-- traffic, balance 0, no ticket) and registered and not signed in for
-- `after_days` (default 30); with `warn` it first mails a warning and
-- deletes `warn_days` later unless the account signs in meanwhile.

ALTER TABLE users ADD COLUMN last_login_at timestamp with time zone;
ALTER TABLE users ADD COLUMN cleanup_warned_at timestamp with time zone;
CREATE INDEX users_cleanup_warned ON users USING btree (cleanup_warned_at) WHERE (cleanup_warned_at IS NOT NULL);

CREATE TABLE cleanup_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    auto boolean DEFAULT false NOT NULL,
    after_days integer DEFAULT 30 NOT NULL,
    warn boolean DEFAULT false NOT NULL,
    warn_days integer DEFAULT 7 NOT NULL,
    last_run_at timestamp with time zone,
    last_deleted integer DEFAULT 0 NOT NULL,
    last_warned integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cleanup_settings_id_check CHECK ((id = 1)),
    CONSTRAINT cleanup_settings_version_check CHECK ((version >= 0)),
    CONSTRAINT cleanup_settings_after_days CHECK (((after_days >= 1) AND (after_days <= 3650))),
    CONSTRAINT cleanup_settings_warn_days CHECK (((warn_days >= 1) AND (warn_days <= 90))),
    CONSTRAINT cleanup_settings_counts CHECK (((last_deleted >= 0) AND (last_warned >= 0)))
);

ALTER TABLE ONLY cleanup_settings ADD CONSTRAINT cleanup_settings_pkey PRIMARY KEY (id);
INSERT INTO cleanup_settings (id) VALUES (1);
