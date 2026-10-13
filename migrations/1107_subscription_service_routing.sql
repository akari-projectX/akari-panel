-- Subscription routing with service groups, pinned lines and failover,
-- region / tag groups and DNS (2026-10-13, `sub-service-groups`; replaces
-- the W30 flat template of 1066).
--
-- `sub_routing`: the operator's routing as one object (shape checked by the
-- API, `sub::routing::Config::parse`): {mode, block, direct, services, rest,
-- tag_groups, dns}; NULL = the recommended built-in. Same row, version and
-- change notification as the other settings; the rule list URL templates
-- of 1066 stay.
--
-- Existing W30 rules move over without loss of any rule: each rule keeps its
-- {type, value}; reject rules become `block`, direct rules `direct`, proxy
-- rules the items of one service "代理" with no pinned line (= the default
-- proxy, what PROXY was). The new model matches by section (block, then
-- direct, then services), so a list is reproduced exactly when it was
-- already ordered reject → direct → proxy (the built-in default and lists
-- edited from it are); in an interleaved list, an earlier rule of a later
-- section no longer wins over an overlapping rule of an earlier section.
-- A site still on the built-in default (NULL) gets the new recommended
-- routing.

ALTER TABLE panel_settings
    ADD COLUMN sub_routing jsonb,
    ADD CONSTRAINT panel_settings_sub_routing CHECK (sub_routing IS NULL
        OR (jsonb_typeof(sub_routing) = 'object' AND pg_column_size(sub_routing) <= 262144));

UPDATE panel_settings SET sub_routing = jsonb_build_object(
    'mode', 'rules',
    'block', coalesce((
        SELECT jsonb_agg(r - 'action' ORDER BY i)
        FROM jsonb_array_elements(sub_rules) WITH ORDINALITY AS t(r, i)
        WHERE r->>'action' = 'reject'), '[]'::jsonb),
    'direct', coalesce((
        SELECT jsonb_agg(r - 'action' ORDER BY i)
        FROM jsonb_array_elements(sub_rules) WITH ORDINALITY AS t(r, i)
        WHERE r->>'action' = 'direct'), '[]'::jsonb),
    'services', coalesce((
        SELECT jsonb_build_array(jsonb_build_object(
            'key', 'proxy', 'name', '代理', 'emoji', '',
            'items', jsonb_agg(r - 'action' ORDER BY i),
            'primary', NULL, 'backups', '[]'::jsonb))
        FROM jsonb_array_elements(sub_rules) WITH ORDINALITY AS t(r, i)
        WHERE r->>'action' = 'proxy'
        HAVING count(*) > 0), '[]'::jsonb),
    'rest', NULL,
    'tag_groups', '[]'::jsonb)
WHERE sub_rules IS NOT NULL;

ALTER TABLE panel_settings
    DROP CONSTRAINT panel_settings_sub_rules,
    DROP COLUMN sub_rules;
