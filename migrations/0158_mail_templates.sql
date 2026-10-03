-- Ops (editable email templates): an admin's override of one mail kind in
-- one language. Absent row = the built-in default (src/mail/templates.rs).
-- `subject` and `body` carry `{placeholders}` from the kind's whitelist
-- (validated on write: unknown placeholders are refused, required ones
-- must be present). `version` for optimistic concurrency; writes are
-- audited (settings.mail_template.update / .reset). Sending looks the row
-- up inside the enqueueing transaction, so the edited version is what goes
-- out.

CREATE TABLE mail_templates (
    kind TEXT NOT NULL CHECK (kind IN ('register_code', 'register_exists', 'email_code',
        'password_reset', 'order_paid', 'expiry_soon', 'expired', 'quota_80', 'quota_100',
        'test', 'ticket_reply', 'ticket_new', 'node_alert', 'announcement', 'admin_notice')),
    locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
    subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200 AND subject !~ '[[:cntrl:]]'),
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT,
    PRIMARY KEY (kind, locale)
);
