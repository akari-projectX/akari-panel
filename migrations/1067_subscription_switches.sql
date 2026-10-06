-- PR ② section 5 (user request 2026-10-06): switches per subscription
-- format and per one-click import client of the portal.
--
-- `sub_formats`: the output formats the subscription URL answers with
-- (NULL = all, the default; an explicit list = exactly those, so a format
-- added by a later release stays off for an operator who chose a list —
-- the way to keep only the own client's channel once it exists). A
-- format that is off answers the uniform rejection (never "disabled").
-- `sub_import_clients`: the portal's one-click import buttons (NULL = all;
-- a button whose format is off is hidden as well).

ALTER TABLE panel_settings
    ADD COLUMN sub_formats text[],
    ADD COLUMN sub_import_clients text[],
    ADD CONSTRAINT panel_settings_sub_formats CHECK (sub_formats IS NULL OR (
        sub_formats <@ ARRAY['clash', 'sing-box', 'links']::text[]
        AND array_position(sub_formats, NULL) IS NULL)),
    ADD CONSTRAINT panel_settings_sub_import_clients CHECK (sub_import_clients IS NULL OR (
        sub_import_clients <@ ARRAY['clash', 'stash', 'shadowrocket', 'sing-box', 'hiddify']::text[]
        AND array_position(sub_import_clients, NULL) IS NULL));
