-- Adds 'inactive' as a real, manually-selectable case status alongside the
-- existing computed "Inactive" dot (isInactiveAwaiting in lib/cases.ts,
-- gray/no-glow after 7+ days idle on 'awaiting_reply'). That computed state
-- never wrote to the database; this lets the operator mark a case inactive
-- by hand too, independent of the 7-day timer.
ALTER TABLE public.case_status
  DROP CONSTRAINT IF EXISTS case_status_status_check;

ALTER TABLE public.case_status
  ADD CONSTRAINT case_status_status_check
  CHECK (status IN (
    'awaiting_reply',
    'inactive',
    'escalated',
    'cm_replied_waiting',
    'cm_replied_solved',
    'closed'
  ));
