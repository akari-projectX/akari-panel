-- Ops (knowledge base, xboard parity): help articles in categories, shown
-- in the portal's 帮助 / Help view (published ones only; the portal search
-- matches titles and bodies in both languages). Bodies are the safe
-- Markdown subset (src/markdown.rs); the English variant is optional.

CREATE TABLE kb_categories (
    id UUID PRIMARY KEY,
    name_zh TEXT NOT NULL CHECK (char_length(name_zh) BETWEEN 1 AND 64),
    name_en TEXT CHECK (name_en IS NULL OR char_length(name_en) BETWEEN 1 AND 64),
    sort INT NOT NULL DEFAULT 0 CHECK (sort BETWEEN -1000000 AND 1000000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kb_articles (
    id UUID PRIMARY KEY,
    category_id UUID REFERENCES kb_categories(id) ON DELETE SET NULL,
    title_zh TEXT NOT NULL CHECK (char_length(title_zh) BETWEEN 1 AND 120),
    title_en TEXT CHECK (title_en IS NULL OR char_length(title_en) BETWEEN 1 AND 120),
    body_zh TEXT NOT NULL CHECK (char_length(body_zh) BETWEEN 1 AND 65536),
    body_en TEXT CHECK (body_en IS NULL OR char_length(body_en) BETWEEN 1 AND 65536),
    sort INT NOT NULL DEFAULT 0 CHECK (sort BETWEEN -1000000 AND 1000000),
    published BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX kb_articles_category ON kb_articles (category_id, sort, created_at);
CREATE INDEX kb_articles_published ON kb_articles (sort, created_at) WHERE published;
