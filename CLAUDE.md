# 문제샘 (seokam-html)

학생 응답 수집 앱. Node.js + Express + Supabase, Railway 배포.
GitHub: `vygotsky007/seokam-html`

입구는 셋이고 서로 파이프라인이 다르다:
1. **HTML 시험지** (자가채점) — 교사가 붙여넣는 문제 HTML
2. **PDF 시험지** — 브라우저에서 변환 → 문항 나누기 → 정답표 → 채점
3. **HTML 활동지** (`kind='html_sheet'`) — 교사가 만든 활동지를 원본 디자인 그대로, 입력칸만 자동 감지해 수집

## 실행 · 검증

```
npm start              # http://localhost:4002
npm test               # 합성 fixture 생성 → 활동지 e2e → 시험지 e2e → 실물 회귀
npm run test:sheet     # HTML 활동지만 (실물 브라우저)
```

검증은 **실제 브라우저(Playwright) + 진짜 server.js + 모의 PostgREST** 로 돈다. Supabase 없이 돌아간다.
`test/fixtures/real/` 은 `.gitignore` 다(실물 학교 자료). 그 자리 것에만 기대는 테스트는 다른 환경에서 죽으므로,
구조가 같은 합성본(`test/fixtures/*-synth.*`)을 함께 두고 실물이 없으면 합성본으로 돈다.

## 🔴 마이그레이션: 파일 경로 말고 **본문을 대화에 그대로 출력**한다

`sql/` 에 마이그레이션을 추가하면, 그 작업을 보고할 때 **SQL 전문을 코드블록으로 출력**한다.

- 이 프로젝트의 스키마 변경은 **사람이 Supabase SQL 에디터에 복붙해서** 실행한다. 자동 적용 경로가 없다.
- 그래서 "`sql/012_x.sql` 을 실행하세요" 는 **미완성 보고**다 — 파일을 찾아 열어야 복붙이 시작된다.
  받는 쪽이 바로 긁어 붙일 수 있어야 끝난 것이다.
- 새 컬럼을 쓰는 코드는 **마이그레이션 전에는 죽는다**(PostgREST 가 없는 컬럼으로 500). 그러니
  본문 출력은 "친절"이 아니라 배포 순서의 일부다. 보고 맨 앞에 둔다.
- 모의 PostgREST 로 검증했으면 **실 DB 에는 적용되지 않았다**는 뜻이다. 통과했다고 적용된 게 아니다 —
  이 점을 함께 밝힌다.

기존 파일 규칙(`sql/*.sql`)을 따른다: ASCII-safe(한글 주석은 `U&'\XXXX'` 이스케이프), 끝에
`notify pgrst, 'reload schema';`, 재실행해도 안전하게(`if not exists` / `drop ... if exists`).

## 정제(sanitize) — 두 개다, 섞지 말 것

- `lib/sanitize.js` — **문항 조각**용. 허용 태그가 `p·br·img` 수준이고 `style`·`section` 을 버린다.
- `lib/sheet-sanitize.js` — **문서 한 채**용(활동지). 구조·표현은 살리고 실행물만 자른다.

활동지에 `sanitize.js` 를 쓰면 원본 디자인이 통째로 죽는다.

`lib/` 는 서버(`require`)와 교사 화면(`<script src="/lib/...">`) 양쪽에서 읽는다.
**그래서 각 파일은 IIFE 로 싸서 전역을 더럽히지 않는다.** 두 파일이 같은 최상위 이름
(`ALLOWED_TAGS` 등)을 두면 브라우저에서 뒤에 읽힌 파일이 통째로 `SyntaxError` 로 죽는다 —
node 의 `require` 는 파일마다 스코프가 따로라 **이 사고가 node 테스트로는 안 보인다.**
