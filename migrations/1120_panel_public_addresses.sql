-- DNS management (linking): the panel's own public addresses, used by "point
-- at this panel" (A / AAAA records of the site domains). Written by the owner
-- only (`dns::link::apply_update_addresses`, audit
-- settings.public_addresses.update); NULL = not set. Validated as public
-- (global unicast) addresses by the writer.
ALTER TABLE panel_settings
    ADD COLUMN public_ipv4 text,
    ADD COLUMN public_ipv6 text,
    ADD CONSTRAINT panel_settings_public_ipv4 CHECK (public_ipv4 IS NULL OR (public_ipv4 ~ '^[0-9.]{7,15}$')),
    ADD CONSTRAINT panel_settings_public_ipv6 CHECK (public_ipv6 IS NULL OR (public_ipv6 ~ '^[0-9a-f:.]{2,45}$' AND position(':' in public_ipv6) > 0));
