-- 문항별 채점 대상 여부 (Supabase SQL 에디터에 붙여넣어 실행)
-- graded=false 인 문항, 또는 정답(answer)이 비어 있는 문항은 자동 채점 제외.
-- 이렇게 하면 "20문항 중 1~10번만 채점"을 정답만 넣어 처리할 수 있다.

alter table questions
  add column if not exists graded boolean not null default true;
