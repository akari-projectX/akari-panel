-- The node install script no longer has a fallback download: every download
-- is checked against the SHA-256 the panel wrote into the script, so the
-- operator-set fallback URL (and its length CHECK) goes.
ALTER TABLE panel_settings DROP COLUMN install_fallback_url;
