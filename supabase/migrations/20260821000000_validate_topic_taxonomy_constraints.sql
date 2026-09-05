-- Every community_patterns row has been reclassified against the fixed
-- taxonomy (scripts/reclassify-patterns.ts, run 2026-08-21, all 37 live
-- rows now carry a valid topic/subtopic, 8 landed "Unclustered"). The
-- NOT VALID constraints from 20260820010000_fixed_topic_taxonomy.sql can
-- now be validated for real: this scans existing rows and confirms every
-- one satisfies the CHECK, upgrading it from "enforced on new writes only"
-- to "enforced everywhere, provably true for the whole table".

ALTER TABLE public.community_patterns
  VALIDATE CONSTRAINT community_patterns_topic_check;

ALTER TABLE public.community_patterns
  VALIDATE CONSTRAINT community_patterns_subtopic_check;
