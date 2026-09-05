-- Vector search over topic_taxonomy_posts.
--
-- The table already holds embedded community posts (scraped and embedded
-- by scripts/topic-taxonomy/), but it was only ever read by those one-off
-- analysis scripts, which pulled embeddings out and clustered them offline.
-- Nothing could search it at runtime. The investigation walkthrough needs to,
-- so it can look for past posts describing the same problem and then check
-- which of them were actually answered.
--
-- Mirrors match_community_patterns (20260815000100) exactly: same signature
-- shape, same SECURITY INVOKER, same search_path note for the `<=>` operator.
--
-- NOTE ON EMBEDDING SHAPE: these vectors are embeddings of `title_en ||
-- body_en` (full translated post text), NOT of an abstracted one-line summary
-- like community_patterns.embedding. Callers must query this function with a
-- full-text-shaped embedding, not the normalized issue description used for
-- the other two searches, or the comparison is raw-vs-abstracted and scores
-- collapse. See _shared/solved-cases.ts.

CREATE OR REPLACE FUNCTION public.match_taxonomy_posts(
  p_user_id        UUID,
  p_embedding      extensions.vector(1536),
  p_match_count    INT,
  p_min_similarity FLOAT
)
RETURNS TABLE (
  id              UUID,
  url             TEXT,
  board           TEXT,
  title           TEXT,
  title_en        TEXT,
  topic           TEXT,
  subtopic        TEXT,
  post_created_at TIMESTAMPTZ,
  similarity      FLOAT
)
LANGUAGE sql
SECURITY INVOKER
STABLE
-- pgvector lives in the `extensions` schema, so the `<=>` distance operator is
-- not on the default search path inside the function body.
SET search_path = public, extensions
AS $$
  SELECT
    p.id,
    p.url,
    p.board,
    p.title,
    p.title_en,
    p.topic,
    p.subtopic,
    p.post_created_at,
    1 - (p.embedding <=> p_embedding) AS similarity
  FROM public.topic_taxonomy_posts p
  WHERE p.user_id = p_user_id
    AND p.embedding IS NOT NULL
    AND 1 - (p.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY p.embedding <=> p_embedding
  LIMIT p_match_count;
$$;
