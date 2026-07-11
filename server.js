// 진입점 — 학생 응답 수집 앱 (2단계: 교사 등록 + 학생 응시 + 자동채점)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const supabase = require('./db');
const submitRouter = require('./routes/submit');
const activitiesRouter = require('./routes/activities');

const app = express();
const PORT = process.env.PORT || 4002;

app.use(cors()); // 학생 HTML이 다른 출처에서 fetch 가능하도록 허용
app.use(express.json({ limit: '2mb' })); // 교사가 붙여넣는 HTML 대비 여유
app.use(express.static(path.join(__dirname, 'public')));

// 배포 확인용
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// 제출/조회 + 교사 활동 API
app.use('/api', submitRouter);
app.use('/api', activitiesRouter);

// 학생 응시 페이지 — 교사 html_body 위에 닉네임칸, 아래에 제출버튼을 서버가 얹어 렌더
app.get('/go/:id', async (req, res) => {
  const { id } = req.params;

  const { data: activity, error } = await supabase
    .from('activities')
    .select('id, title, html_body, status, version')
    .eq('id', id)
    .single();

  if (error || !activity) {
    return res.status(404).send('<h1>활동을 찾을 수 없습니다.</h1>');
  }

  res.type('html').send(renderStudentPage(activity));
});

// 발표 모드 — 문항별 좌우분할·정오필터·익명번호·실시간 폴링
app.get('/present/:id', async (req, res) => {
  const { id } = req.params;
  const { data: activity, error } = await supabase
    .from('activities')
    .select('id, title, html_body')
    .eq('id', id)
    .single();

  if (error || !activity) {
    return res.status(404).send('<h1>활동을 찾을 수 없습니다.</h1>');
  }
  res.type('html').send(renderPresentPage(activity));
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

function renderPresentPage(activity) {
  const title = escapeHtml(activity.title || '활동');
  const activityId = activity.id;
  const body = activity.html_body || '';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>발표 모드 — ${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; height: 100vh; overflow: hidden; }
  .topbar { display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: #1e293b; border-bottom: 1px solid #334155; }
  .topbar h1 { font-size: 16px; margin: 0; color: #94a3b8; font-weight: 600; }
  .participation { font-size: 14px; font-weight: 800; color: #4ade80; background: #14321f; border: 1px solid #22c55e44; padding: 5px 12px; border-radius: 999px; }
  .nav { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; }
  .reveal-row { padding: 10px 16px 0; }
  .reveal-row button { width: 100%; padding: 10px; font-size: 14px; font-weight: 800; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  .reveal-row button.revealed { background: #22543d; border-color: #22c55e; color: #d1fae5; }
  .nav button { min-width: 40px; height: 40px; padding: 0 12px; font-size: 16px; font-weight: 700; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  .nav button.qbtn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  .nav button:disabled { opacity: .4; cursor: default; }
  .live { font-size: 12px; color: #4ade80; margin-left: 8px; white-space: nowrap; }
  .layout { display: flex; height: calc(100vh - 65px); }

  /* 왼쪽: 문제 크게 + 필기 캔버스 오버레이 */
  .left { flex: 1 1 68%; min-width: 0; display: flex; flex-direction: column; }
  .draw-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #1e293b; border-bottom: 1px solid #334155; flex-wrap: wrap; }
  .draw-toolbar button { height: 34px; min-width: 34px; padding: 0 10px; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 700; }
  .draw-toolbar .tb-color { width: 34px; padding: 0; }
  .tb-color.red { background: #ef4444; } .tb-color.blue { background: #3b82f6; } .tb-color.black { background: #111827; }
  .draw-toolbar button.active { outline: 2px solid #60a5fa; outline-offset: 1px; }
  .tb-sep { width: 1px; height: 24px; background: #475569; margin: 0 2px; }
  .tb-label { font-size: 12px; color: #94a3b8; }
  .problem-wrap { position: relative; flex: 1; overflow: auto; background: #0f172a; }
  .problem-content { background: #fff; color: #111; padding: 28px; min-height: 100%; font-size: 21px; line-height: 1.6; }
  .problem-content img { max-width: 100%; height: auto; }
  #drawCanvas { position: absolute; top: 0; left: 0; z-index: 10; touch-action: none; }

  /* 오른쪽: 정답·정답률·필터·목록 (기존 유지) */
  .right { flex: 0 0 32%; max-width: 520px; border-left: 1px solid #334155; background: #1e293b; display: flex; flex-direction: column; }
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
  .empty { color: #64748b; padding: 24px; text-align: center; }
</style>
</head>
<body>
  <div class="topbar">
    <h1>🎬 발표 모드 · ${title}</h1>
    <span class="participation" id="participation">🙋 제출 0명</span>
    <div class="nav" id="nav"></div>
  </div>
  <div class="layout">
    <div class="left">
      <div class="draw-toolbar">
        <span class="tb-label">필기</span>
        <button id="tbToggle" class="active" title="필기 켜기/끄기">✏️ ON</button>
        <span class="tb-sep"></span>
        <button class="tb-color red active" data-color="#ef4444" title="빨강"></button>
        <button class="tb-color blue" data-color="#3b82f6" title="파랑"></button>
        <button class="tb-color black" data-color="#111827" title="검정"></button>
        <span class="tb-sep"></span>
        <button class="tb-size active" data-size="3" title="얇게">얇게</button>
        <button class="tb-size" data-size="9" title="굵게">굵게</button>
        <span class="tb-sep"></span>
        <button id="tbEraser" title="지우개">지우개</button>
        <button id="tbClear" title="전체 지우기">전체 지우기</button>
      </div>
      <div class="problem-wrap" id="problemWrap">
        <div class="problem-content" id="problemContent">
${body}
        </div>
        <canvas id="drawCanvas"></canvas>
      </div>
    </div>
    <div class="right">
      <div class="reveal-row">
        <button id="revealBtn" title="정답 공개/가리기">🙈 정답 가림 — 공개하기</button>
      </div>
      <div class="q-answer" id="qAnswer"></div>
      <div class="filters">
        <button data-f="all" class="active">전체</button>
        <button data-f="correct">맞은 사람</button>
        <button data-f="wrong">틀린 사람</button>
      </div>
      <div class="panel-head" id="panelHead">응답 현황</div>
      <div class="list" id="list"></div>
    </div>
  </div>

<script>
(function () {
  var ACTIVITY_ID = ${JSON.stringify(activityId)};
  var state = { questions: [], students: [], curIdx: 0, filter: 'all', reveal: false };

  function fetchData() {
    return fetch('/api/present/' + ACTIVITY_ID)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || '조회 실패');
        state.questions = data.questions || [];
        state.students = data.students || [];
        if (state.curIdx >= state.questions.length) state.curIdx = 0;
        render(); // 오른쪽 통계만 갱신(왼쪽 문제·필기는 건드리지 않음)
      })
      .catch(function (err) { console.error(err); });
  }

  function curQ() { return state.questions[state.curIdx]; }
  function isCorrect(stu, num) { var c = stu.byNum && stu.byNum[num]; return c ? c.correct : null; }

  function render() { renderParticipation(); renderNav(); renderAnswer(); renderRight(); }

  // 실시간 참여 현황 바
  function renderParticipation() {
    document.getElementById('participation').textContent = '🙋 제출 ' + state.students.length + '명';
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
      valHtml = '<div class="val" style="letter-spacing:4px;color:#64748b">●●●</div>';
    } else {
      valHtml = '<div class="val">' + escapeHtml(q.answer || '(정답 미입력)') + '</div>';
    }

    el.innerHTML =
      '<div><span class="qnum">' + q.num + '번 문항</span><span class="qtype">' + typeLabel + '</span></div>' +
      '<div class="lbl">정답</div>' + valHtml + rateHtml;
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
    rows.forEach(function (s) {
      var cell = s.byNum && s.byNum[q.num];
      var given = cell ? (cell.given || '') : '';
      var c = cell ? cell.correct : null;
      var cls = c === true ? 'correct' : c === false ? 'wrong' : 'neutral';
      var mark = c === true ? '<span class="mark ok">✔</span>' : c === false ? '<span class="mark no">✘</span>' : '<span class="mark">·</span>';
      html += '<div class="item ' + cls + '">' +
        '<div class="no">' + s.no + '번</div>' +
        '<div class="ans">' + (given ? escapeHtml(given) : '<i style="color:#64748b">무응답</i>') + '</div>' +
        mark + '</div>';
    });
    list.innerHTML = html;
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
  var pen = { on: true, color: '#ef4444', size: 3, eraser: false };
  var drawing = false, last = null;

  function fitCanvas() {
    var w = content.scrollWidth, h = Math.max(content.scrollHeight, wrap.clientHeight);
    canvas.width = w; canvas.height = h;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  }
  function clearCanvas() { ctx.clearRect(0, 0, canvas.width, canvas.height); }
  function point(e) { return { x: e.offsetX, y: e.offsetY }; }
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

  // 필기 on/off: off 면 캔버스가 클릭·스크롤을 통과시킴
  function applyPenMode() {
    canvas.style.pointerEvents = pen.on ? 'auto' : 'none';
    var t = document.getElementById('tbToggle');
    t.textContent = pen.on ? '✏️ ON' : '✏️ OFF';
    t.classList.toggle('active', pen.on);
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
</style>
</head>
<body>
<div class="wrap">
  <div id="__updateBanner">🔔 선생님이 문제를 수정했어요. <button id="__reloadBtn" type="button">새로고침</button></div>
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
    html += '<p class="score">채점 결과: ' + score + ' / ' + gradable + '</p>';
    html += '<ul>';
    results.forEach(function (r) {
      if (r.correct === null) {
        html += '<li class="skip">' + r.num + '번 (서술형) — 선생님이 확인합니다</li>';
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
<title>결과 대시보드 — ${title}</title>
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

app.listen(PORT, () => {
  console.log(`[server] 학생 응답 수집 앱 실행 중 → http://localhost:${PORT}`);
});
