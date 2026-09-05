-- Bell notifications: tracks whether a case has a reply the operator hasn't
-- seen yet, and adds a real status for "the user answered back after we
-- replied" so that transition doesn't have to stay purely visual.
--
-- `last_reply_count` is the baseline the poller (check-case-replies) compares
-- against on each run — the non-staff answer count last time this case was
-- checked. A rising count means a new reply arrived since; the column always
-- gets refreshed after a check, whether or not it found anything new, so the
-- same reply is never flagged twice.
--
-- `unread_since` is the bell's own flag: null means nothing new, a timestamp
-- means "unread since this moment" — cleared (set back to null) when the
-- operator opens/views the case. Deliberately separate from `status`: an
-- 'awaiting_reply' case that gets a new comment before anyone from the CM
-- side has answered doesn't have a more specific status to move into (it's
-- already the most action-needed state), so it only ever gets the unread
-- flag, never a status change.
--
-- 'user_replied' is the one case where a status change IS warranted: a case
-- sitting in 'cm_replied_waiting' (we replied, waiting on them) that gets a
-- new non-staff reply means the user answered back and the ball is back in
-- our court — a real, useful distinction from "still waiting on them silently".
-- This is a deliberate, requested exception to the "status is manual only,
-- never inferred" rule in lib/cases.ts: that rule exists because a reply
-- after 'closed' can't reliably be told apart from a plain "thanks"; here the
-- signal (a reply landing while we were the ones waiting) is unambiguous.

ALTER TABLE public.case_status
  ADD COLUMN IF NOT EXISTS last_reply_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.case_status
  ADD COLUMN IF NOT EXISTS unread_since TIMESTAMPTZ;

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
    'user_replied',
    'closed'
  ));

-- Fast "how many unread" count for the bell badge, without scanning every row.
CREATE INDEX IF NOT EXISTS case_status_unread_idx
  ON public.case_status (user_id)
  WHERE unread_since IS NOT NULL;
