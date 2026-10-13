-- Own-client-only mode (strategic decision 2; PLAN-next "进行中" item 2,
-- SPRINT `v1-next-1013`): 系统设置 → 订阅 → 「仅自研客户端」.
--
-- `panel_settings.sub_own_client_only` (NULL = off): while on, every
-- third-party subscription format and one-click import button is off (the
-- stored `sub_formats` / `sub_import_clients` lists are kept untouched, so
-- turning the mode off restores the operator's choice), the subscription
-- URL answers only the Akari client (User-Agent `akari-client/…`), and the
-- portal never shows the link (only the client download: the client will
-- sign in with the user's account and fetch its profile).

ALTER TABLE panel_settings ADD COLUMN sub_own_client_only boolean;
