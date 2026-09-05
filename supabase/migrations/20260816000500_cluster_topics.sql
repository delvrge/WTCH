-- A coarser tier above cluster: cluster ("Discrepancies in Genera Count")
-- is already a fine-grained sub-topic; topic is the broad bucket it sits
-- under ("Credits", "Prompts", "General", max two words, same
-- reuse-existing-verbatim convention as cluster/surface below it). Exists
-- purely so the graph view has something short and readable for its big
-- nodes, clusters become the small, unlabeled dots underneath.

ALTER TABLE public.community_patterns
  ADD COLUMN topic TEXT;

ALTER TABLE public.community_clusters
  ADD COLUMN topic TEXT;
