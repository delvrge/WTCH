-- Adds a many-to-many join table alongside verified_answers.pattern_id (a
-- reply could point at at most one case) — the same reply text (e.g. "our
-- servers are melting, standby") is routinely the correct answer for
-- several different posts, and a case can pick up more than one reply over
-- time. Mirrors verified_answer_images' shape/RLS style, the existing child
-- table for this same parent.
--
-- Deliberately does NOT touch verified_answers.pattern_id — this migration
-- only adds and backfills the new table, so old code (still reading/writing
-- the column) keeps working right up until the new code deploys. The column
-- itself is dropped in a separate later migration
-- (20260819050000_verified_answers_drop_pattern_id.sql), run by hand once
-- the new code is confirmed working in prod.

CREATE TABLE public.verified_answer_cases (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_id  UUID        NOT NULL REFERENCES public.verified_answers(id) ON DELETE CASCADE,
  pattern_id UUID        NOT NULL REFERENCES public.community_patterns(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (answer_id, pattern_id)
);

ALTER TABLE public.verified_answer_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_verified_answer_cases"
  ON public.verified_answer_cases FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_verified_answer_cases"
  ON public.verified_answer_cases FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_verified_answer_cases"
  ON public.verified_answer_cases FOR DELETE
  USING (auth.uid() = user_id);
-- No UPDATE policy: a link either exists or it doesn't — changed by
-- deleting one row and inserting another, never edited in place.

CREATE INDEX verified_answer_cases_answer_id_idx  ON public.verified_answer_cases (answer_id);
CREATE INDEX verified_answer_cases_pattern_id_idx ON public.verified_answer_cases (pattern_id);
CREATE INDEX verified_answer_cases_user_id_idx    ON public.verified_answer_cases (user_id);

-- Backfill every existing single link before the column that held it goes
-- away. FK is ON DELETE CASCADE here (unlike the old column's SET NULL) —
-- a join row's only reason to exist is the pairing itself; a reply or
-- pattern disappearing leaves nothing for it to mean.
INSERT INTO public.verified_answer_cases (answer_id, pattern_id, user_id)
SELECT id, pattern_id, user_id FROM public.verified_answers WHERE pattern_id IS NOT NULL;
