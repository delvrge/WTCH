-- Self-organizing clustering: real-time attach-or-create plus a periodic
-- "refine" sweep (merge near-duplicate clusters, split overloaded ones).
--
-- Two speeds, on purpose:
--   FAST PATH (every new pattern, ~free): embed the pattern, compare against
--   existing cluster centroids for its watch via match_community_clusters,
--   attach if close enough AND surface agrees, else spin a brand-new
--   provisional cluster immediately from that one pattern. No GPT call beyond
--   the extraction that already happens at ingest.
--   REFINE PATH (every 30 min, cheap): a GPT pass over cluster-level
--   summaries only (not every member pattern) proposes merges; a second,
--   narrower pass fetches full members only for clusters big enough to
--   plausibly be two issues stitched together, and proposes splits. Every
--   merge/split is written to cluster_evolution_log so an automatic mistake
--   is visible after the fact instead of silent.

-- ── community_clusters: give clusters a fingerprint too ─────────────────
-- embedding is the cluster's centroid, set at creation from the founding
-- pattern and refreshed by the refine pass after any merge/split. It is
-- deliberately NOT updated on every fast-path attach, precision drifts by
-- at most one refine interval, which the periodic pass corrects, and that
-- tradeoff is what keeps the fast path a pure read (no vector arithmetic).
-- surface mirrors community_patterns.surface: the same metadata gate used
-- for pattern-level dedup (surface must agree, "unknown" matches nothing)
-- also applies at cluster level, so embedding similarity alone never merges
-- two different features into one topic.

ALTER TABLE public.community_clusters
  ADD COLUMN embedding extensions.vector(1536),
  ADD COLUMN surface   TEXT;

CREATE INDEX community_clusters_embedding_hnsw_idx
  ON public.community_clusters USING hnsw (embedding extensions.vector_cosine_ops);

-- ── community_patterns: severity, the one genuinely new structured field ──
-- issue_summary already covers "symptom" and surface already covers
-- "product area", severity is the only axis those don't capture. Nullable:
-- older rows and threads where it can't be judged carry no value rather
-- than a guessed default.

ALTER TABLE public.community_patterns
  ADD COLUMN severity TEXT CHECK (severity IN ('low', 'medium', 'high'));

-- ── match_community_clusters ──────────────────────────────────────────────
-- Mirrors match_community_patterns, scoped additionally to one watch since
-- clusters are always watch-scoped (community_clusters.watch_id is NOT
-- NULL) and cross-watch topic matches would be meaningless.

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
    AND cc.watch_id = p_watch_id
    AND cc.embedding IS NOT NULL
    AND 1 - (cc.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY cc.embedding <=> p_embedding ASC
  LIMIT p_match_count;
$$;

-- ── cluster_evolution_log ─────────────────────────────────────────────────
-- Audit trail for the un-gated part of this system: every automatic merge
-- or split the refine pass performs gets one row here, so a bad automatic
-- call is something the operator can spot and undo, not something that just
-- silently happened.

CREATE TABLE public.cluster_evolution_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  watch_id   UUID        REFERENCES public.community_watches(id) ON DELETE SET NULL,
  action     TEXT        NOT NULL CHECK (action IN ('merge', 'split')),
  summary    TEXT        NOT NULL,
  details    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.cluster_evolution_log.summary IS
  'One human-readable line, e.g. "Merged ''credits disappearing'' + ''credits consumption'' into ''unexpected credit deductions''."';

COMMENT ON COLUMN public.cluster_evolution_log.details IS
  'Machine-readable: { from: [{id,label}], to: [{id,label}] } for both merge and split.';

ALTER TABLE public.cluster_evolution_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_cluster_evolution_log"
  ON public.cluster_evolution_log FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_cluster_evolution_log"
  ON public.cluster_evolution_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_cluster_evolution_log"
  ON public.cluster_evolution_log FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX cluster_evolution_log_user_id_idx
  ON public.cluster_evolution_log (user_id, created_at DESC);

-- ── Cron: refine every 30 minutes ─────────────────────────────────────────
-- pg_net's http_post reads the service-role key out of Vault at call time ,
-- never written into this file, never in git history. Before this job can
-- actually authenticate, run once in the Supabase SQL editor (not from a
-- migration, so the secret is never committed):
--
--   select vault.create_secret('<paste service_role key here>', 'service_role_key');
--
-- refine-clusters itself accepts this key as a Bearer token in place of an
-- interactive user session (see its service-role bypass branch).

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'refine-clusters-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wcpwagwcuercdsfalmkc.supabase.co/functions/v1/refine-clusters',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
