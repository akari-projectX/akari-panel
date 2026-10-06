-- PR ③ (v0.4 D4 + D11): the admin prefix and the subscription path move into
-- the database.
--
-- access_settings (single row, optimistic `version`, read by every instance
-- on the settings notification):
--   admin_prefix       the console's secret first path segment (D4: the only
--                      secret prefix). NULL until the first start imports the
--                      route prefix of data/state.json (`access::ensure`), so
--                      an existing URL keeps working; rotatable, the old one
--                      dies at once.
--   admin_allow_cidrs  optional IP allowlist for everything under the admin
--                      prefix ({} = any address); others get the canonical 404.
--   sub_path           the site-wide subscription path segment (D11), random
--                      at the first start, editable; the old one dies at once.
-- The portal lives at / of the main domain; install links and payment
-- notifications keep their paths (/install/…, /pay/…) without a prefix.

CREATE TABLE access_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    admin_prefix text,
    admin_allow_cidrs text[] DEFAULT '{}'::text[] NOT NULL,
    sub_path text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT access_settings_id_check CHECK ((id = 1)),
    CONSTRAINT access_settings_version_check CHECK ((version >= 0)),
    CONSTRAINT access_settings_admin_prefix CHECK ((admin_prefix IS NULL) OR (admin_prefix ~ '^[A-Za-z0-9_-]{4,64}$')),
    CONSTRAINT access_settings_sub_path CHECK ((sub_path IS NULL) OR (sub_path ~ '^[A-Za-z0-9_-]{4,64}$')),
    CONSTRAINT access_settings_distinct CHECK (((admin_prefix IS NULL) OR (sub_path IS NULL) OR (admin_prefix <> sub_path))),
    CONSTRAINT access_settings_allow_count CHECK ((cardinality(admin_allow_cidrs) <= 64))
);

ALTER TABLE ONLY access_settings ADD CONSTRAINT access_settings_pkey PRIMARY KEY (id);
INSERT INTO access_settings (id) VALUES (1);

CREATE TRIGGER access_settings_notify AFTER INSERT OR DELETE OR UPDATE ON access_settings
    FOR EACH STATEMENT EXECUTE FUNCTION akari_settings_notify();
