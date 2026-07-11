# 학생 응답 수집 앱

**1단계: 뼈대.** 학생 제출을 `/api/submit` 로 받아 Supabase `submissions` 테이블에 저장하고, `/api/health` 로 배포를 확인하며, `/api/submissions?activityId=...` 로 저장 여부를 조회한다. 자동채점·교사 화면·QR·학생 응시 페이지는 2단계 이후. DB 스키마는 `/sql/001_init.sql` 을 Supabase SQL 에디터에 실행할 것.

## 로컬 실행
```bash
npm install
cp .env.example .env   # SUPABASE_URL, SUPABASE_SERVICE_KEY 채우기
npm start              # http://localhost:4002
```

## API
- `GET  /api/health` → `{ ok: true }`
- `POST /api/submit` → body `{ activityId, nickname, answers }`, 성공 시 `{ ok: true, id }`
- `GET  /api/submissions?activityId=...` → 최신순 제출 목록
