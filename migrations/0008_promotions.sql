-- Promotions: the dashboard's activity slot (限时活动). An admin sets a title,
-- a one-line description, an optional badge ("8折"), an optional coupon whose
-- code is shown while the coupon is usable, an optional call to action and a
-- required window (the slot counts down to ends_at). Users see at most one:
-- enabled, inside the window by the database clock, in the audience; highest
-- sort first, then the one ending soonest (promotions::my_promotion).
-- Written only by promotions::apply_* (audit promotion.*); version is the
-- optimistic-concurrency counter for the admin form.
CREATE TABLE promotions (
    id uuid PRIMARY KEY,
    title_zh text NOT NULL CHECK (char_length(title_zh) BETWEEN 1 AND 40),
    title_en text CHECK (char_length(title_en) BETWEEN 1 AND 80),
    line_zh text NOT NULL CHECK (char_length(line_zh) BETWEEN 1 AND 80),
    line_en text CHECK (char_length(line_en) BETWEEN 1 AND 160),
    badge text CHECK (char_length(badge) BETWEEN 1 AND 8),
    coupon_id uuid REFERENCES coupons (id) ON DELETE SET NULL,
    cta_label text CHECK (char_length(cta_label) BETWEEN 1 AND 16),
    cta_url text CHECK (char_length(cta_url) BETWEEN 1 AND 512 AND (cta_url ~ '^(https?://|/)')),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'with_plan', 'without_plan')),
    enabled boolean NOT NULL DEFAULT true,
    sort integer NOT NULL DEFAULT 0 CHECK (sort BETWEEN -1000000 AND 1000000),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT promotions_window CHECK (ends_at > starts_at)
);

CREATE INDEX promotions_live ON promotions (ends_at) WHERE enabled;
CREATE INDEX promotions_coupon ON promotions (coupon_id) WHERE coupon_id IS NOT NULL;
