-- 학생 응답 수집 앱 — 초기 스키마 (Supabase SQL 에디터에 붙여넣어 실행)

-- 활동(문항 세트)
create table if not exists activities (
  id         uuid primary key default gen_random_uuid(),
  title      text,
  html_body  text,
  status     text default 'open',
  created_at timestamptz default now()
);

-- 문항
create table if not exists questions (
  id          uuid primary key default gen_random_uuid(),
  activity_id uuid references activities(id) on delete cascade,
  num         int,
  type        text,
  answer      text
);

-- 제출
create table if not exists submissions (
  id          uuid primary key default gen_random_uuid(),
  activity_id uuid references activities(id) on delete cascade,
  nickname    text,
  answers     jsonb,
  auto_score  int,
  created_at  timestamptz default now()
);

-- 조회 성능용 인덱스
create index if not exists idx_submissions_activity_id on submissions(activity_id);
