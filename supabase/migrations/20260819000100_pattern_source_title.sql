-- The post's own title, stored verbatim.
--
-- community_patterns otherwise holds only abstracted, model-written text (see
-- the table comment in 20260815000100_community_patterns.sql). This column is
-- a deliberate, narrow exception: the Cases table is a report the operator
-- hands to their manager, and a case has to be recognisable as THE post it
-- came from. issue_summary is a generalized English abstraction, so a
-- Portuguese thread became an English sentence nobody could match back to the
-- forum. The title is copied across untouched, in whatever language it was
-- written, and the abstraction stays where it was — issue_summary.
--
-- Title only: the post BODY and the replies are still never stored.

ALTER TABLE public.community_patterns
  ADD COLUMN IF NOT EXISTS source_title TEXT;

COMMENT ON COLUMN public.community_patterns.source_title IS
  'The source thread title, copied verbatim in its original language, never translated or summarized. Used as the Cases title so a case is recognisable as the post it came from. Set from the FIRST thread that produced the pattern and left alone on later dedup bumps, so the title cannot drift. Title only: post/reply bodies are still never stored.';

-- PostgREST caches the schema; without this the UI 400s on the new column.
NOTIFY pgrst, 'reload schema';
