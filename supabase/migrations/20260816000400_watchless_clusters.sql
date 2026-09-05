-- Fixes a bad assumption in 20260816000300: clusters were built watch-scoped,
-- but this app has no Watches UI and the Dashboard's "Collect" button never
-- sends a watch_id, every pattern created through the actual product has
-- watch_id NULL. Under the prior NOT NULL constraint, none of them could
-- ever get a cluster_id. Patterns with no watch now cluster together in
-- their own group (still scoped to the user), same idea, one less
-- assumption about how the product is actually used.

ALTER TABLE public.community_clusters
  ALTER COLUMN watch_id DROP NOT NULL;

-- `=` on two NULLs is NULL (never true), so the watch match has to be
-- null-safe or a watchless pattern would never match a watchless cluster.
CREATE OR REPLACE FUNCTION public.match_community_clusters(
  p_user_id        UUID,
  p_watch_id       UUID,
  p_embedding      extensions.vector(1536),
  p_match_count    INT,
  p_min_similarity FLOAT
)
RETURNS TABLE (
  id            UUID,
  label         TEXT,
  surface       TEXT,
  pattern_count INTEGER,
  similarity    FLOAT
)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, extensions
AS $$
  SELECT
    cc.id,
    cc.label,
    cc.surface,
    cc.pattern_count,
    1 - (cc.embedding <=> p_embedding) AS similarity
  FROM public.community_clusters cc
  WHERE cc.user_id = p_user_id
    AND cc.watch_id IS NOT DISTINCT FROM p_watch_id
    AND cc.embedding IS NOT NULL
    AND 1 - (cc.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY cc.embedding <=> p_embedding ASC
  LIMIT p_match_count;
$$;
