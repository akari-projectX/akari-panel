-- Subscription templates (2026-10-27, brief sub-templates): the per-client
-- configuration an operator edits, replacing the routing page.
--
-- `sub_templates`: one row per client format; no row = the built-in
-- default (src/sub/templates/<format>.tmpl). Body checked by the API
-- (`sub::templates::apply_set`), not here, except for size.
CREATE TABLE sub_templates (
    format text PRIMARY KEY
        CONSTRAINT sub_templates_format CHECK (format IN ('sing-box', 'clash', 'surge', 'surfboard')),
    body text NOT NULL CONSTRAINT sub_templates_body CHECK (length(body) BETWEEN 1 AND 262144),
    version bigint NOT NULL DEFAULT 1 CONSTRAINT sub_templates_version CHECK (version >= 1),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
);

-- Surge and Surfboard join the output formats and the portal's import
-- buttons. A site that never customised the lists (NULL) gets them on; a
-- stored list keeps its choice (the new ids are simply not in it).
ALTER TABLE panel_settings
    DROP CONSTRAINT panel_settings_sub_formats,
    DROP CONSTRAINT panel_settings_sub_import_clients,
    ADD CONSTRAINT panel_settings_sub_formats CHECK (sub_formats IS NULL OR (
        sub_formats <@ ARRAY['clash', 'sing-box', 'links', 'surge', 'surfboard']::text[]
        AND array_position(sub_formats, NULL) IS NULL)),
    ADD CONSTRAINT panel_settings_sub_import_clients CHECK (sub_import_clients IS NULL OR (
        sub_import_clients <@ ARRAY['clash', 'stash', 'shadowrocket', 'sing-box', 'hiddify', 'surge', 'surfboard']::text[]
        AND array_position(sub_import_clients, NULL) IS NULL));

-- The routing the templates replace. The panel converts it ONCE into the
-- four templates at startup (`sub::templates::import_legacy`, which needs
-- the old values), then drops `sub_routing_legacy`. Only a site that
-- changed the routing or the rule list URLs gets a row.
CREATE TABLE sub_routing_legacy (
    id boolean PRIMARY KEY DEFAULT true CONSTRAINT sub_routing_legacy_one CHECK (id),
    routing jsonb,
    clash_url text,
    singbox_url text
);
INSERT INTO sub_routing_legacy (routing, clash_url, singbox_url)
    SELECT sub_routing, sub_rule_set_clash_url, sub_rule_set_singbox_url
    FROM panel_settings
    WHERE sub_routing IS NOT NULL OR sub_rule_set_clash_url IS NOT NULL OR sub_rule_set_singbox_url IS NOT NULL;

ALTER TABLE panel_settings
    DROP COLUMN sub_routing,
    DROP COLUMN sub_rule_set_clash_url,
    DROP COLUMN sub_rule_set_singbox_url;
DROP TABLE sub_rule_sets;
