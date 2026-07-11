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
    .select('id, title')
    .eq('id', id)
    .single();

  if (error || !activity) {
    return res.status(404).send('<h1>활동을 찾을 수 없습니다.</h1>');
  }
  res.type('html').send(renderPresentPage(activity));
});

function renderPresentPage(activity) {
  const title = escapeHtml(activity.title || '활동');
  const activityId = activity.id;

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
  .nav { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .nav button { min-width: 40px; height: 40px; padding: 0 12px; font-size: 16px; font-weight: 700; border: 1px solid #475569; background: #334155; color: #e2e8f0; border-radius: 8px; cursor: pointer; }
  .nav button.qbtn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  .nav button:disabled { opacity: .4; cursor: default; }
  .live { font-size: 12px; color: #4ade80; margin-left: 8px; white-space: nowrap; }
  .layout { display: flex; height: calc(100vh - 65px); }
  .left { flex: 1 1 62%; padding: 40px; display: flex; flex-direction: column; justify-content: center; }
  .right { flex: 0 0 38%; max-width: 480px; border-left: 1px solid #334155; background: #1e293b; display: flex; flex-direction: column; }
  .qnum { font-size: 20px; color: #60a5fa; font-weight: 700; }
  .qtype { display: inline-block; font-size: 13px; padding: 2px 10px; border-radius: 999px; background: #334155; color: #cbd5e1; margin-left: 10px; vertical-align: middle; }
  .answer-box { margin-top: 24px; }
  .answer-label { font-size: 15px; color: #94a3b8; }
  .answer-val { font-size: 56px; font-weight: 800; color: #f8fafc; margin-top: 8px; line-height: 1.1; word-break: break-word; }
  .answer-essay { font-size: 28px; color: #cbd5e1; }
  .rate { margin-top: 32px; font-size: 18px; color: #cbd5e1; }
  .rate b { color: #4ade80; font-size: 22px; }
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
    <div class="nav" id="nav"></div>
  </div>
  <div class="layout">
    <div class="left" id="left"></div>
    <div class="right">
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
  var state = { questions: [], students: [], curIdx: 0, filter: 'all' };

  function fetchData() {
    return fetch('/api/present/' + ACTIVITY_ID)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || '조회 실패');
        state.questions = data.questions || [];
        state.students = data.students || [];
        if (state.curIdx >= state.questions.length) state.curIdx = 0;
        render();
      })
      .catch(function (err) { console.error(err); });
  }

  function curQ() { return state.questions[state.curIdx]; }

  function isCorrect(stu, num) {
    var c = stu.byNum && stu.byNum[num];
    return c ? c.correct : null; // true/false/null(서술형)
  }

  function render() {
    renderNav();
    renderLeft();
    renderRight();
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
    var prev = document.getElementById('prev'); if (prev) prev.onclick = function () { if (state.curIdx > 0) { state.curIdx--; render(); } };
    var next = document.getElementById('next'); if (next) next.onclick = function () { if (state.curIdx < state.questions.length - 1) { state.curIdx++; render(); } };
    nav.querySelectorAll('.qbtn').forEach(function (b) {
      b.onclick = function () { state.curIdx = parseInt(b.getAttribute('data-i'), 10); render(); };
    });
  }

  function renderLeft() {
    var left = document.getElementById('left');
    var q = curQ();
    if (!q) { left.innerHTML = '<div class="empty">문항이 없습니다.</div>'; return; }
    var typeLabel = q.type === 'choice' ? '객관식' : q.type === 'short' ? '단답' : '서술형';

    // 정답률 (채점 대상만, 서술형 제외)
    var total = 0, correct = 0;
    state.students.forEach(function (s) {
      var c = isCorrect(s, q.num);
      if (c === null) return; // 서술형/미채점
      total++; if (c === true) correct++;
    });
    var rateHtml = q.type === 'essay'
      ? '<div class="rate">서술형 — 정답률 없음 (제출 ' + countAnswered(q.num) + '명)</div>'
      : '<div class="rate">정답률 <b>' + (total ? Math.round(correct / total * 100) : 0) + '%</b> (' + correct + ' / ' + total + ')</div>';

    var ansHtml;
    if (q.type === 'essay') {
      ansHtml = '<div class="answer-val answer-essay">— (서술형: 정답 없음)</div>';
    } else {
      ansHtml = '<div class="answer-val">' + escapeHtml(q.answer || '(정답 미입력)') + '</div>';
    }

    left.innerHTML =
      '<div><span class="qnum">' + q.num + '번 문항</span><span class="qtype">' + typeLabel + '</span></div>' +
      '<div class="answer-box"><div class="answer-label">정답</div>' + ansHtml + '</div>' +
      rateHtml;
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

  fetchData();
  setInterval(fetchData, 5000); // 실시간 갱신
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

app.listen(PORT, () => {
  console.log(`[server] 학생 응답 수집 앱 실행 중 → http://localhost:${PORT}`);
});
