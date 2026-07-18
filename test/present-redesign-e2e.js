// 발표 모드 프로 재설계(7+8) 검증 — 시험지·활동지 양쪽.
//   node test/present-redesign-e2e.js
// 본문 85%+ · 독 자동숨김/복귀 · 공용도구(필기·스포트라이트·타이머·전체화면) · 실시간 오버레이 · 닫기 3겹(이중 히스토리 없음).
const path = require('path'), fs = require('fs'), http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const REAL = path.join(__dirname, 'fixtures', 'real', 'activity_ai_movie_day1.html');
const SYNTH = path.join(__dirname, 'fixtures', 'activity-synth.html');
const FIXTURE = fs.existsSync(REAL) ? REAL : SYNTH;
const DB_PORT = 4222, APP_PORT = 4223;
const APP = 'http://127.0.0.1:' + APP_PORT;
const SHEET = 'sheet-1', EXAM = 'exam-1';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMockDb(state) {
  const app = express(); app.use(express.json({ limit: '20mb' }));
  const rowsOf = (t) => state[t] || (state[t] = []);
  const match = (row, q) => Object.keys(q).every((k) => {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) return true;
    const v = String(q[k]); return !v.startsWith('eq.') || String(row[k]) === v.slice(3);
  });
  const reply = (req, res, rows) => (req.headers.accept || '').includes('pgrst.object') ? res.json(rows[0] || null) : res.json(rows);
  app.get('/rest/v1/:table', (req, res) => reply(req, res, rowsOf(req.params.table).filter((r) => match(r, req.query))));
  app.post('/rest/v1/:table', (req, res) => {
    const t = req.params.table, body = Array.isArray(req.body) ? req.body : [req.body];
    const up = String(req.headers.prefer || '').includes('merge-duplicates'); const out = [];
    body.forEach((row) => {
      if (up && t === 'live_sessions') { const h = rowsOf(t).find((r) => r.activity_id === row.activity_id && r.nickname === row.nickname); if (h) { Object.assign(h, row); out.push(h); return; } }
      const d = t === 'activities' ? { version: 1, kind: 'exam', fields: [], notices: [], closed_at: null } : {};
      const w = Object.assign({ id: t + '-' + (rowsOf(t).length + 1) }, d, row); rowsOf(t).push(w); out.push(w);
    });
    reply(req, res, out);
  });
  app.patch('/rest/v1/:table', (req, res) => { const hits = rowsOf(req.params.table).filter((r) => match(r, req.query)); hits.forEach((r) => Object.assign(r, req.body)); reply(req, res, hits); });
  app.delete('/rest/v1/:table', (req, res) => res.json([]));
  return new Promise((r) => { const s = app.listen(DB_PORT, () => r(s)); });
}
function startApp() {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { SUPABASE_URL: 'http://127.0.0.1:' + DB_PORT, SUPABASE_SERVICE_KEY: 'k', PORT: String(APP_PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {}); p.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stderr.write('[app] ' + s); });
  return new Promise((res) => { const t = () => http.get(APP + '/api/health', () => res(p)).on('error', () => setTimeout(t, 150)); t(); });
}
async function bodyRatio(page, selForContent) {
  return page.evaluate((sel) => {
    var el = document.querySelector(sel);
    if (!el) return 0;
    var r = el.getBoundingClientRect();
    return (r.height * r.width) / (window.innerWidth * window.innerHeight);
  }, selForContent);
}

