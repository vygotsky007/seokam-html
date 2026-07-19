// AI 정답·풀이 채우기 검증 ([3]).
//   node test/answer-e2e.js
// 승인 게이트·확신낮음 빈칸·정답표 반영·풀이 저장·발표 풀이 보기·마감후 학생 노출은 실검증.
// 실제 Claude 호출만 /api/ai-status·/api/ai-answer 모킹.
const path = require('path'), fs = require('fs'), http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DB_PORT = 4262, APP_PORT = 4263, STATIC_PORT = 4264;
const APP = 'http://127.0.0.1:' + APP_PORT;
const ACT = 'act-3';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- A) 교사 화면 부분: 정적 서버 + AI 모킹 (정답 생성 UI 흐름) ----
let answerCalls = 0;
function startStatic() {
  const app = express(); app.use(express.json({ limit: '8mb' }));
  app.get('/api/ai-status', (req, res) => res.json({ ok: true, enabled: true, model: 'mock', limit: 200, used: answerCalls, remaining: 200 - answerCalls }));
  app.post('/api/ai-answer', (req, res) => {
    answerCalls++;
    const num = Number(req.body && req.body.num);
    // 2번은 확신 낮음(정답 비움), 나머지는 확신 높음
    if (num === 2) res.json({ ok: true, parsed: { answer: '', solution: '그림이 필요해 확신 어려움', confidence: 'low' }, used: answerCalls, limit: 200 });
    else res.json({ ok: true, parsed: { answer: '②', solution: num + '번 풀이: ②가 정답인 이유', confidence: 'high' }, used: answerCalls, limit: 200 });
  });
  app.get('/api/activities', (req, res) => res.json({ ok: true, activities: [] }));
  app.use('/lib', express.static(path.join(ROOT, 'lib')));
  app.use(express.static(path.join(ROOT, 'public')));
  return new Promise((r) => { const s = app.listen(STATIC_PORT, () => r(s)); });
}

