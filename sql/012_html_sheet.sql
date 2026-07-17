-- HTML activity sheet: a third entrance, independent of the exam (PDF/self-scoring) pipeline.
-- ASCII-safe file: Korean text is written with PostgreSQL Unicode escapes U&'\XXXX'.
-- Run this in the Supabase SQL Editor.
--
-- Why a new column instead of reusing view_mode: view_mode ('all'|'single') describes HOW an exam
-- is paged. An activity sheet is not an exam at all -- it has no questions, no answer key, no score.
-- kind splits the ENTRANCE; view_mode keeps describing exam paging only.
--
--   kind = 'exam'       : existing PDF / self-scoring HTML exam (default, so every existing row is unchanged)
--   kind = 'html_sheet' : teacher-authored HTML worksheet, rendered in its original design
--
-- fields: the response elements detected in the sheet, in document order. Shape:
--   [{ "id": "f1", "tag": "textarea", "label": "...", "section": "...", "collect": true }]
-- The student page binds by id (data-fid="f1"); submissions.answers / live_sessions.answers are
-- keyed by the same id, so the existing save + submit APIs need no schema change.

alter table activities
  add column if not exists kind   text  not null default 'exam',
  add column if not exists fields jsonb not null default '[]'::jsonb;

comment on column activities.kind is
  U&'\D65C\B3D9 \C885\B958: exam(\C2DC\D5D8\C9C0) | html_sheet(HTML \D65C\B3D9\C9C0)';
comment on column activities.fields is
  U&'HTML \D65C\B3D9\C9C0\C758 \C751\B2F5 \D544\B4DC \BAA9\B85D(\BB38\C11C \C21C\C11C)';

-- Only 'exam' and 'html_sheet' are known kinds; reject typos at the DB rather than silently
-- creating an activity that no renderer knows how to draw.
alter table activities
  drop constraint if exists activities_kind_check;
alter table activities
  add constraint activities_kind_check check (kind in ('exam', 'html_sheet'));

-- Teacher's activity list filters by kind.
create index if not exists idx_activities_kind on activities (kind);

-- PostgREST schema cache reload
notify pgrst, 'reload schema';
