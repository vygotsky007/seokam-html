-- AI 정답·풀이 채우기: 문항별 풀이 저장 + 학생에게 풀이를 보일지 여부.
-- ASCII-safe file: Korean comments via PostgreSQL Unicode escapes U&'\XXXX'. Run in Supabase SQL Editor.
--
--   questions.solution        : 문항 풀이(AI 제안 → 교사 승인본). 정답(answer)과 별개로 둔다.
--   activities.show_solutions : 학생에게 풀이를 보일지(기본 false). 마감 후에만, 이 토글이 켜졌을 때만 노출.
--                               (풀이를 시험 중에 보여주면 안 되니 기본 꺼짐 + 마감 게이트를 함께 건다)

alter table questions
  add column if not exists solution text;

alter table activities
  add column if not exists show_solutions boolean not null default false;

comment on column questions.solution is
  U&'\BB38\D56D \D480\C774(AI \C81C\C548 \2192 \AD50\C0AC \C2B9\C778\BCF8)';
comment on column activities.show_solutions is
  U&'\D559\C0DD\C5D0\AC8C \D480\C774 \B178\CD9C(\AE30\BCF8 false, \B9C8\AC10 \D6C4\C5D0\B9CC)';

-- PostgREST schema cache reload
notify pgrst, 'reload schema';