// ---- B) 서버 부분: 모의 PostgREST + 진짜 server.js (저장·발표·학생) ----
function startMockDb(state) {
  const app = express(); app.use(express.json({ limit: '20mb' }));
  const rowsOf = (t) => state[t] || (state[t] = []);
  const match = (row, q) => Object.keys(q).every((k) => { if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) return true; const v = String(q[k]); return !v.startsWith('eq.') || String(row[k]) === v.slice(3); });
  const reply = (req, res, rows) => (req.headers.accept || '').includes('pgrst.object') ? res.json(rows[0] || null) : res.json(rows);
  app.get('/rest/v1/:table', (req, res) => reply(req, res, rowsOf(req.params.table).filter((r) => match(r, req.query))));
  app.post('/rest/v1/:table', (req, res) => { const t = req.params.table, body = Array.isArray(req.body) ? req.body : [req.body]; const out = body.map((row, i) => Object.assign({ id: t + '-' + (rowsOf(t).length + i + 1) }, row)); rowsOf(t).push(...out); reply(req, res, out); });
  app.patch('/rest/v1/:table', (req, res) => { const hits = rowsOf(req.params.table).filter((r) => match(r, req.query)); hits.forEach((r) => Object.assign(r, req.body)); reply(req, res, hits); });
  return new Promise((r) => { const s = app.listen(DB_PORT, () => r(s)); });
}
function startApp() {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { SUPABASE_URL: 'http://127.0.0.1:' + DB_PORT, SUPABASE_SERVICE_KEY: 'k', PORT: String(APP_PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', () => {}); p.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stderr.write('[app] ' + s); });
  return new Promise((res) => { const t = () => http.get(APP + '/api/health', () => res(p)).on('error', () => setTimeout(t, 150)); t(); });
}

(async () => {
  const state = { activities: [], questions: [], submissions: [], live_sessions: [] };
  const stat = await startStatic();
  const db = await startMockDb(state);
  const app = await startApp();
  const browser = await chromium.launch();

  try {
    // ══════════ 1부 · 교사 정답·풀이 채우기(정적+모킹) ══════════
    console.log('\n1부 · AI 정답·풀이 채우기 + 승인 게이트');
    const t = await browser.newPage();
    const terr = []; t.on('pageerror', (e) => terr.push(String(e)));
    t.on('dialog', (d) => d.accept());
    await t.goto('http://127.0.0.1:' + STATIC_PORT + '/teacher.html');
    await sleep(200);
    // 문항표 3개 + qHtml(정답 생성용 텍스트)
    await t.evaluate(() => {
      window.revealExam();   // 업로드 없이 정답 단계로 바로 진입(편집 영역 펼치기)
      document.getElementById('qcount').value = '3';
      window.buildRows();
      window.qHtml = {};
      for (var n = 1; n <= 3; n++) window.qHtml[n] = { parsed: { number: n, stem: n + '번 발문', passage: '', choices: [{ marker: '①', text: '가' }, { marker: '②', text: '나' }], type: 'choice', images: [] }, useImage: false };
      window.aiStatus = { enabled: true, checked: true, limit: 200, used: 0 };
    });
    answerCalls = 0;
    await t.click('#aiAnswerBtn');
    await t.waitForFunction(() => window.answerGenRunning === false && document.getElementById('answerGenPanel').style.display !== 'none', null, { timeout: 8000 });
    ok('문항당 1회 호출(3회)', answerCalls === 3, 'calls=' + answerCalls);
    ok('제안 패널 렌더', (await t.locator('#answerGenPanel .agitem').count()) === 3);
    ok('확신 낮은 2번은 정답 비움 + 직접입력 권장', /확신 낮음/.test(await t.locator('#answerGenPanel .agitem').nth(1).textContent()));
    ok('풀이가 제안에 표시', /②가 정답인 이유/.test(await t.locator('#answerGenPanel').textContent()));
    // 승인 전에는 정답표 비어 있음
    ok('승인 전 정답표 1번 비어 있음', (await t.locator('.q-answer[data-num="1"]').inputValue()) === '');
    // 1번 승인 → 정답표 반영
    await t.locator('#answerGenPanel .agitem').first().locator('button[data-ag="approve"]').click();
    await sleep(150);
    ok('승인 → 정답표에 정답 반영', (await t.locator('.q-answer[data-num="1"]').inputValue()) === '②');
    ok('승인 → solutionOf 저장', await t.evaluate(() => window.solutionOf[1] === '1번 풀이: ②가 정답인 이유'));
    // collectQuestions 에 solution 포함
    ok('collectQuestions 가 solution 을 싣는다', await t.evaluate(() => { var qs = window.collectQuestions(); var q1 = qs.find(function (x) { return x.num === 1; }); return q1 && q1.solution === '1번 풀이: ②가 정답인 이유'; }));
    // 승인 취소 → solution 제거
    await t.locator('#answerGenPanel .agitem').first().locator('button[data-ag="approve"]').click();
    await sleep(150);
    ok('승인 취소 → solutionOf 제거', await t.evaluate(() => window.solutionOf[1] === undefined));
    ok('교사 화면 JS 에러 없음', terr.length === 0, terr.join(' | '));

    // ══════════ 2부 · 발표 풀이 보기 + 학생 노출 토글(진짜 server) ══════════
    console.log('\n2부 · 발표 풀이 보기 + 마감후 학생 노출');
    state.activities.push({ id: ACT, title: '풀이 활동', html_body: '<p>1. <input name="q1"></p>', status: 'open', version: 1, view_mode: 'single', kind: 'exam', fields: [], notices: [], closed_at: null, show_solutions: false });
    state.questions.push(
      { id: 'q1', activity_id: ACT, num: 1, type: 'choice', answer: '②', graded: true, solution: '1번 풀이입니다', slice_image: null, html_content: '<p data-num="1">1. 문제 ① 가 ② 나</p>', meta: {} },
      { id: 'q2', activity_id: ACT, num: 2, type: 'short', answer: '물', graded: true, solution: '2번 풀이입니다', slice_image: null, html_content: '<p data-num="2">2. 답을 쓰시오</p>', meta: {} }
    );
    state.submissions.push({ id: 's1', activity_id: ACT, nickname: '가영', answers: { q1: '②' }, manual_correct: {}, auto_score: 1, created_at: new Date().toISOString() });

    const pr = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const perr = []; pr.on('pageerror', (e) => perr.push(String(e)));
    await pr.goto(APP + '/present/' + ACT);
    await pr.waitForSelector('#answerBtn');
    await pr.click('#answerBtn');
    await pr.waitForSelector('#qAnswer', { state: 'visible' });
    ok('발표에 [풀이 보기] 버튼', (await pr.locator('#solToggle').count()) === 1);
    ok('풀이는 기본 숨김', (await pr.locator('.soltext').count()) === 0);
    await pr.click('#solToggle');
    ok('[풀이 보기] → 풀이 표시', /1번 풀이입니다/.test(await pr.locator('.soltext').textContent()));
    // 마감 전엔 학생 공개 토글 없음
    ok('마감 전엔 학생 공개 토글 없음', (await pr.locator('#solPub').count()) === 0);

    // 마감 → 학생 공개 토글 등장
    await fetch(APP + '/api/live/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activityId: ACT }) });
    await pr.reload(); await pr.click('#answerBtn'); await pr.waitForSelector('#qAnswer', { state: 'visible' });
    await pr.click('#solToggle');
    ok('마감 후 학생 공개 토글 등장', (await pr.locator('#solPub').count()) === 1);

    // ---- 학생: 마감 전엔 풀이 안 보임 ----
    const stu1 = await browser.newPage();
    await stu1.goto(APP + '/go/' + ACT);
    await stu1.waitForSelector('#slide');
    ok('학생: 공개 전(마감됐지만 토글 꺼짐) 풀이 안 보임', (await stu1.locator('.qsolution').count()) === 0);

    // 교사가 공개 토글 ON
    await pr.locator('#solPub').check();
    await sleep(400);
    ok('공개 토글이 서버에 저장됨', state.activities.find((a) => a.id === ACT).show_solutions === true);

    // ---- 학생: 마감 + 공개 후 풀이 보임 ----
    const stu2 = await browser.newPage();
    await stu2.goto(APP + '/go/' + ACT);
    await stu2.waitForSelector('#slide');
    ok('학생: 마감+공개 후 풀이 표시', /1번 풀이입니다/.test(await stu2.locator('.qsolution').textContent()));

    ok('발표·학생 JS 에러 없음', perr.length === 0, perr.join(' | '));

  } catch (e) {
    fail++; console.error('\n💥 예외:', e && e.stack ? e.stack : e);
  } finally {
    await browser.close(); app.kill(); db.close(); stat.close();
  }
  console.log('\n──────────────────────────────');
  console.log('  통과 ' + pass + ' · 실패 ' + fail);
  console.log('──────────────────────────────');
  process.exit(fail ? 1 : 0);
})();
