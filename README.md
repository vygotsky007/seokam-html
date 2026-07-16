# 학생 응답 수집 앱

**2단계: 교사 등록 화면 + 학생 응시 페이지 + 자동채점.**
교사가 문제 HTML과 문항별 정답을 등록하면(`/teacher.html`), 학생 응시 주소 `/go/:id` 가 생긴다. 학생 페이지는 서버가 닉네임칸과 제출버튼을 얹어 렌더하고, 제출 시 `name` 기준으로 답을 수집해 `/api/submit` 으로 보낸다. 제출 저장 시 그 활동의 문항과 대조해 자동채점(choice/short 대조, essay 제외)하고 결과를 학생·교사에게 보여준다. DB 스키마는 `/sql/001_init.sql` 을 Supabase SQL 에디터에 실행할 것.

## 로컬 실행
```bash
npm install
cp .env.example .env   # SUPABASE_URL, SUPABASE_SERVICE_KEY 채우기 (서비스 키 필수)
npm start              # http://localhost:4002
```

## 화면
- `GET /teacher.html` → 교사 등록 화면 (활동 생성 · 목록 · 결과 보기 · 삭제)
- `GET /go/:id` → 학생 응시 페이지 (닉네임 + 교사 HTML + 제출 → 자동채점 결과)

## API
- `GET  /api/health` → `{ ok: true }`
- `POST /api/activities` → body `{ title, html_body, questions:[{num,type,answer}] }` → `{ ok, activityId }`
- `GET  /api/activities` → 활동 목록(최신순)
- `GET  /api/activities/:id` → 활동 1개 + 문항 배열
- `DELETE /api/activities/:id` → 활동·문항·제출 cascade 삭제
- `POST /api/submit` → body `{ activityId, nickname, answers }` → `{ ok, id, auto_score, gradable, results }`
- `GET  /api/submissions?activityId=...` → 제출 목록(nickname·auto_score·answers 포함)

## 비전 AI 변환 (이미지 폴백 문항 → 텍스트)
출판 조판 PDF(분수가 `;4!;` 로 새는 커스텀 인코딩 등) 처럼 규칙 파서가 못 푸는 문항은 "이미지 모드"로 원본 이미지가 된다. 이때 문항별 **[🤖 AI로 변환]** 또는 상단 **[이미지 문항 전체 AI 변환]** 으로 Claude 비전(`claude-sonnet-5`)에 조각 이미지를 보내 `{stem, passage, choices, type, has_figure}` 로 구조화한다. 결과는 편집기에 채워지고 **"AI 변환 — 확인 필요"** 주황 뱃지가 뜨며, 교사가 **[확인 완료]** 를 눌러야 확정된다(그림 포함 문항은 원본 이미지 유지 안내). 저장 전 sanitize 동일 적용.

- 라우트: `POST /api/ai-convert { image(dataURL), num, force? }`, `GET /api/ai-status`
- **키는 코드·레포에 절대 넣지 않는다** — `ANTHROPIC_API_KEY` 환경변수(없으면 버튼에 "API 키 설정 필요" 안내).
- 비용 안전장치: 문항당 1회 캐시(재변환 확인창) · 하루 상한 `AI_DAILY_LIMIT`(기본 200) · 일괄은 동시 2개·부분 실패 허용(실패 문항은 이미지 유지).
- 발급: <https://console.anthropic.com/> → API Keys → Create Key. Railway → 프로젝트 → Variables 에 `ANTHROPIC_API_KEY` 추가.

## 채점 규칙
- `choice`/`short`: 정답과 대조. 공백·괄호·마침표·쉼표·기호 무시, 소문자화, 원문자(①②③…)→숫자 정규화 후 비교.
- `essay`: 채점 제외(정답 없음). 교사가 결과 화면에서 직접 확인.
- 답 입력칸의 `name` 은 `q1`, `q2`, … 규칙을 가정.
