-- Manual title override for a case row, same pattern as the existing `url`
-- override added in 20260818000400_case_status_v2.sql: null means "no
-- override, use the derived title" (the linked pattern's title, else
-- question_summary, else answer_text as a last resort — see lib/cases.ts).
--
-- Kept simple per the url column's precedent: ADD COLUMN IF NOT EXISTS only,
-- no constraint churn, no UPDATE. Existing per-user_id RLS policies on
-- public.case_status already cover every column on the row, this one
-- included, so no policy changes are needed.
ALTER TABLE public.case_status
  ADD COLUMN IF NOT EXISTS title TEXT;
