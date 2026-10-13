-- Routing PR 2: the panel's copies of the remote rule-sets the subscription
-- routing names (`sub::rulesets`). One row per link: the converted sing-box
-- `source` rule-set it hosts at /{sub_path}/rules/<id>.json, its counts,
-- the upstream validators for conditional refreshes, and the refresh
-- state. A row without a body = the link has never been downloaded
-- successfully (only the daily refresh writes such rows, for links saved
-- before this migration); a failed refresh keeps the last good body.
CREATE TABLE sub_rule_sets (
    -- First 32 hex digits of SHA-256(url): the hosted file name.
    id text PRIMARY KEY CONSTRAINT sub_rule_sets_id CHECK (id ~ '^[0-9a-f]{32}$'),
    url text NOT NULL UNIQUE CONSTRAINT sub_rule_sets_url CHECK (length(url) BETWEEN 12 AND 512),
    -- The hosted JSON and its ETag; counts (parse::Counts) and the number
    -- of rules sing-box can use (0 = the profile leaves the list out).
    body text,
    etag text,
    counts jsonb,
    kept integer,
    upstream_etag text CONSTRAINT sub_rule_sets_upstream_etag CHECK (length(upstream_etag) <= 128),
    upstream_last_modified text
        CONSTRAINT sub_rule_sets_upstream_last_modified CHECK (length(upstream_last_modified) <= 128),
    -- Last good copy (downloaded, or confirmed unchanged by a 304).
    fetched_at timestamptz,
    -- Last attempt.
    checked_at timestamptz NOT NULL DEFAULT now(),
    -- The last refresh error, since when the link has been failing.
    last_error text CONSTRAINT sub_rule_sets_last_error CHECK (length(last_error) <= 500),
    failing_since timestamptz,
    CONSTRAINT sub_rule_sets_copy CHECK (
        (body IS NULL) = (etag IS NULL)
        AND (body IS NULL) = (counts IS NULL)
        AND (body IS NULL) = (kept IS NULL)
        AND (body IS NULL) = (fetched_at IS NULL)
        AND (kept IS NULL OR kept >= 0)
        AND (body IS NULL OR octet_length(body) <= 16777216)
        AND (counts IS NULL OR jsonb_typeof(counts) = 'object')
    ),
    CONSTRAINT sub_rule_sets_failing CHECK ((last_error IS NULL) = (failing_since IS NULL))
);
