-- HTML 활동지 세션 정리(유령 세션): 숨기기 · 병합.
-- ASCII-safe file: Korean comments via PostgreSQL Unicode escapes U&'\XXXX'. Run in Supabase SQL Editor.
--
-- 왜 활동에 배열로 두나: 숨김·병합은 '교사의 판단'이라 되돌릴 수 있어야 하고(세션 행을 지우면 복구 불가),
-- live_sessions/submissions 은 닉네임으로 흩어져 있어 한 곳에 모아 두는 편이 읽기·되돌리기 모두 간단하다.
--
--   hidden_sessions : 숨긴 닉네임 목록  ["김철수", ...]  → 발표·통계에서 제외, 응답 보기에선 회색으로 존재
--   session_merges  : 병합 목록  [{"into":"김은솔","from":"김은솔 라시도"}]
--                     읽을 때 from 의 답을 into 로 접어 넣는다(빈 칸만 채움). 자동 병합은 하지 않는다 — 교사가 누른 것만.

alter table activities
  add column if not exists hidden_sessions jsonb not null default '[]'::jsonb,
  add column if not exists session_merges  jsonb not null default '[]'::jsonb;

comment on column activities.hidden_sessions is
  U&'\C228\AE34 \C138\C158 \B2C9\B124\C784 \BAA9\B85D(\BC1C\D45C\B7EC\D1B5\ACC4 \C81C\C678)';
comment on column activities.session_merges is
  U&'\C138\C158 \BCD1\D569 \BAA9\B85D [{into,from}]';

-- PostgREST schema cache reload
notify pgrst, 'reload schema';
