-- Ops: admin batch mail to users ("send email" batch action) goes through
-- the W15 outbox like every other mail (new kind).
-- 'announcement' is the Ops content kind (0155, merged separately). Both
-- migrations list both kinds, so the constraint ends up the same whichever
-- of the two runs last (fresh databases run 0155 first, panels that already
-- ran 0168 run 0155 afterwards).
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check CHECK (kind IN ('register_code',
    'register_exists', 'email_code', 'password_reset', 'order_paid', 'expiry_soon', 'expired',
    'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new', 'node_alert', 'announcement',
    'admin_notice'));
