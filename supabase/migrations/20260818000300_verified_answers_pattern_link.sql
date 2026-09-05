-- Lets a verified answer (Tracker entry) point at the exact community
-- pattern/thread it answers, and carry that thread's URL along for display.
-- Purely descriptive: match_verified_answers still retrieves by embedding
-- similarity on question_summary, same as before, this does not change how
-- a future post gets matched, it just lets the operator record which post a
-- given answer was written for.

ALTER TABLE public.verified_answers
  ADD COLUMN pattern_id UUID REFERENCES public.community_patterns(id) ON DELETE SET NULL,
  ADD COLUMN source_url TEXT;

CREATE INDEX verified_answers_pattern_id_idx
  ON public.verified_answers (pattern_id);

-- Surface source_url alongside the existing match_verified_answers columns
-- so the Dashboard's Tracker rows can link out to the thread when one is on
-- record.
-- The return type gains source_url, and Postgres refuses to change an
-- existing function's return type in place (SQLSTATE 42P13), so the old
-- signature has to be dropped before it can be recreated.
DROP FUNCTION IF EXISTS public.match_verified_answers(
  UUID,
  extensions.vector(1536),
  INT,
  FLOAT
);

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
  source_url       TEXT,
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
    va.source_url,
    1 - (va.embedding <=> p_embedding) AS similarity
  FROM public.verified_answers va
  WHERE va.user_id = p_user_id
    AND va.embedding IS NOT NULL
    AND va.tracked = true
    AND 1 - (va.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY va.embedding <=> p_embedding ASC
  LIMIT p_match_count;
$$;
