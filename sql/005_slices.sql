-- 문항 쪼개기(1단계): 문항별 이미지 조각 (Supabase SQL 에디터에 붙여넣어 실행)
-- ※ 004 번은 채점 컬럼(004_grading.sql)이 이미 쓰고 있어 이 파일은 005 로 매겼습니다.
--   (요청서의 004_slices 대신 005_slices 로 저장)
-- slice_image: 문항 영역을 크롭한 이미지(base64 data URL)
-- group_label: 공통 지문·그림을 쓰는 묶음 표시(예: "3~4")

alter table questions
  add column if not exists slice_image text,
  add column if not exists group_label text;

-- PostgREST 스키마 캐시 즉시 갱신
notify pgrst, 'reload schema';
