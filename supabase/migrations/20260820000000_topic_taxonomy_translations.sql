-- Clustering picked up language as the dominant signal (Spanish posts
-- grouped with Spanish, German with German, etc.) instead of topic. Add
-- English translations to embed on instead of raw multilingual title/body.
-- See scripts/topic-taxonomy/1b-translate.ts.

ALTER TABLE public.topic_taxonomy_posts
  ADD COLUMN title_en TEXT,
  ADD COLUMN body_en  TEXT;

COMMENT ON COLUMN public.topic_taxonomy_posts.title_en IS
  'English translation of title (gpt-4o-mini), written by scripts/topic-taxonomy/1b-translate.ts. NULL = not yet translated.';

COMMENT ON COLUMN public.topic_taxonomy_posts.body_en IS
  'English translation of body (gpt-4o-mini), written by scripts/topic-taxonomy/1b-translate.ts. NULL = not yet translated.';
