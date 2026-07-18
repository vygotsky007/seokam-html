-- 응답 저장 = (활동, 학생) 당 최종본 하나. 과거에 쌓인 중복 제출을 최신만 남기고 정리한다.
-- ASCII-safe file. Run in Supabase SQL Editor.
--
-- 배경: 이제 학생 제출은 replace(같은 활동·닉네임이면 마지막 제출로 덮어쓰기)로 저장되고,
-- live_sessions 는 (활동, 닉네임) upsert 라 항상 한 행이다. 하지만 그 이전에 만들어진 데이터에는
-- 같은 (활동, 닉네임) 제출이 여러 번 쌓여 있을 수 있다. 교사 표·CSV·발표가 최신만 보게 이미 처리하지만,
-- 테이블에 남은 '지운 흔적'을 실제로 지워 최신 한 행만 남긴다(닉네임이 있는 것만 — 익명 null 은 건드리지 않는다).

with ranked as (
  select id,
         row_number() over (
           partition by activity_id, nickname
           order by created_at desc, id desc
         ) as rn
  from submissions
  where nickname is not null and btrim(nickname) <> ''
)
delete from submissions s
using ranked r
where s.id = r.id and r.rn > 1;

-- live_sessions 는 (activity_id, nickname) 유니크 제약이 이미 upsert 를 보장한다.
-- 혹시 제약이 없던 시절의 중복이 있다면 최신만 남긴다.
with ranked_ls as (
  select id,
         row_number() over (
           partition by activity_id, nickname
           order by last_seen desc, id desc
         ) as rn
  from live_sessions
)
delete from live_sessions l
using ranked_ls r
where l.id = r.id and r.rn > 1;

-- (이 마이그레이션은 스키마를 바꾸지 않으므로 pgrst reload 는 불필요)
