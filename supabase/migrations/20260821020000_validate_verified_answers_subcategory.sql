-- Every verified_answers row has been reclassified against the fixed
-- taxonomy (scripts/reclassify-verified-answers.ts, run 2026-08-21, all 5
-- rows now carry a valid subcategory: 3 inherited outright from their linked
-- pattern's subtopic, 2 classified from their own text via LLM, 1 of those
-- landed "Unclustered", 0 failed). The NOT VALID constraint from
-- 20260821010000_verified_answers_subcategory_taxonomy.sql can now be
-- validated for real: this scans existing rows and confirms every one
-- satisfies the CHECK, upgrading it from "enforced on new writes only" to
-- "enforced everywhere, provably true for the whole table".

ALTER TABLE public.verified_answers
  VALIDATE CONSTRAINT verified_answers_subcategory_check;
