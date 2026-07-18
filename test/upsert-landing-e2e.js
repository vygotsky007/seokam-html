// 필드당 최종본 upsert + 닉네임 충돌 + 대문 페이지 검증 (전부 실검증, 키 무관).
//   node test/upsert-landing-e2e.js
const path = require('path'), fs = require('fs'), http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const REAL = path.join(__dirname, 'fixtures', 'real', 'activity_ai_movie_day1.html');
const SYNTH = path.join(__dirname, 'fixtures', 'activity-synth.html');
const FIXTURE = fs.existsSync(REAL) ? REAL : SYNTH;
const DB_PORT = 4272, APP_PORT = 4273;
const APP = 'http://127.0.0.1:' + APP_PORT;
const SHEET = 'sheet-1';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMockDb(state) {
  const app = express(); app.use(express.json({ limit: '20mb' }));
  const rowsOf = (t) => state[t] || (state[t] = []);
  const match = (row, q) => Object.keys(q).every((k) => { if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) return true; const v = String(q[k]); return !v.startsWith('eq.') || String(row[k]) === v.slice(3); });
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
  return new Promise((r) => { const s = app.listen(DB_PORT, () => r(s)); });
}
function startApp() {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { SUPABASE_URL: 'http://127.0.0.1:' + DB_PORT, SUPABASE_SERVICE_KEY: 'k', PORT: String(APP_PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', () => {}); p.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stderr.write('[app] ' + s); });
  return new Promise((res) => { const t = () => http.get(APP + '/api/health', () => res(p)).on('error', () => setTimeout(t, 150)); t(); });
}

(async () => {
  const state = { activities: [], questions: [], submissions: [], live_sessions: [] };
  const db = await startMockDb(state);
  const app = await startApp();
  const browser = await chromium.launch();

  try {
    // 활동지 준비
    const prep = await browser.newPage();
    await prep.goto(APP + '/teacher.html');
    const built = await prep.evaluate((raw) => { const clean = window.sanitizeSheet(raw); const doc = new DOMParser().parseFromString(clean, 'text/html'); const fields = window.SheetFields.detectFields(doc); return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, fields }; }, fs.readFileSync(FIXTURE, 'utf8'));
    await prep.close();
    const cf = built.fields.filter((f) => f.collect);
    state.activities.push({ id: SHEET, title: 'upsert 검증', html_body: built.html, status: 'open', version: 1, view_mode: 'all', kind: 'html_sheet', fields: built.fields, notices: [], closed_at: null, join_code: '1234' });

    // ══════════ 1부 · 대문 페이지 ══════════
    console.log('\n1부 · 대문 페이지 (GET /)');
    const home = await browser.newPage({ viewport: { width: 390, height: 780 } });
    const herr = []; home.on('pageerror', (e) => herr.push(String(e)));
    await home.goto(APP + '/');
    ok('GET / 대문 렌더(문제샘)', /문제샘/.test(await home.textContent('body')));
    ok('학생 코드 입력칸(numeric·자동포커스)', await home.evaluate(() => { const i = document.getElementById('code'); return i && i.getAttribute('inputmode') === 'numeric' && document.activeElement === i; }));
    ok('선생님 [활동 만들기] → teacher.html', await home.evaluate(() => { const a = [...document.querySelectorAll('a')].find((x) => /활동 만들기/.test(x.textContent)); return a && /teacher\.html/.test(a.getAttribute('href')); }));
    // 잘못된 코드
    await home.fill('#code', '12'); await home.click('#go');
    ok('3자리 이하 → 안내', /정확히/.test(await home.textContent('#err')));
    await home.evaluate(() => { document.getElementById('code').value = 'ab'; document.getElementById('code').dispatchEvent(new Event('input')); });
    ok('문자 입력은 자동 제거(숫자만)', (await home.inputValue('#code')) === '');
    // 유효 코드 → /join/:code 이동(서버가 리다이렉트)
    await home.fill('#code', '1234');
    await Promise.all([home.waitForURL(/\/go\//, { timeout: 5000 }).catch(() => {}), home.click('#go')]);
    ok('유효 코드 → 활동으로 입장(/go/)', /\/go\//.test(home.url()), home.url());
    // 기존 라우트 회귀
    ok('회귀: /teacher.html 그대로', (await (await browser.newPage()).goto(APP + '/teacher.html')).ok());
    ok('대문 JS 에러 없음', herr.length === 0, herr.join(' | '));

    // ══════════ 2부 · 필드당 최종본 upsert ══════════
    console.log('\n2부 · 필드당 최종본 (덮어쓰기)');
    const s = await browser.newPage({ viewport: { width: 390, height: 780 } });
    await s.goto(APP + '/go/' + SHEET); await s.waitForSelector('#__mjsBar');
    await s.fill('#__mjsNick', '민준'); await s.locator('#__mjsNick').blur(); await sleep(400);
    const ta = s.locator('textarea[data-fid]').first();
    // 입력 → 지움 → 재입력 반복
    await ta.fill('첫 번째 초안'); await s.waitForFunction(() => document.getElementById('__mjsSave').textContent === '저장됨', null, { timeout: 6000 });
    await ta.fill(''); await sleep(700);
    await ta.fill('두 번째 고침'); await s.waitForFunction(() => document.getElementById('__mjsSave').textContent === '저장됨', null, { timeout: 6000 });
    await ta.fill('최종본입니다'); await s.waitForFunction(() => document.getElementById('__mjsSave').textContent === '저장됨', null, { timeout: 6000 });
    ok('저장 표시가 소극적으로 "저장됨"', /저장됨/.test(await s.textContent('#__mjsSave')));
    // DB: (세션) 당 1행, 최종값만
    const rows = state.live_sessions.filter((x) => x.activity_id === SHEET && x.nickname === '민준');
    ok('DB에 (세션,필드) 당 1행(중간버전 누적 없음)', rows.length === 1, 'rows=' + rows.length);
    ok('DB에 최종값만 저장', rows[0] && rows[0].answers[cf[0].id] === '최종본입니다', JSON.stringify(rows[0] && rows[0].answers[cf[0].id]));
    await s.click('#__mjsSubmit'); await s.waitForFunction(() => /제출 완료/.test(document.getElementById('__mjsSubmit').textContent), null, { timeout: 6000 });
    const subs = state.submissions.filter((x) => x.activity_id === SHEET && x.nickname === '민준');
    ok('제출도 (활동,학생) 당 1행', subs.length === 1, 'subs=' + subs.length);
    // 교사 표·발표 최종값
    const r = await browser.newPage(); await r.goto(APP + '/sheet/' + SHEET); await r.waitForSelector('#stList .st-row');
    await r.locator('#stList .st-row', { hasText: '민준' }).first().click();
    ok('교사 응답 보기에 최종값만', /최종본입니다/.test(await r.locator('#stDetail').textContent()) && !/첫 번째 초안/.test(await r.locator('#stDetail').textContent()));

    // ══════════ 3부 · 닉네임 충돌 ══════════
    console.log('\n3부 · 닉네임 충돌 안내');
    // '민준'은 방금 접속(온라인). 새 학생이 같은 이름으로 입장 시도.
    const b = await browser.newPage({ viewport: { width: 390, height: 780 } });
    await b.goto(APP + '/go/' + SHEET); await b.waitForSelector('#__mjsBar');
    // 확인창 취소(다른 사람) → 이름 비움 + 안내
    b.once('dialog', (d) => { ok('충돌 안내 문구', /이미 "민준"/.test(d.message())); d.dismiss(); });
    await b.fill('#__mjsNick', '민준'); await b.locator('#__mjsNick').blur(); await sleep(600);
    ok('취소 → 이름 비워지고 다른 이름 안내', (await b.inputValue('#__mjsNick')) === '' && /다른 이름/.test(await b.textContent('#__mjsNotice')));
    // 새 이름 = 새 세션(충돌 없음)
    await b.fill('#__mjsNick', '민준2'); await b.locator('#__mjsNick').blur(); await sleep(500);
    ok('새 이름은 충돌 없이 진행', state.live_sessions.some((x) => x.nickname === '민준2'));

    // 이어서 하기(본인) → 기존 답 이어받기
    const c = await browser.newPage({ viewport: { width: 390, height: 780 } });
    await c.goto(APP + '/go/' + SHEET); await c.waitForSelector('#__mjsBar');
    c.once('dialog', (d) => d.accept());   // 이어서 하기
    await c.fill('#__mjsNick', '민준'); await c.locator('#__mjsNick').blur(); await sleep(600);
    ok('이어서 하기 → 기존 답을 불러온다', /최종본입니다/.test(await c.locator('textarea[data-fid]').first().inputValue()));

    // 오프라인이면(접속 끊긴 이름) 충돌 아님 — 확인창 안 뜸
    state.live_sessions.forEach((x) => { if (x.nickname === '민준') x.last_seen = new Date(Date.now() - 60000).toISOString(); });
    const e = await browser.newPage({ viewport: { width: 390, height: 780 } });
    let dlg = false; e.on('dialog', (d) => { dlg = true; d.accept(); });
    await e.goto(APP + '/go/' + SHEET); await e.waitForSelector('#__mjsBar');
    await e.fill('#__mjsNick', '민준'); await e.locator('#__mjsNick').blur(); await sleep(600);
    ok('접속 끊긴 이름은 충돌 아님(확인창 없음)', dlg === false);

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
