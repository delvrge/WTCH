-- A category can now be created ahead of any reply that uses it — the
-- "Add category" button on Replies, next to "Add reply". Without a table of
-- its own, an empty category had nowhere to live: verified_answers.category
-- is free text (20260824000100_subcategory_free_text.sql already dropped
-- the fixed taxonomy there) and every category the app knew about was
-- derived live off rows that already had one. This table is purely that
-- registry — a name exists here the moment it's created, whether or not any
-- reply has picked it yet. Deleting a category is not implemented yet: no
-- DELETE policy, on purpose.
CREATE TABLE public.reply_categories (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE public.reply_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_reply_categories"
  ON public.reply_categories FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_reply_categories"
  ON public.reply_categories FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX reply_categories_user_id_idx
  ON public.reply_categories (user_id);
