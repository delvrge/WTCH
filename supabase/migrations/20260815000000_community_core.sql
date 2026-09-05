-- Core library layer.
--
-- A WATCH is a topic the user cares about. It fills itself with PATTERNS
-- discovered by run-watch, and those patterns are grouped into CLUSTERS
-- (sub-topics) at synthesis time. community_seen_topics records which topic
-- URLs a watch has already handled so repeat runs don't redo work.
--
-- Every table is RLS-scoped to auth.uid() = user_id. Single user, but RLS
-- stays: it is what makes the anon key safe to ship to the browser.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- ── community_watches ────────────────────────────────────────────────────

CREATE TABLE public.community_watches (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
  keywords        TEXT[]      NOT NULL DEFAULT '{}',
  categories      TEXT[]      NOT NULL DEFAULT '{}',
  cover           TEXT,
  auto_run        BOOLEAN     NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  last_run_status TEXT,
  pattern_count   INTEGER     NOT NULL DEFAULT 0,
  "order"         INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.community_watches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_community_watches"
  ON public.community_watches FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_community_watches"
  ON public.community_watches FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_community_watches"
  ON public.community_watches FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_community_watches"
  ON public.community_watches FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX community_watches_user_id_idx
  ON public.community_watches (user_id);

-- ── community_seen_topics ────────────────────────────────────────────────
-- Prevents a watch from re-processing the same topic URL on repeat runs.

CREATE TABLE public.community_seen_topics (
  user_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  watch_id  UUID        NOT NULL REFERENCES public.community_watches(id) ON DELETE CASCADE,
  topic_url TEXT        NOT NULL,
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (watch_id, topic_url)
);

ALTER TABLE public.community_seen_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_community_seen_topics"
  ON public.community_seen_topics FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_community_seen_topics"
  ON public.community_seen_topics FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_community_seen_topics"
  ON public.community_seen_topics FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_community_seen_topics"
  ON public.community_seen_topics FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX community_seen_topics_watch_id_idx
  ON public.community_seen_topics (watch_id);

-- ── community_clusters ───────────────────────────────────────────────────
-- Sub-topic layer. A watch contains sub-topics synthesized across ALL of
-- that watch's patterns at once, each with a recurring-complaint summary and
-- 3 suggested draft replies. Defined before community_patterns because
-- community_patterns.cluster_id points here.
--
-- suggested_replies is an array of objects:
--   { "reply": "...",
--     "grounding": { "type": "verified_answer" | "context_doc" | "ungrounded",
--                    "ref": "<verified_answers.id | context_docs.title | null>",
--                    "excerpt": "<verbatim quote, max 300 chars, or null>" } }
-- The citation is verified server side after the model responds; anything
-- that does not resolve is rewritten to type "ungrounded".
--
-- newest_source_at / oldest_source_at are computed at synthesis time from
-- the member patterns' thread_created_at, so the board can tell a live
-- complaint apart from one about a since-fixed issue.

CREATE TABLE public.community_clusters (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id          UUID        NOT NULL REFERENCES public.community_watches(id) ON DELETE CASCADE,
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label             TEXT        NOT NULL,
  complaint_summary TEXT,
  suggested_replies JSONB       NOT NULL DEFAULT '[]'::jsonb,
  pattern_count     INTEGER     NOT NULL DEFAULT 0,
  newest_source_at  TIMESTAMPTZ,
  oldest_source_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.community_clusters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_community_clusters"
  ON public.community_clusters FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_community_clusters"
  ON public.community_clusters FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_community_clusters"
  ON public.community_clusters FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_community_clusters"
  ON public.community_clusters FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX community_clusters_watch_id_idx
  ON public.community_clusters (watch_id);
