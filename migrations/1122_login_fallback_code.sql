-- Passkey-only fallback: an account whose sign-in is passkey-only (own
-- choice or role policy) may sign in with its password plus a one-time code
-- mailed to its verified address when passkeys are truly unusable (browser
-- without related-origin support, passkey centre unreachable). The code is
-- an `email_codes` row of the new purpose `login_fallback` (subject = the
-- user id) and the mail is the new kind `login_code`.
ALTER TABLE email_codes DROP CONSTRAINT email_codes_user_iff_change_email;
ALTER TABLE email_codes DROP CONSTRAINT email_codes_purpose_check;
ALTER TABLE email_codes ADD CONSTRAINT email_codes_purpose_check
    CHECK (purpose IN ('register', 'change_email', 'login_fallback'));
ALTER TABLE email_codes ADD CONSTRAINT email_codes_user_iff_account_code
    CHECK ((purpose IN ('change_email', 'login_fallback')) = (user_id IS NOT NULL));

ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check CHECK (kind IN (
    'register_code', 'register_exists', 'email_code', 'password_reset', 'order_paid',
    'expiry_soon', 'expired', 'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new',
    'node_alert', 'announcement', 'admin_notice', 'refund', 'security_notice', 'login_code'));
ALTER TABLE mail_templates DROP CONSTRAINT mail_templates_kind_check;
ALTER TABLE mail_templates ADD CONSTRAINT mail_templates_kind_check CHECK (kind IN (
    'register_code', 'register_exists', 'email_code', 'password_reset', 'order_paid',
    'expiry_soon', 'expired', 'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new',
    'node_alert', 'announcement', 'admin_notice', 'refund', 'security_notice', 'login_code'));
