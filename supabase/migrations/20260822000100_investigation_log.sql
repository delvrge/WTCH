-- Coverage-gap tracking: one best-effort row per Investigate click, so the
-- operator can eventually see which topics keep coming back with nothing
-- citable to ground a walkthrough (Section 6 of the status doc: "no
-- coverage-gap view"). Written from investigate/index.ts only — NOT from
-- buildInvestigation() itself, so scripts/preview-investigation.ts (used for
-- prompt tuning) stays side-effect-free, and a failed insert here must never
-- fail the request the operator is waiting on.
--
-- topic/subtopic are taken from the top-ranked similar Library case when one
-- exists (community_patterns.topic/subtopic, already computed at extraction
-- time — no extra classification call spent just to log). Both null means
-- no similar case existed at all, which is itself the most useful signal:
-- a post shape the Library has nothing for yet.

CREATE TABLE public.investigation_log (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  topic           TEXT,
  subtopic        TEXT,
  case_kind       TEXT          NOT NULL CHECK (case_kind IN ('closeable', 'needs_investigation')),
  confidence      TEXT          NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  -- Whether at least one step in the walkthrough cited a past case, a
  -- verified answer, a solved thread, or a support doc. False is the
  -- coverage gap: a walkthrough built on nothing but general procedure.
  had_citation    BOOLEAN       NOT NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.investigation_log IS
  'One best-effort row per Investigate click, for the /coverage gap view. Written only by investigate/index.ts.';

ALTER TABLE public.investigation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_investigation_log"
  ON public.investigation_log FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_investigation_log"
  ON public.investigation_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX investigation_log_user_id_idx
  ON public.investigation_log (user_id);

CREATE INDEX investigation_log_topic_subtopic_idx
  ON public.investigation_log (topic, subtopic);

-- Correct a claim in the topic_taxonomy_posts table comment that's no longer
-- true: as of 2026-08-21, investigation.ts/solved-cases.ts DO read it live
-- for solved-thread retrieval. See scripts/topic-taxonomy/README.md for the
-- full explanation.
COMMENT ON TABLE public.topic_taxonomy_posts IS
  'Full-text corpus of scraped community posts. Originally a one-off taxonomy-design staging table, now also live-read by investigation.ts/solved-cases.ts for solved-thread retrieval. Keep topped up — see scripts/topic-taxonomy/README.md.';
