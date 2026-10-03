-- Ops (announcements, xboard parity): site announcements shown on the
-- portal dashboard, with per-user read state and an optional mailing to
-- the audience through the W15 outbox.
--
-- Visibility (evaluated with the database clock): enabled, now() within
-- [visible_from, visible_until] (NULL = open-ended), and the audience:
-- all / with_plan (an active user_plans row) / without_plan. Bodies are a
-- safe Markdown subset (src/markdown.rs) rendered server-side; the English
-- variant is optional (NULL = the Chinese text is shown).
--
-- Mailing: an admin requests it once (mail_requested_at); the sender loop
-- walks the audience in batches (mail_cursor = last user id handed to the
-- outbox, so a crash resumes without duplicates), counts the rows queued
-- and marks mail_done_at. A second request after completion starts over.

CREATE TABLE announcements (
    id UUID PRIMARY KEY,
    title_zh TEXT NOT NULL CHECK (char_length(title_zh) BETWEEN 1 AND 120),
    title_en TEXT CHECK (title_en IS NULL OR char_length(title_en) BETWEEN 1 AND 120),
    body_zh TEXT NOT NULL CHECK (char_length(body_zh) BETWEEN 1 AND 65536),
    body_en TEXT CHECK (body_en IS NULL OR char_length(body_en) BETWEEN 1 AND 65536),
    pinned BOOLEAN NOT NULL DEFAULT false,
    enabled BOOLEAN NOT NULL DEFAULT true,
    visible_from TIMESTAMPTZ,
    visible_until TIMESTAMPTZ,
    audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'with_plan', 'without_plan')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    mail_requested_at TIMESTAMPTZ,
    mail_cursor UUID,
    mail_sent INT NOT NULL DEFAULT 0 CHECK (mail_sent >= 0),
    mail_done_at TIMESTAMPTZ,
    CHECK (visible_from IS NULL OR visible_until IS NULL OR visible_from < visible_until),
    CHECK (mail_done_at IS NULL OR mail_requested_at IS NOT NULL)
);

CREATE INDEX announcements_order ON announcements (pinned DESC, created_at DESC, id);
CREATE INDEX announcements_mail_due ON announcements (mail_requested_at)
    WHERE mail_requested_at IS NOT NULL AND mail_done_at IS NULL;

CREATE TABLE announcement_reads (
    announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX announcement_reads_user ON announcement_reads (user_id);

-- The announcement mailing is a new outbox kind. 'admin_notice' is the Ops
-- batch mail kind (0168, merged earlier). Both migrations list both kinds, so
-- the constraint ends up the same whichever of the two runs last (fresh
-- databases run 0155 first, panels that already ran 0168 run 0155 afterwards).
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check CHECK (kind IN ('register_code',
    'register_exists', 'email_code', 'password_reset', 'order_paid', 'expiry_soon', 'expired',
    'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new', 'node_alert', 'announcement',
    'admin_notice'));
