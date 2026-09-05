-- Standing precedent bank of replies from trusted Community Managers /
-- Experts (see TRUSTED_AUTHORS in _shared/community-sources.ts) other than
-- the operator. Distinct from verified_answers on purpose: that table's
-- whole design is "a reply the operator actually sent and confirmed
-- worked" (see its header comment in 20260815000200_grounding.sql), these
-- rows are someone else's reply, never the operator's own, so folding them
-- in would misrepresent both what verified_answers means and what the
-- Investigate prompt tells the model it is reading.
--
-- Not split by author: all five trusted people are one pool, one authority
-- tier, matching TRUSTED_AUTHORS itself treating them identically via
-- citableAuthorityAnswers(). source_author/source_badge are kept only for
-- traceability (so a row can be inspected/debugged), never used to weight
-- or filter results.

CREATE TABLE public.trusted_replies (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_summary  TEXT        NOT NULL,
  answer_text       TEXT        NOT NULL,
  source_url        TEXT        NOT NULL,
  source_title      TEXT,
  source_author     TEXT        NOT NULL,
  source_badge      TEXT,
  is_accepted       BOOLEAN     NOT NULL DEFAULT false,
  thread_created_at TIMESTAMPTZ,
  embedding         extensions.vector(1536),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_url, source_author)
);

ALTER TABLE public.trusted_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_trusted_replies"
  ON public.trusted_replies FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_trusted_replies"
  ON public.trusted_replies FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_trusted_replies"
  ON public.trusted_replies FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_trusted_replies"
  ON public.trusted_replies FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX trusted_replies_user_id_idx
  ON public.trusted_replies (user_id);

CREATE INDEX trusted_replies_embedding_hnsw_idx
  ON public.trusted_replies USING hnsw (embedding extensions.vector_cosine_ops);

-- ── Similarity search RPC ────────────────────────────────────────────────
-- Mirrors match_verified_answers exactly (SECURITY INVOKER, same shape),
-- plus source_url/source_author so a citation can link to and label the
-- real thread.

CREATE OR REPLACE FUNCTION public.match_trusted_replies(
  p_user_id        UUID,
  p_embedding      extensions.vector(1536),
  p_match_count    INT,
  p_min_similarity FLOAT
)
RETURNS TABLE (
  id               UUID,
  question_summary TEXT,
  answer_text      TEXT,
  source_url       TEXT,
  source_author    TEXT,
  is_accepted      BOOLEAN,
  similarity       FLOAT
)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, extensions
AS $$
  SELECT
    tr.id,
    tr.question_summary,
    tr.answer_text,
    tr.source_url,
    tr.source_author,
    tr.is_accepted,
    1 - (tr.embedding <=> p_embedding) AS similarity
  FROM public.trusted_replies tr
  WHERE tr.user_id = p_user_id
    AND tr.embedding IS NOT NULL
    AND 1 - (tr.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY tr.embedding <=> p_embedding ASC
  LIMIT p_match_count;
$$;
