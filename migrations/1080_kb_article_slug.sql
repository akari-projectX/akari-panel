-- W33-b: a fixed address for knowledge base articles. The portal's legal
-- pages read the articles with slug `terms` and `privacy` (edited in the
-- console's 内容 view); other slugs are free for links. NULL = none.
ALTER TABLE kb_articles ADD COLUMN slug text;
ALTER TABLE kb_articles ADD CONSTRAINT kb_articles_slug_format
    CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]{0,63}$');
ALTER TABLE kb_articles ADD CONSTRAINT kb_articles_slug_key UNIQUE (slug);
