-- Manual case-tracking status for the Cases table. Cases themselves are
-- derived (not stored) from community_patterns/verified_answers, so status
-- lives in its own small table keyed by the same stable case id the UI
-- already computes ("pattern:<id>" / "verified:<id>") rather than adding a
-- column to either source table.

CREATE TABLE public.case_status (
  case_id     TEXT        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'awaiting_reply'
                CHECK (status IN ('awaiting_reply', 'solved', 'escalated', 'no_reply_needed')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.case_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_case_status"
  ON public.case_status FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_case_status"
  ON public.case_status FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_case_status"
  ON public.case_status FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_case_status"
  ON public.case_status FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX case_status_user_id_idx ON public.case_status (user_id);
