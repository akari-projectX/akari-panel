-- Audit-batch-2 P2-1: a security notice (passkey added / removed, password
-- sign-in switched, email or password changed) goes to the account's
-- verified address through the outbox. New mail kind `security_notice`
-- (outbox and editable templates).
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check CHECK (kind IN (
    'register_code', 'register_exists', 'email_code', 'password_reset', 'order_paid',
    'expiry_soon', 'expired', 'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new',
    'node_alert', 'announcement', 'admin_notice', 'refund', 'security_notice'));
ALTER TABLE mail_templates DROP CONSTRAINT mail_templates_kind_check;
ALTER TABLE mail_templates ADD CONSTRAINT mail_templates_kind_check CHECK (kind IN (
    'register_code', 'register_exists', 'email_code', 'password_reset', 'order_paid',
    'expiry_soon', 'expired', 'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new',
    'node_alert', 'announcement', 'admin_notice', 'refund', 'security_notice'));
