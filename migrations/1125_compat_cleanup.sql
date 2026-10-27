-- Compatibility cleanup (folded into the new baseline at the squash).
-- Every subscription token has its hash and its ciphertext.
DROP TRIGGER users_sub_token_enc_guard ON users;
DROP FUNCTION akari_sub_token_enc_guard();
ALTER TABLE users DROP CONSTRAINT users_sub_token_enc_has_hash;
ALTER TABLE users ADD CONSTRAINT users_sub_token_pair
    CHECK ((sub_token_hash IS NULL) = (sub_token_enc IS NULL));
