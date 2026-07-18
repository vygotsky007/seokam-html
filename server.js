// 진입점 — 학생 응답 수집 앱 (2단계: 교사 등록 + 학생 응시 + 자동채점)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const supabase = require('./db');
const submitRouter = require('./routes/submit');
const activitiesRouter = require('./routes/activities');
const liveRouter = require('./routes/live');
const aiRouter = require('./routes/ai');
const similarRouter = require('./routes/similar');
const sheetsRouter = require('./routes/sheets');
const { sanitizeHtml } = require('./lib/sanitize');

const app = express();
const PORT = process.env.PORT || 4002;

// 앱 이름(임시). 나중에 한 번에 바꿀 수 있게 한 곳에 모음.
const APP_NAME = '문제샘';

app.use(cors()); // 학생 HTML이 다른 출처에서 fetch 가능하도록 허용
app.use(express.json({ limit: '2mb' })); // 교사가 붙여넣는 HTML 대비 여유
app.use(express.static(path.join(__dirname, 'public')));
app.use('/lib', express.static(path.join(__dirname, 'lib')));   // 교사 화면과 서버가 같은 sanitize 를 쓴다

// 배포 확인용
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// 제출/조회 + 교사 활동 API
app.use('/api', submitRouter);
app.use('/api', activitiesRouter);
app.use('/api', liveRouter);
app.use('/api', aiRouter);   // 비전 AI 변환(이미지 폴백 문항 → 구조화 텍스트)
app.use('/api', similarRouter);
app.use('/api', sheetsRouter);   // HTML 활동지 결과(행=학생, 열=필드)

// 교사용 실시간 교실 대시보드
app.get('/live/:id', async (req, res) => {
  const { data: activity, error } = await supabase
    .from('activities').select('id, title, kind').eq('id', req.params.id).single();
  if (error || !activity) return res.status(404).send('<h1>활동을 찾을 수 없습니다.</h1>');
  // 화면은 하나다 — 열의 정체(문항 번호 / 수집 칸)만 /api/live/state 의 kind 를 보고 갈린다.
  res.type('html').send(renderLivePage(activity));
});

// 학생 응시 페이지 — 교사 html_body 위에 닉네임칸, 아래에 제출버튼을 서버가 얹어 렌더
app.get('/go/:id', async (req, res) => {
  const { id } = req.params;

  const { data: activity, error } = await supabase
    .from('activities')
    .select('id, title, html_body, status, version, view_mode, kind, fields, closed_at')
    .eq('id', id)
    .single();

  if (error || !activity) {
    return res.status(404).send('<h1>활동을 찾을 수 없습니다.</h1>');
  }

  // HTML 활동지: 시험지 파이프라인을 타지 않는다. 원본 문서를 그대로 내보내고 바만 얹는다.
  if (activity.kind === 'html_sheet') {
    return res.type('html').send(renderSheetStudentPage(activity));
  }

  // 한 문제씩 모드: 문항 조각(slice_image)들을 불러와 전용 화면 렌더
  if (activity.view_mode === 'single') {
    const { data: questions } = await supabase
      .from('questions')
      .select('num, type, slice_image, group_label, html_content, meta')
      .eq('activity_id', id)
      .order('num', { ascending: true });
    const qs = (questions || []).filter((q) => q); // 안전
    // 조각 이미지나 변환된 HTML 이 하나라도 있으면 single 화면, 없으면 기존 전체 화면으로 폴백
    if (qs.some((q) => q.slice_image || q.html_content)) {
      return res.type('html').send(renderStudentSinglePage(activity, qs));
    }
  }

  res.type('html').send(renderStudentPage(activity));
});

// 발표 모드 — 문항별 좌우분할·정오필터·익명번호·실시간 폴링
app.get('/present/:id', async (req, res) => {
  const { id } = req.params;
  const { data: activity, error } = await supabase
    .from('activities')
    .select('id, title, html_body, kind, fields')
    .eq('id', id)
    .single();

  if (error || !activity) {
    return res.status(404).send('<h1>활동을 찾을 수 없습니다.</h1>');
  }

  // HTML 활동지: 정답이 없으니 정오필터·보기분포가 설 자리가 없다.
  // 발표에서 볼 것은 '아이들이 뭐라고 썼는가' 하나뿐 → 전용 화면(답 함께 보기).
  if (activity.kind === 'html_sheet') {
    return res.type('html').send(renderSheetPresentPage(activity));
  }

  // 문항 조각(slice_image)이 있으면 문항 넘길 때 그 조각을 크게 표시 — 문항번호→이미지 맵을 페이지에 1회 주입
  const { data: qs } = await supabase
    .from('questions')
    .select('num, slice_image, group_label')
    .eq('activity_id', id)
    .order('num', { ascending: true });
  const sliceByNum = buildSliceByNum(qs || []);

  res.type('html').send(renderPresentPage(activity, sliceByNum));
});

// 문항번호 → slice 이미지. 묶음(group_label "3~4")은 포함된 모든 번호에 같은 조각을 매핑.
function buildSliceByNum(qs) {
  const map = {};
  const parseRange = (s) => {
    s = String(s || '');
    const m = s.match(/(\d+)\s*[~\-]\s*(\d+)/);
    if (m) { const a = +m[1], b = +m[2], out = []; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i); return out; }
    return s.split(/[,\s]+/).map(Number).filter((n) => n > 0);
  };
  qs.forEach((q) => {
    if (!q.slice_image) return;
    let nums = q.group_label ? parseRange(q.group_label) : [q.num];
    if (!nums.length) nums = [q.num];
    nums.forEach((n) => { if (map[n] == null) map[n] = q.slice_image; });
    if (map[q.num] == null) map[q.num] = q.slice_image;
  });
  return map;
}

// HTML 활동지 결과 — 행=학생, 열=필드 (시험지 대시보드와 다른 화면)
app.get('/sheet/:id', async (req, res) => {
  const { data: activity, error } = await supabase
    .from('activities').select('id, title, kind').eq('id', req.params.id).single();
  if (error || !activity) return res.status(404).send('<h1>활동을 찾을 수 없습니다.</h1>');
  if (activity.kind !== 'html_sheet') return res.redirect('/dashboard/' + activity.id);   // 시험지는 기존 대시보드로
  res.type('html').send(renderSheetResultsPage(activity));
});

// 짧은 입장: 4자리 코드 → 해당 활동 /go/:id 로 리다이렉트
app.get('/join/:code', async (req, res) => {
  const { code } = req.params;
  const { data, error } = await supabase
    .from('activities')
    .select('id')
    .eq('join_code', code)
    .limit(1);

  if (error || !data || !data.length) {
    return res.status(404).send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding:60px"><h1>입장 코드를 찾을 수 없어요</h1><p>코드를 다시 확인하세요.</p><a href="/join.html">← 코드 다시 입력</a></body>');
  }
  res.redirect('/go/' + data[0].id);
});

// 결과 대시보드 페이지
app.get('/dashboard/:id', async (req, res) => {
  const { id } = req.params;
  const { data: activity, error } = await supabase
    .from('activities')
    .select('id, title')
    .eq('id', id)
    .single();

  if (error || !activity) {
    return res.status(404).send('<h1>활동을 찾을 수 없습니다.</h1>');
  }
  res.type('html').send(renderDashboardPage(activity));
});

