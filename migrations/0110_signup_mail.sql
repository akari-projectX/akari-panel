-- W15 (M7, numbered after W16's 0105–0108): self-service registration, password reset by email, SMTP
-- outbox, email notices and invite attribution. Every table here is
-- written by src/signup/ and src/mail/ only (docs: migrations/CLAUDE.md).

-- Accounts get an email address (lower case, validated by
-- signup::email::parse). Only a VERIFIED address is unique, receives mail,
-- logs in and resets passwords: an address an admin typed (unverified) can
-- never block or take over its real owner's registration.
ALTER TABLE users
    ADD COLUMN email TEXT CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
    ADD COLUMN email_verified_at TIMESTAMPTZ,
    -- Language of the mails sent to the account (portal/registration).
    ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh' CHECK (locale IN ('zh', 'en')),
    ADD CONSTRAINT users_verified_email CHECK (email_verified_at IS NULL OR email IS NOT NULL);
CREATE UNIQUE INDEX users_email_verified ON users (email) WHERE email_verified_at IS NOT NULL;
-- Invite attribution: users.inviter_id comes from W16's 0105 (no self /
-- no cycle trigger); the registration transaction here sets it once from
-- the invite code's owner (signup::invite::consume).

-- 系统设置 → 注册 (one row). Read per request (no cache: every instance
-- sees a change at once). Written only by signup::apply_update_settings
-- (audited, optimistic concurrency on `version`).
CREATE TABLE signup_settings (
    id                    SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version               BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    register_enabled      BOOLEAN NOT NULL DEFAULT false,
    invite_required       BOOLEAN NOT NULL DEFAULT false,
    -- A code admits one registration (false: until its owner deletes it).
    invite_single_use     BOOLEAN NOT NULL DEFAULT false,
    invite_codes_per_user INTEGER NOT NULL DEFAULT 5 CHECK (invite_codes_per_user BETWEEN 0 AND 100),
    -- Empty = any domain. Lower-case ASCII (punycode) domain names.
    email_domains         TEXT[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(email_domains) <= 100 AND array_position(email_domains, NULL) IS NULL),
    -- Optional trial: new accounts get this plan for trial_days.
    trial_plan_id         UUID REFERENCES plans(id) ON DELETE SET NULL,
    trial_days            INTEGER NOT NULL DEFAULT 1 CHECK (trial_days BETWEEN 1 AND 3650),
    reset_enabled         BOOLEAN NOT NULL DEFAULT false,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO signup_settings (id) VALUES (1);

-- 系统设置 → 邮件 (one row). password_enc = 0x01‖nonce‖AES-256-GCM
-- (totp::Keys, AAD = mail::SMTP_AAD), never returned by the API.
CREATE TABLE smtp_settings (
    id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version            BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    enabled            BOOLEAN NOT NULL DEFAULT false,
    host               TEXT,
    port               INTEGER NOT NULL DEFAULT 587 CHECK (port BETWEEN 1 AND 65535),
    -- starttls (required), tls (implicit, e.g. 465), none (plain: no
    -- credentials allowed; local relays and test sinks only).
    security           TEXT NOT NULL DEFAULT 'starttls' CHECK (security IN ('starttls', 'tls', 'none')),
    username           TEXT,
    password_enc       BYTEA,
    from_addr          TEXT,
    from_name          TEXT CHECK (length(from_name) <= 64),
    notify_order_paid  BOOLEAN NOT NULL DEFAULT true,
    -- Plan expiry reminder N days before (0 = off).
    notify_expiry_days INTEGER NOT NULL DEFAULT 3 CHECK (notify_expiry_days BETWEEN 0 AND 30),
    notify_expired     BOOLEAN NOT NULL DEFAULT true,
    notify_quota       BOOLEAN NOT NULL DEFAULT true,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT smtp_enabled_complete CHECK (NOT enabled OR (host IS NOT NULL AND from_addr IS NOT NULL)),
    CONSTRAINT smtp_plain_no_auth CHECK (security <> 'none' OR username IS NULL)
);
INSERT INTO smtp_settings (id) VALUES (1);

-- Email verification codes (registration, email change): one live code per
-- (purpose, subject) — subject = the address (register) or the user id
-- (change_email); a new request replaces it. Only an HMAC of the code is
-- stored (key from data/totp.key). Single use (used_at), 10 minutes, at
-- most 5 wrong attempts.
CREATE TABLE email_codes (
    purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'change_email')),
    subject    TEXT NOT NULL,
    email      TEXT NOT NULL,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    PRIMARY KEY (purpose, subject),
    CHECK ((purpose = 'change_email') = (user_id IS NOT NULL))
);
CREATE INDEX email_codes_expires ON email_codes (expires_at);

-- Password reset links: SHA-256 of a 256-bit token, 30 minutes, single use,
-- bound to the verified address it was sent to.
CREATE TABLE password_resets (
    token_hash BYTEA PRIMARY KEY CHECK (length(token_hash) = 32),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);
CREATE INDEX password_resets_user ON password_resets (user_id);
CREATE INDEX password_resets_expires ON password_resets (expires_at);

-- Per-user invite codes (signup::invite). `uses` counts registrations.
CREATE TABLE invite_codes (
    code       TEXT PRIMARY KEY CHECK (code ~ '^[a-z2-9]{8,32}$'),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uses       INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invite_codes_user ON invite_codes (user_id, created_at);

-- Mail outbox (mail::sender): requests only INSERT here (in their own
-- transaction); a sender on any instance claims due rows (FOR UPDATE SKIP
-- LOCKED + lease + claim token), sends, and settles them. Bodies are
-- cleared once a row is settled (codes and reset links never linger).
CREATE TABLE mail_outbox (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('register_code', 'register_exists', 'email_code',
                        'password_reset', 'order_paid', 'expiry_soon', 'expired', 'quota_80',
                        'quota_100', 'test')),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    to_addr         TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body_text       TEXT NOT NULL,
    body_html       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_until   TIMESTAMPTZ,
    claim_token     UUID,
    -- Not worth sending after this (codes, reset links): dead 'expired'.
    discard_after   TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at      TIMESTAMPTZ,
    CHECK ((status = 'pending') = (settled_at IS NULL))
);
CREATE INDEX mail_outbox_due ON mail_outbox (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX mail_outbox_settled ON mail_outbox (status, settled_at) WHERE status <> 'pending';

-- Sent markers of the periodic notices (mail::notices): at most one row per
-- (user, kind). Expiry kinds key on the expiry instant (a renewal re-arms
-- them); quota kinds are deleted when usage drops below the threshold
-- (period reset, bigger plan), which re-arms them: once per period.
CREATE TABLE user_notices (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL CHECK (kind IN ('expiry_soon', 'expired', 'quota_80', 'quota_100')),
    key     TEXT NOT NULL,
    at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind)
);
