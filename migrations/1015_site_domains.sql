-- PR ③ (v0.4 D8): the main, subscription and node communication domains
-- become lists, each with one preferred entry.
--
-- site_domains: one row per (kind, name). `domain` is the normalized
-- authority (settings::Domain::authority: lower-case host or IP literal,
-- IPv6 in brackets, optional port); `host` is its host part (IPv6 without
-- brackets) — what a request's Host header is matched against. A host
-- serves one HTTP role: main and subscription names never share one
-- (site_domains_http_host); a node communication name may share the main
-- domain's host (agents dial the gRPC port; HTTP for it is the main
-- domain's). Exactly one preferred entry per kind that has entries: at most
-- one by site_domains_one_preferred, at least one checked at commit
-- (site_domains_preferred, deferred, AK030).
--
-- What uses the preferred entries: main = install links, mail links,
-- payment notify URLs, passkeys' RP ID; subscription = subscription links
-- (or, with panel_settings.sub_domain_per_user, each user's own choice
-- among all subscription domains by rendezvous hashing); node = new
-- bootstrap files and install scripts (every node name ever written into
-- one stays in grpc_server_names: the certificate's SAN set only grows).
-- Changes notify every instance like the other settings.

CREATE TABLE site_domains (
    id bigint GENERATED ALWAYS AS IDENTITY,
    kind text NOT NULL,
    domain text NOT NULL,
    host text NOT NULL,
    preferred boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_domains_kind CHECK ((kind = ANY (ARRAY['main'::text, 'sub'::text, 'node'::text]))),
    CONSTRAINT site_domains_domain CHECK (((char_length(domain) >= 1) AND (char_length(domain) <= 300))),
    CONSTRAINT site_domains_host CHECK (((char_length(host) >= 1) AND (char_length(host) <= 253)))
);

ALTER TABLE ONLY site_domains ADD CONSTRAINT site_domains_pkey PRIMARY KEY (id);
ALTER TABLE ONLY site_domains ADD CONSTRAINT site_domains_kind_host_key UNIQUE (kind, host);
CREATE UNIQUE INDEX site_domains_http_host ON site_domains (host) WHERE (kind = ANY (ARRAY['main'::text, 'sub'::text]));
CREATE UNIQUE INDEX site_domains_one_preferred ON site_domains (kind) WHERE preferred;

CREATE FUNCTION site_domains_preferred() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM site_domains GROUP BY kind HAVING NOT bool_or(preferred)) THEN
        RAISE EXCEPTION 'every domain kind with entries needs a preferred one'
            USING ERRCODE = 'AK030';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER site_domains_preferred AFTER INSERT OR DELETE OR UPDATE ON site_domains
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION site_domains_preferred();

CREATE TRIGGER site_domains_notify AFTER INSERT OR DELETE OR UPDATE ON site_domains
    FOR EACH STATEMENT EXECUTE FUNCTION akari_settings_notify();

-- The single values become the preferred entries.
INSERT INTO site_domains (kind, domain, host, preferred)
SELECT k, d, CASE WHEN d LIKE '[%' THEN substring(d FROM '^\[([^]]+)\]') ELSE split_part(d, ':', 1) END, true
FROM panel_settings,
     LATERAL (VALUES ('main', main_domain), ('sub', sub_domain), ('node', node_domain)) AS v(k, d)
WHERE d IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE panel_settings
    DROP COLUMN main_domain,
    DROP COLUMN sub_domain,
    DROP COLUMN node_domain,
    ADD COLUMN sub_domain_per_user boolean;
