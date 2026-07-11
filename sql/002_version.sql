-- 활동 수정 버전 관리 (Supabase SQL 에디터에 붙여넣어 실행)
-- 활동을 수정할 때마다 version 을 +1 하고, 학생 페이지가 이 값을 폴링해 변경을 감지한다.

alter table activities
  add column if not exists version int not null default 1;
