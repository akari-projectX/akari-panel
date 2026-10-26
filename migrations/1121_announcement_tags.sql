-- Announcement tags (2026-10-15 request, style C "solid"): a small coloured
-- label before an announcement's title ([活动] [维护] ...), managed by the
-- operator. The colour is one of eleven preset keys (the portal and the
-- admin map them to CSS variables; no free colour, so every tag is legible
-- in the light and the dark theme). An announcement carries at most one tag.
--
-- A tag used by an announcement cannot be deleted (ON DELETE RESTRICT; the
-- API answers 409 with the count first), only disabled: a disabled tag stays
-- on the announcements that have it but cannot be picked for new ones.

CREATE TABLE announcement_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name_zh text NOT NULL,
    name_en text,
    color text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcement_tags_pkey PRIMARY KEY (id),
    CONSTRAINT announcement_tags_name_zh CHECK (char_length(name_zh) BETWEEN 1 AND 12),
    CONSTRAINT announcement_tags_name_en CHECK (name_en IS NULL OR char_length(name_en) BETWEEN 1 AND 12),
    CONSTRAINT announcement_tags_color CHECK (color IN
        ('red', 'orange', 'amber', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'slate')),
    CONSTRAINT announcement_tags_sort CHECK (sort BETWEEN -1000000 AND 1000000)
);

CREATE INDEX announcement_tags_order ON announcement_tags (sort, created_at, id);

INSERT INTO announcement_tags (name_zh, name_en, color, sort) VALUES
    ('活动', 'Event', 'pink', 0),
    ('维护', 'Maintenance', 'amber', 1),
    ('调整', 'Change', 'blue', 2),
    ('新功能', 'New feature', 'violet', 3),
    ('优惠', 'Offer', 'green', 4),
    ('重要', 'Important', 'red', 5),
    ('新线路', 'New route', 'teal', 6),
    ('通知', 'Notice', 'slate', 7);

ALTER TABLE announcements
    ADD COLUMN tag_id uuid REFERENCES announcement_tags (id) ON DELETE RESTRICT;
CREATE INDEX announcements_tag ON announcements (tag_id) WHERE tag_id IS NOT NULL;
