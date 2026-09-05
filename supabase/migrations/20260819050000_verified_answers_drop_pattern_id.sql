-- Second half of the reply<->case many-to-many migration
-- (20260819040000_verified_answer_cases.sql). Run this one by hand only
-- after the new code (save-verified pattern_ids, stage-ai-drafts,
-- lib/cases.ts, the Replies/Library UIs) is confirmed working in prod ,
-- verified_answers.pattern_id is unused by then, this just removes it.
DROP INDEX IF EXISTS verified_answers_pattern_id_idx;
ALTER TABLE public.verified_answers DROP COLUMN pattern_id;
