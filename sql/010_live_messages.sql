-- Realtime classroom: per-student direct messages (separate channel from class-wide notices).
-- ASCII-safe file. Run this in the Supabase SQL Editor.
--
-- Class-wide notices live on activities.notices (see 008_live.sql).
-- Direct messages live here, on the student's own live session row, so a poll response
-- can only ever carry the messages that belong to that one student.
--
-- Shape: [{ id, text, at, seen_at }]  (seen_at = null  ->  teacher sees "unread")

alter table live_sessions
  add column if not exists messages jsonb not null default '[]'::jsonb;

-- PostgREST schema cache reload
notify pgrst, 'reload schema';
