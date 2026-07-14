-- Realtime classroom (presence, progress matrix, notices, close).
-- ASCII-safe file. Run this in the Supabase SQL Editor.
--
-- Why a new table: presence must exist BEFORE a student submits. The submissions table only
-- gets a row at submit time, so it cannot answer "who is connected right now / where are they".
-- live_sessions is the live view (heartbeat every 5s); submissions stays the record of record.
--
-- One row per (activity, nickname). answers holds the in-progress answers so that
-- [close] can auto-submit whatever an unsubmitted student has on screen.

create table if not exists live_sessions (
  id          uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities(id) on delete cascade,
  nickname    text not null,
  current_q   int,
  answers     jsonb not null default '{}'::jsonb,
  submitted   boolean not null default false,
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (activity_id, nickname)
);

create index if not exists idx_live_sessions_activity on live_sessions (activity_id, last_seen desc);

-- Server-side permission checks are used instead of RLS in this project.
alter table live_sessions disable row level security;

-- Notices (last N kept in a jsonb array: [{ text, at }]) and close time, on the activity itself.
alter table activities add column if not exists notices   jsonb not null default '[]'::jsonb;
alter table activities add column if not exists closed_at timestamptz;

-- PostgREST schema cache reload
notify pgrst, 'reload schema';
