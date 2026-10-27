-- Compatibility cleanup (folded into the new baseline at the squash).
-- Every subscription token has its hash and its ciphertext.
DROP TRIGGER users_sub_token_enc_guard ON users;
DROP FUNCTION akari_sub_token_enc_guard();
ALTER TABLE users DROP CONSTRAINT users_sub_token_enc_has_hash;
ALTER TABLE users ADD CONSTRAINT users_sub_token_pair
    CHECK ((sub_token_hash IS NULL) = (sub_token_enc IS NULL));

-- Panel.toml imports are gone.
DROP TABLE legacy_config_imports;
ALTER TABLE grpc_server_names DROP CONSTRAINT grpc_server_names_source_check;
ALTER TABLE grpc_server_names ADD CONSTRAINT grpc_server_names_source_check
    CHECK (source = ANY (ARRAY['settings'::text, 'enrollment'::text]));

-- Node-level labels are shown nowhere (the tags are the entrance's).
ALTER TABLE nodes DROP COLUMN tags;

-- Every enrollment token records the endpoint it was issued for.
ALTER TABLE server_enrollments ALTER COLUMN panel_addr SET NOT NULL;
ALTER TABLE server_enrollments ALTER COLUMN server_name SET NOT NULL;
