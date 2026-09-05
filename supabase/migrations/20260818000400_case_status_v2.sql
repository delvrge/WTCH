-- Case status v2: six-value status model, plus a manual URL override column.
--
-- 'solved' is renamed to 'closed' (same meaning, same green dot), existing
-- rows are migrated in place. Two new "replied" states are added so a CM's
-- own reply can be tracked separately from the original awaiting/escalated
-- states: 'cm_replied_waiting' (replied, waiting on the user) and
-- 'cm_replied_solved' (replied, and it resolved things).
--
-- `url` lets a case's link be corrected by hand from the Cases table when
-- the derived link (source_url / cluster-match fallback) is wrong or
-- missing; null means "no override, use the derived link".

-- The constraint has to come off BEFORE the rows are migrated: the old CHECK
-- only permits 'solved', so updating a row to 'closed' while it is still in
-- force fails with SQLSTATE 23514.
--
-- The original CHECK was declared inline without a name, so Postgres gave it
-- the standard auto-generated name for a single-column check constraint.
ALTER TABLE public.case_status
  DROP CONSTRAINT IF EXISTS case_status_status_check;

UPDATE public.case_status SET status = 'closed' WHERE status = 'solved';

ALTER TABLE public.case_status
  ADD CONSTRAINT case_status_status_check
  CHECK (status IN (
    'awaiting_reply',
    'escalated',
    'cm_replied_waiting',
    'cm_replied_solved',
    'closed',
    'no_reply_needed'
  ));

ALTER TABLE public.case_status
  ADD COLUMN IF NOT EXISTS url TEXT;

-- No RLS/policy changes needed: the existing per-user_id policies on
-- public.case_status already cover every column on the row, this one
-- included.
