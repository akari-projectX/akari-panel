-- R22: system settings (admin "系统设置"): the three domains and the
-- "trust Cloudflare" switch. One row (id = 1). NULL = not set in the
-- database: the panel.toml value applies (settings.rs documents the
-- precedence). Every change goes through settings::apply_* (audited, same
-- transaction) and bumps `version` (optimistic concurrency of the admin
-- form); the trigger below wakes every panel instance.
CREATE TABLE panel_settings (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version          BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    -- host[:port], ASCII (IDN as punycode), no scheme/path.
    main_domain      TEXT,
    sub_domain       TEXT,
    node_domain      TEXT,
    trust_cloudflare BOOLEAN,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO panel_settings (id) VALUES (1);

-- Every TLS server name agents may verify on the gRPC endpoint. The panel's
-- gRPC server certificate covers all of them (plus web.advertised_names):
-- an enrolled agent keeps the server_name of its bootstrap file forever, so
-- a name is never dropped implicitly. Rows are added when a node domain is
-- saved and whenever an enrollment token is issued (the name written into
-- that bootstrap); only an explicit admin action removes one.
CREATE TABLE grpc_server_names (
    name          TEXT PRIMARY KEY,
    source        TEXT NOT NULL CHECK (source IN ('settings', 'config', 'enrollment')),
    first_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The endpoint written into a token's bootstrap (fixed at issue time) and,
-- once the agent enrolled with it, the server name the node's agent uses.
-- NULL on nodes enrolled before 0060 (unknown: most likely the
-- grpc.server_name of panel.toml at the time).
ALTER TABLE node_enrollments
    ADD COLUMN panel_addr TEXT,
    ADD COLUMN server_name TEXT;
ALTER TABLE nodes ADD COLUMN server_name TEXT;

-- Any committed settings change wakes every instance (payload 'settings';
-- instances reload the row and the name list, re-issue the gRPC server
-- certificate when its name set changed). Same-transaction NOTIFY: nothing
-- to do after commit.
CREATE FUNCTION akari_settings_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('akari_change', 'settings');
    RETURN NULL;
END $$;

CREATE TRIGGER panel_settings_notify
    AFTER INSERT OR UPDATE OR DELETE ON panel_settings
    FOR EACH STATEMENT EXECUTE FUNCTION akari_settings_notify();
-- Row level: an `INSERT ... ON CONFLICT DO NOTHING` of a known name (every
-- token issue) inserts nothing and notifies nobody.
CREATE TRIGGER grpc_server_names_notify
    AFTER INSERT OR UPDATE OR DELETE ON grpc_server_names
    FOR EACH ROW EXECUTE FUNCTION akari_settings_notify();
