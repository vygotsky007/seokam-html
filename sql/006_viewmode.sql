-- 학생 응시 방식 (Supabase SQL 에디터에 붙여넣어 실행)
-- view_mode = 'all'(전체 보기, 기본) | 'single'(한 문제씩)

alter table activities
  add column if not exists view_mode text not null default 'all';

-- PostgREST 스키마 캐시 즉시 갱신
notify pgrst, 'reload schema';
