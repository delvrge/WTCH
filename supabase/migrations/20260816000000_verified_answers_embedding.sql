-- Embedding-based retrieval for the tracker (verified_answers), mirroring
-- community_patterns' pgvector setup. Replaces draft-reply's keyword-overlap
-- scoring of verified_answers with semantic similarity search.

ALTER TABLE public.verified_answers
  ADD COLUMN embedding extensions.vector(1536);

CREATE INDEX verified_answers_embedding_hnsw_idx
  ON public.verified_answers USING hnsw (embedding extensions.vector_cosine_ops);

-- ── Similarity search RPC ────────────────────────────────────────────────
-- SECURITY INVOKER (not DEFINER) so RLS still applies, this runs as the
-- requesting user, mirroring match_community_patterns.

CREATE OR REPLACE FUNCTION public.match_verified_answers(
  p_user_id        UUID,
  p_embedding      extensions.vector(1536),
  p_match_count    INT,
  p_min_similarity FLOAT
)
RETURNS TABLE (
  id               UUID,
  question_summary TEXT,
  answer_text      TEXT,
  verified_at      TIMESTAMPTZ,
  similarity       FLOAT
)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, extensions
AS $$
  SELECT
    va.id,
    va.question_summary,
    va.answer_text,
    va.verified_at,
    1 - (va.embedding <=> p_embedding) AS similarity
  FROM public.verified_answers va
  WHERE va.user_id = p_user_id
    AND va.embedding IS NOT NULL
    AND 1 - (va.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY va.embedding <=> p_embedding ASC
  LIMIT p_match_count;
$$;
