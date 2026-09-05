-- One-off offline analysis staging table: raw scraped community board posts
-- (title/body/date/url) for generating a fixed Topic/Subtopic taxonomy from
-- a year of historical data. Deliberately isolated from community_patterns,
-- verified_answers, and community_clusters, nothing here is read by any
-- live case-tracking path, and this table is never written to by the app or
-- any edge function. Populated only by the one-off scripts under
-- scripts/topic-taxonomy/.

CREATE TABLE public.topic_taxonomy_posts (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url               TEXT          NOT NULL UNIQUE,
  board             TEXT          NOT NULL
                      CHECK (board IN ('bug-reports-403', 'feature-requests-405', 'questions-404')),
  title             TEXT          NOT NULL,
  body              TEXT          NOT NULL,
  post_created_at   TIMESTAMPTZ,
  scraped_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  embedding         extensions.vector(1536),
  -- HDBSCAN cluster label. -1 is HDBSCAN's noise/unclustered convention,
  -- kept as a real value (not NULL) so "not yet clustered" (NULL) stays
  -- distinguishable from "clustered as noise" (-1).
  cluster_id        INTEGER,
  topic             TEXT,
  subtopic          TEXT
);

COMMENT ON TABLE public.topic_taxonomy_posts IS
  'One-off staging table for the historical Topic/Subtopic taxonomy analysis. Not read by any live Vigilante feature.';

COMMENT ON COLUMN public.topic_taxonomy_posts.cluster_id IS
  'HDBSCAN label written by scripts/topic-taxonomy/3-apply-clusters.ts. NULL = not yet clustered, -1 = HDBSCAN noise (deliberately unclustered), >= 0 = cluster label.';

ALTER TABLE public.topic_taxonomy_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_topic_taxonomy_posts"
  ON public.topic_taxonomy_posts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_topic_taxonomy_posts"
  ON public.topic_taxonomy_posts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_topic_taxonomy_posts"
  ON public.topic_taxonomy_posts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_topic_taxonomy_posts"
  ON public.topic_taxonomy_posts FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX topic_taxonomy_posts_user_id_idx
  ON public.topic_taxonomy_posts (user_id);

CREATE INDEX topic_taxonomy_posts_cluster_id_idx
  ON public.topic_taxonomy_posts (cluster_id);

CREATE INDEX topic_taxonomy_posts_post_created_at_idx
  ON public.topic_taxonomy_posts (post_created_at DESC);
