-- Abstracted community-support patterns per user, used for AI-assisted
-- reply suggestions. A pattern captures the SHAPE of a recurring issue
-- (summary + typical approach) so it can be matched against future questions
-- via embedding similarity. The raw post/reply text is deliberately never
-- stored here, only these abstracted summaries and the source links.

CREATE TABLE public.community_patterns (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  watch_id            UUID          REFERENCES public.community_watches(id) ON DELETE CASCADE,
  cluster_id          UUID          REFERENCES public.community_clusters(id) ON DELETE SET NULL,
  cluster             TEXT,
  issue_summary       TEXT          NOT NULL,
  typical_approach    TEXT          NOT NULL,
  surface             TEXT,
  tags                TEXT[]        NOT NULL DEFAULT '{}',
  frequency           INTEGER       NOT NULL DEFAULT 1 CHECK (frequency > 0),
  source_url          TEXT,
  source_urls         TEXT[]        NOT NULL DEFAULT '{}',
  thread_created_at   TIMESTAMPTZ,
  source_thread_dates TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
  review_status       TEXT          NOT NULL DEFAULT 'unreviewed'
                        CHECK (review_status IN ('unreviewed', 'confirmed', 'rejected')),
  reviewed_at         TIMESTAMPTZ,
  last_seen           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  embedding           extensions.vector(1536)
);

COMMENT ON COLUMN public.community_patterns.surface IS
  'Short lowercase noun phrase for what the user was doing / which feature failed (e.g. "video generation", "image generation", "image to video", "billing/credits", "account/login"). Nullable. Acts as a dedup facet alongside embedding similarity so generically-titled threads describing genuinely different issues do not merge into one pattern.';

COMMENT ON COLUMN public.community_patterns.source_url IS
  'The topic URL the pattern was first extracted from. A LINK, not raw post/reply content.';

COMMENT ON COLUMN public.community_patterns.source_urls IS
  'Every thread URL that contributed to this pattern, appended on each dedup bump, so the operator can audit every source by hand. Like source_url, these are LINKS only, never raw post/reply content.';

COMMENT ON COLUMN public.community_patterns.source_thread_dates IS
  'Parallel array to source_urls: the source date of each contributing thread, appended on each dedup bump the same way source_urls appends.';

COMMENT ON COLUMN public.community_patterns.thread_created_at IS
  'The NEWEST date in source_thread_dates, so "is this pattern still current" is a single column read. Parsed from the thread JSON-LD (dateCreated for QAPage, datePublished for DiscussionForumPosting).';

-- Users manage their own patterns directly, all four RLS policies are needed.
ALTER TABLE public.community_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_community_patterns"
  ON public.community_patterns FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_community_patterns"
  ON public.community_patterns FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_community_patterns"
  ON public.community_patterns FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_community_patterns"
  ON public.community_patterns FOR DELETE
  USING (auth.uid() = user_id);

-- ── Indexes ──────────────────────────────────────────────────────────────

CREATE INDEX community_patterns_user_id_idx
  ON public.community_patterns (user_id);

CREATE INDEX community_patterns_watch_id_idx
  ON public.community_patterns (watch_id);

CREATE INDEX community_patterns_cluster_id_idx
  ON public.community_patterns (cluster_id);

CREATE INDEX community_patterns_watch_id_review_status_idx
  ON public.community_patterns (watch_id, review_status);

CREATE INDEX community_patterns_embedding_hnsw_idx
  ON public.community_patterns USING hnsw (embedding extensions.vector_cosine_ops);

CREATE INDEX community_patterns_tags_gin_idx
  ON public.community_patterns USING gin (tags);

-- Default board view filters to sources newer than 90 days, widenable to
-- 180 / 365 / all.
CREATE INDEX community_patterns_thread_created_at_idx
  ON public.community_patterns (thread_created_at DESC);

-- ── Similarity search RPC ────────────────────────────────────────────────
-- Returns the caller's own patterns whose embedding is close to the query
-- embedding. SECURITY INVOKER (not DEFINER) so RLS still applies, this runs
-- as the requesting user.

CREATE OR REPLACE FUNCTION public.match_community_patterns(
  p_user_id        UUID,
  p_embedding      extensions.vector(1536),
  p_match_count    INT,
  p_min_similarity FLOAT
)
RETURNS TABLE (
  id               UUID,
  issue_summary    TEXT,
  typical_approach TEXT,
  tags             TEXT[],
  frequency        INTEGER,
  last_seen        TIMESTAMPTZ,
  similarity       FLOAT
)
LANGUAGE sql
SECURITY INVOKER
STABLE
-- pgvector lives in the `extensions` schema, so the `<=>` distance operator is
-- not on the default search path inside the function body.
SET search_path = public, extensions
AS $$
  SELECT
    cp.id,
    cp.issue_summary,
    cp.typical_approach,
    cp.tags,
    cp.frequency,
    cp.last_seen,
    1 - (cp.embedding <=> p_embedding) AS similarity
  FROM public.community_patterns cp
  WHERE cp.user_id = p_user_id
    AND 1 - (cp.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY cp.embedding <=> p_embedding ASC
  LIMIT p_match_count;
$$;
