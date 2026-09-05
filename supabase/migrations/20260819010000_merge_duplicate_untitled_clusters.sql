-- attachPatternToCluster (see _shared/pattern-extract.ts) used to spin up a
-- brand-new community_clusters row every time the model came back with no
-- cluster name, rather than reusing the one that already existed -- six
-- separate "Untitled" boxes on the Replies screen, all empty, indistinguish-
-- able from one another. The function is fixed going forward (same
-- migration commit); this is the one-time cleanup for what it already
-- created: fold every "Untitled" cluster per (user_id, watch_id) into the
-- oldest one, repoint anything pointing at the others, then drop them.

DO $$
DECLARE
  merged_patterns int;
  merged_replies int;
BEGIN
  CREATE TEMP TABLE untitled_merge AS
  WITH ranked AS (
    SELECT id, user_id, watch_id,
           row_number() OVER (
             PARTITION BY user_id, watch_id ORDER BY created_at ASC
           ) AS rn
    FROM public.community_clusters
    WHERE label = 'Untitled'
  )
  SELECT r.id AS dupe_id, c.id AS canonical_id
  FROM ranked r
  JOIN ranked c ON c.user_id = r.user_id
    AND c.watch_id IS NOT DISTINCT FROM r.watch_id
    AND c.rn = 1
  WHERE r.rn > 1;

  UPDATE public.community_patterns p
  SET cluster_id = m.canonical_id
  FROM untitled_merge m
  WHERE p.cluster_id = m.dupe_id;
  GET DIAGNOSTICS merged_patterns = ROW_COUNT;

  UPDATE public.verified_answers v
  SET cluster_id = m.canonical_id
  FROM untitled_merge m
  WHERE v.cluster_id = m.dupe_id;
  GET DIAGNOSTICS merged_replies = ROW_COUNT;

  DELETE FROM public.community_clusters c
  USING untitled_merge m
  WHERE c.id = m.dupe_id;

  -- pattern_count is a denormalized cache (see attachPatternToCluster) that
  -- the merge above makes stale on the surviving rows -- recompute it from
  -- the actual linked patterns rather than trying to sum the old values.
  UPDATE public.community_clusters c
  SET pattern_count = counted.n
  FROM (
    SELECT cluster_id, count(*) AS n
    FROM public.community_patterns
    WHERE cluster_id IN (SELECT DISTINCT canonical_id FROM untitled_merge)
    GROUP BY cluster_id
  ) counted
  WHERE c.id = counted.cluster_id;

  RAISE NOTICE 'untitled cluster merge: % patterns repointed, % replies repointed', merged_patterns, merged_replies;

  DROP TABLE untitled_merge;
END $$;
