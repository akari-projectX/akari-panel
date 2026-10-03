-- Ops: admin batch mail to users ("send email" batch action) goes through
-- the W15 outbox like every other mail (new kind).
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check CHECK (kind IN ('register_code',
    'register_exists', 'email_code', 'password_reset', 'order_paid', 'expiry_soon', 'expired',
    'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new', 'node_alert', 'admin_notice'));
