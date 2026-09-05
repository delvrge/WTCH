-- Distinguish clusters the operator created by hand from the ones the
-- self-organizing passes create on their own.
--
-- refine-clusters merges near-duplicate clusters and splits oversized ones on
-- a 30-minute cron. That is desirable for clusters it created itself, but a
-- box the operator made deliberately should not silently disappear into a
-- merge. This column is the marker that makes respecting that possible.
--
-- NOTE: refine-clusters does not read this column yet — adding it here is the
-- prerequisite, teaching the edge function to honour it is a follow-up.
--
-- Everything that exists today came from the automatic passes, so the default
-- backfills correctly with no data migration needed. No RLS change is
-- required: the existing per-user_id policies on community_clusters already
-- cover every column on the row.

ALTER TABLE public.community_clusters
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto';

-- Added as a separate statement rather than inline so re-running the
-- migration against a table that already has the column is still valid.
ALTER TABLE public.community_clusters
  DROP CONSTRAINT IF EXISTS community_clusters_source_check;

ALTER TABLE public.community_clusters
  ADD CONSTRAINT community_clusters_source_check
  CHECK (source IN ('auto', 'manual'));
