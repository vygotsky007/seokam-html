-- Per-question HTML conversion (text + images hybrid).
-- ASCII-safe file: Korean text is written with PostgreSQL Unicode escapes U&'\XXXX'.
-- Run this in the Supabase SQL Editor.
--
-- html_content: sanitized HTML for one question. NULL/empty => student page falls back to slice_image.
-- slice_image is kept as-is; html_content is an ADDITIONAL field, not a replacement.

alter table questions
  add column if not exists html_content text;

comment on column questions.html_content is
  U&'\BB38\D56D HTML\D654 \ACB0\ACFC(\C815\C81C\B41C HTML). \BE44\C5B4 \C788\C73C\BA74 slice_image \B85C \D3F4\BC31';

-- PostgREST schema cache reload
notify pgrst, 'reload schema';
