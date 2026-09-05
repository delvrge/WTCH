-- Replaces the self-organizing cluster system (community_clusters +
-- refine-clusters' merge/split/retopic phases) with a FIXED, locked
-- 9-topic/27-subtopic taxonomy. HDBSCAN found no stable cluster count on
-- this corpus (a topical continuum, not density-separated groups, see
-- scripts/topic-taxonomy/), so an LLM map-reduce pass over post titles
-- proposed this taxonomy directly, and it was reviewed and locked by hand.
-- Canonical list: lib/topic-taxonomy.ts (app) / mirrored at
-- supabase/functions/_shared/topic-taxonomy.ts (edge functions).
--
-- community_clusters itself, cluster_evolution_log,
-- community_patterns.cluster/cluster_id, and verified_answers.cluster_id
-- are all DELIBERATELY NOT touched here, they stay until a later, separate
-- migration once the fixed taxonomy is confirmed working, dropping all of
-- it together in one pass (nothing here reads or writes those anymore, but
-- historical rows keep whatever they already had).

ALTER TABLE public.community_patterns
  ADD COLUMN subtopic TEXT;

COMMENT ON COLUMN public.community_patterns.subtopic IS
  'Fixed taxonomy, see lib/topic-taxonomy.ts. One of the 27 locked subtopics, or "Unclustered". NULL on patterns extracted before the fixed taxonomy replaced the self-organizing cluster system; a later one-time batch pass reclassifies those.';

-- `topic` already existed (added 20260816000500_cluster_topics.sql) as a
-- free-text column written by the old self-organizing prompt (values like
-- "Credits", "General", ...). Existing rows will NOT satisfy the fixed-list
-- CHECK below, so both constraints are added NOT VALID: enforced on every
-- new INSERT/UPDATE from today, but not retroactively checked against
-- existing rows. Run `VALIDATE CONSTRAINT` by hand once the one-time
-- reclassification pass (scripts/topic-taxonomy/5-llm-taxonomy.ts's
-- map-reduce shape, reused as classify-against-fixed-list) has updated
-- every pre-existing row.
ALTER TABLE public.community_patterns
  ADD CONSTRAINT community_patterns_topic_check
  CHECK (topic IS NULL OR topic IN (
    'Image Generation', 'Video Generation', 'Credit Management', 'Subscription Issues',
    'App Stability & Experience', 'Content Guidelines', 'Model Specific Problems',
    'Feedback and Suggestions', 'Access and Permissions', 'Unclustered'
  )) NOT VALID;

ALTER TABLE public.community_patterns
  ADD CONSTRAINT community_patterns_subtopic_check
  CHECK (subtopic IS NULL OR subtopic IN (
    'Image Generation Errors', 'Image Upload Issues', 'Quality and Accuracy Concerns',
    'Video Generation Errors', 'Audio and Video Sync Issues', 'Export and Download Failures',
    'Credit Usage Discrepancies', 'Credit Refund Requests', 'Credit Consumption Problems',
    'Subscription and Payment Issues', 'Subscription Activation Problems', 'Promotional Offers Confusion',
    'Errors and Bugs', 'Performance and Freezing', 'UI and Navigation Issues',
    'Content and Feature Bugs', 'Prompt Compliance', 'Content Credentials Problems',
    'Model Performance Issues', 'Non-Functioning Models', 'Model Limitations',
    'Feature Requests', 'Feedback and Reporting Issues', 'Miscellaneous Feature Requests',
    'Access Restrictions', 'Access to Previous Work', 'User Access Issues',
    'Unclustered'
  )) NOT VALID;

-- ── Retire the two cron jobs that drove the self-organizing system ────────
-- refine-clusters (merge/split/retopic + backlog sweep) and stage-ai-drafts
-- (auto-staged AI drafts keyed by cluster_id/suggested_replies) are both
-- deleted (supabase/functions/refine-clusters,
-- supabase/functions/stage-ai-drafts), retired outright rather than
-- repurposed. Drafting is manual-per-case only now (existing draft-reply
-- flow). Guarded with an existence check since the job row is created by
-- cron.schedule() regardless of whether the Vault secret step was ever
-- completed on this environment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refine-clusters-30min') THEN
    PERFORM cron.unschedule('refine-clusters-30min');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stage-ai-drafts-30min') THEN
    PERFORM cron.unschedule('stage-ai-drafts-30min');
  END IF;
END $$;
