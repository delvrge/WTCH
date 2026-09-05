-- Retires the community_clusters system entirely. Deferred from
-- 20260820010000_fixed_topic_taxonomy.sql until every live reader was
-- migrated off it: Cases and Replies' box grouping (both retired to the
-- fixed topic/subtopic taxonomy), Context's Categories panel and graph
-- (repointed to the fixed taxonomy too). Confirmed via full-repo grep
-- immediately before this migration that nothing else reads
-- community_clusters, cluster_evolution_log, or either cluster_id column —
-- the app-side cleanup accompanying this migration removed the last few
-- references (save-verified edge function's cluster_id handling, lib/cases.ts's
-- dead cluster-fallback path for orphaned verified_answers, and the Library
-- page's already-dead Patterns-browser fetch and lib/library.ts, both
-- leftover from a screen removed earlier and never cleaned up).
--
-- community_patterns.cluster (a separate free-text column, not cluster_id)
-- is NOT touched here — out of scope, untouched by anything in this pass.

ALTER TABLE public.community_patterns DROP COLUMN cluster_id;
ALTER TABLE public.verified_answers DROP COLUMN cluster_id;

-- The only other object referencing community_clusters (never called by any
-- live code — extract-pattern's fast-path attach-or-create was retired with
-- refine-clusters). Dropped explicitly, ahead of the table, rather than
-- relying on CASCADE to take it out implicitly.
DROP FUNCTION public.match_community_clusters(UUID, UUID, extensions.vector(1536), INT, FLOAT);

DROP TABLE public.community_clusters;
DROP TABLE public.cluster_evolution_log;
