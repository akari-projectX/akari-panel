-- W30: routing rules in the subscriptions (admin-editable template).
--
-- `sub_rules`: the ordered rules every Clash (rule-providers) and sing-box
-- (route.rule_set) subscription carries before the final "everything else
-- through the proxy" (NULL = the built-in default: ads rejected, private
-- and mainland-China destinations direct; [] = no rules). Shape checked by
-- the API (`sub::routing::parse`): [{type, value, action}].
-- `sub_rule_set_clash_url` / `sub_rule_set_singbox_url`: where clients
-- download the geosite/geoip lists, `{kind}` (geosite|geoip) and `{name}`
-- substituted (NULL = the MetaCubeX meta-rules-dat lists on jsDelivr).
-- Same row, version and change notification as the other settings.

ALTER TABLE panel_settings
    ADD COLUMN sub_rules jsonb,
    ADD COLUMN sub_rule_set_clash_url text,
    ADD COLUMN sub_rule_set_singbox_url text,
    ADD CONSTRAINT panel_settings_sub_rules CHECK (sub_rules IS NULL OR (jsonb_typeof(sub_rules) = 'array'
        AND jsonb_array_length(sub_rules) <= 64)),
    ADD CONSTRAINT panel_settings_sub_rule_set_urls CHECK (
        (sub_rule_set_clash_url IS NULL OR char_length(sub_rule_set_clash_url) BETWEEN 12 AND 512)
        AND (sub_rule_set_singbox_url IS NULL OR char_length(sub_rule_set_singbox_url) BETWEEN 12 AND 512));
