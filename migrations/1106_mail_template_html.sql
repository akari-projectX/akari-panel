-- Mail templates: an optional HTML source.
--
-- Until now an override replaced the subject and the plain-text body, and the
-- panel wrapped the text in its own HTML shell. `html_source` lets an admin
-- replace the whole HTML part (the shell included). The text body stays: it
-- is the multipart plain-text alternative and is still required.
--
-- NULL = no source: the HTML is built from the body as before. The API
-- validates the source (templates::validate_html: whitelisted placeholders,
-- the required ones present, no scripts / forms / event handlers); the
-- check here only bounds its size.

ALTER TABLE mail_templates ADD COLUMN html_source text;
ALTER TABLE mail_templates ADD CONSTRAINT mail_templates_html_check
    CHECK (html_source IS NULL OR char_length(html_source) BETWEEN 1 AND 100000);
