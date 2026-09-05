-- Persisted corpus for the configured SUPPORT_DOCS_HOST's support docs.
--
-- Previously _shared/support-docs.ts crawled the support-docs host fresh on every
-- draft-reply request (module-cache TTL only, no DB row survived a cold
-- isolate), which capped the corpus at MAX_PAGES=25 to stay inside one
-- request's time budget. That crawl now runs off the request path in the
-- crawl-support-docs edge function, walking hundreds of pages and upserting
-- them here; searchSupportDocs() reads this table instead of crawling.
--
-- No user_id: this is not user data, it is one shared read-only mirror of
-- the vendor's own public documentation, fed exclusively by crawl-support-docs
-- (service role) and read exclusively by searchSupportDocs (also called
-- with a service-role client from draft-reply). Every other table in this
-- schema is RLS-scoped to auth.uid() = user_id because the anon key ships
-- to the browser and needs a policy to open under; this table has no owning
-- user to scope to, so RLS stays enabled per house convention but
-- deliberately carries NO policies, the anon key gets zero rows here,
-- which is the safe default for a table only edge functions should ever
-- touch.

CREATE TABLE public.support_docs (
  url          TEXT        PRIMARY KEY,
  title        TEXT        NOT NULL DEFAULT '',
  text         TEXT        NOT NULL DEFAULT '',
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Generated (not maintained by application code) so it can never drift
  -- out of sync with title/text. title is weighted 'A' (outranks body text)
  -- since a keyword hit in the title is a stronger relevance signal than
  -- the same hit buried in the page body.
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(text, '')), 'B')
  ) STORED
);

COMMENT ON COLUMN public.support_docs.text IS
  'Full plain-text of the page, as produced by htmlToText() in _shared/support-docs.ts. Kept whole (not excerpted) so grounding.ts can verify a quoted citation appears verbatim anywhere on the page.';

CREATE INDEX support_docs_search_vector_idx
  ON public.support_docs USING GIN (search_vector);

ALTER TABLE public.support_docs ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies, see header comment. Only a service-role
-- client (crawl-support-docs, searchSupportDocs) reads or writes this
-- table; both bypass RLS entirely, so no policy is needed for them to
-- work, and none is added for anon/authenticated roles.
