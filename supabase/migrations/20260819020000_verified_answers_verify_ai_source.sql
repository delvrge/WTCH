-- Renames verified_answers.tracked -> verified, and adds a `source` column,
-- to support an autonomous drafting path (stage-ai-drafts) alongside the
-- existing manual save flow (save-verified / ReplyBlock "Save to Replies").
--
-- Today every row in verified_answers was put there by a human action ,
-- clicking "Save to Replies" on an AI draft, or filling in the manual-entry
-- form, so `tracked` (default true) already meant "trust this, use it to
-- ground and cite future drafts." That is exactly what "verified" means
-- going forward, so this is a rename, not a new concept: existing rows keep
-- behaving exactly as before.
--
-- What's new is stage-ai-drafts, which writes a drafted reply into this
-- table on its own, with no click, for a case that's open in the Library
-- and doesn't have a reply yet. Those rows insert with verified = false, so
-- they sit in Replies for review without silently grounding anything until
-- the operator flips the toggle. `source` records which path wrote the row,
-- so the UI can show "AI draft" on the ones still waiting for review.
ALTER TABLE public.verified_answers RENAME COLUMN tracked TO verified;

ALTER TABLE public.verified_answers
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_draft'));

CREATE INDEX IF NOT EXISTS verified_answers_source_idx ON public.verified_answers (source);

-- Same signature/return shape as the v2 function in 20260818000000, the
-- WHERE clause is the only change, so CREATE OR REPLACE is safe here (no
-- DROP needed, unlike the source_url-adding change in that same migration).
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
    AND va.verified = true
    AND va.embedding IS NOT NULL
    AND 1 - (va.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY va.embedding <=> p_embedding ASC
  LIMIT p_match_count;
$$;
