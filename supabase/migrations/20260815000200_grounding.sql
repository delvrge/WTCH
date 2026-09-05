-- Grounding sources for drafted replies.
--
-- Authority order, never violated:
--   1. verified_answers, highest. A reply the user actually sent that
--      actually worked.
--   2. context_docs    , authoritative reference the user pastes in.
--   3. Forum thread text, signal only. It says what people are ASKING or
--      COMPLAINING about; it is never a statement of fact about how the
--      product works, and is never stored in either of these tables.

-- ── context_docs ─────────────────────────────────────────────────────────
-- Plain text the user pastes in themselves (release notes, known issues,
-- glossary, credit-system rules). Multiple named docs.

CREATE TABLE public.context_docs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL DEFAULT '',
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.context_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_context_docs"
  ON public.context_docs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_context_docs"
  ON public.context_docs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_context_docs"
  ON public.context_docs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_context_docs"
  ON public.context_docs FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX context_docs_user_id_idx
  ON public.context_docs (user_id);

-- ── verified_answers ─────────────────────────────────────────────────────
-- The feedback loop. Outranks context_docs, which outrank forum text.
-- A citation resolving to VA:<id> is checked against answer_text server side
-- before a reply may be shown as grounded.

CREATE TABLE public.verified_answers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  watch_id         UUID        REFERENCES public.community_watches(id) ON DELETE SET NULL,
  cluster_id       UUID        REFERENCES public.community_clusters(id) ON DELETE SET NULL,
  category         TEXT,
  subcategory      TEXT,
  question_summary TEXT        NOT NULL,
  answer_text      TEXT        NOT NULL,
  source_note      TEXT,
  verified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.verified_answers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_verified_answers"
  ON public.verified_answers FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_verified_answers"
  ON public.verified_answers FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_verified_answers"
  ON public.verified_answers FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_verified_answers"
  ON public.verified_answers FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX verified_answers_user_id_idx
  ON public.verified_answers (user_id);

CREATE INDEX verified_answers_cluster_id_idx
  ON public.verified_answers (cluster_id);

CREATE INDEX verified_answers_verified_at_idx
  ON public.verified_answers (verified_at DESC);
