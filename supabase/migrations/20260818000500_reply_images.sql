-- Image attachments for verified_answers replies (Replies screen).
--
-- Attachments are stored in their own table + Storage bucket, NOT inline in
-- verified_answers.answer_text. This matters for grounding: only
-- question_summary is ever sent to the embeddings API (see
-- save-verified/index.ts and match_verified_answers in
-- 20260818000000_verified_answers_tracked.sql) — answer_text is never
-- embedded at all today. Keeping images out of answer_text means that stays
-- true even if a future change starts embedding answer_text too: there is no
-- image markup anywhere in the text columns to strip.

CREATE TABLE public.verified_answer_images (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_id     UUID        NOT NULL REFERENCES public.verified_answers(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path  TEXT        NOT NULL,
  content_type  TEXT,
  size_bytes    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.verified_answer_images ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_verified_answer_images"
  ON public.verified_answer_images FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_verified_answer_images"
  ON public.verified_answer_images FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_verified_answer_images"
  ON public.verified_answer_images FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_verified_answer_images"
  ON public.verified_answer_images FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX verified_answer_images_answer_id_idx
  ON public.verified_answer_images (answer_id);

CREATE INDEX verified_answer_images_user_id_idx
  ON public.verified_answer_images (user_id);

-- ── Storage bucket ──────────────────────────────────────────────────────
-- Private (public = false), matching the per-user_id RLS convention used
-- everywhere else in this project. Images are only ever served through
-- signed URLs generated at read time by the client — never persisted.

INSERT INTO storage.buckets (id, name, public)
VALUES ('reply-images', 'reply-images', false)
ON CONFLICT (id) DO NOTHING;

-- Upload paths are namespaced {user_id}/{answer_id}/{uuid}.{ext} — the first
-- path segment is the owning user, checked via storage.foldername(name).

CREATE POLICY "users_read_own_reply_images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'reply-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "users_insert_own_reply_images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'reply-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "users_update_own_reply_images"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'reply-images' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'reply-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "users_delete_own_reply_images"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'reply-images' AND auth.uid()::text = (storage.foldername(name))[1]);