function renderPresentPage(activity, sliceByNum) {
  const title = escapeHtml(activity.title || '활동');
  const activityId = activity.id;
  const slices = sliceByNum || {};
  const hasSlices = Object.keys(slices).length > 0;
  // 조각이 있으면 왼쪽은 클라이언트가 문항별 이미지로 채움(초기 비움), 없으면 기존 html_body 그대로.
  const body = hasSlices ? '' : (activity.html_body || '');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>발표 모드 — ${title}</title>
<style>
  /* 본문이 화면의 대부분. 상단은 얇은 상태바+문항 이동, 도구는 하단 독, 응답·채점은 오버레이. */
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  .statusbar { display: flex; align-items: center; gap: 10px; padding: 6px 16px; background: #1e293b; border-bottom: 1px solid #334155; font-size: 13px; }
  .statusbar h1 { font-size: 14px; margin: 0; color: #94a3b8; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .participation { font-size: 13px; font-weight: 800; color: #4ade80; white-space: nowrap; }
  .statusbar .live { font-size: 12px; color: #4ade80; white-space: nowrap; margin-left: auto; }
  /* 문항 이동 — 얇은 상시 행 */
  .navrow { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: #0b1220; border-bottom: 1px solid #334155; overflow-x: auto; }
  .navrow button { min-width: 38px; height: 36px; padding: 0 10px; font-size: 15px; font-weight: 700; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  .navrow button.qbtn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  .navrow button:disabled { opacity: .4; cursor: default; }
  .live { color: #4ade80; }

  /* 문제 본문 — 화면의 대부분 + 필기 캔버스 */
  .stagewrap { position: relative; flex: 1; min-height: 0; }
  .problem-wrap { position: absolute; inset: 0; overflow: hidden; background: #0f172a; touch-action: none; }
  .zoom-layer { position: relative; transform-origin: 0 0; width: 100%; will-change: transform; }
  .problem-content { background: #fff; color: #111; padding: 28px; min-height: 100%; font-size: 22px; line-height: 1.6; text-align: center; }
  .problem-content img { max-width: 100%; height: auto; display: inline-block; }
  .problem-content > * { text-align: left; }
  .problem-content > img, .problem-content > .slice-full { text-align: center; }
  #drawCanvas { position: absolute; top: 0; left: 0; z-index: 10; touch-action: none; }

  /* 실시간 오버레이 — 우상단 선지 분포 + 미답 수 */
  .rtdist { position: absolute; top: 12px; right: 14px; z-index: 8; background: rgba(30,41,59,.92); border: 1px solid #334155;
    border-radius: 12px; padding: 10px 14px; min-width: 180px; max-width: 260px; box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: pointer; }
  .rtdist.collapsed .rt-body { display: none; }
  .rtdist .rt-head { font-size: 12px; color: #94a3b8; font-weight: 800; display: flex; justify-content: space-between; gap: 8px; }
  .rtdist .rt-bar { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 13px; }
  .rtdist .rt-mk { flex: 0 0 26px; font-weight: 800; color: #93c5fd; }
  .rtdist .rt-track { flex: 1; height: 16px; background: #0f172a; border-radius: 5px; overflow: hidden; }
  .rtdist .rt-fill { height: 100%; background: #3b82f6; }
  .rtdist .rt-n { flex: 0 0 30px; text-align: right; color: #cbd5e1; }
  .rtdist .rt-miss { margin-top: 8px; font-size: 13px; color: #f59e0b; font-weight: 700; }

  /* 응답·채점 오버레이(하단 독에서 연다) — 3겹 닫기 */
  #answerPanel { position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 92vw; background: #1e293b; border-left: 1px solid #334155;
    z-index: 90; display: none; flex-direction: column; box-shadow: -8px 0 30px rgba(0,0,0,.5); }
  .reveal-row { padding: 12px 16px 0; }
  .reveal-row button { width: 100%; padding: 10px; font-size: 14px; font-weight: 800; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  .reveal-row button.revealed { background: #22543d; border-color: #22c55e; color: #d1fae5; }
  .q-answer { padding: 14px 16px; border-bottom: 1px solid #334155; }
  .q-answer .qnum { font-size: 16px; color: #60a5fa; font-weight: 700; }
  .q-answer .qtype { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #334155; color: #cbd5e1; margin-left: 8px; }
  .q-answer .lbl { font-size: 13px; color: #94a3b8; margin-top: 10px; }
  .q-answer .val { font-size: 34px; font-weight: 800; color: #f8fafc; line-height: 1.15; word-break: break-word; }
  .q-answer .val.essay { font-size: 20px; color: #cbd5e1; }
  .q-answer .rate { margin-top: 10px; font-size: 15px; color: #cbd5e1; }
  .q-answer .rate b { color: #4ade80; font-size: 19px; }
  .filters { display: flex; gap: 8px; padding: 14px 16px; border-bottom: 1px solid #334155; }
  .filters button { flex: 1; padding: 10px; font-size: 14px; font-weight: 700; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  .filters button.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  .panel-head { padding: 10px 16px; font-size: 13px; color: #94a3b8; border-bottom: 1px solid #334155; }
  .list { flex: 1; overflow-y: auto; padding: 8px 12px; }
  .item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; margin-bottom: 6px; background: #0f172a; }
  .item .no { flex: 0 0 44px; font-weight: 800; color: #93c5fd; }
  .item .ans { flex: 1; word-break: break-word; }
  .item .mark { flex: 0 0 28px; text-align: center; font-size: 18px; }
  .item.correct { border-left: 4px solid #22c55e; }
  .item.wrong { border-left: 4px solid #ef4444; }
  .item.neutral { border-left: 4px solid #64748b; }
  .mark.ok { color: #22c55e; }
  .mark.no { color: #ef4444; }
  .q-answer .keyrow { display: flex; gap: 6px; margin-top: 10px; }
  .q-answer .keyrow input { flex: 1; min-width: 0; padding: 8px 10px; font-size: 14px; border: 1px solid #475569; background: #0f172a; color: #e2e8f0; border-radius: 8px; }
  .q-answer .keyrow button { padding: 8px 12px; font-size: 13px; font-weight: 800; border: 0; background: #3b82f6; color: #fff; border-radius: 8px; cursor: pointer; }
  .item.near { background: #422006; }
  .mark.warn { color: #f59e0b; border: 0; background: transparent; font-size: 18px; cursor: pointer; }
  .empty { color: #64748b; padding: 24px; text-align: center; }

  /* 필기 서브 도구(켜면 뜬다) */
  #drawTools { position: fixed; left: 16px; bottom: 74px; z-index: 71; display: none; gap: 6px; background: rgba(15,23,42,.92);
    border: 1px solid #334155; border-radius: 10px; padding: 6px 8px; align-items: center; flex-wrap: wrap; }
  #drawTools.on { display: flex; }
  #drawTools button { height: 34px; min-width: 34px; padding: 0 8px; font-size: 13px; font-weight: 700; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 7px; cursor: pointer; }
  #drawTools .tb-color { width: 30px; padding: 0; }
  .tb-color.red { background: #ef4444; } .tb-color.blue { background: #3b82f6; } .tb-color.black { background: #facc15; }
  #drawTools button.active { outline: 2px solid #60a5fa; }

  /* 교실 도우미 플로팅 패널 */
  .helper { position: fixed; left: 16px; bottom: 74px; z-index: 72; width: 300px; display: none; }
  .helper.shown { display: block; }
  .helper-body { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.5); max-height: 62vh; overflow-y: auto; }
  .helper-sec { margin-bottom: 12px; }
  .helper-lab { font-size: 12px; color: #94a3b8; font-weight: 700; margin-bottom: 6px; }
  .helper-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .helper-grid button { padding: 8px 10px; font-size: 13px; font-weight: 700; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  .helper-grid button:hover { background: #3b4a61; }
  .helper-row { display: flex; align-items: center; gap: 6px; }
  .helper-row input[type=text] { flex: 1; padding: 8px; font-size: 13px; border: 1px solid #475569; background: #0f172a; color: #e2e8f0; border-radius: 8px; }
  .helper-row select, .helper-row button { padding: 7px 10px; font-size: 13px; font-weight: 700; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  .helper-row #customSpeak { background: #2563eb; border-color: #2563eb; }
</style>
<script src="/lib/present-tools.js"></script>
<script src="/lib/match.js"></script>
</head>
<body>
  <div class="statusbar">
    <h1>🎬 ${title}</h1>
    <span class="participation" id="participation">🙋 제출 0명</span>
    <span class="live" id="liveTag">● 실시간 (5초)</span>
  </div>
  <div class="navrow" id="nav"></div>
  <div class="stagewrap">
    <div class="problem-wrap" id="problemWrap">
      <div class="zoom-layer" id="zoomLayer">
        <div class="problem-content" id="problemContent">
${body}
        </div>
        <canvas id="drawCanvas"></canvas>
      </div>
    </div>
    <div class="rtdist collapsed" id="rtDist"><div class="rt-head"><span id="rtTitle">응답 분포</span><span id="rtToggle">▾</span></div><div class="rt-body" id="rtBody"></div></div>
  </div>

  <!-- 하단 도구 독 -->
  <div id="dock">
    <button id="tbToggle" class="on" title="필기 켜기/끄기">✏️ 필기</button>
    <button id="answerBtn" title="응답·채점 보기">📊 응답·채점</button>
    <button id="revealBtn" title="정답 공개/가리기">🙈 정답 가림</button>
    <button id="zoomOut" title="축소">🔍−</button>
    <button id="zoomReset" title="원래대로">100%</button>
    <button id="zoomIn" title="확대">🔍+</button>
    <button id="spotBtn" title="스포트라이트">🔦</button>
    <button id="timerBtn" title="타이머">⏱</button>
    <button id="helperBtn" title="교실 도우미">🧑‍🏫</button>
    <button id="ttsRead" title="문제 읽어주기" style="display:none">🔊 읽기</button>
    <button id="ttsStop" title="정지" style="display:none">⏹</button>
    <select id="ttsRate" title="읽기 속도" style="display:none; height:44px; border-radius:10px; background:#334155; color:#e2e8f0; border:1px solid #475569;"><option value="1">보통</option><option value="0.7">느리게</option></select>
    <button id="helpBtn" title="단축키">?</button>
    <button id="fscBtn" title="전체화면 (F)">⛶</button>
  </div>

  <!-- 필기 서브 도구 -->
  <div id="drawTools">
    <button class="tb-color red active" data-color="#ef4444" title="빨강"></button>
    <button class="tb-color blue" data-color="#3b82f6" title="파랑"></button>
    <button class="tb-color black" data-color="#facc15" title="노랑"></button>
    <button class="tb-size active" data-size="3" title="얇게">얇게</button>
    <button class="tb-size" data-size="9" title="굵게">굵게</button>
    <button id="tbEraser" title="지우개">지우개</button>
    <button id="tbClear" title="전체 지우기">전체 지우기</button>
  </div>

  <!-- 응답·채점 오버레이 -->
  <div id="answerPanel">
    <div class="q-answer" id="qAnswer"></div>
    <div class="filters">
      <button data-f="all" class="active">전체</button>
      <button data-f="correct">맞은 사람</button>
      <button data-f="wrong">틀린 사람</button>
    </div>
    <div class="panel-head" id="panelHead">응답 현황</div>
    <div class="list" id="list"></div>
  </div>

  <!-- 교실 도우미: 하단 독에서 연다 -->
  <div id="helper" class="helper">
    <div class="helper-body" id="helperBody">
      <div class="helper-sec">
        <div class="helper-lab">안내 음성</div>
        <div class="helper-grid" id="presetPhrases"></div>
      </div>
      <div class="helper-sec">
        <div class="helper-lab">신호음</div>
        <div class="helper-grid">
          <button data-sound="focus">🔔 집중 신호음</button>
          <button data-sound="start">▶ 시작 신호음</button>
          <button data-sound="end">⏹ 종료 신호음</button>
        </div>
      </div>
      <div class="helper-sec">
        <div class="helper-lab">직접 입력해서 읽어주기</div>
        <div class="helper-row">
          <input id="customPhrase" type="text" placeholder="예) 3분 뒤에 걷어요" />
          <button id="customSpeak">🔊</button>
        </div>
        <div class="helper-grid" id="recentPhrases"></div>
      </div>
      <div class="helper-sec">
        <div class="helper-lab">음성 선택 <span id="voiceNote" style="color:#f59e0b"></span></div>
        <div class="helper-row">
          <select id="helperVoice" style="flex:1"></select>
          <button id="helperPreview">미리듣기</button>
        </div>
      </div>
      <div class="helper-sec">
        <div class="helper-row">
          <span class="helper-lab" style="margin:0">속도</span>
          <select id="helperRate"><option value="1">보통</option><option value="0.8">느리게</option></select>
          <span class="helper-lab" style="margin:0">음량</span>
          <input id="helperVol" type="range" min="0" max="1" step="0.1" value="1" style="flex:1" />
          <button id="helperStopVoice">정지</button>
        </div>
      </div>
    </div>
  </div>

<script>
(function () {
  var ACTIVITY_ID = ${JSON.stringify(activityId)};
  var SLICE_BY_NUM = ${JSON.stringify(slices)};
  var HAS_SLICES = ${hasSlices ? 'true' : 'false'};
  var state = { questions: [], students: [], curIdx: 0, filter: 'all', reveal: false };
  var lastProblemNum = null;

  function fetchData() {
    return fetch('/api/present/' + ACTIVITY_ID)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || '조회 실패');
        state.questions = data.questions || [];
        state.students = data.students || [];
        if (state.curIdx >= state.questions.length) state.curIdx = 0;
        renderProblem(); // 조각 모드: 현재 문항 이미지 반영(바뀔 때만)
        render(); // 오른쪽 통계만 갱신
      })
      .catch(function (err) { console.error(err); });
  }

  // 조각 모드에서 현재 문항의 slice_image 를 왼쪽에 크게 표시(문항 바뀔 때만 교체)
  function renderProblem() {
    if (!HAS_SLICES) return;
    var q = curQ(); if (!q) return;
    if (q.num === lastProblemNum) return;
    lastProblemNum = q.num;
    var img = SLICE_BY_NUM[q.num];
    content.innerHTML = img
      ? '<img class="slice-full" alt="' + q.num + '번 문항" src="' + img + '" />'
      : '<div style="padding:40px;color:#e11d48;text-align:center;font-size:20px;">🙏 문항 이미지를 불러올 수 없어요</div>';
    var im = content.querySelector('img');
    if (im) { im.addEventListener('load', fitCanvas); }
    fitCanvas();
  }

  function curQ() { return state.questions[state.curIdx]; }
  function qByNum(num) { return state.questions.filter(function (q) { return q.num === num; })[0]; }
  function givenOf(stu, num) { var c = stu.byNum && stu.byNum[num]; return c ? String(c.given || '') : ''; }
  function manualOk(stu, num) { return !!(stu.manual && stu.manual[String(num)]); }

  // 판정은 화면에서 다시 계산한다 — 교사가 정답을 입력하는 즉시 ✅/❌ 와 정답률이 바뀌어야 하고,
  // '정답 가림' 상태에서도 교사 쪽 채점은 이미 되어 있어야 한다(공개 타이밍을 정답률 보고 정한다).
  // 규칙은 채점기와 같은 lib/match.js (㉡=ㄴ, 5=5개, "ㄱ,ㄷ"="ㄷ ㄱ", 정답 여러 개는 "㉡|28-(17+6)").
  function isCorrect(stu, num) {
    var q = qByNum(num);
    if (!q || q.type === 'essay') return null;
    var g = givenOf(stu, num);
    if (!g.trim()) return null;                         // 무응답 → 판정 없음
    if (manualOk(stu, num)) return true;                // 교사가 손으로 인정
    if (!String(q.answer || '').trim()) return null;    // 정답 미입력 → 아직 채점 못 함
    return window.answerMatch.isCorrect(g, q.answer);
  }
  // 정답은 아니지만 오타 수준(편집거리 1) — 교사 눈에 띄게만 하고 자동 정답 처리는 하지 않는다
  function isNearMiss(stu, num) {
    var q = qByNum(num);
    if (!q || q.type === 'essay' || manualOk(stu, num)) return false;
    var g = givenOf(stu, num);
    if (!g.trim() || !String(q.answer || '').trim()) return false;
    return window.answerMatch.isNearMiss(g, q.answer);
  }

  function render() { renderParticipation(); renderNav(); renderAnswer(); renderRight(); renderRtDist(); }

  // 실시간 참여 현황 바
  function renderParticipation() {
    document.getElementById('participation').textContent = '🙋 제출 ' + state.students.length + '명';
  }

  // 실시간 오버레이 — 현재 문항의 선지 분포 + 미답 수. 정답 공개 전엔 어느 게 정답인지 표시 안 함(개수만).
  function renderRtDist() {
    var box = document.getElementById('rtDist');
    var body = document.getElementById('rtBody');
    var q = curQ();
    if (!box || !q) return;
    document.getElementById('rtTitle').textContent = q.num + '번 응답';
    if (q.type === 'essay') {
      body.innerHTML = '<div class="rt-miss" style="color:#7dd3fc">서술형 — 작성 ' + countAnswered(q.num) + '명</div>';
      return;
    }
    var tally = {}, miss = 0, order = [];
    state.students.forEach(function (s) {
      var g = givenOf(s, q.num).trim();
      if (!g) { miss++; return; }
      if (tally[g] == null) { tally[g] = 0; order.push(g); }
      tally[g]++;
    });
    var max = 1; order.forEach(function (k) { if (tally[k] > max) max = tally[k]; });
    order.sort(function (a, b) { return tally[b] - tally[a]; });
    var revealed = state.reveal;
    var html = order.slice(0, 6).map(function (k) {
      var isAns = revealed && String(q.answer || '').trim() && window.answerMatch.isCorrect(k, q.answer);
      return '<div class="rt-bar"><span class="rt-mk">' + escapeHtml(k.slice(0, 3)) + '</span>' +
        '<span class="rt-track"><span class="rt-fill" style="width:' + Math.round(tally[k] / max * 100) + '%;' +
        (isAns ? 'background:#22c55e;' : '') + '"></span></span><span class="rt-n">' + tally[k] + '</span></div>';
    }).join('');
    if (!order.length) html = '<div class="rt-miss" style="color:#64748b">아직 응답이 없어요</div>';
    html += '<div class="rt-miss">미답 ' + miss + '명</div>';
    body.innerHTML = html;
  }

  // 정답 공개 토글(기본 가림)
  var revealBtn = document.getElementById('revealBtn');
  revealBtn.onclick = function () {
    state.reveal = !state.reveal;
    revealBtn.textContent = state.reveal ? '🙉 정답 공개됨 — 가리기' : '🙈 정답 가림 — 공개하기';
    revealBtn.classList.toggle('revealed', state.reveal);
    renderAnswer();
  };

  // 문항 이동 시에만 필기 초기화(폴링 render 에서는 초기화하지 않음)
  function goTo(idx) {
    if (idx < 0 || idx >= state.questions.length || idx === state.curIdx) return;
    state.curIdx = idx;
    clearCanvas();
    renderProblem(); // 조각 모드: 문항 이미지 교체
    render();
  }

  function renderNav() {
    var nav = document.getElementById('nav');
    var html = '';
    html += '<button id="prev" ' + (state.curIdx <= 0 ? 'disabled' : '') + '>← 이전</button>';
    state.questions.forEach(function (q, i) {
      html += '<button class="qbtn ' + (i === state.curIdx ? 'active' : '') + '" data-i="' + i + '">' + q.num + '</button>';
    });
    html += '<button id="next" ' + (state.curIdx >= state.questions.length - 1 ? 'disabled' : '') + '>다음 →</button>';
    html += '<span class="live">● 실시간 (5초)</span>';
    nav.innerHTML = html;
    var prev = document.getElementById('prev'); if (prev) prev.onclick = function () { goTo(state.curIdx - 1); };
    var next = document.getElementById('next'); if (next) next.onclick = function () { goTo(state.curIdx + 1); };
    nav.querySelectorAll('.qbtn').forEach(function (b) {
      b.onclick = function () { goTo(parseInt(b.getAttribute('data-i'), 10)); };
    });
  }

  // 오른쪽 상단: 현재 문항 정답 + 정답률
  function renderAnswer() {
    var el = document.getElementById('qAnswer');
    var q = curQ();
    if (!q) { el.innerHTML = '<div class="empty">문항이 없습니다.</div>'; return; }
    var typeLabel = q.type === 'choice' ? '객관식' : q.type === 'short' ? '단답' : '서술형';

    // 교사가 정답칸을 입력하는 중이면 그 값을 지킨다.
    // 5초 통계 폴링(fetchData)이 이 패널을 통째로 다시 그리는데, 그때 서버의 옛 정답으로
    // 입력칸을 되돌려 버려 "㉡|28-(17+6)" 처럼 여러 정답을 치던 도중에 앞부분만 남고 잘렸다.
    var edit = document.getElementById('keyInput');
    var keepVal = (edit && document.activeElement === edit) ? edit.value : null;
    var keepSel = keepVal !== null ? [edit.selectionStart, edit.selectionEnd] : null;
    if (keepVal !== null) q.answer = keepVal;    // 편집 중 값으로 정답률도 계속 맞춘다

    var total = 0, correct = 0;
    state.students.forEach(function (s) {
      var c = isCorrect(s, q.num);
      if (c === null) return;
      total++; if (c === true) correct++;
    });
    var rateHtml = q.type === 'essay'
      ? '<div class="rate">서술형 — 정답률 없음 (제출 ' + countAnswered(q.num) + '명)</div>'
      : '<div class="rate">정답률 <b>' + (total ? Math.round(correct / total * 100) : 0) + '%</b> (' + correct + ' / ' + total + ')</div>';
    var valHtml;
    if (q.type === 'essay') {
      valHtml = '<div class="val essay">— (서술형: 정답 없음)</div>';
    } else if (!state.reveal) {
      // 가려도 '교사만 보는 입력칸'은 살아 있다 — 정답을 넣는 즉시 채점되고, 공개는 따로 결정한다
      valHtml = '<div class="val" style="letter-spacing:4px;color:#64748b">●●●</div>';
    } else if (q.type === 'match') {
      // 선긋기 정답은 "0:0,1:1" 이라 그대로 띄우면 못 읽는다 → 이어진 쌍을 글로 보여준다
      var mm = q.meta || {}, L = mm.left || [], R = mm.right || [];
      var prs = String(q.answer || '').split(',').map(function (p) { return p.split(':'); })
        .filter(function (p) { return p.length === 2; });
      valHtml = prs.length
        ? '<div class="val" style="font-size:20px;line-height:1.5;">' + prs.map(function (p) {
            return escapeHtml(L[Number(p[0])] || p[0]) + ' — ' + escapeHtml(R[Number(p[1])] || p[1]);
          }).join('<br />') + '</div>'
        : '<div class="val">(정답 미입력)</div>';
    } else {
      valHtml = '<div class="val">' + escapeHtml(q.answer || '(정답 미입력)') + '</div>';
    }

    var keyHtml = q.type === 'essay' ? '' :
      '<div class="keyrow">' +
      '<input id="keyInput" type="text" placeholder="정답 입력 (여러 개면 ㉡|28-(17+6))" value="' + escapeHtml(q.answer || '') + '" autocomplete="off" />' +
      '<button id="keySave" type="button">저장</button>' +
      '</div>';

    el.innerHTML =
      '<div><span class="qnum">' + q.num + '번 문항</span><span class="qtype">' + typeLabel + '</span></div>' +
      '<div class="lbl">정답</div>' + valHtml + keyHtml + rateHtml;

    var inp = document.getElementById('keyInput');
    if (inp) {
      // 폴링이 이 패널을 다시 그려도 편집 중이던 값·커서를 되살린다
      if (keepVal !== null) {
        inp.value = keepVal;
        try { inp.focus(); inp.setSelectionRange(keepSel[0], keepSel[1]); } catch (e) {}
      }
      var save = function () { saveAnswerKey(q.num, inp.value); };
      document.getElementById('keySave').onclick = save;
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
      // 타이핑하는 동안에도 바로 채점해 보여준다(저장은 [저장]/Enter 에서)
      inp.addEventListener('input', function () { q.answer = inp.value; renderRate(); renderRight(); });
    }
  }
  // 정답률만 다시 그린다(입력칸 포커스를 잃지 않게 renderAnswer 전체를 다시 그리지 않는다)
  function renderRate() {
    var q = curQ(); if (!q) return;
    var el = document.querySelector('#qAnswer .rate');
    if (!el) return;
    var total = 0, correct = 0;
    state.students.forEach(function (s) {
      var c = isCorrect(s, q.num);
      if (c === null) return;
      total++; if (c === true) correct++;
    });
    el.innerHTML = q.type === 'essay'
      ? '서술형 — 정답률 없음 (제출 ' + countAnswered(q.num) + '명)'
      : '정답률 <b>' + (total ? Math.round(correct / total * 100) : 0) + '%</b> (' + correct + ' / ' + total + ')';
  }
  function saveAnswerKey(num, answer) {
    fetch('/api/present/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID, num: num, answer: answer }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '저장 실패');
      var q = qByNum(num); if (q) q.answer = answer;      // 다음에 열어도 유지된다
      render();
    }).catch(function (e) { alert('정답 저장 실패: ' + e.message); });
  }
  // 애매 판정을 교사가 손으로 인정 — 그 학생 그 문항에만 저장된다
  function acceptManual(stu, num) {
    fetch('/api/present/manual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId: stu.id, num: num, correct: true }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '실패');
      stu.manual = d.manual || {};
      render();
    }).catch(function (e) { alert('정답 인정 실패: ' + e.message); });
  }

  function countAnswered(num) {
    var n = 0;
    state.students.forEach(function (s) {
      var c = s.byNum && s.byNum[num];
      if (c && String(c.given || '').trim() !== '') n++;
    });
    return n;
  }

  function renderRight() {
    var list = document.getElementById('list');
    var q = curQ();
    if (!q) { list.innerHTML = '<div class="empty">문항이 없습니다.</div>'; return; }

    var rows = state.students.filter(function (s) {
      var c = isCorrect(s, q.num);
      if (state.filter === 'all') return true;
      if (state.filter === 'correct') return c === true;
      if (state.filter === 'wrong') return c === false;
      return true;
    });

    document.getElementById('panelHead').textContent =
      '응답 현황 · ' + q.num + '번 · ' + labelOf(state.filter) + ' (' + rows.length + '명)';

    if (!rows.length) { list.innerHTML = '<div class="empty">해당하는 제출이 없습니다.</div>'; return; }

    var html = '';
    rows.forEach(function (s, i) {
      var given = givenOf(s, q.num);
      var c = isCorrect(s, q.num);
      var near = isNearMiss(s, q.num);
      var cls = c === true ? 'correct' : c === false ? 'wrong' : 'neutral';
      // 학생이 뭐라고 썼는지가 정보다 — 원문을 그대로 보여준다("ㄴ" 을 "㉡" 으로 바꿔 보이면 안 된다)
      var mark = c === true
        ? '<span class="mark ok">' + (manualOk(s, q.num) ? '✅손' : '✔') + '</span>'
        : near ? '<button class="mark warn" data-accept="' + i + '" title="오타 같아요 — 눌러서 정답 인정">⚠</button>'
          : c === false ? '<span class="mark no">✘</span>' : '<span class="mark">·</span>';
      html += '<div class="item ' + cls + (near ? ' near' : '') + '">' +
        '<div class="no">' + s.no + '번</div>' +
        '<div class="ans">' + (given ? escapeHtml(given) : '<i style="color:#64748b">무응답</i>') + '</div>' +
        mark + '</div>';
    });
    list.innerHTML = html;
    list.querySelectorAll('button[data-accept]').forEach(function (b) {
      b.onclick = function () { acceptManual(rows[Number(b.getAttribute('data-accept'))], q.num); };
    });
  }

  function labelOf(f) { return f === 'correct' ? '맞은 사람' : f === 'wrong' ? '틀린 사람' : '전체'; }

  document.querySelectorAll('.filters button').forEach(function (b) {
    b.onclick = function () {
      state.filter = b.getAttribute('data-f');
      document.querySelectorAll('.filters button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      renderRight();
    };
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- 필기 캔버스 ----
  var canvas = document.getElementById('drawCanvas');
  var ctx = canvas.getContext('2d');
  var wrap = document.getElementById('problemWrap');
  var content = document.getElementById('problemContent');
  var zoomLayer = document.getElementById('zoomLayer');
  var pen = { on: true, color: '#ef4444', size: 3, eraser: false };
  var drawing = false, last = null;

  // ---- 확대/축소/패닝 (필기 캔버스와 같은 좌표계로 함께 변환) ----
  var view = { z: 1, panX: 0, panY: 0 };
  function applyZoom() {
    zoomLayer.style.transform = 'translate(' + view.panX + 'px,' + view.panY + 'px) scale(' + view.z + ')';
    var rb = document.getElementById('zoomReset'); if (rb) rb.textContent = Math.round(view.z * 100) + '%';
  }
  function clampPan() {
    var sw = zoomLayer.offsetWidth * view.z, sh = zoomLayer.offsetHeight * view.z;
    var ww = wrap.clientWidth, wh = wrap.clientHeight;
    view.panX = Math.min(0, Math.max(view.panX, Math.min(0, ww - sw)));
    view.panY = Math.min(0, Math.max(view.panY, Math.min(0, wh - sh)));
  }
  function zoomAt(newZ, clientX, clientY) {
    var r = wrap.getBoundingClientRect();
    var cx = clientX - r.left, cy = clientY - r.top;
    var contentX = (cx - view.panX) / view.z, contentY = (cy - view.panY) / view.z;
    view.z = Math.max(1, Math.min(3, newZ));
    view.panX = cx - contentX * view.z; view.panY = cy - contentY * view.z;
    clampPan(); applyZoom();
  }
  // 확대 기준점: 실제로 보이는 콘텐츠(이미지)의 중심을 뷰포트 안으로 클램프한 지점
  // → 좁은 조각 이미지가 좌상단으로 밀려나지 않고 화면 중앙에서 커진다.
  function zoomCenter(newZ) {
    var el = content.querySelector('img') || content;
    var cr = el.getBoundingClientRect();
    var wr = wrap.getBoundingClientRect();
    var ax = Math.min(Math.max((cr.left + cr.right) / 2, wr.left + 20), wr.right - 20);
    var ay = Math.min(Math.max((cr.top + cr.bottom) / 2, wr.top + 20), wr.bottom - 20);
    zoomAt(newZ, ax, ay);
  }
  document.getElementById('zoomIn').onclick = function () { zoomCenter(view.z * 1.25); };
  document.getElementById('zoomOut').onclick = function () { zoomCenter(view.z / 1.25); };
  document.getElementById('zoomReset').onclick = function () { view.z = 1; view.panX = 0; view.panY = 0; applyZoom(); }; // 배율·위치 모두 초기화
  wrap.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(view.z * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX, e.clientY); }
    else { e.preventDefault(); view.panX -= e.deltaX; view.panY -= e.deltaY; clampPan(); applyZoom(); } // 일반 휠 = 상하/좌우 이동
  }, { passive: false });
  // 펜 OFF 일 때 드래그로 패닝(펜 ON 이면 그리기 우선)
  var panning = false, panStart = null;
  wrap.addEventListener('pointerdown', function (e) {
    if (pen.on) return;
    panning = true; panStart = { x: e.clientX, y: e.clientY, px: view.panX, py: view.panY };
  });
  wrap.addEventListener('pointermove', function (e) {
    if (!panning) return;
    view.panX = panStart.px + (e.clientX - panStart.x);
    view.panY = panStart.py + (e.clientY - panStart.y);
    clampPan(); applyZoom();
  });
  function endPan() { panning = false; }
  wrap.addEventListener('pointerup', endPan);
  wrap.addEventListener('pointerleave', endPan);

  function fitCanvas() {
    var w = content.scrollWidth, h = Math.max(content.scrollHeight, wrap.clientHeight);
    canvas.width = w; canvas.height = h;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    clampPan(); applyZoom();
  }
  function clearCanvas() { ctx.clearRect(0, 0, canvas.width, canvas.height); }
  // 줌·패닝을 반영해 클라이언트 좌표 → 캔버스 좌표 (필기가 문제와 정확히 정렬)
  function point(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  }
  function drawSeg(a, b) {
    ctx.globalCompositeOperation = pen.eraser ? 'destination-out' : 'source-over';
    ctx.strokeStyle = pen.color;
    ctx.lineWidth = pen.eraser ? pen.size * 6 : pen.size;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (!pen.on) return;
    drawing = true; last = point(e);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drawing || !pen.on) return;
    var p = point(e); drawSeg(last, p); last = p;
  });
  function endStroke() { drawing = false; last = null; }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  // 필기 on/off: off 면 캔버스가 클릭·스크롤을 통과시킴. 켜면 색·굵기 서브도구가 뜬다.
  function applyPenMode() {
    canvas.style.pointerEvents = pen.on ? 'auto' : 'none';
    var t = document.getElementById('tbToggle');
    t.textContent = pen.on ? '✏️ 필기' : '✏️ 필기 끔';
    t.classList.toggle('on', pen.on);
    document.getElementById('drawTools').classList.toggle('on', pen.on);
  }
  document.getElementById('tbToggle').onclick = function () { pen.on = !pen.on; applyPenMode(); };

  document.querySelectorAll('.tb-color').forEach(function (b) {
    b.onclick = function () {
      pen.color = b.getAttribute('data-color'); pen.eraser = false;
      document.querySelectorAll('.tb-color').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      document.getElementById('tbEraser').classList.remove('active');
    };
  });
  document.querySelectorAll('.tb-size').forEach(function (b) {
    b.onclick = function () {
      pen.size = parseInt(b.getAttribute('data-size'), 10) || 3;
      document.querySelectorAll('.tb-size').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
    };
  });
  document.getElementById('tbEraser').onclick = function () {
    pen.eraser = true;
    this.classList.add('active');
    document.querySelectorAll('.tb-color').forEach(function (x) { x.classList.remove('active'); });
  };
  document.getElementById('tbClear').onclick = function () { clearCanvas(); };

  // 캔버스 크기 맞춤: 로드·이미지 로드·리사이즈 시(리사이즈 시 필기는 초기화됨 — 임시 필기라 허용)
  fitCanvas();
  window.addEventListener('load', fitCanvas);
  window.addEventListener('resize', fitCanvas);
  content.querySelectorAll('img').forEach(function (img) {
    if (!img.complete) img.addEventListener('load', fitCanvas);
  });
  setTimeout(fitCanvas, 500);
  applyPenMode();

  // ---- TTS: 글자 모드(data-tts=on) 활동에서만 문제 읽어주기 ----
  (function initPresentTts() {
    var textDoc = content.querySelector('.pdf-text-doc[data-tts="on"]');
    if (!textDoc || !('speechSynthesis' in window)) return; // 이미지/기존 활동은 TTS 버튼 숨김(비활성)
    ['ttsRead', 'ttsStop', 'ttsRate'].forEach(function (id) { var e = document.getElementById(id); if (e) e.style.display = ''; });
    function rate() { return parseFloat(document.getElementById('ttsRate').value) || 1; }
    document.getElementById('ttsRead').onclick = function () {
      var text = textDoc.innerText || textDoc.textContent || '';
      if (!text.trim()) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = rate();
      window.speechSynthesis.speak(u);
    };
    document.getElementById('ttsStop').onclick = function () { window.speechSynthesis.cancel(); };
  })();

  // ---- 교실 도우미: 안내 음성 + 신호음(Web Audio) + 커스텀 문구 ----
  (function initHelper() {
    var helper = document.getElementById('helper');
    document.getElementById('helperBtn').onclick = function () { helper.classList.toggle('shown'); };

    // 한국어 음성 목록(OS 설치분) 채우기
    var koVoices = [];
    function loadVoices() {
      if (!('speechSynthesis' in window)) return;
      koVoices = window.speechSynthesis.getVoices().filter(function (v) { return /^ko/i.test(v.lang); });
      var sel = document.getElementById('helperVoice');
      var note = document.getElementById('voiceNote');
      sel.innerHTML = '';
      if (!koVoices.length) {
        var o = document.createElement('option'); o.value = ''; o.textContent = '(기본 음성)';
        sel.appendChild(o);
        note.textContent = '— 설치된 한국어 음성이 없어 기본 음성을 씁니다';
      } else {
        note.textContent = '';
        koVoices.forEach(function (v, i) {
          var o = document.createElement('option'); o.value = String(i); o.textContent = v.name;
          sel.appendChild(o);
        });
      }
    }
    loadVoices();
    if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = loadVoices;

    function say(text) {
      if (!text || !('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      var vi = document.getElementById('helperVoice').value;
      if (vi !== '' && koVoices[vi]) u.voice = koVoices[vi];
      u.rate = parseFloat(document.getElementById('helperRate').value) || 1;
      u.volume = parseFloat(document.getElementById('helperVol').value); // 기본 1.0(최대)
      window.speechSynthesis.speak(u);
    }
    document.getElementById('helperStopVoice').onclick = function () { window.speechSynthesis.cancel(); };
    document.getElementById('helperPreview').onclick = function () { say('안녕하세요'); };

    // 기본 안내 문구
    var PRESETS = ['조용히 해주세요', '바른 자세로 앉아주세요', '선생님을 봐주세요', '정리하는 시간이에요', '집중해주세요'];
    var pg = document.getElementById('presetPhrases');
    PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.textContent = '🔊 ' + p;
      b.onclick = function () { say(p); };
      pg.appendChild(b);
    });

    // 커스텀 문구 + 최근 사용(세션 내 배열, 최대 3개)
    var recent = [];
    var rg = document.getElementById('recentPhrases');
    function renderRecent() {
      rg.innerHTML = '';
      recent.forEach(function (p) {
        var b = document.createElement('button');
        b.textContent = '↩ ' + p;
        b.onclick = function () { say(p); };
        rg.appendChild(b);
      });
    }
    function speakCustom() {
      var el = document.getElementById('customPhrase');
      var v = (el.value || '').trim();
      if (!v) return;
      say(v);
      recent = [v].concat(recent.filter(function (x) { return x !== v; })).slice(0, 3);
      renderRecent();
    }
    document.getElementById('customSpeak').onclick = speakCustom;
    document.getElementById('customPhrase').addEventListener('keydown', function (e) { if (e.key === 'Enter') speakCustom(); });

    // 신호음(Web Audio API — 음성 아님). 교실에서 들리게 크게, 컴프레서로 클리핑 방지.
    var AC = window.AudioContext || window.webkitAudioContext;
    var actx = null, comp = null;
    function tone(freq, start, dur, type) {
      var t0 = actx.currentTime + start;
      var osc = actx.createOscillator();
      var g = actx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.85, t0 + 0.02); // 크게(0.35→0.85)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(comp);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    function playSound(kind) {
      if (!AC) return;
      if (!actx) { actx = new AC(); comp = actx.createDynamicsCompressor(); comp.connect(actx.destination); }
      if (actx.state === 'suspended') actx.resume();
      if (kind === 'focus') { tone(880, 0, 0.25); tone(1320, 0.22, 0.35); } // 종소리 2음
      else if (kind === 'start') { tone(660, 0, 0.18); tone(990, 0.16, 0.3, 'triangle'); } // 상승
      else if (kind === 'end') { tone(880, 0, 0.2); tone(587, 0.18, 0.34, 'triangle'); } // 하강
    }
    document.querySelectorAll('[data-sound]').forEach(function (b) {
      b.onclick = function () { playSound(b.getAttribute('data-sound')); };
    });
  })();

  // ---- 공용 도구: 응답 오버레이 · 스포트라이트 · 타이머 · 도움말 · 전체화면 · 하단 독 ----
  var PT = window.PresentTools;

  // 응답·채점 오버레이(3겹 닫기). 사이드 패널이라 배경 클릭으로는 안 닫는다(작업 중 손실 방지) — ✕·Esc·뒤로가기로만.
  var ansOv = PT.createOverlay(document.getElementById('answerPanel'), {
    name: 'answer', display: 'flex', backdrop: false, closeLabel: '닫기'
  });
  document.getElementById('answerBtn').onclick = function () { ansOv.isOpen() ? ansOv.close() : ansOv.open(); };

  // 실시간 분포 오버레이 접기
  document.getElementById('rtDist').addEventListener('click', function () {
    this.classList.toggle('collapsed');
    document.getElementById('rtToggle').textContent = this.classList.contains('collapsed') ? '▸' : '▾';
  });

  var spot = PT.createSpotlight();
  document.getElementById('spotBtn').onclick = function () { spot.open(); };
  var timer = PT.createTimer();
  document.getElementById('timerBtn').onclick = function () { timer.open(); };
  var help = PT.createHelp([
    ['←/→', '문항 이동'], ['F', '전체화면'], ['Esc', '오버레이 닫기'],
    ['✕ / 뒤로가기', '오버레이 닫기(발표 유지)']
  ]);
  document.getElementById('helpBtn').onclick = function () { help.open(); };
  document.getElementById('fscBtn').onclick = function () { PT.toggleFullscreen(); };

  document.addEventListener('keydown', function (e) {
    var t = (e.target && e.target.tagName) || '';
    if (t === 'INPUT' || t === 'TEXTAREA') return;
    if (e.key === 'f' || e.key === 'F') { PT.toggleFullscreen(); }
    else if (PT._stackDepth() === 0 && e.key === 'ArrowRight') { goTo(state.curIdx + 1); }   // 오버레이 없을 때만 문항 이동
    else if (PT._stackDepth() === 0 && e.key === 'ArrowLeft') { goTo(state.curIdx - 1); }
  });

  PT.createDock(document.getElementById('dock'), { idleMs: 5000 });

  fetchData();
  setInterval(fetchData, 5000); // 오른쪽 통계 실시간 갱신
})();
</script>
</body>
</html>`;
}

function renderStudentPage(activity) {
  const title = escapeHtml(activity.title || '활동');
  const body = activity.html_body || '';
  const activityId = activity.id;
  const version = Number(activity.version) || 1;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: #1a1a1a; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 16px; }
  .bar { background: #2b6cb0; color: #fff; padding: 14px 16px; border-radius: 12px; margin-bottom: 16px; }
  .bar h1 { font-size: 18px; margin: 0 0 8px; }
  .bar input { width: 100%; padding: 10px; font-size: 16px; border: 0; border-radius: 8px; box-sizing: border-box; }
  .content { background: #fff; padding: 16px; border-radius: 12px; }
  .submit-bar { position: sticky; bottom: 0; margin-top: 16px; padding: 12px 0; }
  .submit-bar button { width: 100%; padding: 14px; font-size: 17px; font-weight: 700; color: #fff; background: #2f855a; border: 0; border-radius: 12px; cursor: pointer; }
  .submit-bar button:disabled { background: #a0aec0; }
  #result { margin-top: 16px; background: #fff; border-radius: 12px; padding: 16px; display: none; }
  #result h2 { margin: 0 0 8px; }
  #result ul { padding-left: 18px; }
  #result li.ok { color: #2f855a; }
  #result li.no { color: #c53030; }
  #result li.skip { color: #718096; }
  .score { font-size: 22px; font-weight: 800; }
  #__updateBanner { display: none; position: sticky; top: 0; z-index: 50; background: #fefcbf; color: #744210; border: 1px solid #ecc94b; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; font-weight: 700; }
  #__updateBanner button { margin-left: 10px; padding: 6px 14px; font-size: 14px; font-weight: 700; color: #fff; background: #d69e2e; border: 0; border-radius: 8px; cursor: pointer; }
  #__ttsBar { display: none; align-items: center; gap: 8px; flex-wrap: wrap; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 12px; margin-bottom: 12px; }
  #__ttsBar .lab { font-size: 13px; color: #718096; font-weight: 700; }
  #__ttsBar button, #__ttsBar select { padding: 6px 10px; font-size: 14px; font-weight: 700; border: 1px solid #cbd5e1; background: #f7fafc; border-radius: 7px; cursor: pointer; }
  .tts-play { margin-right: 6px; padding: 2px 8px !important; font-size: 13px !important; background: #ebf8ff !important; border: 1px solid #bee3f8 !important; border-radius: 6px; cursor: pointer; }
  /* 선지 클릭 = 답 선택(변환된 문항에만 선지 <li data-marker> 가 있다) */
  ol.choices li.pick { min-height: 44px; display: flex; align-items: center; cursor: pointer; user-select: none; }
  ol.choices li.pick.on { border: 2px solid #2b6cb0; background: #ebf8ff; font-weight: 700; }
  .cmark { font-weight: 800; color: #2b6cb0; margin-right: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <div id="__updateBanner">🔔 선생님이 문제를 수정했어요. <button id="__reloadBtn" type="button">새로고침</button></div>
  <div id="__ttsBar">
    <span class="lab">📖 글자 크기</span>
    <button id="__fsMinus" type="button">A-</button>
    <button id="__fsPlus" type="button">A+</button>
    <span class="lab">🔊 읽기 속도</span>
    <select id="__ttsRate"><option value="1">보통</option><option value="0.7">느리게</option></select>
    <button id="__ttsStop" type="button">⏹ 정지</button>
  </div>
  <div class="bar">
    <h1>${title}</h1>
    <input id="__nickname" type="text" placeholder="닉네임(이름)을 입력하세요" autocomplete="off" />
  </div>

  <div class="content" id="__activityBody">
${body}
  </div>

  <div class="submit-bar">
    <button id="__submitBtn" type="button">선생님께 제출</button>
  </div>

  <div id="result"></div>
</div>

<script>
(function () {
  var ACTIVITY_ID = ${JSON.stringify(activityId)};
  var MY_VERSION = ${version};
  var btn = document.getElementById('__submitBtn');
  var nickEl = document.getElementById('__nickname');
  var resultEl = document.getElementById('result');
  var bodyEl = document.getElementById('__activityBody');

  // 선지 클릭 = 답 선택 — 해당 문항의 답칸(input[name=qN])에 마커('③')를 그대로 넣는다.
  // 답칸은 그대로 두므로(직접 타이핑도 가능) collectAnswers 는 손댈 필요가 없다.
  (function bindChoicePick() {
    bodyEl.querySelectorAll('ol.choices li[data-marker]').forEach(function (li) {
      var block = li.closest('[data-num]');
      if (!block) return;
      var num = block.getAttribute('data-num');
      var input = bodyEl.querySelector('input[name="q' + num + '"]');
      if (!input) return;
      li.classList.add('pick');
      var mk = li.getAttribute('data-marker');
      if (input.value === mk) li.classList.add('on');
      li.addEventListener('click', function () {
        var same = input.value === mk;
        input.value = same ? '' : mk;                      // 같은 선지 재클릭 = 해제
        bodyEl.querySelectorAll('ol.choices li[data-marker]').forEach(function (o) {
          var ob = o.closest('[data-num]');
          if (ob && ob.getAttribute('data-num') === num) o.classList.toggle('on', o.getAttribute('data-marker') === input.value);
        });
      });
    });
  })();

  function collectAnswers() {
    var answers = {};
    // radio: name 별로 checked 값만
    var radios = bodyEl.querySelectorAll('input[type=radio]');
    radios.forEach(function (r) {
      if (r.name && r.checked) answers[r.name] = r.value;
    });
    // 나머지 input(라디오/체크박스 제외) + textarea + select
    var fields = bodyEl.querySelectorAll('input[name], textarea[name], select[name]');
    fields.forEach(function (el) {
      if (!el.name) return;
      var t = (el.type || '').toLowerCase();
      if (t === 'radio') return; // 위에서 처리
      if (t === 'checkbox') {
        if (el.checked) {
          answers[el.name] = answers[el.name] ? answers[el.name] + ',' + el.value : el.value;
        }
        return;
      }
      answers[el.name] = el.value;
    });
    return answers;
  }

  btn.addEventListener('click', function () {
    var nickname = (nickEl.value || '').trim();
    if (!nickname) { alert('닉네임(이름)을 입력해 주세요.'); nickEl.focus(); return; }

    // 교사 HTML 이 스스로 채점해 window.__quizResult 를 담아뒀으면 자가채점 방식으로 전송
    var qr = window.__quizResult;
    var payload;
    if (qr && typeof qr === 'object' && (qr.total != null || Array.isArray(qr.detail))) {
      payload = {
        activityId: ACTIVITY_ID, nickname: nickname,
        self_scored: true,
        score: Number(qr.score) || 0,
        total: Number(qr.total) || (Array.isArray(qr.detail) ? qr.detail.length : 0),
        detail: Array.isArray(qr.detail) ? qr.detail : [],
      };
    } else {
      payload = { activityId: ACTIVITY_ID, nickname: nickname, answers: collectAnswers() };
    }

    btn.disabled = true;
    btn.textContent = '제출 중...';

    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || '제출 실패');
        showResult(data);
      })
      .catch(function (err) {
        alert('제출에 실패했어요: ' + err.message);
        btn.disabled = false;
        btn.textContent = '선생님께 제출';
      });
  });

  function showResult(data) {
    btn.textContent = '제출 완료';
    var results = data.results || [];
    var gradable = data.gradable || 0;
    var score = data.auto_score || 0;

    var html = '<h2>제출 완료!</h2>';
    html += '<p class="score">채점 대상 ' + gradable + '문항 중 <b>' + score + '개</b> 정답</p>';
    html += '<ul>';
    results.forEach(function (r) {
      if (r.type === 'essay') {
        html += '<li class="skip">' + r.num + '번 (서술형) — 선생님이 확인합니다</li>';
      } else if (r.excluded) {
        // 채점 제외 문항(정답 미입력/채점대상 해제)은 결과에 표시하지 않음
        return;
      } else if (r.correct === null) {
        return;
      } else if (r.correct) {
        html += '<li class="ok">' + r.num + '번 — 정답 ✔</li>';
      } else {
        html += '<li class="no">' + r.num + '번 — 오답 ✗</li>';
      }
    });
    html += '</ul>';
    resultEl.innerHTML = html;
    resultEl.style.display = 'block';
    resultEl.scrollIntoView({ behavior: 'smooth' });
  }

  // ---- 실시간 변경 알림: 8초마다 version 폴링, 서버가 더 크면 배너 표시(자동 새로고침 안 함) ----
  document.getElementById('__reloadBtn').addEventListener('click', function () { location.reload(); });
  function pollVersion() {
    fetch('/api/activities/' + ACTIVITY_ID + '/version')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && Number(data.version) > MY_VERSION) {
          document.getElementById('__updateBanner').style.display = 'block';
        }
      })
      .catch(function () {});
  }
  setInterval(pollVersion, 8000);

  // ---- TTS(읽어주기) + 글자 크기: 글자 모드(data-tts=on) 활동에서만 활성 ----
  (function initTts() {
    var doc = document.querySelector('.pdf-text-doc[data-tts="on"]');
    if (!doc || !('speechSynthesis' in window)) return; // 이미지 모드/기존 HTML은 TTS 비활성
    var bar = document.getElementById('__ttsBar');
    bar.style.display = 'flex';

    var fs = 18;
    function setFs(v) { fs = Math.max(12, Math.min(40, v)); doc.style.setProperty('--tts-fs', fs + 'px'); }
    document.getElementById('__fsPlus').onclick = function () { setFs(fs + 3); };
    document.getElementById('__fsMinus').onclick = function () { setFs(fs - 3); };

    function rate() { return parseFloat(document.getElementById('__ttsRate').value) || 1; }
    function speak(text) {
      if (!text) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = rate();
      window.speechSynthesis.speak(u);
    }
    document.getElementById('__ttsStop').onclick = function () { window.speechSynthesis.cancel(); };

    // 각 단락 앞에 🔊 버튼
    doc.querySelectorAll('.tts-para').forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'tts-play'; btn.textContent = '🔊';
      btn.onclick = function () { speak(p.textContent); };
      p.insertBefore(btn, p.firstChild);
    });
  })();
})();
</script>
</body>
</html>`;
}

// 학생 한 문제씩 응시 화면 (view_mode='single')
// ================= 교사용 실시간 교실 대시보드 =================
// 3초 폴링. 학생 하트비트(5초)가 last_seen 을 갱신하고, 15초 넘게 소식이 없으면 '연결 끊김'.
function renderLivePage(activity) {
  const title = escapeHtml(activity.title || '활동');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>실시간 현황 · ${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: #1a1a1a; }
  .top { background: #fff; border-bottom: 1px solid #e2e8f0; padding: 14px 18px; position: sticky; top: 0; z-index: 20; }
  .top h1 { margin: 0 0 6px; font-size: 18px; }
  .sum { font-size: 15px; font-weight: 800; color: #2b6cb0; }
  .sum .off { color: #a0aec0; font-weight: 700; margin-left: 8px; font-size: 13px; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 16px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 10px; font-size: 15px; }
  .noticebar { display: flex; gap: 8px; }
  .noticebar input { flex: 1; padding: 10px 12px; font-size: 15px; border: 1px solid #cbd5e1; border-radius: 8px; }
  .noticebar button { padding: 10px 16px; font-weight: 800; color: #fff; background: #2b6cb0; border: 0; border-radius: 8px; cursor: pointer; }
  .nlist { margin-top: 10px; font-size: 13px; color: #4a5568; }
  .nlist div { padding: 4px 0; border-top: 1px dashed #e2e8f0; }
  .closebtn { padding: 10px 16px; font-weight: 800; color: #fff; background: #c53030; border: 0; border-radius: 8px; cursor: pointer; }
  .closed { padding: 10px 12px; background: #fed7d7; border: 1px solid #fc8181; border-radius: 8px; font-weight: 800; color: #822727; }
  table.matrix { border-collapse: collapse; font-size: 13px; width: 100%; }
  /* 활동지는 열이 서너 개뿐이다. width:100% 를 그대로 두면 남는 폭을 '학생' 열이 다 먹어
     칸들이 화면 오른쪽 끝으로 밀려난다(문항 20개짜리 시험지에서는 안 보이던 문제).
     내용 너비로 두어 이름 옆에 붙게 한다. */
  table.matrix.sheet { width: auto; }
  table.matrix.sheet td.name, table.matrix.sheet th.name { min-width: 120px; }
  table.matrix th, table.matrix td { border: 1px solid #e2e8f0; padding: 5px 6px; text-align: center; }
  table.matrix th.name, table.matrix td.name { text-align: left; white-space: nowrap; font-weight: 700; position: sticky; left: 0; background: #fff; }
  table.matrix th.qh { cursor: pointer; }
  table.matrix th.qh:hover { background: #ebf8ff; }
  /* 활동지 열 머리글 — 번호가 아니라 라벨이라 자리가 더 필요하다. 누를 것도 없으니 손모양 없음 */
  table.matrix th.fh { cursor: default; min-width: 62px; max-width: 96px; font-size: 11.5px; line-height: 1.3; white-space: normal; word-break: break-all; }
  table.matrix th.fh:hover { background: #f7fafc; }
  table.matrix td.cell { width: 30px; height: 26px; }
  td.a { background: #c6f6d5; }          /* 답함 / 입력 있음 */
  td.c { background: #bee3f8; box-shadow: inset 0 0 0 2px #2b6cb0; }  /* 지금 보는 중 / 입력 중 */
  td.u { background: #edf2f7; }          /* 미답 / 비어 있음 */
  tr.off td.name { color: #a0aec0; }
  .badge { display: inline-block; font-size: 11px; font-weight: 800; padding: 1px 7px; border-radius: 999px; margin-left: 6px; }
  .badge.on { background: #c6f6d5; color: #22543d; }
  .badge.offb { background: #edf2f7; color: #718096; }
  .badge.sub { background: #bee3f8; color: #2a4365; }
  tfoot td { font-weight: 800; color: #4a5568; background: #f7fafc; }
  .scroller { overflow-x: auto; }
  .dist { margin-top: 8px; }
  .bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .bar .mk { width: 34px; font-weight: 800; color: #2b6cb0; }
  .bar .track { flex: 1; background: #edf2f7; border-radius: 6px; height: 24px; position: relative; }
  .bar .fill { background: #90cdf4; height: 100%; border-radius: 6px; }
  .bar .n { width: 100px; font-size: 12px; color: #4a5568; }
  .who { font-size: 12px; color: #718096; margin-left: 4px; }
  .muted { color: #718096; font-size: 13px; }
  /* 학생 패널 — 이름을 누르면 오른쪽에서 밀려 나온다 */
  table.matrix td.name { cursor: pointer; }
  table.matrix td.name:hover { background: #ebf8ff; }
  #stuPanel { position: fixed; top: 0; right: 0; width: 380px; max-width: 100%; height: 100%; background: #fff;
    border-left: 1px solid #e2e8f0; box-shadow: -4px 0 20px rgba(0,0,0,.10); padding: 16px; overflow-y: auto;
    transform: translateX(100%); transition: transform .18s ease; z-index: 40; }
  #stuPanel.show { transform: translateX(0); }
  #stuPanel h3 { margin: 0 0 4px; font-size: 17px; }
  #stuPanel .close { position: absolute; top: 12px; right: 14px; border: 0; background: transparent; font-size: 20px; cursor: pointer; color: #718096; }
  .stat { font-size: 13px; color: #4a5568; margin-bottom: 12px; }
  .stat b { color: #2b6cb0; }
  .ansrow { display: flex; gap: 8px; padding: 5px 0; border-top: 1px dashed #e2e8f0; font-size: 13px; }
  .ansrow .n { flex: 0 0 40px; font-weight: 800; color: #4a5568; }
  .ansrow .v { flex: 1; word-break: break-word; }
  .ansrow .v.none { color: #a0aec0; }
  .quick { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .quick button { padding: 7px 10px; font-size: 12px; font-weight: 700; border: 1px solid #cbd5e1; background: #f7fafc; border-radius: 999px; cursor: pointer; }
  .msgbar { display: flex; gap: 6px; }
  .msgbar input { flex: 1; min-width: 0; padding: 9px 10px; font-size: 14px; border: 1px solid #cbd5e1; border-radius: 8px; }
  .msgbar button { padding: 9px 12px; font-weight: 800; color: #fff; background: #2b6cb0; border: 0; border-radius: 8px; cursor: pointer; }
  .msglog { margin-top: 10px; }
  .msglog .m { padding: 8px 10px; margin-bottom: 6px; background: #ebf8ff; border: 1px solid #bee3f8; border-radius: 8px; font-size: 13px; }
  .msglog .m .meta { font-size: 11px; color: #718096; margin-top: 3px; }
  .msglog .m.unread { background: #fffaf0; border-color: #f6ad55; }
  .msglog .m .badge2 { font-size: 11px; font-weight: 800; color: #975a16; }
  /* 셀 클릭 → 이동 요청 팝오버 */
  table.matrix td.cell { cursor: pointer; }
  #pop { display: none; position: absolute; z-index: 50; background: #fff; border: 1px solid #cbd5e1;
    border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.14); padding: 12px; font-size: 13px; }
  #pop.show { display: block; }
  #pop .pt { font-weight: 800; margin-bottom: 8px; white-space: nowrap; }
  #pop .pa { display: flex; gap: 6px; }
  #pop button { padding: 7px 12px; font-size: 13px; font-weight: 800; border-radius: 8px; cursor: pointer; border: 1px solid #cbd5e1; background: #fff; }
  #pop button.go { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
  .gotorow { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .gotorow select { flex: 1; padding: 8px; font-size: 13px; border: 1px solid #cbd5e1; border-radius: 8px; }
  .gotorow button { padding: 8px 12px; font-weight: 800; color: #fff; background: #2f855a; border: 0; border-radius: 8px; cursor: pointer; }
</style>
</head>
<body>
  <div class="top">
    <h1>🟢 실시간 현황 · ${title}</h1>
    <div class="sum" id="sum">불러오는 중...</div>
  </div>
  <div class="wrap">
    <div class="card">
      <h2>📢 공지 보내기</h2>
      <div class="noticebar">
        <input id="noticeText" type="text" placeholder="예: 5번은 건너뛰세요" autocomplete="off" />
        <button id="noticeSend" type="button">보내기</button>
        <button class="closebtn" id="closeBtn" type="button">마감하기</button>
      </div>
      <div class="nlist" id="nlist"></div>
      <div id="closedBox" style="display:none; margin-top:10px;" class="closed">🔒 마감됨 — 학생 화면이 제출 마감으로 바뀌었고, 미제출 학생의 답은 자동 제출됐어요.</div>
    </div>

    <div class="card">
      <h2>📊 진행 매트릭스 <span class="muted" id="mxHint">— 문항 번호를 누르면 응답 분포를 볼 수 있어요</span></h2>
      <div class="scroller"><table class="matrix" id="matrix"></table></div>
    </div>

    <div class="card" id="distCard" style="display:none;">
      <h2 id="distTitle"></h2>
      <div class="dist" id="dist"></div>
    </div>
  </div>

  <div id="stuPanel">
    <button class="close" id="stuClose" type="button">✕</button>
    <div id="stuBody"></div>
  </div>
  <div id="pop"></div>
<script>
(function () {
  var ACTIVITY_ID = ${JSON.stringify(activity.id)};
  var state = null, pickedQ = null, openStu = null;   // openStu = 패널을 열어 둔 학생 닉네임

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hasAns(st, num) { return String((st.answers || {})['q' + num] || '').trim() !== ''; }

  function poll() {
    fetch('/api/live/state?activityId=' + encodeURIComponent(ACTIVITY_ID))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) { state = d; render(); } })
      .catch(function () {});
  }

  // ---- 매트릭스의 열 ----
  // 시험지는 문항 번호가 열이다. 활동지는 문항이 없으니 '수집 필드'가 열이다.
  // 두 화면을 따로 만들지 않는 이유: 공지·개별 메시지·마감·학생 패널은 완전히 같은 기능이라,
  // 갈라놓으면 한쪽만 고쳐지는 사고가 난다. 다른 건 열의 정체뿐이라 여기서만 가른다.
  function isSheet() { return state.kind === 'html_sheet'; }
  function cols() {
    if (isSheet()) {
      return (state.fields || []).filter(function (f) { return f.collect; }).map(function (f) {
        return { key: f.id, head: shortLabel(f.label), title: f.label + (f.section ? ' · ' + f.section : ''), field: f };
      });
    }
    return (state.questions || []).map(function (q) {
      return { key: q.num, head: String(q.num), title: q.num + '번', field: null };
    });
  }
  // 열 머리글은 좁다 — 라벨을 줄여 넣고 전체는 title 로 띄운다.
  function shortLabel(s) {
    var t = String(s || '').trim();
    return t.length > 8 ? t.slice(0, 7) + '…' : t;
  }

  // ---- '입력 중' 판정 ----
  // 서버에 필드별 타임스탬프는 없다. 그래서 폴링 사이에 값이 바뀌었는지로 본다:
  // 바뀐 순간을 기록해 두고 10초간 파랑. 학생 화면이 타이핑 멎고 600ms 뒤 하트비트를 쏘므로
  // 실제 타이핑과 이 판정의 시차는 한 폴링(3초) 안쪽이다.
  // (컬럼을 새로 파지 않은 이유 — 교사 화면에서만 필요한 표시라 스키마를 늘릴 값이 아니다)
  var TYPING_MS = 10000;
  var lastSeenVal = {};    // nick -> { fid: 직전 폴링의 값 }
  var typedAt = {};        // nick -> { fid: 바뀐 것을 본 시각 }
  function noteTyping() {
    if (!isSheet()) return;
    var now = Date.now();
    (state.students || []).forEach(function (st) {
      var nick = st.nickname;
      var prev = lastSeenVal[nick];
      var cur = {};
      cols().forEach(function (c) { cur[c.key] = JSON.stringify((st.answers || {})[c.key] == null ? '' : st.answers[c.key]); });
      if (prev) {
        Object.keys(cur).forEach(function (k) {
          if (prev[k] !== undefined && prev[k] !== cur[k]) {
            typedAt[nick] = typedAt[nick] || {};
            typedAt[nick][k] = now;
          }
        });
      }
      lastSeenVal[nick] = cur;
    });
  }
  function isTyping(nick, key) {
    var t = typedAt[nick] && typedAt[nick][key];
    return !!t && (Date.now() - t) < TYPING_MS;
  }

  // 답이 들어 있는가 — 시험지는 q1·q2…, 활동지는 f1·f3… (체크 묶음은 배열)
  function hasVal(st, col) {
    if (!isSheet()) return hasAns(st, col.key);
    var v = (st.answers || {})[col.key];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v).trim() !== '';
  }

  // 답 한 칸을 사람이 읽는 글로. 체크 묶음(배열)은 고른 항목 이름으로 편다.
  function showVal(st, col) {
    var v = (st.answers || {})[isSheet() ? col.key : 'q' + col.key];
    if (v == null) return '';
    if (Array.isArray(v)) {
      var opts = (col.field && col.field.options) || [];
      return v.map(function (i) { return opts[i] != null ? opts[i] : '#' + (i + 1); }).join(' · ');
    }
    return String(v).trim();
  }

  function render() {
    var cs = cols(), sts = state.students;
    document.getElementById('sum').innerHTML =
      '접속 ' + state.online + '명 · 제출 ' + state.submitted + '명' +
      '<span class="off">(전체 ' + sts.length + '명)</span>';
    noteTyping();

    document.getElementById('mxHint').innerHTML = isSheet()
      ? '— 열은 <b>수집 칸</b>이에요. <span style="background:#c6f6d5;padding:0 6px;border-radius:4px;">입력 있음</span> ' +
        '<span style="background:#bee3f8;padding:0 6px;border-radius:4px;">입력 중</span> ' +
        '<span style="background:#edf2f7;padding:0 6px;border-radius:4px;">비어 있음</span> · 이름·칸을 누르면 쓴 글이 보여요'
      : '— 문항 번호를 누르면 응답 분포를 볼 수 있어요';

    // ---- 진행 매트릭스 ----
    var h = '<thead><tr><th class="name">학생</th>';
    cs.forEach(function (c) {
      h += '<th class="qh' + (isSheet() ? ' fh' : '') + '" data-q="' + esc(String(c.key)) + '" title="' + esc(c.title) + '">' + esc(c.head) + '</th>';
    });
    h += '</tr></thead><tbody>';
    sts.forEach(function (st) {
      h += '<tr class="' + (st.online ? '' : 'off') + '"><td class="name" data-nick="' + esc(st.nickname) + '" title="눌러서 학생 패널 열기">' + esc(st.nickname) +
        (st.online ? '' : '<span class="badge offb">연결 끊김</span>') +
        (st.submitted ? '<span class="badge sub">제출</span>' : '') + '</td>';
      cs.forEach(function (c) {
        var cls;
        if (isSheet()) {
          // 파랑(입력 중)이 초록(입력 있음)을 이긴다 — 지금 손이 가 있는 칸을 먼저 보여 준다.
          cls = isTyping(st.nickname, c.key) ? 'c' : (hasVal(st, c) ? 'a' : 'u');
        } else {
          cls = hasAns(st, c.key) ? 'a' : (st.current_q === c.key ? 'c' : 'u');
          if (st.current_q === c.key && cls === 'a') cls = 'a c';
        }
        h += '<td class="cell ' + cls + '" data-nick="' + esc(st.nickname) + '" data-q="' + esc(String(c.key)) + '"></td>';
      });
      h += '</tr>';
    });
    h += '</tbody><tfoot><tr><td class="name">답한 학생</td>';
    cs.forEach(function (c) {
      var n = sts.filter(function (st) { return hasVal(st, c); }).length;
      h += '<td>' + n + '</td>';
    });
    h += '</tr></tfoot>';
    var mx = document.getElementById('matrix');
    mx.className = 'matrix' + (isSheet() ? ' sheet' : '');
    mx.innerHTML = h;

    // 문항 이동·보기 분포는 '문항 번호'가 있어야 성립한다 → 활동지에서는 열 머리글이 그냥 이름표다.
    if (!isSheet()) {
      document.querySelectorAll('th.qh').forEach(function (th) {
        var q = Number(th.getAttribute('data-q'));
        th.onclick = function () { pickedQ = q; renderDist(); };
        // 열 머리글 우클릭/길게 누르기 = "다 같이 N번 보세요"
        th.oncontextmenu = function (e) { e.preventDefault(); showPop(e, null, q); return false; };
        var timer = null;
        th.onpointerdown = function (e) { timer = setTimeout(function () { showPop(e, null, q); }, 550); };
        th.onpointerup = th.onpointerleave = function () { clearTimeout(timer); };
      });
    }
    document.querySelectorAll('#matrix td.name').forEach(function (td) {
      td.onclick = function () { openStu = td.getAttribute('data-nick'); renderStu(); };
    });
    document.querySelectorAll('#matrix td.cell').forEach(function (td) {
      if (isSheet()) {
        // 보낼 문항 번호가 없다 → 셀 클릭은 그 학생 패널을 연다(거기서 쓴 글·메시지를 본다).
        td.onclick = function () { openStu = td.getAttribute('data-nick'); renderStu(); };
      } else {
        // 셀 클릭 = 이 학생을 이 문항으로 보내기(행 × 열 = 직관 그대로)
        td.onclick = function (e) { showPop(e, td.getAttribute('data-nick'), Number(td.getAttribute('data-q'))); };
      }
    });
    if (openStu) renderStu();

    // ---- 공지 이력 / 마감 상태 ----
    document.getElementById('nlist').innerHTML = (state.notices || []).map(function (n) {
      return '<div>' + esc(n.text) + ' <span class="who">' + new Date(n.at).toLocaleTimeString('ko-KR') + '</span></div>';
    }).join('') || '<div class="muted">보낸 공지가 없어요.</div>';
    document.getElementById('closedBox').style.display = state.closed ? 'block' : 'none';
    document.getElementById('closeBtn').disabled = !!state.closed;

    if (pickedQ != null) renderDist();
  }

  // ---- 문항 이동 요청 ----
  // nickname = null → 전체. 학생 화면은 배너로 '부탁'만 하고, 학생이 [가기] 를 눌러야 이동한다.
  // 실제로 이동했는지는 매트릭스의 파랑 셀이 따라 움직이는 것으로 확인된다(별도 확인 UI 불필요).
  var pop = document.getElementById('pop');
  function showPop(e, nickname, q) {
    pop.classList.add('show');
    pop.style.left = Math.min(e.pageX + 8, window.innerWidth - 240) + 'px';
    pop.style.top = (e.pageY + 8) + 'px';
    pop.innerHTML = '<div class="pt">' + (nickname ? esc(nickname) + ' 학생을 ' : '전체를 ') + q + '번으로 보낼까요?</div>' +
      '<div class="pa"><button type="button" class="go" id="popGo">이동 요청</button>' +
      '<button type="button" id="popNo">취소</button></div>';
    document.getElementById('popGo').onclick = function () { hidePop(); requestGoto(nickname ? [nickname] : null, q); };
    document.getElementById('popNo').onclick = hidePop;
  }
  function hidePop() { pop.classList.remove('show'); }
  document.addEventListener('click', function (e) {
    if (!pop.contains(e.target) && !e.target.closest('td.cell') && !e.target.closest('th.qh')) hidePop();
  });

  function requestGoto(nicknames, q) {
    fetch('/api/live/goto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID, nicknames: nicknames, q: q }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '실패');
      poll();
    }).catch(function (e) { alert('이동 요청 실패: ' + e.message); });
  }

  // ---- 학생 패널: 상태 · 답 목록 · 개별 메시지(전체 공지와 다른 채널) ----
  var QUICK = ['잘하고 있어요 👍', '다시 확인해 보세요', '선생님한테 오세요'];

  document.getElementById('stuClose').onclick = function () {
    openStu = null;
    document.getElementById('stuPanel').classList.remove('show');
  };

  function renderStu() {
    var panel = document.getElementById('stuPanel');
    var st = (state.students || []).filter(function (s) { return s.nickname === openStu; })[0];
    if (!st) { panel.classList.remove('show'); return; }
    panel.classList.add('show');

    var cs = cols();
    var answered = cs.filter(function (c) { return hasVal(st, c); }).length;

    var h = '<h3>' + esc(st.nickname) + '</h3>' +
      '<div class="stat">' +
      (st.online ? '🟢 접속 중' : '⚪ 연결 끊김') +
      (isSheet() ? '' : ' · 현재 <b>' + (st.current_q != null ? st.current_q + '번' : '—') + '</b>') +
      ' · ' + (isSheet() ? '채운 칸' : '답한 문항') + ' <b>' + answered + '/' + cs.length + '</b>' +
      ' · ' + (st.submitted ? '제출 완료' : '미제출') +
      '</div>';

    h += '<div class="lbl" style="font-weight:800;font-size:13px;margin-bottom:4px;">' +
      (isSheet() ? '칸별로 쓴 글 (원문 그대로)' : '문항별 답 (원문 그대로)') + '</div>';
    h += cs.map(function (c) {
      var v = showVal(st, c);
      return '<div class="ansrow"><span class="n"' + (isSheet() ? ' title="' + esc(c.title) + '"' : '') + '>' +
        esc(isSheet() ? c.head : c.key + '번') + '</span>' +
        '<span class="v' + (v ? '' : ' none') + '">' + (v ? esc(v) : '—') + '</span></div>';
    }).join('');

    // 문항 이동 요청은 보낼 번호가 있어야 성립한다 — 활동지는 한 장짜리라 이동이라는 개념이 없다.
    if (!isSheet()) {
      h += '<div class="lbl" style="font-weight:800;font-size:13px;margin:14px 0 4px;">문항 이동 요청</div>';
      h += '<div class="gotorow"><select id="stuGotoQ">' +
        cs.map(function (c) { return '<option value="' + c.key + '">' + c.key + '번</option>'; }).join('') +
        '</select><button type="button" id="stuGoto">이동 요청</button></div>';
    }

    h += '<div class="lbl" style="font-weight:800;font-size:13px;margin:14px 0 4px;">개별 메시지</div>';
    h += '<div class="quick">' + QUICK.map(function (t, i) {
      return '<button type="button" data-quick="' + i + '">' + esc(t) + '</button>';
    }).join('') + '</div>';
    h += '<div class="msgbar"><input id="stuMsg" type="text" placeholder="이 학생에게만 보내는 말" autocomplete="off" />' +
      '<button id="stuSend" type="button">보내기</button></div>';

    var msgs = (st.messages || []).slice().reverse();
    h += '<div class="msglog">' + (msgs.length
      ? msgs.map(function (m) {
          return '<div class="m' + (m.seen_at ? '' : ' unread') + '">' + esc(m.text) +
            '<div class="meta">' + new Date(m.at).toLocaleTimeString('ko-KR') + ' · ' +
            (m.seen_at ? '확인함' : '<span class="badge2">미확인' + (st.online ? '' : ' (연결 끊김 — 재접속하면 전달돼요)') + '</span>') +
            '</div></div>';
        }).join('')
      : '<div class="muted">보낸 메시지가 없어요.</div>') + '</div>';

    document.getElementById('stuBody').innerHTML = h;
    // 활동지에는 이동 요청 UI 가 없다 — 없는 버튼에 바인딩하면 여기서 터져서
    // 바로 아래 '개별 메시지' 바인딩이 통째로 안 걸린다(공지는 되는데 메시지만 죽는 꼴).
    var gotoBtn = document.getElementById('stuGoto');
    if (gotoBtn) {
      gotoBtn.onclick = function () {
        requestGoto([st.nickname], Number(document.getElementById('stuGotoQ').value));
      };
    }
    document.getElementById('stuSend').onclick = function () {
      var el = document.getElementById('stuMsg');
      sendMessage(st.nickname, el.value);
      el.value = '';
    };
    document.getElementById('stuMsg').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { sendMessage(st.nickname, this.value); this.value = ''; }
    });
    panel.querySelectorAll('button[data-quick]').forEach(function (b) {
      b.onclick = function () { sendMessage(st.nickname, QUICK[Number(b.getAttribute('data-quick'))]); };
    });
  }

  function sendMessage(nickname, text) {
    var t = String(text || '').trim();
    if (!t) return;
    fetch('/api/live/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID, nickname: nickname, text: t }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '실패');
      poll();
    }).catch(function (e) { alert('메시지 보내기 실패: ' + e.message); });
  }

  // ---- 문항별 응답 분포(이름은 교사에게만) ----
  function renderDist() {
    var q = (state.questions || []).filter(function (x) { return x.num === pickedQ; })[0];
    if (!q) return;
    var box = document.getElementById('distCard');
    box.style.display = 'block';
    document.getElementById('distTitle').textContent = pickedQ + '번 응답 분포 (' +
      (q.type === 'choice' ? '선다형' : q.type === 'essay' ? '서술형' : '단답형') + ')';

    // 선긋기는 답이 "0:0,1:1" 이라 그대로 나열하면 못 읽는다 → 완전 정답 / 부분 / 오답으로 묶는다
    if (q.type === 'match') {
      var full = [], part = [], none = [];
      (state.students || []).forEach(function (st) {
        var v = String((st.answers || {})['q' + pickedQ] || '').trim();
        if (!v) return;
        if (window.answerMatch.isCorrect(v, q.answer)) full.push(st.nickname);
        else if (window.answerMatch.partialCount(v, q.answer) > 0) part.push(st.nickname);
        else none.push(st.nickname);
      });
      var bar = function (label, list, color) {
        var tot = full.length + part.length + none.length || 1;
        return '<div class="bar"><span class="mk">' + label + '</span>' +
          '<span class="track"><span class="fill" style="width:' + Math.round(list.length / tot * 100) + '%;background:' + color + '"></span></span>' +
          '<span class="n">' + list.length + '명<span class="who"> ' + esc(list.join(', ')) + '</span></span></div>';
      };
      document.getElementById('dist').innerHTML =
        bar('완전', full, '#68d391') + bar('부분', part, '#f6ad55') + bar('오답', none, '#fc8181');
      return;
    }

    var byAns = {};
    (state.students || []).forEach(function (st) {
      var v = String((st.answers || {})['q' + pickedQ] || '').trim();
      if (!v) return;
      (byAns[v] = byAns[v] || []).push(st.nickname);
    });
    var keys = Object.keys(byAns).sort();
    var max = keys.reduce(function (m, k) { return Math.max(m, byAns[k].length); }, 0) || 1;
    var total = (state.students || []).length || 1;

    document.getElementById('dist').innerHTML = keys.length
      ? keys.map(function (k) {
          var n = byAns[k].length;
          var right = q.answer != null && String(q.answer).trim() !== '' && norm(k) === norm(q.answer);
          return '<div class="bar"><span class="mk">' + esc(k) + (right ? ' ✅' : '') + '</span>' +
            '<span class="track"><span class="fill" style="width:' + Math.round(n / max * 100) + '%"></span></span>' +
            '<span class="n">' + n + '명 (' + Math.round(n / total * 100) + '%)<span class="who"> ' + esc(byAns[k].join(', ')) + '</span></span></div>';
        }).join('')
      : '<div class="muted">아직 답한 학생이 없어요.</div>';
  }
  // 채점과 같은 관대한 비교(①→1)
  function norm(v) {
    var circled = { '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10' };
    return String(v == null ? '' : v).replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, function (m) { return circled[m]; })
      .toLowerCase().replace(/[\\s().,·]/g, '');
  }

  document.getElementById('noticeSend').onclick = function () {
    var el = document.getElementById('noticeText');
    var text = (el.value || '').trim();
    if (!text) return;
    fetch('/api/live/notice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID, text: text }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '실패');
      el.value = '';
      poll();
    }).catch(function (e) { alert('공지 보내기 실패: ' + e.message); });
  };

  document.getElementById('closeBtn').onclick = function () {
    if (!confirm('지금 마감할까요?\\n미제출 학생의 답은 화면에 있던 그대로 자동 제출됩니다.')) return;
    fetch('/api/live/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '실패');
      poll();
    }).catch(function (e) { alert('마감 실패: ' + e.message); });
  };

  poll();
  setInterval(poll, 3000);   // 3초 폴링이면 교실에서 충분하다(WebSocket 불필요)
})();
</script>
</body>
</html>`;
}

function renderStudentSinglePage(activity, questions) {
  const title = escapeHtml(activity.title || '활동');
  const activityId = activity.id;
  const version = Number(activity.version) || 1;
  const qData = (questions || []).map((q) => ({
    num: q.num, type: q.type || 'short',
    slice_image: q.slice_image || null, group_label: q.group_label || null,
    // 변환된 HTML 이 있으면 이걸로 렌더(확대해도 안 깨짐). 없으면 조각 이미지로 폴백.
    html_content: q.html_content ? sanitizeHtml(q.html_content) : null,
    meta: q.meta || {},          // 선긋기·기호 채우기·번호 버튼처럼 구조가 필요한 유형
  }));

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · ${APP_NAME}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: #1a1a1a; }
  .top { background: #fff; border-bottom: 1px solid #e2e8f0; padding: 12px 14px; position: sticky; top: 0; z-index: 20; }
  .top .brand { font-size: 12px; color: #718096; }
  .top h1 { font-size: 17px; margin: 2px 0 8px; }
  .top input.nick { width: 100%; padding: 9px; font-size: 15px; border: 1px solid #cbd5e1; border-radius: 8px; margin-bottom: 8px; }
  .prog { height: 8px; background: #edf2f7; border-radius: 999px; overflow: hidden; margin-bottom: 8px; }
  .prog > div { height: 100%; background: #48bb78; width: 0; transition: width .2s; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { width: 34px; height: 34px; border-radius: 8px; border: 2px solid transparent; font-weight: 800; font-size: 13px; cursor: pointer; background: #e2e8f0; color: #4a5568; }
  .chip.answered { background: #c6f6d5; color: #22543d; }
  .chip.later { background: #fefcbf; color: #975a16; }
  .chip.wrong { background: #fed7d7; color: #c53030; }
  .chip.cur { border-color: #2b6cb0; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 14px; }
  .slide { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
  .slide .grouptag { display: inline-block; font-size: 12px; background: #ebf8ff; color: #2b6cb0; font-weight: 700; padding: 2px 10px; border-radius: 999px; margin-bottom: 8px; }
  .slide img { width: 100%; height: auto; border: 1px solid #e2e8f0; border-radius: 8px; }
  .slide .noimg { padding: 30px; text-align: center; color: #a0aec0; }
  /* HTML 로 변환된 문항 */
  .fontbar { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #718096; margin-bottom: 10px; }
  .fontbar button { padding: 4px 10px; font-size: 12px; font-weight: 700; border: 1px solid #cbd5e1; background: #fff; color: #4a5568; border-radius: 6px; cursor: pointer; }
  .fontbar button.on { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
  .qhtml { line-height: 1.6; }
  .qhtml .stem { font-weight: 700; margin: 0 0 10px; }
  .qhtml .passage { border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px; background: #f7fafc; margin: 10px 0; position: sticky; top: 0; max-height: 45vh; overflow-y: auto; }
  .qhtml .passage.folded { display: none; }
  .psg-toggle { display: inline-block; margin: 2px 0 0; padding: 4px 10px; font-size: 12px; font-weight: 700; color: #4a5568; background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; cursor: pointer; }
  .qhtml .subq { border-top: 1px dashed #e2e8f0; margin-top: 14px; padding-top: 10px; }
  .qhtml .subnum { font-weight: 800; color: #2b6cb0; margin-bottom: 6px; }
  .qhtml ol.choices { list-style: none; padding: 0; margin: 10px 0 0; }
  .qhtml ol.choices li { padding: 7px 10px; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 6px; background: #fff; }
  .qhtml .cmark { font-weight: 800; color: #2b6cb0; margin-right: 6px; }
  /* 선지 클릭 = 답 선택. 폰에서 눌리는 크기(44px 이상)와 즉각적인 시각 피드백. */
  .qhtml ol.choices li.pick { min-height: 44px; display: flex; align-items: center; cursor: pointer; user-select: none; transition: background .12s, border-color .12s; }
  .qhtml ol.choices li.pick:active { background: #ebf8ff; }
  .qhtml ol.choices li.pick.on { border-color: #2b6cb0; border-width: 2px; background: #ebf8ff; font-weight: 700; }
  .qhtml img { width: auto; max-width: 100%; margin: 8px 0; }
  .answers { margin-top: 12px; }
  .arow { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .arow label { flex: 0 0 46px; font-weight: 800; }
  .arow input { flex: 1; padding: 11px 12px; font-size: 16px; border: 1px solid #cbd5e1; border-radius: 8px; }
  /* 객관식: 입력칸 대신 선택 상태만 보여준다 */
  .picked { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-weight: 700; color: #2b6cb0; min-height: 32px; }
  .picked .none { color: #a0aec0; font-weight: 400; }
  .picked .mk { font-size: 20px; }
  .picked button { margin-left: auto; padding: 6px 10px; font-size: 13px; font-weight: 700; border: 1px solid #cbd5e1; background: #fff; border-radius: 8px; cursor: pointer; }
  /* 순서 배열형: 몇 번째로 골랐는지 선지에 붙여 보여준다 */
  .qhtml ol.choices li .ordno { margin-left: auto; font-size: 12px; font-weight: 800; color: #fff; background: #2b6cb0; border-radius: 999px; padding: 2px 8px; }
  /* O/X 판정형: 큰 버튼 두 개 */
  .oxbtns { display: flex; gap: 10px; margin-left: auto; }
  .oxb { min-width: 64px; min-height: 48px; font-size: 22px; font-weight: 800; border: 2px solid #cbd5e1; background: #fff; border-radius: 12px; cursor: pointer; margin: 0 !important; }
  .oxb.on { border-color: #2b6cb0; background: #ebf8ff; color: #2b6cb0; }
  /* 선긋기(match) — 화면에서 실제로 선을 그어 답한다 */
  .matchwrap { position: relative; margin-top: 8px; }
  .matchwrap svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }
  .mcols { display: flex; gap: 44px; justify-content: space-between; touch-action: none; }
  .mcol { flex: 1; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .mcard { position: relative; display: flex; align-items: center; min-height: 52px; padding: 10px 12px;
    border: 2px solid #cbd5e1; border-radius: 10px; background: #fff; font-weight: 700; cursor: pointer;
    user-select: none; word-break: break-word; z-index: 2; }
  .mcard.sel { border-color: #2b6cb0; background: #ebf8ff; }
  .mcard .dot { position: absolute; width: 20px; height: 20px; border-radius: 50%; background: #fff;
    border: 3px solid #718096; top: 50%; transform: translateY(-50%); }
  .mcol.left .mcard .dot { right: -12px; }
  .mcol.right .mcard .dot { left: -12px; }
  .mcard.linked .dot { background: #2b6cb0; border-color: #2b6cb0; }
  .mhint { font-size: 12px; color: #718096; margin-top: 8px; }
  /* 번호 버튼(marker_only) */
  .mkbtns { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }
  .mkb { min-width: 48px; min-height: 48px; font-size: 20px; font-weight: 800; border: 2px solid #cbd5e1;
    background: #fff; border-radius: 12px; cursor: pointer; margin: 0 !important; }
  .mkb.on { border-color: #2b6cb0; background: #ebf8ff; color: #2b6cb0; }
  /* 기호 채우기(fill_symbol) */
  .fillexpr { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; font-size: 22px; font-weight: 800;
    padding: 12px; border: 1px solid #cbd5e1; border-radius: 10px; background: #fff; touch-action: none; }
  .fillexpr .slot { min-width: 46px; min-height: 46px; font-size: 20px; font-weight: 800; border: 2px dashed #a0aec0;
    background: #f7fafc; color: #4a5568; border-radius: 10px; cursor: pointer; margin: 0 4px; }
  .fillexpr .slot.filled { border-style: solid; border-color: #2b6cb0; background: #ebf8ff; color: #2b6cb0; }
  .sympop { position: absolute; z-index: 60; display: flex; gap: 6px; padding: 8px; background: #fff;
    border: 1px solid #cbd5e1; border-radius: 10px; box-shadow: 0 6px 18px rgba(0,0,0,.14); }
  .sympop button { min-width: 44px; min-height: 44px; font-size: 18px; font-weight: 800; border: 1px solid #cbd5e1;
    background: #fff; border-radius: 8px; cursor: pointer; }
  .arow.essay { align-items: flex-start; }
  .arow textarea { flex: 1; padding: 11px 12px; font-size: 16px; border: 1px solid #cbd5e1; border-radius: 8px; font-family: inherit; resize: vertical; }
  .counter { font-size: 13px; color: #4a5568; font-weight: 700; margin-top: 6px; }
  .autonext { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #4a5568; margin-top: 6px; }
  .autonext button { padding: 4px 10px; font-size: 12px; font-weight: 700; border: 1px solid #cbd5e1; background: #fff; color: #4a5568; border-radius: 999px; cursor: pointer; }
  .autonext button.on { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
  .qhtml .opts p { margin: 4px 0; }
  /* 연습장(스케치패드) — 답이 아니라 학생이 끄적이는 자리. 서버로 보내지 않는다. */
  .padbar { margin-top: 12px; }
  .padbtn { padding: 9px 14px; font-size: 14px; font-weight: 800; border: 1px solid #cbd5e1; background: #fff; border-radius: 10px; cursor: pointer; min-height: 44px; }
  .padbtn.on { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
  .pad { margin-top: 8px; border: 1px solid #cbd5e1; border-radius: 10px; background: #fff; overflow: hidden; }
  .padtools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid #e2e8f0; background: #f7fafc; }
  .padtools button { min-width: 44px; min-height: 44px; padding: 6px 10px; font-size: 13px; font-weight: 700; border: 1px solid #cbd5e1; background: #fff; border-radius: 8px; cursor: pointer; }
  .padtools button.on { outline: 3px solid #bee3f8; border-color: #2b6cb0; }
  .padtools .dot { width: 18px; height: 18px; border-radius: 50%; display: inline-block; }
  .padtools .sp { flex: 1; }
  /* touch-action:none — 폰에서 그리는 동안 화면이 딸려 스크롤되면 연습장을 쓸 수 없다 */
  .pad canvas { display: block; width: 100%; touch-action: none; background: #fff; cursor: crosshair; }
  .donehint { margin-top: 10px; padding: 10px 12px; background: #f0fff4; border: 1px solid #9ae6b4; border-radius: 8px; font-weight: 700; color: #22543d; }
  .donehint button { margin-left: 8px; padding: 8px 14px; font-size: 14px; font-weight: 800; border: 0; border-radius: 8px; background: #2f855a; color: #fff; cursor: pointer; }
  .misslist { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin: 0 0 16px; }
  .misslist button { width: auto; min-width: 40px; padding: 8px 10px; margin: 0; font-weight: 800; background: #fed7d7; border-color: #feb2b2; color: #c53030; }
  .nav { display: flex; gap: 8px; margin-top: 14px; }
  .nav button { flex: 1; padding: 13px; font-size: 15px; font-weight: 800; border: 1px solid #cbd5e1; background: #fff; border-radius: 10px; cursor: pointer; }
  .nav button.later.on { background: #fefcbf; border-color: #ecc94b; color: #975a16; }
  .nav button.next { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
  .overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 50; align-items: center; justify-content: center; padding: 20px; }
  .overlay.show { display: flex; }
  /* 문항이 많으면 안 푼 번호 목록이 길어진다 — 시트 안에서 스크롤되게(버튼이 화면 밖으로 밀리면 못 누른다) */
  .sheet { background: #fff; border-radius: 16px; padding: 24px; max-width: 380px; width: 100%; text-align: center; max-height: 85vh; overflow-y: auto; }
  .sheet h2 { margin: 0 0 8px; font-size: 20px; }
  .sheet p { color: #4a5568; margin: 0 0 18px; }
  .sheet button { width: 100%; padding: 13px; font-size: 15px; font-weight: 800; border-radius: 10px; margin-top: 8px; cursor: pointer; border: 1px solid #cbd5e1; background: #fff; }
  .sheet button.primary { background: #2f855a; color: #fff; border-color: #2f855a; }
  #updateBanner { display: none; background: #fefcbf; color: #744210; border: 1px solid #ecc94b; border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-weight: 700; font-size: 14px; }
  #updateBanner button { margin-left: 8px; padding: 4px 10px; border: 0; border-radius: 6px; background: #d69e2e; color: #fff; font-weight: 700; cursor: pointer; }
  /* 선생님 공지 — 새 공지가 오면 부드럽게 강조(진동·소리 없음: 수업 중이다) */
  /* 전체 공지 — 노란 계열 */
  #noticeBanner { display: none; background: #fffaf0; color: #744210; border: 1px solid #f6ad55; border-radius: 8px; padding: 10px 12px; margin: 8px 0; font-weight: 700; font-size: 14px; transition: background .6s ease; }
  #noticeBanner.fresh { background: #feebc8; }
  /* 나에게만 온 메시지 — 파란 계열 + "선생님이 나에게" 라벨(전체 공지와 한눈에 구분) */
  #dmBanner { display: none; background: #ebf8ff; color: #2a4365; border: 2px solid #2b6cb0; border-radius: 8px; padding: 10px 12px; margin: 8px 0; font-size: 14px; transition: background .6s ease; }
  #dmBanner.fresh { background: #bee3f8; }
  #dmBanner .dmlab { display: inline-block; font-size: 11px; font-weight: 800; color: #fff; background: #2b6cb0; border-radius: 999px; padding: 2px 8px; margin-bottom: 4px; }
  #dmBanner .dmtext { font-weight: 800; }
  #dmBanner .dmact { margin-top: 8px; display: flex; gap: 6px; }
  #dmBanner button { padding: 8px 14px; font-size: 13px; font-weight: 800; border: 0; border-radius: 8px; background: #2b6cb0; color: #fff; cursor: pointer; min-height: 40px; }
  /* 문항 이동 요청 — 초록 계열. 학생이 [가기] 를 눌러야 이동한다(강제 이동 없음) */
  #gotoBanner { display: none; background: #f0fff4; color: #22543d; border: 2px solid #38a169; border-radius: 8px; padding: 10px 12px; margin: 8px 0; font-size: 14px; }
  #gotoBanner .gtext { font-weight: 800; }
  #gotoBanner .gact { margin-top: 8px; display: flex; gap: 6px; }
  #gotoBanner button { padding: 8px 14px; font-size: 13px; font-weight: 800; border: 0; border-radius: 8px; cursor: pointer; min-height: 40px; }
  #gotoBanner .go { background: #2f855a; color: #fff; }
  #gotoBanner .later { background: #fff; color: #4a5568; border: 1px solid #cbd5e1; }
  #closedOverlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 60; align-items: center; justify-content: center; padding: 20px; }
  #closedOverlay.show { display: flex; }
</style>
</head>
<body>
  <div class="top">
    <div class="brand">${APP_NAME}</div>
    <h1>${title}</h1>
    <input class="nick" id="nick" type="text" placeholder="닉네임(이름)을 입력하세요" autocomplete="off" />
    <div id="updateBanner">🔔 선생님이 문제를 수정했어요. <button id="reloadBtn">새로고침</button></div>
    <div id="noticeBanner"></div>
    <div id="dmBanner"></div>
    <div id="gotoBanner"></div>
    <div class="prog"><div id="progFill"></div></div>
    <div class="chips" id="chips"></div>
    <div class="counter" id="counter"></div>
    <div class="autonext">답을 고르면 다음 문제로
      <button id="autoNextBtn" type="button">자동 넘김 켬</button>
    </div>
  </div>
  <div class="wrap">
    <div class="slide" id="slide"></div>
    <div class="nav">
      <button id="prevBtn">← 이전</button>
      <button class="later" id="laterBtn">🔖 나중에 다시</button>
      <button class="next" id="nextBtn">다음 →</button>
    </div>
  </div>

  <div class="overlay" id="finishOverlay"><div class="sheet" id="finishSheet"></div></div>
  <div class="overlay" id="resultOverlay"><div class="sheet" id="resultSheet"></div></div>
  <div id="closedOverlay"><div class="sheet">
    <h2>제출이 마감됐어요 🔒</h2>
    <p>선생님이 마감했어요. 여기까지 푼 답은 자동으로 제출됐습니다.</p>
  </div></div>

<script>
(function () {
  var ACTIVITY_ID = ${JSON.stringify(activityId)};
  var MY_VERSION = ${version};
  var QUESTIONS = ${JSON.stringify(qData)};
  var slides = buildSlides(QUESTIONS);
  var answers = {}, later = {}, wrong = {};
  var cur = 0, submitted = false, restrictWrong = false;

  function parseRange(s) {
    s = String(s || '');
    var m = s.match(/(\\d+)\\s*[~\\-]\\s*(\\d+)/);
    if (m) { var a = +m[1], b = +m[2], out = []; for (var i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i); return out; }
    return s.split(/[,\\s]+/).map(Number).filter(function (n) { return n > 0; });
  }
  function buildSlides(qs) {
    var covered = {}, out = [];
    qs.forEach(function (q) {
      if (covered[q.num]) return;
      if (q.slice_image || q.html_content) {
        var nums = q.group_label ? parseRange(q.group_label) : [q.num];
        if (!nums.length) nums = [q.num];
        // 실제 존재하는 문항 번호만
        nums = nums.filter(function (n) { return qs.some(function (x) { return x.num === n; }); });
        if (!nums.length) nums = [q.num];
        nums.forEach(function (n) { covered[n] = true; });
        out.push({ image: q.slice_image || null, html: q.html_content || null, nums: nums, group: q.group_label || null });
      } else {
        covered[q.num] = true;
        out.push({ image: null, html: null, nums: [q.num], group: null });
      }
    });
    return out;
  }

  // 글자 크기(HTML 문항일 때만 의미 있음) — 이미지와 달리 확대해도 안 깨지는 게 HTML 화의 핵심 이점
  var FONT_STEPS = { small: 15, normal: 18, large: 23 };
  var fontSize = 'normal';
  try { fontSize = localStorage.getItem('qFont') || 'normal'; } catch (e) { }
  if (!FONT_STEPS[fontSize]) fontSize = 'normal';
  function setFont(k) {
    fontSize = k;
    try { localStorage.setItem('qFont', k); } catch (e) { }
    render();
  }

  function allNums() { return QUESTIONS.map(function (q) { return q.num; }); }
  function hasAnswer(num) { return String(answers['q' + num] || '').trim() !== ''; }
  function slideOfQuestion(num) { for (var i = 0; i < slides.length; i++) { if (slides[i].nums.indexOf(num) >= 0) return i; } return 0; }
  function navigable() {
    if (!restrictWrong) return slides.map(function (_, i) { return i; });
    return slides.map(function (_, i) { return i; }).filter(function (i) { return slides[i].nums.some(function (n) { return wrong[n]; }); });
  }

  // ---- 자동 넘김(학생이 끌 수 있다 — 검토하며 푸는 학생을 막지 않는다) ----
  var autoNext = true, nextTimer = null;
  try { autoNext = localStorage.getItem('autoNext') !== 'off'; } catch (e) { }
  function syncAutoNextBtn() {
    var b = document.getElementById('autoNextBtn');
    b.textContent = autoNext ? '자동 넘김 켬' : '자동 넘김 끔';
    b.classList.toggle('on', autoNext);
  }
  document.getElementById('autoNextBtn').onclick = function () {
    autoNext = !autoNext;
    try { localStorage.setItem('autoNext', autoNext ? 'on' : 'off'); } catch (e) { }
    if (!autoNext && nextTimer) { clearTimeout(nextTimer); nextTimer = null; }
    syncAutoNextBtn();
  };

  // 진행바·번호바·카운터만 갱신(슬라이드는 건드리지 않는다 — 입력 중 재렌더하면 포커스가 날아간다)
  function renderChrome() {
    var total = allNums().length;
    var done = allNums().filter(hasAnswer).length;
    document.getElementById('progFill').style.width = total ? Math.round(done / total * 100) + '%' : '0';
    document.getElementById('counter').textContent = done + '/' + total + ' 답함';
    var chips = document.getElementById('chips'); chips.innerHTML = '';
    var curNums = slides[cur] ? slides[cur].nums : [];
    QUESTIONS.forEach(function (q) {
      var b = document.createElement('button'); b.className = 'chip'; b.textContent = q.num;
      if (submitted && wrong[q.num]) b.classList.add('wrong');
      else if (later[q.num]) b.classList.add('later');
      else if (hasAnswer(q.num)) b.classList.add('answered');
      if (curNums.indexOf(q.num) >= 0) b.classList.add('cur');
      b.onclick = function () { goQuestion(q.num); };
      chips.appendChild(b);
    });
    syncAutoNextBtn();
  }

  // ---- 선지 클릭 = 답 선택 ----
  // 선지 <li data-marker="③"> 를 눌러 답한다. 저장값은 마커 그대로('③') — 교사 정답표·통계와 같은 표기다.
  // (채점은 grade.js 가 ①→1 로 정규화하므로 정답표가 '3' 이어도 맞는다)
  function choiceEls(el, n, s) {
    var scope = el.querySelector('.qhtml [data-num="' + n + '"]');
    if (!scope && s.nums.length === 1) scope = el.querySelector('.qhtml');   // 단일 문항(예전 저장분엔 data-num 이 없다)
    if (!scope) return [];
    return Array.prototype.slice.call(scope.querySelectorAll('li[data-marker]'));
  }
  function isChoice(el, n, s) { return choiceEls(el, n, s).length > 0; }

  // 문항 유형 — 선지를 어떻게 고르는지가 유형마다 다르다
  function typeOfNum(n) {
    var q = QUESTIONS.filter(function (x) { return x.num === n; })[0];
    return (q && q.type) || 'short';
  }
  function picked(n) {
    var v = String(answers['q' + n] || '').trim();
    return v ? v.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : [];
  }
  function setPicked(n, list) {
    if (list.length) answers['q' + n] = list.join(',');
    else delete answers['q' + n];
  }

  function pickChoice(n, mk, el, s) {
    var t = typeOfNum(n), cur = picked(n), was = cur.indexOf(mk) >= 0, done = false;
    if (t === 'multi_choice') {
      // 복수 선택: 누를 때마다 켜고 끈다. 저장은 "㉠,㉢"(순서 무시 채점)
      setPicked(n, was ? cur.filter(function (x) { return x !== mk; }) : cur.concat([mk]));
    } else if (t === 'order') {
      // 순서 배열: 누른 순서대로 쌓인다. 다시 누르면 취소. 저장은 "㉢,㉠,㉡"(순서가 답)
      setPicked(n, was ? cur.filter(function (x) { return x !== mk; }) : cur.concat([mk]));
    } else {
      setPicked(n, was ? [] : [mk]);        // 단일 선택: 같은 선지 재클릭 = 해제
      done = !was;
    }
    paintChoices(el, n, s);
    renderChrome();
    renderAnswers(el, s);
    heartbeat();                            // 답이 바뀌면 바로 알린다(대시보드가 3초 안에 본다)
    if (done && autoNext) scheduleNext(el, s);
  }
  // 선택 상태를 선지에 칠한다(순서 배열은 몇 번째로 골랐는지도 보여준다)
  function paintChoices(el, n, s) {
    var t = typeOfNum(n), cur = picked(n);
    choiceEls(el, n, s).forEach(function (li) {
      var mk = li.getAttribute('data-marker');
      var at = cur.indexOf(mk);
      li.classList.toggle('on', at >= 0);
      var badge = li.querySelector('.ordno');
      if (t === 'order' && at >= 0) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'ordno'; li.appendChild(badge); }
        badge.textContent = (at + 1) + '번째';
      } else if (badge) { badge.remove(); }
    });
  }
  function bindChoices(el, s) {
    s.nums.forEach(function (n) {
      choiceEls(el, n, s).forEach(function (li) {
        li.classList.add('pick');
        li.addEventListener('click', function () { pickChoice(n, li.getAttribute('data-marker'), el, s); });
      });
      paintChoices(el, n, s);
    });
  }
  // 이 슬라이드의 객관식을 다 풀었을 때만 넘어간다(묶음 8·9 는 둘 다 답해야 다음으로)
  function scheduleNext(el, s) {
    if (s.nums.some(function (n) { return isChoice(el, n, s) && !hasAnswer(n); })) return;
    var nav = navigable(), pos = nav.indexOf(cur);
    if (nextTimer) clearTimeout(nextTimer);
    if (pos < 0 || pos === nav.length - 1) {          // 마지막 문항 → 넘기지 않고 마무리를 권한다
      var box = el.querySelector('#doneHint');
      if (box) {
        box.innerHTML = '<div class="donehint">다 풀었어요! <button id="hintSubmit" type="button">제출하기</button></div>';
        document.getElementById('hintSubmit').onclick = function () { finish(); };
      }
      return;
    }
    nextTimer = setTimeout(function () { nextTimer = null; step(1); }, 400);
  }

  // 답 입력 영역 — 객관식은 입력칸 대신 '선택: ③' 상태만, 단답·서술형은 기존 입력칸 유지
  function renderAnswers(el, s) {
    var box = el.querySelector('#answers');
    if (!box) return;
    var html = '';
    s.nums.forEach(function (n) {
      var t = typeOfNum(n), cur = picked(n);
      if (t === 'match') {
        // 선긋기 — 답 영역 자체가 인터랙티브하다(본문이 이미지여도 여기서 답한다)
        html += '<div class="picked" data-num="' + n + '"><span>' + n + '번</span>' +
          '<span class="none" id="mstat' + n + '">왼쪽에서 오른쪽으로 이어 보세요</span></div>' +
          '<div class="matchwrap" data-match="' + n + '"></div>';
      } else if (t === 'marker_only') {
        // 선지 텍스트가 원래 없는 문항(식 위 ↑ 와 ①~⑤ 만) → 본문 이미지 + 번호 버튼
        var cnt = Number(metaOf(n).count) || 5;
        var btns = '';
        for (var mi = 0; mi < cnt; mi++) {
          var mkc = MARKERS[mi];
          btns += '<button type="button" class="mkb' + (cur[0] === mkc ? ' on' : '') + '" data-mk="' + n + '" data-v="' + mkc + '">' + mkc + '</button>';
        }
        html += '<div class="picked" data-num="' + n + '"><span>' + n + '번</span>' +
          '<span class="mkbtns">' + btns + '</span></div>';
      } else if (t === 'fill_symbol') {
        html += '<div class="picked" data-num="' + n + '"><span>' + n + '번</span>' +
          '<span class="none" id="fstat' + n + '">○ 를 눌러 기호를 넣으세요</span></div>' +
          '<div class="fillwrap" data-fill="' + n + '"></div>';
      } else if (t === 'short_sub') {
        // 소문항 (1)(2) — 자리마다 입력칸. 저장은 자리 순서대로 "3,5"
        var subs = metaOf(n).subs || ['(1)', '(2)'];
        html += subs.map(function (lab, i) {
          return '<div class="arow"><label>' + n + '번 ' + escapeHtml(lab) + '</label>' +
            '<input type="text" data-sub="' + n + '" data-i="' + i + '" value="' + escapeHtml(cur[i] || '') +
            '" placeholder="답 입력" autocomplete="off" /></div>';
        }).join('');
      } else if (t === 'ox') {
        // O/X 판정형 — 큰 버튼 두 개
        html += '<div class="picked" data-num="' + n + '"><span>' + n + '번</span>' +
          '<span class="oxbtns">' +
          '<button type="button" class="oxb' + (cur[0] === 'O' ? ' on' : '') + '" data-ox="' + n + '" data-v="O">○</button>' +
          '<button type="button" class="oxb' + (cur[0] === 'X' ? ' on' : '') + '" data-ox="' + n + '" data-v="X">✕</button>' +
          '</span></div>';
      } else if (t === 'essay') {
        html += '<div class="arow essay"><label>' + n + '번</label>' +
          '<textarea data-num="' + n + '" rows="4" placeholder="생각을 자유롭게 쓰세요">' + escapeHtml(answers['q' + n] || '') + '</textarea></div>';
      } else if (isChoice(el, n, s)) {
        var label = t === 'order' ? '순서: ' : t === 'multi_choice' ? '선택: ' : '선택: ';
        var shown = t === 'order' ? cur.join(' → ') : cur.join(', ');
        var hint = t === 'order' ? '순서대로 눌러 주세요(다시 누르면 취소)'
          : t === 'multi_choice' ? '해당하는 것을 모두 눌러 주세요'
            : '선지를 눌러 답하세요';
        html += '<div class="picked" data-num="' + n + '"><span>' + n + '번</span>' +
          (cur.length
            ? '<span class="mk">' + label + escapeHtml(shown) + '</span><button type="button" data-clear="' + n + '">선택 지우기</button>'
            : '<span class="none">' + hint + '</span>') + '</div>';
      } else {
        var ph = t === 'multi_short' ? '답을 모두 쓰세요 (예: 1, 2, 4, 8)' : '답 입력';
        html += '<div class="arow"><label>' + n + '번</label>' +
          '<input type="text" data-num="' + n + '" value="' + escapeHtml(answers['q' + n] || '') + '" placeholder="' + ph + '" autocomplete="off" /></div>';
      }
    });
    box.innerHTML = html;
    // 소문항: 자리 순서대로 모아 하나의 답으로 저장한다("3,5")
    box.querySelectorAll('input[data-sub]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var n = Number(inp.getAttribute('data-sub'));
        var vals = [];
        box.querySelectorAll('input[data-sub="' + n + '"]').forEach(function (x) { vals.push((x.value || '').trim()); });
        while (vals.length && !vals[vals.length - 1]) vals.pop();
        setPicked(n, vals);
        renderChrome();
        clearTimeout(inp.__hb);
        inp.__hb = setTimeout(heartbeat, 600);
      });
    });
    box.querySelectorAll('.fillwrap[data-fill]').forEach(function (w) {
      mountFill(w, Number(w.getAttribute('data-fill')), el, s);
    });
    box.querySelectorAll('button[data-mk]').forEach(function (b) {
      b.onclick = function () {
        var n = Number(b.getAttribute('data-mk')), v = b.getAttribute('data-v');
        var was = picked(n)[0] === v;
        setPicked(n, was ? [] : [v]);          // 같은 번호 재클릭 = 해제
        renderChrome(); renderAnswers(el, s); heartbeat();
        if (!was && autoNext) scheduleNext(el, s);
      };
    });
    box.querySelectorAll('input[data-num], textarea[data-num]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        answers['q' + inp.getAttribute('data-num')] = inp.value;
        renderChrome();      // 슬라이드는 다시 그리지 않는다(포커스 유지)
        clearTimeout(inp.__hb);
        inp.__hb = setTimeout(heartbeat, 600);   // 타이핑이 멈추면 알린다
      });
    });
    box.querySelectorAll('.matchwrap[data-match]').forEach(function (w) {
      mountMatch(w, Number(w.getAttribute('data-match')), el, s);
    });
    box.querySelectorAll('button[data-ox]').forEach(function (b) {
      b.onclick = function () {
        var n = Number(b.getAttribute('data-ox')), v = b.getAttribute('data-v');
        var was = picked(n)[0] === v;
        setPicked(n, was ? [] : [v]);          // 같은 버튼 재클릭 = 해제
        renderChrome(); renderAnswers(el, s); heartbeat();
        if (!was && autoNext) scheduleNext(el, s);
      };
    });
    box.querySelectorAll('button[data-clear]').forEach(function (b) {
      b.onclick = function () {
        var n = Number(b.getAttribute('data-clear'));
        delete answers['q' + n];
        paintChoices(el, n, s);
        renderChrome(); renderAnswers(el, s); heartbeat();
      };
    });
  }

  // ================= 선긋기(match) =================
  // 답 = 쌍 목록 "0:0,1:1,2:2" (왼쪽index:오른쪽index). 순서는 무시하고 채점한다.
  // 조작은 두 가지를 다 지원한다 — 드래그(●에서 끌어다 놓기)와 탭탭(왼쪽 탭 → 오른쪽 탭).
  // 저학년은 폰에서 드래그가 서툴러 탭탭이 사실상 주 경로다.
  var MATCH_COLORS = ['#e53e3e', '#3182ce', '#38a169', '#d69e2e', '#805ad5', '#dd6b20'];
  var MARKERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

  // ---- 발문 끝의 답란 표기 숨기기 ----
  // 탭으로 답하는 유형은 발문 끝의 "…… ( )" 가 뜻 없는 잔재다(종이에 손으로 쓰라는 표시).
  // 단답·서술형은 그대로 둔다 — 거기선 '빈칸에 쓰라'는 신호다.
  // 데이터(stem 원문)는 건드리지 않는다 — 화면에서만 숨긴다.
  var TAP_TYPES = ['choice', 'marker_only', 'multi_choice', 'ox', 'order', 'match', 'fill_symbol'];
  // …·⋯·‥ 는 한 글자가 이미 말줄임이다(…… 는 두 글자). 마침표·가운뎃점은 3개 이상일 때만 점선으로 본다.
  // ※ 이 스크립트는 서버의 템플릿 리터럴 안에 있다 — 정규식의 백슬래시는 반드시 \\ 로 써야 한다
  //   (\s 로 쓰면 템플릿이 백슬래시를 먹어 그냥 문자 s 가 된다).
  var TAIL_BLANK_RE = /(?:(?:[…⋯‥]+|[.·]{3,})\\s*)?[(（][\\s_ㆍ·．.]*[)）]\\s*$/;
  var TAIL_DOTS_RE = /(?:[…⋯‥]+|[.·]{3,})\\s*$/;
  function hideTailBlank(el, s) {
    s.nums.forEach(function (n) {
      if (TAP_TYPES.indexOf(typeOfNum(n)) < 0) return;
      var scope = el.querySelector('.qhtml [data-num="' + n + '"]');
      if (!scope && s.nums.length === 1) scope = el.querySelector('.qhtml');
      if (!scope) return;
      scope.querySelectorAll('.stem').forEach(function (p) {
        var h = p.innerHTML.replace(TAIL_BLANK_RE, '').replace(TAIL_DOTS_RE, '');
        if (h !== p.innerHTML) p.innerHTML = h;
      });
    });
  }
  function metaOf(n) {
    var q = QUESTIONS.filter(function (x) { return x.num === n; })[0];
    return (q && q.meta) || {};
  }
  function pairsOf(n) {
    return picked(n).map(function (p) {
      var a = p.split(':');
      return [Number(a[0]), Number(a[1])];
    }).filter(function (p) { return !isNaN(p[0]) && !isNaN(p[1]); });
  }
  function setPairs(n, pairs) {
    setPicked(n, pairs.map(function (p) { return p[0] + ':' + p[1]; }));
  }

  function mountMatch(wrap, n, el, s) {
    var meta = metaOf(n);
    var left = meta.left || [], right = meta.right || [];
    var once = meta.once !== false;          // 기본 1:1 — 새로 이으면 기존 선을 대체한다
    var selLeft = null;

    wrap.innerHTML = '<svg></svg><div class="mcols">' +
      '<div class="mcol left">' + left.map(function (t, i) {
        return '<div class="mcard" data-side="L" data-i="' + i + '"><span></span><span class="dot"></span></div>';
      }).join('') + '</div>' +
      '<div class="mcol right">' + right.map(function (t, i) {
        return '<div class="mcard" data-side="R" data-i="' + i + '"><span class="dot"></span><span></span></div>';
      }).join('') + '</div></div>' +
      '<div class="mhint">왼쪽을 누르고 오른쪽을 누르면 이어져요. 끌어서 이어도 돼요. 이은 선을 다시 누르면 지워져요.</div>';

    // 텍스트는 textContent 로 — 시험지 내용이 그대로 들어가므로 HTML 로 해석시키지 않는다
    wrap.querySelectorAll('.mcol.left .mcard').forEach(function (c, i) { c.querySelector('span').textContent = left[i]; });
    wrap.querySelectorAll('.mcol.right .mcard').forEach(function (c, i) { c.querySelectorAll('span')[1].textContent = right[i]; });

    var svg = wrap.querySelector('svg');
    var cardOf = function (side, i) { return wrap.querySelector('.mcard[data-side="' + side + '"][data-i="' + i + '"]'); };
    var dotXY = function (side, i) {
      var d = cardOf(side, i).querySelector('.dot');
      var r = d.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      return { x: r.left + r.width / 2 - w.left, y: r.top + r.height / 2 - w.top };
    };

    function draw(preview) {
      var pairs = pairsOf(n);
      var lines = pairs.map(function (p, k) {
        var a = dotXY('L', p[0]), b = dotXY('R', p[1]);
        return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
          '" stroke="' + MATCH_COLORS[k % MATCH_COLORS.length] + '" stroke-width="4" stroke-linecap="round" />';
      }).join('');
      if (preview) {
        lines += '<line x1="' + preview.a.x + '" y1="' + preview.a.y + '" x2="' + preview.b.x + '" y2="' + preview.b.y +
          '" stroke="#a0aec0" stroke-width="3" stroke-dasharray="6 5" stroke-linecap="round" />';
      }
      svg.innerHTML = lines;
      wrap.querySelectorAll('.mcard').forEach(function (c) {
        var side = c.getAttribute('data-side'), i = Number(c.getAttribute('data-i'));
        var linked = pairs.some(function (p) { return side === 'L' ? p[0] === i : p[1] === i; });
        c.classList.toggle('linked', linked);
        c.classList.toggle('sel', side === 'L' && selLeft === i);
      });
      var st = document.getElementById('mstat' + n);
      if (st) {
        var done = pairs.length && pairs.length === Math.min(left.length, right.length);
        st.className = pairs.length ? 'mk' : 'none';
        st.textContent = pairs.length
          ? (done ? '모두 이었어요 (' + pairs.length + '쌍)' : pairs.length + '쌍 이었어요')
          : '왼쪽에서 오른쪽으로 이어 보세요';
      }
    }

    function link(li, ri) {
      var pairs = pairsOf(n);
      var had = pairs.some(function (p) { return p[0] === li && p[1] === ri; });
      if (had) pairs = pairs.filter(function (p) { return !(p[0] === li && p[1] === ri); });   // 같은 선 재탭 = 해제
      else {
        if (once) pairs = pairs.filter(function (p) { return p[0] !== li && p[1] !== ri; });   // 1:1 → 기존 선 대체
        pairs.push([li, ri]);
      }
      setPairs(n, pairs);
      selLeft = null;
      draw();
      renderChrome();
      heartbeat();
    }

    // 탭탭: 왼쪽 → 오른쪽
    wrap.querySelectorAll('.mcard').forEach(function (c) {
      c.addEventListener('click', function () {
        var side = c.getAttribute('data-side'), i = Number(c.getAttribute('data-i'));
        if (side === 'L') { selLeft = (selLeft === i ? null : i); draw(); return; }
        if (selLeft == null) return;
        link(selLeft, i);
      });
    });

    // 드래그: 왼쪽 카드에서 끌어 오른쪽 카드에 놓기(그리는 동안 점선 미리보기)
    wrap.querySelectorAll('.mcol.left .mcard').forEach(function (c) {
      c.addEventListener('pointerdown', function (e) {
        var li = Number(c.getAttribute('data-i'));
        var moved = false;
        var a = dotXY('L', li);
        function mv(ev) {
          moved = true;
          var w = wrap.getBoundingClientRect();
          draw({ a: a, b: { x: ev.clientX - w.left, y: ev.clientY - w.top } });
        }
        function up(ev) {
          document.removeEventListener('pointermove', mv);
          document.removeEventListener('pointerup', up);
          if (!moved) { draw(); return; }                     // 그냥 탭이면 click 핸들러가 처리한다
          var t = document.elementFromPoint(ev.clientX, ev.clientY);
          var target = t && t.closest ? t.closest('.mcol.right .mcard') : null;
          if (target) link(li, Number(target.getAttribute('data-i')));
          else draw();
        }
        document.addEventListener('pointermove', mv);
        document.addEventListener('pointerup', up);
      });
    });

    draw();
    window.addEventListener('resize', function () { draw(); });
  }

  // ================= 기호 채우기(fill_symbol) =================
  // "○ 안에 ×, ÷ 를 한 번씩 써넣으시오" — 식의 ○ 자리를 눌러 기호를 넣는다.
  // 답은 '자리 순서대로' 기호 배열("×,÷") — 자리가 뜻이므로 순서를 따진다.
  function mountFill(wrap, n, el, s) {
    var meta = metaOf(n);
    var expr = String(meta.expr || '');
    var syms = meta.symbols || [];
    var once = meta.once !== false;              // "한 번씩" → 같은 기호를 두 곳에 못 쓴다

    var slots = [];
    var html = '';
    for (var i = 0; i < expr.length; i++) {
      var ch = expr[i];
      if (ch === '○' || ch === '□') {
        var k = slots.length;
        slots.push(k);
        html += '<button type="button" class="slot" data-slot="' + k + '"></button>';
      } else {
        html += '<span>' + escapeHtml(ch) + '</span>';
      }
    }
    wrap.innerHTML = '<div class="fillexpr">' + html + '</div>' +
      '<div class="mhint">○ 를 눌러 기호를 넣어요' + (once ? ' (같은 기호는 한 번만 쓸 수 있어요)' : '') + '</div>';

    function cur() {
      var v = picked(n);
      var out = [];
      for (var i = 0; i < slots.length; i++) out.push(v[i] || '');
      return out;
    }
    function paint() {
      var c = cur();
      wrap.querySelectorAll('.slot').forEach(function (b, i) {
        b.textContent = c[i] || '○';
        b.classList.toggle('filled', !!c[i]);
      });
      var st = document.getElementById('fstat' + n);
      if (st) {
        var filled = c.filter(Boolean);
        st.className = filled.length ? 'mk' : 'none';
        st.textContent = filled.length ? '넣은 기호: ' + filled.join(' , ') : '○ 를 눌러 기호를 넣으세요';
      }
    }
    function setSlot(i, val) {
      var c = cur();
      if (once && val) {
        for (var k = 0; k < c.length; k++) if (k !== i && c[k] === val) c[k] = '';   // 이미 쓴 기호는 자동 해제
      }
      c[i] = val;
      while (c.length && !c[c.length - 1]) c.pop();
      setPicked(n, c);
      paint();
      renderChrome();
      heartbeat();
    }

    wrap.querySelectorAll('.slot').forEach(function (b, i) {
      b.onclick = function () {
        var c = cur();
        // 후보가 2개면 탭할 때마다 순환(빈칸 → ① → ② → 빈칸), 3개 이상이면 팝오버로 고른다
        if (syms.length <= 2) {
          var at = syms.indexOf(c[i]);
          var next = at + 1 >= syms.length ? '' : syms[at + 1];
          setSlot(i, next);
          return;
        }
        showSymPop(b, syms, function (v) { setSlot(i, v); });
      };
    });
    paint();
  }
  function showSymPop(anchor, syms, pick) {
    var old = document.getElementById('symPop');
    if (old) old.remove();
    var p = document.createElement('div');
    p.id = 'symPop';
    p.className = 'sympop';
    p.innerHTML = syms.concat(['지우기']).map(function (sv) {
      return '<button type="button" data-v="' + escapeHtml(sv === '지우기' ? '' : sv) + '">' + escapeHtml(sv) + '</button>';
    }).join('');
    document.body.appendChild(p);
    var r = anchor.getBoundingClientRect();
    p.style.left = Math.min(r.left + window.scrollX, window.innerWidth - 160) + 'px';
    p.style.top = (r.bottom + window.scrollY + 6) + 'px';
    p.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () { pick(b.getAttribute('data-v')); p.remove(); };
    });
    setTimeout(function () {
      document.addEventListener('click', function once2(e) {
        if (!p.contains(e.target)) { p.remove(); document.removeEventListener('click', once2); }
      });
    }, 0);
  }

  // ================= 연습장(스케치패드) =================
  // 문항마다 따로 보관한다(3번에서 그린 게 4번에 나오면 안 된다). 메모리에만 두고 제출과 무관하다.
  // 화면을 다시 그릴 때마다 캔버스는 새로 만들어지므로, 그림은 dataURL 스냅샷으로 복원한다.
  var padInk = {};      // { 문항키: dataURL }        — 현재 그림
  var padUndo = {};     // { 문항키: [dataURL...] }   — 실행취소 스택(획 하나 = 한 단계)
  var padOpen = {};     // { 문항키: true }           — 펼침 상태
  var padBig = {};      // { 문항키: true }           — 480px 확장
  var padTool = { mode: 'pen', color: '#1a202c' };
  var PAD_UNDO_MAX = 20;

  function padKey(s) { return s.nums.join('_'); }
  // 추후 확장(제출·저장) 대비 — 지금은 아무도 부르지 않는다. 연습장은 서버로 보내지 않는다.
  function extractSketch(num) {
    var hit = Object.keys(padInk).filter(function (k) { return k.split('_').indexOf(String(num)) >= 0; })[0];
    return hit ? padInk[hit] : null;
  }

  function mountPad(el, s) {
    var key = padKey(s);
    var btn = el.querySelector('#padToggle');
    var host = el.querySelector('#padHost');
    btn.classList.toggle('on', !!padOpen[key]);
    btn.textContent = padOpen[key] ? '✏️ 연습장 접기' : '✏️ 연습장';
    btn.onclick = function () { padOpen[key] = !padOpen[key]; mountPad(el, s); };
    if (!padOpen[key]) { host.innerHTML = ''; return; }

    host.innerHTML =
      '<div class="pad"><div class="padtools">' +
      '<button data-pen="#1a202c" title="검정"><span class="dot" style="background:#1a202c"></span></button>' +
      '<button data-pen="#2b6cb0" title="파랑"><span class="dot" style="background:#2b6cb0"></span></button>' +
      '<button data-pen="#e53e3e" title="빨강"><span class="dot" style="background:#e53e3e"></span></button>' +
      '<button data-eraser="1">지우개</button>' +
      '<span class="sp"></span>' +
      '<button data-undo="1">↶ 실행취소</button>' +
      '<button data-clear="1">전체 지우기</button>' +
      '<button data-big="1">' + (padBig[key] ? '작게' : '더 크게') + '</button>' +
      '</div><canvas id="padCanvas"></canvas></div>';

    var cv = host.querySelector('#padCanvas');
    var h = padBig[key] ? 480 : 240;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(200, Math.round(cv.clientWidth || host.clientWidth));
    cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    if (padInk[key]) {                                   // 이전 그림 복원
      var img = new Image();
      img.onload = function () { ctx.drawImage(img, 0, 0, w, h); };
      img.src = padInk[key];
    }

    host.querySelectorAll('[data-pen]').forEach(function (b) {
      b.classList.toggle('on', padTool.mode === 'pen' && padTool.color === b.getAttribute('data-pen'));
      b.onclick = function () { padTool = { mode: 'pen', color: b.getAttribute('data-pen') }; mountPad(el, s); };
    });
    var er = host.querySelector('[data-eraser]');
    er.classList.toggle('on', padTool.mode === 'eraser');
    er.onclick = function () { padTool = { mode: 'eraser', color: padTool.color }; mountPad(el, s); };
    host.querySelector('[data-clear]').onclick = function () {
      pushPadUndo(key);
      ctx.clearRect(0, 0, w, h);
      padInk[key] = cv.toDataURL('image/png');
    };
    host.querySelector('[data-undo]').onclick = function () {
      var stack = padUndo[key] || [];
      if (!stack.length) return;
      padInk[key] = stack.pop();
      mountPad(el, s);
    };
    host.querySelector('[data-big]').onclick = function () { padBig[key] = !padBig[key]; mountPad(el, s); };

    // ---- 그리기(터치·마우스·펜슬 공통: pointer 이벤트) ----
    var drawing = false;
    function pos(e) {
      var r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (w / r.width), y: (e.clientY - r.top) * (h / r.height) };
    }
    cv.addEventListener('pointerdown', function (e) {
      e.preventDefault();                               // 폰에서 그리다 화면이 스크롤되지 않게
      pushPadUndo(key);
      drawing = true;
      cv.setPointerCapture(e.pointerId);
      var p = pos(e);
      ctx.globalCompositeOperation = padTool.mode === 'eraser' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = padTool.color;
      ctx.lineWidth = padTool.mode === 'eraser' ? 18 : 2.4;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y); ctx.stroke();
    });
    cv.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      e.preventDefault();
      var p = pos(e);
      ctx.lineTo(p.x, p.y); ctx.stroke();
    });
    function end() {
      if (!drawing) return;
      drawing = false;
      ctx.globalCompositeOperation = 'source-over';
      padInk[key] = cv.toDataURL('image/png');          // 획이 끝날 때만 스냅샷
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', end);
  }
  function pushPadUndo(key) {
    var stack = padUndo[key] || (padUndo[key] = []);
    stack.push(padInk[key] || '');
    if (stack.length > PAD_UNDO_MAX) stack.shift();
  }

  function render() {
    renderChrome();
    // 슬라이드
    var s = slides[cur]; var el = document.getElementById('slide');
    var html = '';
    if (s.group) html += '<span class="grouptag">묶음 ' + escapeHtml(s.group) + '</span>';
    if (s.html) {
      // HTML 로 변환된 문항 — 글자 크기 조절 가능
      html += '<div class="fontbar">글자 크기' +
        '<button data-f="small" class="' + (fontSize === 'small' ? 'on' : '') + '">작게</button>' +
        '<button data-f="normal" class="' + (fontSize === 'normal' ? 'on' : '') + '">보통</button>' +
        '<button data-f="large" class="' + (fontSize === 'large' ? 'on' : '') + '">크게</button></div>';
      html += '<div class="qhtml" style="font-size:' + FONT_STEPS[fontSize] + 'px;">' + s.html + '</div>';
    } else if (s.image) {
      html += '<img alt="문항" src="' + s.image + '" />';
    } else {
      html += '<div class="noimg" style="color:#e11d48;">🙏 문항을 불러올 수 없어요</div>';
    }
    html += '<div class="answers" id="answers"></div><div id="doneHint"></div>';
    html += '<div class="padbar"><button class="padbtn" id="padToggle" type="button">✏️ 연습장</button></div><div id="padHost"></div>';
    el.innerHTML = html;
    hideTailBlank(el, s);      // 발문 끝 "…… ( )" 는 탭 유형에선 잔재다(원문은 그대로 둔다)
    bindChoices(el, s);        // 선지 클릭 = 답 선택(선지가 있는 문항만)
    renderAnswers(el, s);      // 객관식이면 입력칸 대신 선택 상태
    mountPad(el, s);           // 문항별 연습장
    el.querySelectorAll('.fontbar button').forEach(function (b) {
      b.addEventListener('click', function () { setFont(b.getAttribute('data-f')); });
    });
    // 묶음 문항의 공통 지문: 폰에서 길면 스크롤 부담이 크니 접을 수 있게 한다
    var psg = el.querySelector('.qhtml .passage');
    if (psg) {
      var t = document.createElement('button');
      t.className = 'psg-toggle';
      var folded = false;
      t.textContent = '지문 접기 ▲';
      t.onclick = function () {
        folded = !folded;
        psg.classList.toggle('folded', folded);
        t.textContent = folded ? '지문 펼치기 ▼' : '지문 접기 ▲';
      };
      psg.parentNode.insertBefore(t, psg);
    }
    // 나중에 다시 버튼 상태(현재 슬라이드 첫 문항 기준)
    var curNums = slides[cur] ? slides[cur].nums : [];
    var laterOn = curNums.some(function (n) { return later[n]; });
    document.getElementById('laterBtn').classList.toggle('on', laterOn);
    var nav = navigable();
    document.getElementById('prevBtn').disabled = nav.indexOf(cur) <= 0;
  }

  function goSlide(i) { if (i < 0 || i >= slides.length) return; cur = i; render(); heartbeat(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function goQuestion(num) { goSlide(slideOfQuestion(num)); }
  function step(dir) {
    var nav = navigable(); var pos = nav.indexOf(cur);
    if (pos < 0) { if (nav.length) goSlide(nav[0]); return; }
    if (dir > 0 && pos === nav.length - 1) { finish(); return; }
    var np = Math.max(0, Math.min(nav.length - 1, pos + dir));
    goSlide(nav[np]);
  }

  document.getElementById('prevBtn').onclick = function () { step(-1); };
  document.getElementById('nextBtn').onclick = function () { step(1); };
  document.getElementById('laterBtn').onclick = function () {
    var nums = slides[cur].nums;
    var on = nums.some(function (n) { return later[n]; });
    nums.forEach(function (n) { if (on) delete later[n]; else later[n] = true; });
    render();
    if (!on) step(1); // 표시하면 다음으로
  };

  // ---- 마무리 분기 ----
  function finish() {
    var unanswered = allNums().filter(function (n) { return !hasAnswer(n); });
    var laterNums = allNums().filter(function (n) { return later[n]; });
    var sheet = document.getElementById('finishSheet');
    var h;
    if (unanswered.length) {
      // 안 푼 문항을 번호로 짚어 준다 — 번호를 누르면 그 문항으로 바로 간다
      h = '<h2>잠깐만요 🙂</h2><p>' + unanswered.length + '개를 안 풀었어요(' + unanswered.join(', ') + '번). 그래도 제출할까요?</p>' +
        '<div class="misslist">' + unanswered.map(function (n) {
          return '<button type="button" data-go="' + n + '">' + n + '</button>';
        }).join('') + '</div>' +
        '<button class="primary" id="fGo">안 푼 문제로 가기</button><button id="fSubmit">그래도 제출</button>';
    } else if (laterNums.length) {
      h = '<h2>거의 다 됐어요 ✨</h2><p>다시 볼 문제가 ' + laterNums.length + '개 있어요. 확인해볼까요?</p>' +
        '<button class="primary" id="fGo">다시 볼 문제로 가기</button><button id="fSubmit">제출하기</button>';
    } else {
      h = '<h2>다 풀었어요! 🎉</h2><p>제출하기 전에 한 번 더 확인해볼까요?</p>' +
        '<button id="fGo">처음부터 훑어보기</button><button class="primary" id="fSubmit">제출하기</button>';
    }
    sheet.innerHTML = h;
    document.getElementById('finishOverlay').classList.add('show');
    sheet.querySelectorAll('button[data-go]').forEach(function (b) {
      b.onclick = function () { hide('finishOverlay'); goQuestion(Number(b.getAttribute('data-go'))); };
    });
    document.getElementById('fSubmit').onclick = function () { hide('finishOverlay'); submit(); };
    document.getElementById('fGo').onclick = function () {
      hide('finishOverlay');
      if (unanswered.length) goQuestion(unanswered[0]);
      else if (laterNums.length) goQuestion(laterNums[0]);
      else goSlide(0);
    };
  }
  function hide(id) { document.getElementById(id).classList.remove('show'); }

  // ---- 제출 ----
  function submit() {
    var nick = (document.getElementById('nick').value || '').trim();
    if (!nick) { alert('닉네임(이름)을 입력해 주세요.'); document.getElementById('nick').focus(); return; }
    fetch('/api/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID, nickname: nick, answers: answers, replace: true }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok) throw new Error(data.error || '제출 실패');
      submitted = true;
      wrong = {};
      (data.results || []).forEach(function (r) { if (r.correct === false) wrong[r.num] = true; });
      showResult(data);
    }).catch(function (e) { alert('제출 실패: ' + e.message); });
  }

  function showResult(data) {
    var score = data.auto_score || 0, gradable = data.gradable || 0;
    var missed = gradable - score;
    var sheet = document.getElementById('resultSheet');
    var h;
    if (gradable > 0 && missed === 0) {
      h = '<h2>완벽해요! 수고했어요 🎉</h2><p>모든 채점 문항을 맞혔어요.</p><button class="primary" id="rDone">제출 완료</button>';
    } else if (missed > 0) {
      h = '<h2>' + missed + '개가 아쉬워요</h2><p>조금 더 생각해보고 다시 제출할 수 있어요.</p>' +
        '<button class="primary" id="rRedo">다시 풀어보기</button><button id="rDone">이대로 제출 완료</button>';
    } else {
      h = '<h2>제출 완료 ✅</h2><p>수고했어요!</p><button class="primary" id="rDone">확인</button>';
    }
    sheet.innerHTML = h;
    document.getElementById('resultOverlay').classList.add('show');
    var done = document.getElementById('rDone'); if (done) done.onclick = function () { hide('resultOverlay'); render(); };
    var redo = document.getElementById('rRedo');
    if (redo) redo.onclick = function () {
      hide('resultOverlay'); restrictWrong = true;
      var nav = navigable(); if (nav.length) goSlide(nav[0]); render();
    };
    render();
  }

  // ---- 실시간 교실: 하트비트(5초) ----
  // 살아 있음 + 지금 보는 문항 + 지금까지의 답을 함께 올린다.
  // 답을 올려 두면 [마감] 때 서버가 미제출 학생의 답을 그대로 제출할 수 있다(브라우저가 닫혀도 남는다).
  var lastNoticeAt = null;
  function heartbeat() {
    var nick = (document.getElementById('nick').value || '').trim();
    if (!nick) return;                                  // 닉네임 전에는 누구인지 알 수 없다
    fetch('/api/live/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activityId: ACTIVITY_ID, nickname: nick,
        currentQ: slides[cur] ? slides[cur].nums[0] : null,
        answers: answers,                               // 연습장은 보내지 않는다(답이 아니다)
      }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      showNotice((d.notices || [])[0]);
      // 본인 앞으로 온 것만 서버가 보내 준다. 그냥 메시지와 이동 요청은 배너가 따로다.
      var mine = d.messages || [];
      showDm(mine.filter(function (m) { return m.type !== 'goto'; })[0]);
      var gotos = mine.filter(function (m) { return m.type === 'goto'; });
      showGoto(gotos[gotos.length - 1]);     // 새 요청이 이전 요청을 대체한다(배너 중첩 금지)
      if (d.closed) onClosed();
    }).catch(function () {});
  }

  // ---- 선생님이 나에게 보낸 메시지(전체 공지와 다른 채널·다른 색) ----
  var dmShown = null;
  function showDm(m) {
    var el = document.getElementById('dmBanner');
    if (!m) { if (!dmShown) el.style.display = 'none'; return; }
    if (dmShown === m.id) return;             // 같은 메시지를 다시 그리지 않는다(중첩 금지)
    dmShown = m.id;
    el.style.display = 'block';
    el.innerHTML = '<div class="dmlab">선생님이 나에게</div>' +
      '<div class="dmtext"></div>' +
      '<div class="dmact"><button type="button" id="dmOk">확인</button></div>';
    el.querySelector('.dmtext').textContent = m.text;
    el.classList.add('fresh');
    setTimeout(function () { el.classList.remove('fresh'); }, 1200);
    document.getElementById('dmOk').onclick = function () { ackDm(m.id); };
  }
  function ackDm(id) {
    var el = document.getElementById('dmBanner');
    el.style.display = 'none';
    dmShown = null;                            // 새 메시지가 오면 다시 뜬다
    markSeen(id);
  }
  function markSeen(id) {
    var nick = (document.getElementById('nick').value || '').trim();
    fetch('/api/live/message/seen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID, nickname: nick, messageId: id }),
    }).catch(function () {});
  }

  // ---- 문항 이동 요청 — '부탁'이지 강제가 아니다. 작성 중이던 답은 어떤 경우에도 건드리지 않는다. ----
  var gotoShown = null;
  function showGoto(m) {
    var el = document.getElementById('gotoBanner');
    if (!m) { if (!gotoShown) el.style.display = 'none'; return; }
    if (gotoShown === m.id) return;
    gotoShown = m.id;                          // 새 요청이 오면 이전 배너를 덮어쓴다(중첩 금지)
    el.style.display = 'block';
    el.innerHTML = '<div class="gtext">🙋 선생님이 ' + m.q + '번 문제로 이동을 요청했어요</div>' +
      '<div class="gact"><button type="button" class="go" id="gotoGo">' + m.q + '번으로 가기</button>' +
      '<button type="button" class="later" id="gotoLater">나중에</button></div>';
    document.getElementById('gotoGo').onclick = function () {
      closeGoto(m.id);
      goQuestion(Number(m.q));                 // 답은 answers 에 그대로 남아 있다
    };
    document.getElementById('gotoLater').onclick = function () { closeGoto(m.id); };
  }
  function closeGoto(id) {
    document.getElementById('gotoBanner').style.display = 'none';
    gotoShown = null;
    markSeen(id);
  }
  function showNotice(n) {
    var el = document.getElementById('noticeBanner');
    if (!n || !n.text) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.textContent = '📢 ' + n.text;
    if (n.at !== lastNoticeAt) {                        // 새 공지만 잠깐 강조(소리·진동 없음)
      lastNoticeAt = n.at;
      el.classList.add('fresh');
      setTimeout(function () { el.classList.remove('fresh'); }, 1200);
    }
  }
  var closedDone = false;
  function onClosed() {
    if (closedDone) return;
    closedDone = true;
    document.getElementById('closedOverlay').classList.add('show');   // 서버가 미제출분을 자동 제출한다
    ['prevBtn', 'nextBtn', 'laterBtn'].forEach(function (id) { document.getElementById(id).disabled = true; });
  }
  setInterval(heartbeat, 5000);
  document.getElementById('nick').addEventListener('change', heartbeat);   // 이름 넣자마자 접속으로 잡힌다

  // 버전 폴링(수정 알림)
  document.getElementById('reloadBtn').onclick = function () { location.reload(); };
  setInterval(function () {
    fetch('/api/activities/' + ACTIVITY_ID + '/version').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok && Number(d.version) > MY_VERSION) document.getElementById('updateBanner').style.display = 'block';
    }).catch(function () {});
  }, 8000);

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  render();
})();
</script>
</body>
</html>`;
}

function renderDashboardPage(activity) {
  const title = escapeHtml(activity.title || '활동');
  const activityId = activity.id;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>응답 보기 — ${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: #1a1a1a; }
  .header { background: #fff; border-bottom: 1px solid #e2e8f0; padding: 14px 20px; display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 18px; margin: 0; }
  .header .live { font-size: 12px; color: #2f855a; margin-left: auto; }
  .header a { font-size: 13px; color: #2b6cb0; text-decoration: none; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 20px 16px 60px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
  .card .k { font-size: 13px; color: #718096; }
  .card .v { font-size: 30px; font-weight: 800; margin-top: 4px; }
  .section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 18px; }
  .section h2 { font-size: 16px; margin: 0 0 14px; }
  .qbar { margin-bottom: 12px; }
  .qbar .top { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 4px; }
  .qbar .track { height: 22px; background: #edf2f7; border-radius: 6px; overflow: hidden; }
  .qbar .fill { height: 100%; background: #48bb78; border-radius: 6px; text-align: right; color: #fff; font-size: 12px; line-height: 22px; padding-right: 6px; }
  .qbar.worst .fill { background: #e53e3e; }
  .qbar .essay { color: #718096; font-size: 13px; }
  .dist { margin: 6px 0 0; padding-left: 0; list-style: none; font-size: 13px; color: #4a5568; }
  .dist li { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
  .dist .lab { flex: 0 0 90px; font-weight: 700; }
  .dist .db { height: 12px; background: #90cdf4; border-radius: 4px; }
  .dist .db.correct { background: #48bb78; }
  table.rank { width: 100%; border-collapse: collapse; }
  table.rank th, table.rank td { border-bottom: 1px solid #edf2f7; padding: 8px 10px; text-align: left; font-size: 14px; }
  table.rank th { color: #718096; font-weight: 600; }
  table.rank td.sc { font-weight: 800; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  button { padding: 9px 14px; font-size: 14px; font-weight: 700; border: 1px solid #e2e8f0; background: #fff; border-radius: 8px; cursor: pointer; }
  button.primary { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
  button.green { background: #2f855a; color: #fff; border-color: #2f855a; }
  .essay-block { margin-bottom: 14px; }
  .essay-block h3 { font-size: 14px; margin: 0 0 6px; }
  .essay-item { background: #f7fafc; border: 1px solid #edf2f7; border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; font-size: 14px; }
  .essay-item .who { font-size: 12px; color: #718096; margin-bottom: 2px; }
  .muted { color: #718096; }
  @media print { .toolbar, .header .live, .header a { display: none; } body { background: #fff; } }
</style>
</head>
<body>
  <div class="header">
    <h1>📊 ${title}</h1>
    <span class="live" id="live">● 실시간 (5초)</span>
    <a href="/teacher.html">← 교사 홈</a>
  </div>
  <div class="wrap">
    <div class="toolbar">
      <button class="green" id="csvBtn">⬇ 엑셀(CSV) 다운로드</button>
      <button id="pdfBtn">🖨 PDF 리포트(인쇄)</button>
      <label class="muted" style="margin-left:8px;"><input type="checkbox" id="nameToggle" /> 실명 표시</label>
    </div>

    <div class="cards" id="cards"></div>

    <div class="section">
      <h2>문항별 정답률 <span class="muted" style="font-size:12px;">(가장 많이 틀린 문항 빨강)</span></h2>
      <div id="qbars"></div>
    </div>

    <div class="section" id="distSection">
      <h2>객관식 보기별 응답 분포</h2>
      <div id="dists"></div>
    </div>

    <div class="section">
      <h2>학생별 점수 순위</h2>
      <table class="rank"><thead><tr><th>순위</th><th>학생</th><th>점수</th></tr></thead><tbody id="rankBody"></tbody></table>
    </div>

    <div class="section" id="essaySection">
      <h2>서술형 답 모아보기</h2>
      <div id="essays"></div>
    </div>
  </div>

<script>
(function () {
  var ACTIVITY_ID = ${JSON.stringify(activityId)};
  var DATA = null;
  var showNames = false;

  function nameOf(s) { return showNames ? (s.nickname || '(익명)') : (s.no + '번'); }

  function fetchData() {
    return fetch('/api/dashboard/' + ACTIVITY_ID)
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.ok) throw new Error(d.error || '조회 실패'); DATA = d; renderAll(); })
      .catch(function (e) { console.error(e); });
  }

  function renderAll() { renderCards(); renderQBars(); renderDists(); renderRank(); renderEssays(); }

  function renderCards() {
    var s = DATA.summary;
    var cards = [
      ['제출 인원', s.submissions + '명'],
      ['평균 점수', s.avg + (s.questionCount ? ' / ' + s.questionCount : '')],
      ['최고 점수', s.max],
      ['최저 점수', s.min],
      ['문항 수', s.questionCount],
    ];
    document.getElementById('cards').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>';
    }).join('');
  }

  function renderQBars() {
    var pq = DATA.perQuestion || [];
    // 가장 많이 틀린 문항(정답률 최저, 채점 대상만) 찾기
    var worstRate = 101, worstNum = null;
    pq.forEach(function (q) { if (q.rate !== null && q.rate < worstRate) { worstRate = q.rate; worstNum = q.num; } });

    document.getElementById('qbars').innerHTML = pq.map(function (q) {
      if (q.type === 'essay') {
        return '<div class="qbar"><div class="top"><b>' + q.num + '번</b> <span class="essay">서술형 — 응답 ' + q.answered + '명</span></div></div>';
      }
      var rate = q.rate === null ? 0 : q.rate;
      var worst = (q.num === worstNum && q.rate !== null);
      return '<div class="qbar' + (worst ? ' worst' : '') + '">' +
        '<div class="top"><b>' + q.num + '번</b> <span>' + rate + '% (' + q.correct + '/' + q.gradable + ')' + (worst ? ' ⚠ 최다 오답' : '') + '</span></div>' +
        '<div class="track"><div class="fill" style="width:' + rate + '%">' + rate + '%</div></div></div>';
    }).join('');
  }

  function renderDists() {
    var pq = (DATA.perQuestion || []).filter(function (q) { return q.type === 'choice'; });
    var sec = document.getElementById('distSection');
    if (!pq.length) { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    var maxN = 1;
    pq.forEach(function (q) { Object.keys(q.distribution).forEach(function (k) { maxN = Math.max(maxN, q.distribution[k]); }); });
    document.getElementById('dists').innerHTML = pq.map(function (q) {
      var keys = Object.keys(q.distribution).sort();
      var rows = keys.map(function (k) {
        var n = q.distribution[k];
        var isAns = String(k).trim() === String(q.answer).trim();
        return '<li><span class="lab">' + escapeHtml(k) + (isAns ? ' ✔' : '') + '</span>' +
          '<span class="db' + (isAns ? ' correct' : '') + '" style="width:' + Math.round(n / maxN * 160) + 'px"></span>' +
          '<span>' + n + '명</span></li>';
      }).join('');
      return '<div style="margin-bottom:14px"><b>' + q.num + '번</b> <span class="muted">(정답 ' + escapeHtml(q.answer || '-') + ')</span><ul class="dist">' + (rows || '<li class="muted">응답 없음</li>') + '</ul></div>';
    }).join('');
  }

  function renderRank() {
    var st = (DATA.students || []).slice().sort(function (a, b) { return b.score - a.score; });
    document.getElementById('rankBody').innerHTML = st.map(function (s, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(nameOf(s)) + (s.self_scored ? ' <span class="muted">(자가채점)</span>' : '') + '</td><td class="sc">' + s.score + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">제출 없음</td></tr>';
  }

  function renderEssays() {
    var essays = (DATA.questions || []).filter(function (q) { return q.type === 'essay'; });
    var sec = document.getElementById('essaySection');
    if (!essays.length) { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    document.getElementById('essays').innerHTML = essays.map(function (q) {
      var items = (DATA.students || []).map(function (s) {
        var cell = s.byNum[q.num];
        var given = cell && cell.given ? String(cell.given).trim() : '';
        if (!given) return '';
        return '<div class="essay-item"><div class="who">' + escapeHtml(nameOf(s)) + '</div>' + escapeHtml(given) + '</div>';
      }).filter(Boolean).join('');
      return '<div class="essay-block"><h3>' + q.num + '번</h3>' + (items || '<div class="muted">응답 없음</div>') + '</div>';
    }).join('');
  }

  // CSV: 학생 × 문항 표(각 칸 정오/답, 점수)
  function downloadCsv() {
    var qs = DATA.questions || [];
    var head = ['학생'].concat(qs.map(function (q) { return q.num + '번'; })).concat(['점수']);
    var lines = [head.join(',')];
    (DATA.students || []).forEach(function (s) {
      var row = [csv(nameOf(s))];
      qs.forEach(function (q) {
        var cell = s.byNum[q.num] || {};
        var mark = cell.correct === true ? 'O' : cell.correct === false ? 'X' : '-';
        var given = cell.given != null ? String(cell.given) : '';
        row.push(csv(given ? (given + '(' + mark + ')') : mark));
      });
      row.push(s.score);
      lines.push(row.join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'result_' + ACTIVITY_ID.slice(0, 8) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function csv(v) { v = String(v == null ? '' : v); return /[",\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  document.getElementById('csvBtn').onclick = downloadCsv;
  document.getElementById('pdfBtn').onclick = function () { window.print(); };
  document.getElementById('nameToggle').onchange = function () { showNames = this.checked; renderAll(); };

  fetchData();
  setInterval(fetchData, 5000);
})();
</script>
</body>
</html>`;
}

// ───────────────── HTML 활동지(kind='html_sheet') 학생 화면 ─────────────────
//
// 시험지 화면(renderStudentPage)과 결정적으로 다른 점: 감싸지 않는다.
// 시험지 화면은 교사 HTML 을 .wrap/.content 안에 넣고 자기 배경·글꼴·760px 폭을 덮어씌운다.
// 활동지에 그렇게 하면 교사가 만든 디자인(히어로 헤더·색·반응형)이 통째로 죽는다.
// 그래서 원본 문서를 그대로 내보내고, <head> 끝과 <body> 끝에만 우리 것을 '얹는다'.

// 원본 문서의 </head>·</body> 앞에 끼워 넣는다. 문자열 replace 는 $& 같은 치환 패턴을
// 해석하므로(주입 문자열에 CSS·JS 가 들어 있다) 반드시 함수형 replace 로 넣는다.
function injectIntoSheet(docHtml, headExtra, bodyExtra) {
  let out = String(docHtml || '');

  if (/<\/head\s*>/i.test(out)) out = out.replace(/<\/head\s*>/i, () => headExtra + '</head>');
  else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body([^>]*)>/i, (m) => '<head>' + headExtra + '</head>' + m);
  else out = headExtra + out;

  if (/<\/body\s*>/i.test(out)) out = out.replace(/<\/body\s*>/i, () => bodyExtra + '</body>');
  else out += bodyExtra;

  return out;
}

// <script> 안에 안전하게 넣을 JSON. </script> 로 문서를 탈출하지 못하게 '<' 를 escape 한다.
function jsonForScript(v) {
  return JSON.stringify(v == null ? null : v).replace(/</g, '\\u003c');
}

function renderSheetStudentPage(activity) {
  const activityId = activity.id;
  const version = Number(activity.version) || 1;
  const fields = Array.isArray(activity.fields) ? activity.fields : [];
  const closed = !!activity.closed_at;

  const headExtra = `
<style>
  /* 문제샘 표준 바 — 원본 디자인에 섞이지 않도록 전부 __mjs 로 이름을 가르고, 값도 상속받지 않는다. */
  #__mjsBar, #__mjsBar * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  #__mjsBar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;
    background: #1a202c; color: #fff; padding: 10px 14px;
    box-shadow: 0 -4px 18px rgba(0,0,0,.28);
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  #__mjsBar .g { display: flex; align-items: center; gap: 8px; min-width: 0; }
  #__mjsBar .g.grow { flex: 1; min-width: 140px; }
  #__mjsBar label { font-size: 12px; font-weight: 700; color: #a0aec0; white-space: nowrap; margin: 0; }
  #__mjsNick {
    flex: 1; min-width: 90px; padding: 9px 10px; font-size: 16px;
    border: 2px solid #4a5568; border-radius: 8px; background: #2d3748; color: #fff;
  }
  #__mjsNick:focus { outline: 2px solid #63b3ed; border-color: #63b3ed; }
  #__mjsCount { font-size: 13px; font-weight: 700; color: #90cdf4; white-space: nowrap; }
  #__mjsSave { font-size: 12px; color: #a0aec0; white-space: nowrap; min-width: 72px; }
  #__mjsSave.on { color: #68d391; }
  #__mjsSubmit {
    padding: 11px 20px; font-size: 15px; font-weight: 800; color: #fff;
    background: #2f855a; border: 0; border-radius: 9px; cursor: pointer; white-space: nowrap;
  }
  #__mjsSubmit:disabled { background: #4a5568; cursor: default; }
  #__mjsNotice {
    position: fixed; left: 0; right: 0; bottom: 62px; z-index: 2147483000;
    background: #fefcbf; color: #744210; padding: 10px 14px; font-size: 14px; font-weight: 700;
    font-family: system-ui, sans-serif; display: none;
  }
  /* 바가 문서 끝(푸터)을 가리지 않게 자리를 비운다 */
  body { padding-bottom: 96px !important; }
  @media (max-width: 520px) {
    #__mjsBar { gap: 8px; padding: 8px 10px; }
    #__mjsSubmit { flex: 1; }
    body { padding-bottom: 132px !important; }
  }
  @media print { #__mjsBar, #__mjsNotice { display: none !important; } }
</style>`;

  const bodyExtra = `
<div id="__mjsNotice"></div>
<div id="__mjsBar">
  <div class="g grow">
    <label for="__mjsNick">닉네임</label>
    <input id="__mjsNick" type="text" placeholder="이름을 입력하세요" autocomplete="off" />
  </div>
  <div class="g">
    <span id="__mjsCount">0/0</span>
    <span id="__mjsSave">저장 안 됨</span>
  </div>
  <button id="__mjsSubmit" type="button">제출하기</button>
</div>
<script>
(function () {
  var ACTIVITY_ID = ${jsonForScript(activityId)};
  var VERSION = ${version};
  var FIELDS = ${jsonForScript(fields)};
  var CLOSED0 = ${closed ? 'true' : 'false'};

  var COLLECT = FIELDS.filter(function (f) { return f.collect; });
  var byId = {};
  FIELDS.forEach(function (f) { byId[f.id] = f; });

  var LSKEY = 'mjs-sheet-' + ACTIVITY_ID;
  var answers = {};
  var closed = CLOSED0;
  var submitted = false;

  var nickEl = document.getElementById('__mjsNick');
  var countEl = document.getElementById('__mjsCount');
  var saveEl = document.getElementById('__mjsSave');
  var submitEl = document.getElementById('__mjsSubmit');
  var noticeEl = document.getElementById('__mjsNotice');

  // ---- 저장한 것 되살리기 ----
  // 서버(live_sessions)에도 올리지만, 되살리기는 localStorage 로 한다. 새로고침·창 닫기에
  // 네트워크 없이도 즉시 복구돼야 하고, 서버 것은 교사 화면·마감용이다.
  try {
    var raw = localStorage.getItem(LSKEY);
    if (raw) {
      var saved = JSON.parse(raw);
      if (saved && saved.v === VERSION && saved.answers) answers = saved.answers;
      if (saved && saved.nickname) nickEl.value = saved.nickname;
    }
  } catch (e) {}

  function persist() {
    try {
      localStorage.setItem(LSKEY, JSON.stringify({ v: VERSION, nickname: (nickEl.value || '').trim(), answers: answers }));
    } catch (e) {}
  }

  // ---- 칸 ↔ 답 ----
  function readEl(el) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return el.value;
    if (tag === 'input') return el.value;
    return el.innerText != null ? el.innerText : el.textContent;   // contenteditable
  }
  function writeEl(el, v) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') el.value = v == null ? '' : v;
    else el.textContent = v == null ? '' : v;
  }

  function restore() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-fid]'), function (el) {
      var fid = el.getAttribute('data-fid');
      var f = byId[fid];
      if (!f) return;
      var v = answers[fid];
      if (v == null) return;
      if (f.tag === 'checkbox') {
        var idx = Number(el.getAttribute('data-fopt'));
        el.checked = Array.isArray(v) && v.indexOf(idx) >= 0;
      } else {
        writeEl(el, v);
      }
    });
  }

  function collectFrom(fid) {
    var f = byId[fid];
    if (!f) return;
    if (f.tag === 'checkbox') {
      var on = [];
      Array.prototype.forEach.call(document.querySelectorAll('[data-fid="' + fid + '"]'), function (el) {
        if (el.checked) on.push(Number(el.getAttribute('data-fopt')));
      });
      on.sort(function (a, b) { return a - b; });
      answers[fid] = on;
    } else {
      var el = document.querySelector('[data-fid="' + fid + '"]');
      if (el) answers[fid] = readEl(el);
    }
  }

  function isEmpty(v) {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return String(v).replace(/\\s+/g, '') === '';
  }
  function filled() {
    var n = 0;
    COLLECT.forEach(function (f) { if (!isEmpty(answers[f.id])) n++; });
    return n;
  }

  // ---- 원본 진행률 바 되살리기 ----
  // 교사가 넣은 인라인 스크립트는 정제 단계에서 통째로 걷어낸다(그게 안전하다).
  // 그래서 진행률 바가 0% 에 굳는다 — 수집 스크립트가 대신 움직여 준다.
  // 이름을 정확히 알 수 없으니 흔한 작명(progress-fill / progress-pct)을 폭넓게 잡는다.
  var fillEls = document.querySelectorAll('[class*=progress][class*=fill],[class*=prog][class*=fill],[class*=bar][class*=fill]');
  var pctEls = document.querySelectorAll('[class*=progress][class*=pct],[class*=prog][class*=pct],[class*=percent]');
  var allBoxes = document.querySelectorAll('input[type=checkbox]');

  function paintProgress() {
    var done, total;
    if (allBoxes.length) {                     // 원본 진행률 바는 대개 '미션 체크'를 세던 것이다
      total = allBoxes.length; done = 0;
      Array.prototype.forEach.call(allBoxes, function (b) { if (b.checked) done++; });
    } else {
      total = COLLECT.length; done = filled();
    }
    var p = total ? Math.round(done / total * 100) : 0;
    Array.prototype.forEach.call(fillEls, function (el) { el.style.width = p + '%'; });
    Array.prototype.forEach.call(pctEls, function (el) { el.textContent = (p === 100 ? '🎉' : '') + p + '%'; });
    countEl.textContent = filled() + '/' + COLLECT.length;
  }

  // ---- 원본 [복사] 버튼 되살리기 ----
  Array.prototype.forEach.call(document.querySelectorAll('button'), function (btn) {
    var t = (btn.textContent || '').trim();
    if (!/^(복사|copy)$/i.test(t)) return;
    btn.addEventListener('click', function () {
      var box = btn.parentElement;
      if (!box) return;
      var target = box.querySelector('[class*=text]') || box;
      var text = (target.innerText || target.textContent || '').trim();
      var done = function () {
        var old = btn.textContent;
        btn.textContent = '복사됨!';
        setTimeout(function () { btn.textContent = old; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { fallback(text, done); });
      } else { fallback(text, done); }
    });
  });
  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  // ---- 자동 임시저장 ----
  var hbTimer = null;
  function touch(fid) {
    collectFrom(fid);
    persist();                                  // 로컬은 즉시 — 제출 전에도 유실 없게
    paintProgress();
    saveEl.textContent = '저장 중…'; saveEl.className = '';
    clearTimeout(hbTimer);
    hbTimer = setTimeout(push, 600);            // 서버는 타이핑이 멎으면
  }

  function push() {
    var nick = (nickEl.value || '').trim();
    if (!nick) { saveEl.textContent = '닉네임 먼저'; saveEl.className = ''; return; }
    fetch('/api/live/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID, nickname: nick, currentQ: null, answers: answers }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) { saveEl.textContent = '저장 실패'; saveEl.className = ''; return; }
      saveEl.textContent = '저장됨'; saveEl.className = 'on';
      var n = (d.notices || [])[0];
      if (n) { noticeEl.style.display = 'block'; noticeEl.textContent = '📢 ' + n.text; }
      if (d.closed) onClosed();
    }).catch(function () { saveEl.textContent = '저장 실패(오프라인)'; saveEl.className = ''; });
  }

  // ---- 묶기 ----
  // 교사가 [수집]을 끈 칸에는 아예 손을 대지 않는다. 값을 읽어 두기만 해도 그대로 저장·제출로 새어
  // 결과표에 없는 답이 DB 에 쌓인다("모으지 않는다"는 약속이 깨진다).
  // 진행률 바는 아래 allBoxes 에서 따로 움직이므로 여기서 빠져도 멀쩡하다.
  Array.prototype.forEach.call(document.querySelectorAll('[data-fid]'), function (el) {
    var fid = el.getAttribute('data-fid');
    var f = byId[fid];
    if (!f || !f.collect) return;
    if (f.tag === 'checkbox') {
      el.addEventListener('change', function () { touch(fid); });
    } else {
      el.addEventListener('input', function () { touch(fid); });
      el.addEventListener('change', function () { touch(fid); });
    }
  });
  nickEl.addEventListener('input', function () { persist(); });
  nickEl.addEventListener('blur', function () { if ((nickEl.value || '').trim()) push(); });

  // 체크박스는 수집 대상이 아니어도 진행률 바는 움직여야 한다(원본이 그랬다).
  Array.prototype.forEach.call(allBoxes, function (b) {
    b.addEventListener('change', paintProgress);
  });

  // ---- 마감 ----
  function onClosed() {
    if (closed) return;
    closed = true;
    submitEl.disabled = true;
    submitEl.textContent = '마감됨';
    noticeEl.style.display = 'block';
    noticeEl.textContent = '🔒 선생님이 활동을 마감했어요. 지금까지 쓴 내용은 자동으로 제출됐습니다.';
  }

  // ---- 제출 ----
  submitEl.addEventListener('click', function () {
    var nick = (nickEl.value || '').trim();
    if (!nick) { alert('닉네임(이름)을 먼저 입력해 주세요.'); nickEl.focus(); return; }
    COLLECT.forEach(function (f) { collectFrom(f.id); });
    if (filled() === 0 && !confirm('아직 아무것도 쓰지 않았어요. 그래도 제출할까요?')) return;
    if (submitted && !confirm('이미 제출했어요. 다시 제출하면 이전 제출을 덮어씁니다. 계속할까요?')) return;

    submitEl.disabled = true; submitEl.textContent = '제출 중…';
    fetch('/api/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID, nickname: nick, answers: answers, replace: true }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '제출 실패');
      submitted = true;
      submitEl.textContent = '제출 완료 ✓';
      saveEl.textContent = '제출됨'; saveEl.className = 'on';
      noticeEl.style.display = 'block';
      noticeEl.textContent = '✅ 제출했어요! 계속 고쳐 쓰고 다시 제출할 수 있어요.';
      setTimeout(function () {
        if (!closed) { submitEl.disabled = false; submitEl.textContent = '다시 제출'; }
      }, 1500);
      push();
    }).catch(function (e) {
      alert('제출에 실패했어요: ' + e.message);
      submitEl.disabled = false; submitEl.textContent = '제출하기';
    });
  });

  // ---- 시작 ----
  restore();
  paintProgress();
  if (closed) onClosed();
  setInterval(function () { if ((nickEl.value || '').trim()) push(); }, 5000);   // 접속 표시 + 마감 감지
})();
</script>`;

  return injectIntoSheet(activity.html_body || '', headExtra, bodyExtra);
}

// ───────────────── HTML 활동지 — 발표 모드(답 함께 보기) ─────────────────
//
// 시험지 발표 모드를 재사용하지 않는 이유: 그 화면의 뼈대는 '정답'이다 — 정오 필터, 보기 분포,
// 문항 넘기기. 활동지에는 정답이 없고 문항도 없다. 여기서 볼 것은 하나뿐이다.
// "이 질문에 우리 반이 뭐라고 썼는가" — 그래서 화면 전체가 그 한 가지에 맞춰져 있다.
function renderSheetPresentPage(activity) {
  const title = escapeHtml(activity.title || '활동');
  const activityId = activity.id;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>발표 모드 — ${title}</title>
<style>
  /* TV·빔 프로젝터용 — 본문이 화면의 대부분. 상단은 얇은 상태바, 도구는 하단 독 한 줄. */
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #0b1220; color: #e2e8f0; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  /* 얇은 상태바 */
  .statusbar { display: flex; align-items: center; gap: 10px; padding: 6px 16px; background: #1e293b; border-bottom: 1px solid #334155; font-size: 13px; white-space: nowrap; overflow: hidden; }
  .statusbar h1 { font-size: 14px; margin: 0; color: #94a3b8; font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
  .statusbar .loc { color: #7dd3fc; font-weight: 800; }
  .statusbar .part { color: #4ade80; font-weight: 800; margin-left: auto; }
  .statusbar .live { color: #4ade80; }

  /* 필드 탭 — 얇게 */
  .tabs { display: flex; gap: 6px; padding: 6px 16px 0; overflow-x: auto; background: #0b1220; }
  .tab { padding: 7px 14px; font-size: 14px; font-weight: 800; border: 1px solid #475569; background: #1e293b; color: #94a3b8; border-radius: 9px 9px 0 0; cursor: pointer; white-space: nowrap; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
  .tab:hover { color: #e2e8f0; }
  .tab.on { background: #0b1220; color: #fff; border-color: #3b82f6; border-bottom-color: #0b1220; }
  .tab .sec { display: block; font-size: 10px; font-weight: 600; opacity: .65; }

  /* 본문 — 화면의 대부분 */
  .stagewrap { position: relative; flex: 1; min-height: 0; }
  .stage { position: absolute; inset: 0; overflow-y: auto; padding: 14px 20px 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 16px 18px; cursor: pointer; transition: transform .12s, border-color .12s; }
  .card:hover { transform: translateY(-2px); border-color: #3b82f6; }
  .card .who { font-size: 14px; font-weight: 800; color: #38bdf8; margin-bottom: 8px; }
  .card .who .sub { font-size: 11px; color: #64748b; font-weight: 600; margin-left: 6px; }
  /* 카드 글자 크게 + 긴 답은 3줄 말줄임(전체는 확대에서) */
  .card .txt { font-size: var(--fs, 21px); line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: #e2e8f0;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card.anon .who { color: #94a3b8; }
  @keyframes popin { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
  .card.fresh { animation: popin .32s ease-out; border-color: #22c55e; }
  .card.roul { border-color: #f0a03c; background: #3a2c14; transform: scale(1.03); }
  #empty { color: #64748b; text-align: center; padding: 60px 0; font-size: 16px; }

  /* 필기 캔버스 — 본문 위에 겹친다 */
  #drawCv { position: absolute; inset: 0; z-index: 5; }
  /* 필기 서브 도구(켜면 뜬다) */
  #drawTools { position: fixed; left: 16px; bottom: 74px; z-index: 71; display: none; gap: 6px; background: rgba(15,23,42,.92);
    border: 1px solid #334155; border-radius: 10px; padding: 6px 8px; align-items: center; }
  #drawTools.on { display: flex; }
  #drawTools button { height: 34px; min-width: 34px; padding: 0 8px; font-size: 13px; font-weight: 700; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 7px; cursor: pointer; }
  #drawTools .sw { width: 26px; padding: 0; } .sw.red { background: #ef4444; } .sw.blue { background: #3b82f6; } .sw.black { background: #111827; }
  #drawTools button.on { outline: 2px solid #60a5fa; }

  /* 실시간 오버레이 — 현재 필드 작성 수 */
  .rt { position: absolute; top: 12px; right: 16px; z-index: 6; background: rgba(30,41,59,.9); border: 1px solid #334155;
    border-radius: 999px; padding: 8px 16px; font-size: 15px; font-weight: 800; color: #7dd3fc; pointer-events: none; }
  .rt b { color: #f8fafc; font-size: 18px; }

  /* 크게 보기 — 낭독용, 화면 꽉 차게 */
  #big { position: fixed; inset: 0; background: rgba(2,6,23,.97); display: none; flex-direction: column; z-index: 100; padding: 28px 40px 20px; }
  #big .bwho { font-size: 24px; font-weight: 800; color: #38bdf8; margin-bottom: 6px; }
  #big .blab { font-size: 15px; color: #64748b; margin-bottom: 18px; }
  #big .btxt { flex: 1; overflow-y: auto; font-size: var(--bfs, 44px); line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: #f8fafc; font-weight: 500; }
  #big .bnav { display: flex; align-items: center; gap: 10px; padding-top: 14px; border-top: 1px solid #1e293b; }
  #big .bnav button { min-width: 44px; height: 44px; padding: 0 14px; font-size: 16px; font-weight: 800; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  #big .bnav .pos { color: #64748b; font-size: 14px; }
  #big .bnav .hint { margin-left: auto; color: #475569; font-size: 12.5px; }
</style>
<script src="/lib/present-tools.js"></script>
</head>
<body>
  <div class="statusbar">
    <h1>🎬 ${title}</h1>
    <span class="loc" id="loc"></span>
    <span class="part" id="part">—</span>
    <span class="live" id="live">● 실시간</span>
  </div>

  <div class="tabs" id="tabs"></div>
  <div class="stagewrap">
    <div class="stage" id="stage">
      <div class="grid" id="grid"></div>
      <div id="empty">아직 이 칸에 쓴 학생이 없어요. 학생이 쓰면 여기에 바로 나타납니다.</div>
    </div>
    <canvas id="drawCv"></canvas>
    <div class="rt" id="rt"></div>
  </div>

  <!-- 하단 도구 독 -->
  <div id="dock">
    <button id="penBtn" type="button" title="필기">✏️ 필기</button>
    <button id="spotBtn" type="button" title="스포트라이트">🔦 스포트라이트</button>
    <button id="timerBtn" type="button" title="타이머">⏱ 타이머</button>
    <button id="anonBtn" type="button" title="닉네임을 가려 익명으로">🙈 이름 가리기</button>
    <button id="pickBtn" type="button" title="무작위 뽑기">🎲 무작위 뽑기</button>
    <button id="fsMinus" type="button" title="글자 작게">A-</button>
    <button id="fsPlus" type="button" title="글자 크게">A+</button>
    <button id="helpBtn" type="button" title="단축키">?</button>
    <button id="fscBtn" type="button" title="전체화면 (F)">⛶</button>
  </div>
  <div id="drawTools">
    <button class="sw red on" data-color="#ef4444" title="빨강"></button>
    <button class="sw blue" data-color="#3b82f6" title="파랑"></button>
    <button class="sw black" data-color="#facc15" title="노랑" style="background:#facc15"></button>
    <button class="dsz on" data-size="4">얇게</button>
    <button class="dsz" data-size="10">굵게</button>
    <button id="dEraser">지우개</button>
    <button id="dClear">전체 지우기</button>
    <button id="dKeep" title="문항 바꿔도 필기 유지">🔒 유지</button>
  </div>

  <div id="big">
    <div class="bwho" id="bwho"></div>
    <div class="blab" id="blab"></div>
    <div class="btxt" id="btxt"></div>
    <div class="bnav">
      <button id="bprev" type="button">← 이전</button>
      <button id="bnext" type="button">다음 →</button>
      <span class="pos" id="bpos"></span>
      <button id="bfsMinus" type="button">A-</button>
      <button id="bfsPlus" type="button">A+</button>
      <span class="hint">←/→ 넘기기 · Esc·✕·뒤로가기 닫기</span>
    </div>
  </div>

<script>
(function () {
  var ACTIVITY_ID = ${jsonForScript(activityId)};
  var PT = window.PresentTools;
  var data = null;
  var curFid = null;
  var anon = false;
  var bigIdx = -1;
  var rendered = {};        // 닉네임 -> 카드 엘리먼트 (폴링마다 새로 그리지 않기 위해)

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- 글자 크기 (3px 씩, localStorage 기억) ----
  var fs = 21, bfs = 44;
  try { fs = Number(localStorage.getItem('sheetPresentFs')) || 21; } catch (e) {}
  try { bfs = Number(localStorage.getItem('sheetPresentBigFs')) || 44; } catch (e) {}
  function setFs(v) {
    fs = Math.max(14, Math.min(44, v));
    document.documentElement.style.setProperty('--fs', fs + 'px');
    try { localStorage.setItem('sheetPresentFs', String(fs)); } catch (e) {}
  }
  function setBfs(v) {
    bfs = Math.max(24, Math.min(110, v));
    document.documentElement.style.setProperty('--bfs', bfs + 'px');
    try { localStorage.setItem('sheetPresentBigFs', String(bfs)); } catch (e) {}
  }
  document.getElementById('fsPlus').onclick = function () { setFs(fs + 3); };
  document.getElementById('fsMinus').onclick = function () { setFs(fs - 3); };
  document.getElementById('bfsPlus').onclick = function () { setBfs(bfs + 4); };
  document.getElementById('bfsMinus').onclick = function () { setBfs(bfs - 4); };
  setFs(fs); setBfs(bfs);

  function fields() { return ((data && data.activity.fields) || []).filter(function (f) { return f.collect; }); }
  function curField() { return fields().filter(function (f) { return f.id === curFid; })[0] || null; }

  function show(r, f) {
    var v = (r.answers || {})[f.id];
    if (v == null) return '';
    if (Array.isArray(v)) {
      var opts = f.options || [];
      return v.map(function (i) { return opts[i] != null ? opts[i] : '#' + (i + 1); }).join(' · ');
    }
    return String(v).trim();
  }
  function list() {
    var f = curField();
    if (!f) return [];
    return (data.rows || [])
      .filter(function (r) { return show(r, f).trim(); })
      .sort(function (a, b) { return String(a.nickname).localeCompare(String(b.nickname), 'ko'); });
  }
  function label(r, i) { return anon ? '학생 ' + (i + 1) : r.nickname; }

  function load() {
    fetch('/api/sheet/' + ACTIVITY_ID + '/results')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        data = d;
        if (!curFid && fields().length) curFid = fields()[0].id;
        paintTabs(); paint();
      })
      .catch(function () {});
  }

  function paintTabs() {
    var h = '';
    fields().forEach(function (f) {
      h += '<button class="tab' + (f.id === curFid ? ' on' : '') + '" data-f="' + esc(f.id) + '" title="' + esc(f.label) + '">' +
        esc(f.label) + (f.section ? '<span class="sec">' + esc(f.section) + '</span>' : '') + '</button>';
    });
    document.getElementById('tabs').innerHTML = h;
    document.querySelectorAll('.tab').forEach(function (b) {
      b.onclick = function () {
        if (curFid === b.getAttribute('data-f')) return;
        curFid = b.getAttribute('data-f');
        rendered = {};
        document.getElementById('grid').innerHTML = '';
        drawing.onContextChange();            // 필드 바꾸면 필기 자동 지움(유지 토글이면 남김)
        paintTabs(); paint();
      };
    });
  }

  // 실시간 오버레이 — 현재 필드 작성 수. 새 답이 오면 부드럽게 숫자만 갱신.
  function paintRt(wrote) {
    var f = curField();
    var total = (data && data.total) || fields().length || 0;
    document.getElementById('rt').innerHTML = f ? '작성 <b>' + wrote + '</b> / ' + ((data.rows || []).length) : '';
    document.getElementById('loc').textContent = f ? f.label : '';
  }

  function paint() {
    var f = curField();
    var rows = list();
    var grid = document.getElementById('grid');

    document.getElementById('part').textContent = (data.rows || []).length + '명 참여';
    document.getElementById('empty').style.display = rows.length ? 'none' : '';
    paintRt(rows.length);

    var seen = {};
    rows.forEach(function (r, i) {
      seen[r.nickname] = 1;
      var txt = show(r, f);
      var el = rendered[r.nickname];
      if (!el) {
        el = document.createElement('div');
        el.className = 'card fresh';
        el.innerHTML = '<div class="who"></div><div class="txt"></div>';
        grid.appendChild(el);
        rendered[r.nickname] = el;
        setTimeout(function () { el.classList.remove('fresh'); }, 400);
      }
      el.classList.toggle('anon', anon);
      var who = el.querySelector('.who');
      who.innerHTML = esc(label(r, i)) + (r.submitted ? '' : '<span class="sub">작성 중</span>');
      var t = el.querySelector('.txt');
      if (t.textContent !== txt) t.textContent = txt;
      el.__idx = i;
      el.onclick = function () { openBig(el.__idx); };
    });
    Object.keys(rendered).forEach(function (nick) {
      if (!seen[nick]) { var e = rendered[nick]; if (e && e.parentNode) e.parentNode.removeChild(e); delete rendered[nick]; }
    });
    if (bigOv.isOpen()) paintBig();
  }

  // ---- 크게 보기 (오버레이 3겹 닫기) ----
  var bigOv = PT.createOverlay(document.getElementById('big'), {
    name: 'enlarge', closeLabel: '목록으로',
    onClose: function () { bigIdx = -1; }
  });
  function openBig(i) { bigIdx = i; bigOv.open(); paintBig(); }
  function paintBig() {
    var rows = list(), f = curField();
    if (!rows.length || bigIdx < 0) { bigOv.close(); return; }
    if (bigIdx >= rows.length) bigIdx = rows.length - 1;
    var r = rows[bigIdx];
    document.getElementById('bwho').textContent = label(r, bigIdx);
    document.getElementById('blab').textContent = f ? f.label + (f.section ? ' · ' + f.section : '') : '';
    document.getElementById('btxt').textContent = show(r, f);
    document.getElementById('bpos').textContent = (bigIdx + 1) + ' / ' + rows.length;
  }
  function step(d) {
    var n = list().length;
    if (!n) return;
    bigIdx = (bigIdx + d + n) % n;
    paintBig();
  }
  document.getElementById('bprev').onclick = function () { step(-1); };
  document.getElementById('bnext').onclick = function () { step(1); };
  // ←/→ 는 확대 중일 때만(오버레이 매니저가 Esc 는 처리)
  document.addEventListener('keydown', function (e) {
    if (!bigOv.isOpen()) return;
    if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
  });

  // ---- 이름 가리기 ----
  document.getElementById('anonBtn').onclick = function () {
    anon = !anon;
    this.classList.toggle('on', anon);
    this.textContent = anon ? '🙈 이름 가림' : '🙈 이름 가리기';
    paint();
    if (bigOv.isOpen()) paintBig();
  };

  // ---- 무작위 뽑기 (룰렛) ----
  var rouling = false;
  document.getElementById('pickBtn').onclick = function () {
    var rows = list();
    if (rouling || !rows.length) return;
    rouling = true;
    if (bigOv.isOpen()) bigOv.close();
    var btn = this;
    btn.disabled = true;
    var target = Math.floor(Math.random() * rows.length);
    var i = 0, ticks = 0;
    var total = rows.length * 2 + target + 6;
    var delay = 60;
    function tick() {
      Object.keys(rendered).forEach(function (n) { rendered[n].classList.remove('roul'); });
      var r = rows[i % rows.length];
      var el = rendered[r.nickname];
      if (el) { el.classList.add('roul'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      i++; ticks++;
      if (ticks >= total) {
        setTimeout(function () {
          Object.keys(rendered).forEach(function (n) { rendered[n].classList.remove('roul'); });
          openBig((i - 1) % rows.length);
          rouling = false; btn.disabled = false;
        }, 420);
        return;
      }
      if (ticks > total - 10) delay += 42;
      setTimeout(tick, delay);
    }
    tick();
  };

  // ---- 공용 도구: 필기 · 스포트라이트 · 타이머 · 도움말 · 전체화면 · 도구 독 ----
  var cv = document.getElementById('drawCv');
  function sizeCv() { var r = cv.parentElement.getBoundingClientRect(); cv.width = r.width; cv.height = r.height; drawing && drawing.resize(); }
  var drawing = PT.createDrawing(cv, {});
  drawing.setOn(false); cv.style.pointerEvents = 'none';
  window.addEventListener('resize', sizeCv); setTimeout(sizeCv, 50);

  var penOn = false;
  document.getElementById('penBtn').onclick = function () {
    penOn = !penOn;
    drawing.setOn(penOn);
    cv.style.pointerEvents = penOn ? 'auto' : 'none';
    this.classList.toggle('on', penOn);
    document.getElementById('drawTools').classList.toggle('on', penOn);
    if (penOn) sizeCv();
  };
  document.querySelectorAll('#drawTools .sw').forEach(function (b) {
    b.onclick = function () {
      document.querySelectorAll('#drawTools .sw').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on'); drawing.setColor(b.getAttribute('data-color'));
      document.getElementById('dEraser').classList.remove('on');
    };
  });
  document.querySelectorAll('#drawTools .dsz').forEach(function (b) {
    b.onclick = function () {
      document.querySelectorAll('#drawTools .dsz').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on'); drawing.setSize(b.getAttribute('data-size'));
    };
  });
  document.getElementById('dEraser').onclick = function () { var on = !this.classList.contains('on'); this.classList.toggle('on', on); drawing.setEraser(on); };
  document.getElementById('dClear').onclick = function () { drawing.clear(); };
  document.getElementById('dKeep').onclick = function () { var k = !drawing.isKeep(); drawing.setKeep(k); this.classList.toggle('on', k); };

  var spot = PT.createSpotlight();
  document.getElementById('spotBtn').onclick = function () { spot.open(); };
  var timer = PT.createTimer();
  document.getElementById('timerBtn').onclick = function () { timer.open(); };
  var help = PT.createHelp([
    ['←/→', '확대에서 이전·다음 답'], ['Esc', '오버레이 닫기'], ['F', '전체화면'],
    ['✕ / 배경클릭 / 뒤로가기', '오버레이 닫기(발표 유지)']
  ]);
  document.getElementById('helpBtn').onclick = function () { help.open(); };
  document.getElementById('fscBtn').onclick = function () { PT.toggleFullscreen(); };
  document.addEventListener('keydown', function (e) {
    var t = (e.target && e.target.tagName) || '';
    if ((e.key === 'f' || e.key === 'F') && t !== 'INPUT' && t !== 'TEXTAREA') { PT.toggleFullscreen(); }
  });

  PT.createDock(document.getElementById('dock'), { idleMs: 5000 });

  load();
  setInterval(function () { if (!rouling) load(); }, 3000);
})();
</script>
</body>
</html>`;
}

// ───────────────── HTML 활동지 — 교사 결과 화면 ─────────────────
// 시험지 대시보드(점수·정답률·보기분포)는 활동지에 쓸 자리가 없다. 활동지는 점수가 없다.
// 여기서 필요한 건 둘뿐이다: (1) 누가 무엇을 썼는가(표) (2) 한 질문에 아이들이 뭐라 썼는가(모아보기).
function renderSheetResultsPage(activity) {
  const title = escapeHtml(activity.title || '활동');
  const activityId = activity.id;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>응답 보기 — ${title}</title>
<style>
  :root { --line: #e2e8f0; --ink: #1a202c; --muted: #718096; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: var(--ink); }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
  .card { background: #fff; border-radius: 12px; padding: 14px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .stat { font-size: 13px; font-weight: 700; color: #2b6cb0; background: #ebf8ff; border-radius: 999px; padding: 5px 12px; }
  .stat.warn { color: #975a16; background: #fffaf0; }
  button { padding: 8px 14px; font-size: 14px; font-weight: 700; border: 1px solid #cbd5e1; background: #f7fafc; border-radius: 8px; cursor: pointer; }
  button.on { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
  button.green { background: #2f855a; color: #fff; border-color: #2f855a; }
  button.red { background: #c53030; color: #fff; border-color: #c53030; }
  .tabs { display: flex; gap: 6px; margin-bottom: 12px; }
  .tblwrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f7fafc; font-size: 12.5px; position: sticky; top: 0; z-index: 2; }
  th.nick, td.nick { position: sticky; left: 0; background: #fff; z-index: 1; font-weight: 700; white-space: nowrap; min-width: 96px; }
  th.nick { background: #f7fafc; z-index: 3; }
  td.cell { max-width: 260px; cursor: pointer; }
  td.cell .clip { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; word-break: break-word; }
  td.cell:hover { background: #ebf8ff; }
  td.empty { color: #cbd5e1; }
  .badge { font-size: 11px; font-weight: 700; border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  .badge.done { background: #c6f6d5; color: #22543d; }
  .badge.live { background: #fefcbf; color: #744210; }
  .muted { color: var(--muted); font-size: 12.5px; }
  /* 필드별 모아보기 */
  .pick { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .pick button { font-size: 13px; }
  .ans { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
  .ans .who { font-size: 12px; font-weight: 700; color: #2b6cb0; margin-bottom: 4px; }
  .ans .txt { white-space: pre-wrap; word-break: break-word; }
  /* 전체 보기 */
  #modal { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; align-items: center; justify-content: center; padding: 20px; z-index: 100; }
  #modal .box { background: #fff; border-radius: 12px; padding: 18px; max-width: 680px; width: 100%; max-height: 80vh; overflow: auto; }
  #modal .who { font-weight: 800; margin-bottom: 2px; }
  #modal .lab { color: var(--muted); font-size: 12.5px; margin-bottom: 10px; }
  #modal .txt { white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.7; }
  #empty { text-align: center; color: var(--muted); padding: 40px 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${title}</h1>
  <div class="sub">HTML 활동지 · 응답 보기</div>

  <div class="card">
    <div class="row">
      <span class="stat" id="stCount">0명</span>
      <span class="stat" id="stDone">제출 0</span>
      <span class="stat warn" id="stClosed" style="display:none;">🔒 마감됨</span>
      <span class="muted" id="stCode"></span>
      <span style="flex:1"></span>
      <button id="csvBtn">⬇ CSV 내려받기</button>
      <button id="closeBtn" class="red">🔒 마감하기</button>
    </div>
  </div>

  <div class="tabs">
    <button id="tabTable" class="on">표로 보기</button>
    <button id="tabField">필드별 모아보기</button>
  </div>

  <div class="card" id="paneTable">
    <div class="tblwrap"><table id="tbl"></table></div>
    <div id="empty">아직 응답이 없어요. 학생이 활동지를 열면 여기에 실시간으로 나타납니다.</div>
    <div class="muted" style="margin-top:8px;">💡 칸을 클릭하면 전체 내용을 볼 수 있어요. 3초마다 자동 새로고침됩니다.</div>
  </div>

  <div class="card" id="paneField" style="display:none;">
    <div class="pick" id="pick"></div>
    <div id="list"></div>
  </div>
</div>

<div id="modal"><div class="box">
  <div class="who" id="mWho"></div>
  <div class="lab" id="mLab"></div>
  <div class="txt" id="mTxt"></div>
  <div style="margin-top:14px;text-align:right;"><button id="mClose">닫기</button></div>
</div></div>

<script>
(function () {
  var ACTIVITY_ID = ${jsonForScript(activityId)};
  var data = null;
  var curField = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 답 한 칸을 사람이 읽는 글로. 체크박스 묶음은 고른 항목 이름으로 편다.
  function show(v, f) {
    if (v == null) return '';
    if (Array.isArray(v)) {
      var opts = (f && f.options) || [];
      return v.map(function (i) { return opts[i] != null ? opts[i] : '#' + (i + 1); }).join(' · ');
    }
    return String(v);
  }

  function load() {
    fetch('/api/sheet/' + ACTIVITY_ID + '/results')
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) { data = d; paint(); } })
      .catch(function () {});
  }

  function collected() { return (data.activity.fields || []).filter(function (f) { return f.collect; }); }

  function paint() {
    var rows = data.rows || [];
    var fs = collected();
    document.getElementById('stCount').textContent = rows.length + '명';
    document.getElementById('stDone').textContent = '제출 ' + rows.filter(function (r) { return r.submitted; }).length;
    document.getElementById('stClosed').style.display = data.activity.closed_at ? '' : 'none';
    document.getElementById('stCode').textContent = data.activity.join_code ? '입장 코드 ' + data.activity.join_code : '';
    document.getElementById('empty').style.display = rows.length ? 'none' : '';

    // ---- 표: 행=학생, 열=필드 ----
    var h = '<thead><tr><th class="nick">학생</th><th>진행</th>';
    fs.forEach(function (f) { h += '<th title="' + esc(f.section) + '">' + esc(f.label) + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function (r, ri) {
      h += '<tr><td class="nick">' + esc(r.nickname) +
        ' <span class="badge ' + (r.submitted ? 'done">제출' : 'live">작성 중') + '</span></td>' +
        '<td class="muted">' + r.filled + '/' + data.total + '</td>';
      fs.forEach(function (f) {
        var t = show(r.answers[f.id], f);
        h += t
          ? '<td class="cell" data-r="' + ri + '" data-f="' + esc(f.id) + '"><div class="clip">' + esc(t) + '</div></td>'
          : '<td class="empty">—</td>';
      });
      h += '</tr>';
    });
    h += '</tbody>';
    document.getElementById('tbl').innerHTML = rows.length ? h : '';

    // ---- 필드별 모아보기 ----
    if (!curField && fs.length) curField = fs[0].id;
    var p = '';
    fs.forEach(function (f) {
      p += '<button data-f="' + esc(f.id) + '" class="' + (f.id === curField ? 'on' : '') + '">' + esc(f.label) + '</button>';
    });
    document.getElementById('pick').innerHTML = p;

    var f = fs.filter(function (x) { return x.id === curField; })[0];
    var l = '';
    if (f) {
      var wrote = rows.filter(function (r) { return show(r.answers[f.id], f).trim(); });
      l += '<div class="muted" style="margin-bottom:8px;">' + esc(f.label) + ' — ' + wrote.length + '명 작성' +
           (f.section ? ' <span style="opacity:.7">· ' + esc(f.section) + '</span>' : '') + '</div>';
      if (!wrote.length) l += '<div id="empty">아직 이 칸에 쓴 학생이 없어요.</div>';
      wrote.forEach(function (r) {
        l += '<div class="ans"><div class="who">' + esc(r.nickname) + '</div><div class="txt">' +
             esc(show(r.answers[f.id], f)) + '</div></div>';
      });
    }
    document.getElementById('list').innerHTML = l;
  }

  // ---- 셀 클릭 → 전체 보기 ----
  document.getElementById('tbl').addEventListener('click', function (e) {
    var td = e.target.closest ? e.target.closest('td.cell') : null;
    if (!td) return;
    var r = data.rows[Number(td.getAttribute('data-r'))];
    var f = collected().filter(function (x) { return x.id === td.getAttribute('data-f'); })[0];
    if (!r || !f) return;
    document.getElementById('mWho').textContent = r.nickname;
    document.getElementById('mLab').textContent = f.label + (f.section ? ' · ' + f.section : '');
    document.getElementById('mTxt').textContent = show(r.answers[f.id], f);
    document.getElementById('modal').style.display = 'flex';
  });
  document.getElementById('mClose').onclick = function () { document.getElementById('modal').style.display = 'none'; };
  document.getElementById('modal').addEventListener('click', function (e) {
    if (e.target.id === 'modal') this.style.display = 'none';
  });

  document.getElementById('pick').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-f]') : null;
    if (!b) return;
    curField = b.getAttribute('data-f');
    paint();
  });

  // ---- 탭 ----
  function tab(which) {
    document.getElementById('tabTable').className = which === 't' ? 'on' : '';
    document.getElementById('tabField').className = which === 'f' ? 'on' : '';
    document.getElementById('paneTable').style.display = which === 't' ? '' : 'none';
    document.getElementById('paneField').style.display = which === 'f' ? '' : 'none';
  }
  document.getElementById('tabTable').onclick = function () { tab('t'); };
  document.getElementById('tabField').onclick = function () { tab('f'); };

  // ---- CSV ----
  // Excel 이 한글을 깨지 않게 BOM 을 붙인다.
  document.getElementById('csvBtn').onclick = function () {
    if (!data) return;
    var fs = collected();
    var head = ['학생', '제출여부', '진행'].concat(fs.map(function (f) { return f.label; }));
    var lines = [head.map(cell).join(',')];
    (data.rows || []).forEach(function (r) {
      var line = [r.nickname, r.submitted ? '제출' : '작성중', r.filled + '/' + data.total]
        .concat(fs.map(function (f) { return show(r.answers[f.id], f); }));
      lines.push(line.map(cell).join(','));
    });
    var blob = new Blob(['\\ufeff' + lines.join('\\r\\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (data.activity.title || '활동지').replace(/[\\\\/:*?"<>|]/g, '_') + '_응답.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };
  function cell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }

  // ---- 마감 ----
  document.getElementById('closeBtn').onclick = function () {
    if (!confirm('지금 마감할까요?\\n\\n미제출 학생의 화면에 있던 내용도 자동으로 제출됩니다.')) return;
    fetch('/api/live/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: ACTIVITY_ID }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return alert('마감 실패: ' + ((d && d.error) || ''));
      alert('마감했어요. 미제출 ' + d.auto_submitted + '명의 내용을 자동 제출했습니다.');
      load();
    });
  };

  load();
  setInterval(load, 3000);
})();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

app.listen(PORT, () => {
  console.log(`[server] 학생 응답 수집 앱 실행 중 → http://localhost:${PORT}`);
});
