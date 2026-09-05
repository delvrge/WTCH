-- Lets a case be pulled out of the tracker entirely (not the CM's case to
-- handle) without touching its source row in community_patterns /
-- verified_answers. Separate from `status`, which tracks progress on a case
-- that IS the CM's to work.

ALTER TABLE public.case_status
  ADD COLUMN dismissed BOOLEAN NOT NULL DEFAULT false;
