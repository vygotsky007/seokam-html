-- 전문 기능 업그레이드 (Supabase SQL 에디터에 붙여넣어 실행)
-- 1) 짧은 입장 코드용 join_code
-- 2) status 기본값 확인('draft' 임시저장 / 'open' 발행)

alter table activities
  add column if not exists join_code text;

-- 입장 코드 빠른 조회용(선택)
create index if not exists idx_activities_join_code on activities(join_code);

-- status 기본값이 없다면 'open' 으로. (이미 001_init 에서 default 'open' 이면 무해)
alter table activities
  alter column status set default 'open';
