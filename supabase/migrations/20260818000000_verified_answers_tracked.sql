-- Saving a reply to verified_answers shouldn't force it into the citation
-- pool — some entries are just a personal record (e.g. answered outside the
-- reply flow, or a note-to-self) and were never meant to ground a future
-- draft or show up in Tracker search. `tracked` gates both: loadGrounding
-- (grounding.ts) and match_verified_answers (the Tracker's semantic search,
-- used by draft-reply) now both require it. Defaults true so every existing
-- row and every reply saved via ReplyBlock's normal flow keeps behaving
-- exactly as before — this only matters when explicitly turned off.

ALTER TABLE public.verified_answers
  ADD COLUMN tracked BOOLEAN NOT NULL DEFAULT true;

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
    AND va.tracked = true
    AND va.embedding IS NOT NULL
    AND 1 - (va.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY va.embedding <=> p_embedding ASC
  LIMIT p_match_count;
$$;
