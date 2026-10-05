-- W27 (v0.4 D1): registration switches and bot protection.
--
-- 1. "Registration requires email verification" is an explicit switch,
--    default off (it used to be NULL = "automatic: verify whenever SMTP
--    sending is on"). "Registration requires an invite code"
--    (invite_required) already is one; the two are independent.
-- 2. auth_settings (single row, optimistic `version`, read per request like
--    signup_settings): Cloudflare Turnstile — site key, sealed secret
--    (master key, fixed AAD `botguard::TURNSTILE_AAD`) and one switch per
--    form (login, registration, password reset); a switch needs both keys —
--    and the honeypot / minimum-submit-time checks of the public forms
--    (default on: 2 s).

UPDATE signup_settings SET email_verify = false WHERE email_verify IS NULL;
ALTER TABLE signup_settings ALTER COLUMN email_verify SET DEFAULT false;
ALTER TABLE signup_settings ALTER COLUMN email_verify SET NOT NULL;

CREATE TABLE auth_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    turnstile_site_key text,
    turnstile_secret_enc bytea,
    turnstile_login boolean DEFAULT false NOT NULL,
    turnstile_register boolean DEFAULT false NOT NULL,
    turnstile_reset boolean DEFAULT false NOT NULL,
    honeypot boolean DEFAULT true NOT NULL,
    min_submit_secs integer DEFAULT 2 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_settings_id_check CHECK ((id = 1)),
    CONSTRAINT auth_settings_version_check CHECK ((version >= 0)),
    CONSTRAINT auth_settings_site_key CHECK ((turnstile_site_key IS NULL) OR (turnstile_site_key ~ '^[A-Za-z0-9_-]{1,128}$')),
    CONSTRAINT auth_settings_turnstile_keys CHECK (
        NOT (turnstile_login OR turnstile_register OR turnstile_reset)
        OR (turnstile_site_key IS NOT NULL AND turnstile_secret_enc IS NOT NULL)),
    CONSTRAINT auth_settings_min_submit_secs CHECK ((min_submit_secs BETWEEN 0 AND 60))
);

ALTER TABLE ONLY auth_settings ADD CONSTRAINT auth_settings_pkey PRIMARY KEY (id);
INSERT INTO auth_settings (id) VALUES (1);