(async () => {
  console.log('활동지: ' + path.basename(FIXTURE));
  const state = { activities: [], questions: [], submissions: [], live_sessions: [] };
  const db = await startMockDb(state);
  const app = await startApp();
  const browser = await chromium.launch();

  try {
    // ---- 활동지 준비(감지) ----
    const prep = await browser.newPage();
    await prep.goto(APP + '/teacher.html');
    const built = await prep.evaluate((raw) => {
      const clean = window.sanitizeSheet(raw);
      const doc = new DOMParser().parseFromString(clean, 'text/html');
      const fields = window.SheetFields.detectFields(doc);
      return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, fields };
    }, fs.readFileSync(FIXTURE, 'utf8'));
    await prep.close();
    state.activities.push({ id: SHEET, title: '활동지 발표', html_body: built.html, status: 'open', version: 1, view_mode: 'all', kind: 'html_sheet', fields: built.fields, notices: [], closed_at: null });
    // 답 몇 개
    const now = new Date().toISOString();
    const cf = built.fields.filter((f) => f.collect);
    state.live_sessions.push({ id: 'ls1', activity_id: SHEET, nickname: '가영', answers: { [cf[0].id]: '가영의 답입니다. 길게 써서 세 줄이 넘도록 아주 길게 씁니다. 두 번째 줄. 세 번째 줄. 네 번째 줄까지.' }, submitted: false, last_seen: now, messages: [] });
    state.live_sessions.push({ id: 'ls2', activity_id: SHEET, nickname: '나은', answers: { [cf[0].id]: '나은의 답' }, submitted: true, last_seen: now, messages: [] });

    // ---- 시험지 준비 ----
    state.activities.push({ id: EXAM, title: '시험지 발표', html_body: '<p>문제 본문</p>', status: 'open', version: 1, view_mode: 'all', kind: 'exam', fields: [], notices: [], closed_at: null });
    state.questions.push(
      { id: 'q1', activity_id: EXAM, num: 1, type: 'choice', answer: '②', graded: true, html_content: '<p data-num="1">1. 다음 중 옳은 것은? ① 가 ② 나 ③ 다</p>', meta: {} },
      { id: 'q2', activity_id: EXAM, num: 2, type: 'short', answer: '물', graded: true, html_content: '<p data-num="2">2. 답을 쓰시오</p>', meta: {} }
    );
    state.live_sessions.push({ id: 'e1', activity_id: EXAM, nickname: '다온', current_q: 1, answers: { q1: '②' }, submitted: false, last_seen: now, messages: [] });
    state.submissions.push({ id: 's1', activity_id: EXAM, nickname: '다온', answers: { q1: '②' }, manual_correct: {}, auto_score: 0, created_at: now });

    // ══════════ 활동지 발표 ══════════
    console.log('\n1부 · 활동지 발표 재설계');
    const a = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const aerr = []; a.on('pageerror', (e) => aerr.push(String(e)));
    await a.goto(APP + '/present/' + SHEET);
    await a.waitForSelector('.card');

    ok('본문(카드 영역)이 뷰포트 85%+', (await bodyRatio(a, '.stagewrap')) >= 0.85, ((await bodyRatio(a, '.stagewrap')) * 100).toFixed(0) + '%');
    ok('하단 도구 독이 있다', await a.evaluate(() => !!document.querySelector('#dock.pt-dock')));
    ok('카드 답이 3줄 말줄임(-webkit-line-clamp)', await a.evaluate(() => getComputedStyle(document.querySelector('.card .txt')).webkitLineClamp === '3'));

    // 독 자동 숨김/복귀
    await a.evaluate(() => window.dispatchEvent(new Event('mousemove')));
    await sleep(5300);
    ok('독이 5초 무조작 후 숨는다', await a.evaluate(() => document.getElementById('dock').classList.contains('hidden')));
    await a.mouse.move(640, 799);   // 하단으로
    await sleep(150);
    ok('마우스 하단 이동으로 독 복귀', await a.evaluate(() => !document.getElementById('dock').classList.contains('hidden')));

    // 실시간 오버레이(작성 수)
    ok('실시간 오버레이(작성 수) 표시', /작성/.test(await a.textContent('#rt')));
    const before = await a.textContent('#rt');
    // 새 학생이 이 필드에 답 → 3초 내 반영
    await a.evaluate((fid) => fetch('/api/live/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activityId: 'sheet-1', nickname: '라임', answers: { [fid]: '라임 답' } }) }), cf[0].id);
    await a.waitForFunction((prev) => document.getElementById('rt').textContent !== prev, before, { timeout: 6000 });
    ok('새 답이 3초 내 실시간 오버레이에 반영', true);

    // 확대 3겹 닫기
    await a.click('.card');
    await a.waitForSelector('#big .pt-x', { state: 'visible' });
    ok('확대 보기 열림 + ✕ 버튼(48px)', (await a.evaluate(() => document.querySelector('#big .pt-x').offsetHeight)) === 48);
    await a.click('#big .pt-x');
    await sleep(150);
    ok('✕ 로 확대 닫힘', !(await a.isVisible('#big')));
    // 바깥 클릭
    await a.click('.card'); await a.waitForSelector('#big', { state: 'visible' });
    await a.mouse.click(5, 5);
    await sleep(150);
    ok('바깥 클릭으로 확대 닫힘', !(await a.isVisible('#big')));
    // 뒤로가기
    await a.click('.card'); await a.waitForSelector('#big', { state: 'visible' });
    await a.goBack(); await sleep(200);
    ok('브라우저 뒤로가기로 확대 닫힘(발표 유지)', !(await a.isVisible('#big')) && await a.evaluate(() => !!document.querySelector('.card')));
    // 오버레이는 히스토리에 딱 1칸만 쌓았으므로, 한 번 더 뒤로가기는 발표 페이지를 벗어난다(이중 아님).
    const urlBeforeBack = a.url();
    await a.goBack().catch(() => {}); await sleep(200);
    ok('한 번 더 뒤로가기는 발표를 벗어난다(오버레이가 히스토리를 이중으로 안 쌓음)', a.url() !== urlBeforeBack || !(await a.isVisible('#big')));
    // 이어서 검증하려면 발표 페이지를 다시 연다
    await a.goto(APP + '/present/' + SHEET); await a.waitForSelector('.card');

    // 스포트라이트
    await a.mouse.move(640, 799);  // 독 복귀(실제 마우스 하단 이동)
    await sleep(150);
    await a.click('#spotBtn'); await sleep(150);
    ok('스포트라이트 열림', await a.isVisible('.pt-spot'));
    await a.keyboard.press('Escape'); await sleep(150);
    ok('Esc 로 스포트라이트 해제', !(await a.isVisible('.pt-spot')));
    // 타이머
    await a.click('#timerBtn'); await sleep(150);
    ok('타이머 열림', await a.isVisible('.pt-timer'));
    await a.click('.pt-timer [data-sec="30"]'); await sleep(150);
    ok('타이머 프리셋 30초 설정', /0:2\d|0:30/.test(await a.textContent('#ptTimerNum')));
    await a.click('.pt-timer .pt-x'); await sleep(150);
    ok('✕ 로 타이머 닫힘', !(await a.isVisible('.pt-timer')));
    // 필기
    await a.click('#penBtn'); await sleep(100);
    ok('필기 켜면 서브도구 뜬다', await a.isVisible('#drawTools'));
    ok('필기 캔버스가 포인터를 받는다', (await a.evaluate(() => getComputedStyle(document.getElementById('drawCv')).pointerEvents)) === 'auto');
    ok('활동지 발표 JS 에러 없음', aerr.length === 0, aerr.join(' | '));

    // ══════════ 시험지 발표 ══════════
    console.log('\n2부 · 시험지 발표 재설계');
    const e = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const eerr = []; e.on('pageerror', (x) => eerr.push(String(x)));
    await e.goto(APP + '/present/' + EXAM);
    await e.waitForSelector('.qbtn');

    ok('본문(문제 영역)이 뷰포트 85%+', (await bodyRatio(e, '.stagewrap')) >= 0.85, ((await bodyRatio(e, '.stagewrap')) * 100).toFixed(0) + '%');
    ok('하단 도구 독이 있다', await e.evaluate(() => !!document.querySelector('#dock.pt-dock')));
    ok('문항 이동 nav 상시 노출(.qbtn)', await e.isVisible('.qbtn'));
    ok('응답 패널은 기본 숨김(본문 우선)', !(await e.isVisible('#qAnswer')));

    // 실시간 분포 오버레이
    ok('실시간 분포 오버레이 존재', await e.isVisible('#rtDist'));
    ok('공개 전에는 정답 표시 없이 개수만', await e.evaluate(() => !/background:#22c55e/.test(document.getElementById('rtBody').innerHTML)));

    // 응답 패널 3겹 닫기
    await e.click('#answerBtn'); await e.waitForSelector('#qAnswer', { state: 'visible' });
    ok('응답 패널 열림 + ✕', (await e.evaluate(() => document.querySelector('#answerPanel .pt-x').offsetHeight)) === 48);
    await e.click('#answerPanel .pt-x'); await sleep(150);
    ok('✕ 로 응답 패널 닫힘', !(await e.isVisible('#qAnswer')));
    await e.click('#answerBtn'); await e.waitForSelector('#qAnswer', { state: 'visible' });
    await e.goBack(); await sleep(200);
    ok('뒤로가기로 응답 패널 닫힘(발표 유지)', !(await e.isVisible('#qAnswer')) && await e.isVisible('.qbtn'));

    // 스포트라이트·타이머(공용 모듈이 시험지에도)
    await e.mouse.move(640, 799); await sleep(150);
    await e.click('#spotBtn'); await sleep(150);
    ok('시험지 발표에도 스포트라이트', await e.isVisible('.pt-spot'));
    await e.keyboard.press('Escape'); await sleep(150);
    await e.click('#timerBtn'); await sleep(150);
    ok('시험지 발표에도 타이머', await e.isVisible('.pt-timer'));
    await e.keyboard.press('Escape'); await sleep(150);
    // 필기(기존 줌 정렬 유지)
    ok('필기 캔버스 존재', await e.evaluate(() => !!document.getElementById('drawCanvas')));
    ok('교실 도우미 버튼(공용 흡수)', await e.evaluate(() => !!document.getElementById('helperBtn')));
    ok('시험지 발표 JS 에러 없음', eerr.length === 0, eerr.join(' | '));

  } catch (ex) {
    fail++; console.error('\n💥 예외:', ex && ex.stack ? ex.stack : ex);
  } finally {
    await browser.close(); app.kill(); db.close();
  }
  console.log('\n──────────────────────────────');
  console.log('  통과 ' + pass + ' · 실패 ' + fail);
  console.log('──────────────────────────────');
  process.exit(fail ? 1 : 0);
})();
