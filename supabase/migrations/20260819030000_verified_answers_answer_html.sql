-- The Replies editor now supports rich text (bold/italic/underline, lists,
-- links, inline code, inline images) via a plain contenteditable + execCommand
--, see components/RichTextEditor.tsx. answer_text stays the plain-text
-- derivation (images become "[image]", lists become "- "/"1. ") so grounding,
-- citation-excerpt matching and embeddings keep reading exactly what they
-- always have; answer_html is only set when a reply actually carries
-- formatting, and is what the Replies screen renders/copies when present.
ALTER TABLE public.verified_answers
  ADD COLUMN answer_html TEXT;
