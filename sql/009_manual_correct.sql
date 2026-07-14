-- Present mode: teacher can accept a near-miss answer by hand ("manual correct").
-- ASCII-safe file. Run this in the Supabase SQL Editor.
--
-- Stored per submission, keyed by question number: { "16": true }.
-- grade.js treats a manually accepted answer as correct.

alter table submissions
  add column if not exists manual_correct jsonb not null default '{}'::jsonb;

-- PostgREST schema cache reload
notify pgrst, 'reload schema';
