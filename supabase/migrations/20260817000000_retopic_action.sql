-- refine-clusters gains a third phase (retopic): reclassifying clusters
-- stuck under the "General" catch-all once enough of the corpus exists to
-- tell what they actually are. Logged to cluster_evolution_log for the same
-- reason merge/split are — an automatic reclassification should be visible
-- and undoable, not silent.

ALTER TABLE public.cluster_evolution_log
  DROP CONSTRAINT cluster_evolution_log_action_check;

ALTER TABLE public.cluster_evolution_log
  ADD CONSTRAINT cluster_evolution_log_action_check
  CHECK (action IN ('merge', 'split', 'retopic'));
