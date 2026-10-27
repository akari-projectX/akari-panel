-- Admin order search (`GET /orders?q=`, the summary counts and the CSV
-- export) matches `out_trade_no`, `trade_no` and, for an address, the
-- user's e-mail with ILIKE '%term%', which can only be answered by a
-- sequential scan (about 110 ms on 200 000 orders). Trigram indexes serve
-- the substring match. pg_trgm ships with PostgreSQL's contrib modules
-- (the PGDG packages, the postgres Docker image) and is a trusted
-- extension, so the database owner can create it. It lives in `public` so
-- the operator class resolves whatever the search_path is.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;

CREATE INDEX orders_out_trade_no_trgm ON orders USING gin (out_trade_no public.gin_trgm_ops);
CREATE INDEX orders_trade_no_trgm ON orders USING gin (trade_no public.gin_trgm_ops);
CREATE INDEX users_email_trgm ON users USING gin (email public.gin_trgm_ops);
