-- Un-fixes the taxonomy: the operator wants to add a category/subcategory
-- on the fly from the Replies screen, without a migration every time. The
-- CHECK from 20260821010000_verified_answers_subcategory_taxonomy.sql (27
-- fixed values, VALIDATEd in 20260821020000) is dropped; subcategory becomes
-- free text, same as category already was.
--
-- Grouping on the Replies screen no longer reads TOPIC_TAXONOMY membership
-- to decide nesting, it groups by whatever (category, subcategory) pairs
-- actually exist on the rows (see app/(app)/replies/page.tsx). The 27 fixed
-- names still ship as suggested options in the picker; they just aren't
-- enforced any more.
ALTER TABLE public.verified_answers
  DROP CONSTRAINT IF EXISTS verified_answers_subcategory_check;
