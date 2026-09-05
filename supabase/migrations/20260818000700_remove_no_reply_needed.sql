-- Drop 'no_reply_needed' from the case status model. It never earned its
-- keep as a separate state — everything that landed there was, in practice,
-- functionally the same as 'closed' (the case is real, but nothing further
-- is expected of the CM), so it's folded into that value instead of
-- carrying a rarely-used sixth status forward.
--
-- Same ordering pitfall as case_status_v2: the constraint has to come off
-- BEFORE the row is updated, or the UPDATE fails with SQLSTATE 23514 against
-- the old CHECK. Drop, then migrate the row, then add the narrower CHECK.
ALTER TABLE public.case_status
  DROP CONSTRAINT IF EXISTS case_status_status_check;

UPDATE public.case_status SET status = 'closed' WHERE status = 'no_reply_needed';

ALTER TABLE public.case_status
  ADD CONSTRAINT case_status_status_check
  CHECK (status IN (
    'awaiting_reply',
    'escalated',
    'cm_replied_waiting',
    'cm_replied_solved',
    'closed'
  ));
