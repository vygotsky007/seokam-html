// 다필드 활동지(B) 검증 — 25필드 합성 활동 + 학생 창 2개.
//   node test/sheet-manyfields-e2e.js
// 그룹 추출 · 학생 카드 보기·표 그룹 접기 · 진행 막대 자동 전환 · 발표 2단 탭 · 세션 병합/숨기기(자동 병합 없음).
const path = require('path'), fs = require('fs'), http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const BIG = path.join(__dirname, 'fixtures', 'activity-synth-big.html');
const DB_PORT = 4232, APP_PORT = 4233;
const APP = 'http://127.0.0.1:' + APP_PORT;
const MANY = 'many-1', FEW = 'few-1';

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
      const d = t === 'activities' ? { version: 1, kind: 'exam', fields: [], notices: [], closed_at: null, hidden_sessions: [], session_merges: [] } : {};
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

(async () => {
  const state = { activities: [], questions: [], submissions: [], live_sessions: [] };
  const db = await startMockDb(state);
  const app = await startApp();
  const browser = await chromium.launch();

  try {
    // ---- 25필드 활동 감지 ----
    const prep = await browser.newPage();
    await prep.goto(APP + '/teacher.html');
    const built = await prep.evaluate((raw) => {
      const clean = window.sanitizeSheet(raw);
      const doc = new DOMParser().parseFromString(clean, 'text/html');
      const fields = window.SheetFields.detectFields(doc);
      return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, fields };
    }, fs.readFileSync(BIG, 'utf8'));
    await prep.close();
    const collected = built.fields.filter((f) => f.collect);
    console.log('감지: ' + built.fields.length + '필드(수집 ' + collected.length + ')');

    console.log('\n0부 · 그룹 자동 추출');
    ok('25개 필드 감지', collected.length === 25, collected.length + '개');
    const grps = [...new Set(collected.map((f) => f.group))];
    ok('의미 있는 그룹으로 나뉨(≥5)', grps.length >= 5, JSON.stringify(grps));
    ok('그룹에 기본 정보/주인공/마무리 포함', grps.some((g) => /기본 정보/.test(g)) && grps.some((g) => /주인공/.test(g)), JSON.stringify(grps));

    state.activities.push({ id: MANY, title: '캠프 다필드', html_body: built.html, status: 'open', version: 1, view_mode: 'all', kind: 'html_sheet', fields: built.fields, notices: [], closed_at: null, hidden_sessions: [], session_merges: [] });

    // 학생 3명(유사쌍 포함): 김은솔 ⊂ 김은솔 라시도
    const now = new Date().toISOString();
    const ans = {}; collected.slice(0, 20).forEach((f, i) => { ans[f.id] = '답' + i; });
    state.live_sessions.push({ id: 'l1', activity_id: MANY, nickname: '김은솔', answers: ans, submitted: false, last_seen: now, messages: [] });
    state.live_sessions.push({ id: 'l2', activity_id: MANY, nickname: '김은솔 라시도', answers: { [collected[22].id]: '늦게 쓴 답' }, submitted: false, last_seen: now, messages: [] });
    state.live_sessions.push({ id: 'l3', activity_id: MANY, nickname: '박하늘', answers: (() => { const a = {}; collected.forEach((f) => a[f.id] = 'x'); return a; })(), submitted: true, last_seen: now, messages: [] });

    // ---- 10필드 활동(매트릭스 유지 확인용) ----
    const few = built.fields.slice(0, 8);
    state.activities.push({ id: FEW, title: '적은필드', html_body: built.html, status: 'open', version: 1, view_mode: 'all', kind: 'html_sheet', fields: few, notices: [], closed_at: null, hidden_sessions: [], session_merges: [] });
    state.live_sessions.push({ id: 'f1', activity_id: FEW, nickname: '가나', answers: {}, submitted: false, last_seen: now, messages: [] });

    // ══════════ 응답 보기 ══════════
    console.log('\n1부 · 응답 보기(학생 카드 + 표 그룹 접기)');
    const r = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const rerr = []; r.on('pageerror', (e) => rerr.push(String(e)));
    await r.goto(APP + '/sheet/' + MANY);
    await r.waitForSelector('#stList .st-row');
    ok('기본 = 학생별 보기', await r.locator('#paneStudent').isVisible());
    await r.locator('#stList .st-row', { hasText: '박하늘' }).first().click();
    ok('학생 상세가 그룹별로 나뉜다(≥5 그룹 제목)', (await r.locator('#stDetail .st-grp h4').count()) >= 5);
    // 표 그룹 접기
    await r.click('#tabTable');
    await r.waitForSelector('#tbl th.grp');
    const grpCols = await r.locator('#tbl th.grp').count();
    ok('표에 그룹 헤더', grpCols >= 5, grpCols + '개');
    const collapsedFirst = await r.locator('#tbl th.grp', { hasText: '▸' }).count();
    ok('기본은 첫 그룹만 펼침(나머지 접힘)', collapsedFirst === grpCols - 1, '접힘 ' + collapsedFirst + '/' + grpCols);
    // 첫 그룹 헤더 클릭 → 접기 토글
    await r.locator('#tbl th.grp').first().click();
    await sleep(100);
    ok('그룹 헤더 클릭으로 접기/펼치기', (await r.locator('#tbl th.grp', { hasText: '▸' }).count()) !== collapsedFirst);
    ok('응답 보기 JS 에러 없음', rerr.length === 0, rerr.join(' | '));

    // ══════════ 실시간 현황 ══════════
    console.log('\n2부 · 실시간 현황 진행 막대');
    const lv = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const lerr = []; lv.on('pageerror', (e) => lerr.push(String(e)));
    await lv.goto(APP + '/live/' + MANY);
    await lv.waitForSelector('#bars .barrow', { timeout: 6000 });
    ok('25필드 → 진행 막대로 자동 전환', await lv.locator('#bars').isVisible() && !(await lv.locator('.scroller').isVisible()));
    ok('학생당 막대 + 그룹 색 구간', (await lv.locator('#bars .barrow .bseg').count()) >= 5 * 3);
    ok('진행 숫자 표시(채운/전체)', /\/25/.test(await lv.locator('#bars .bnum').first().textContent()));
    ok('그룹 색 범례', (await lv.locator('#bars .blegend span').count()) >= 5);
    // 막대 클릭 → 학생 상세
    await lv.locator('#bars .barrow').first().click();
    await lv.waitForSelector('#stuPanel.show');
    ok('막대 클릭 → 학생 상세 패널', /칸별로 쓴 글/.test(await lv.locator('#stuBody').textContent()));
    await lv.click('#stuClose');

    // 10필드는 매트릭스 유지
    const lv2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await lv2.goto(APP + '/live/' + FEW);
    await lv2.waitForSelector('#matrix th');
    ok('≤10 필드는 기존 셀 매트릭스 유지', await lv2.locator('.scroller').isVisible() && !(await lv2.locator('#bars').isVisible()));
    ok('실시간 현황 JS 에러 없음', lerr.length === 0, lerr.join(' | '));

    // ══════════ 발표 2단 탭 + 세션 정리 ══════════
    console.log('\n3부 · 발표 2단 탭 + 세션 정리');
    const pr = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const perr = []; pr.on('pageerror', (e) => perr.push(String(e)));
    await pr.goto(APP + '/present/' + MANY);
    await pr.waitForSelector('.grouptabs .gtab');
    ok('상단 그룹 탭(2단 상단)', (await pr.locator('.grouptabs .gtab').count()) >= 5);
    ok('하단 필드 탭은 현재 그룹 것만(눌림 방지)', (await pr.locator('.fieldtabs .tab').count()) <= 6, (await pr.locator('.fieldtabs .tab').count()) + '개');
    // 그룹 전환 → 필드 탭 바뀜
    const f0 = await pr.locator('.fieldtabs .tab').first().textContent();
    await pr.locator('.grouptabs .gtab').nth(1).click();
    await sleep(200);
    ok('그룹 전환 시 하단 필드 탭이 바뀐다', (await pr.locator('.fieldtabs .tab').first().textContent()) !== f0);

    // 유령 세션 제안(이름 포함관계 김은솔 ⊂ 김은솔 라시도)
    ok('유사 세션 제안 배너', await pr.locator('#sessbar .sess-sug').isVisible(), await pr.locator('#sessbar').textContent().catch(() => ''));
    ok('제안에 이름 포함관계 감지', /김은솔/.test(await pr.locator('#sessbar').textContent()));

    // 병합 실행(자동 아님 — 버튼 눌러야)
    const before = state.activities.find((a) => a.id === MANY).session_merges.length;
    await pr.locator('#sessbar button.sm').first().click();
    await sleep(400);
    const after = state.activities.find((a) => a.id === MANY).session_merges;
    ok('제안 [병합] 클릭 시에만 병합(자동 아님)', before === 0 && after.length === 1, JSON.stringify(after));

    // 숨기기
    await pr.goto(APP + '/present/' + MANY); await pr.waitForSelector('.card');
    const hb0 = state.activities.find((a) => a.id === MANY).hidden_sessions.length;
    // 카드 호버 → 숨기기
    await pr.locator('.card').first().hover();
    await pr.locator('.card .chide').first().click();
    await sleep(400);
    const hb1 = state.activities.find((a) => a.id === MANY).hidden_sessions;
    ok('카드 [숨기기] → 숨김 세션에 추가', hb0 === 0 && hb1.length === 1, JSON.stringify(hb1));
    ok('발표 JS 에러 없음', perr.length === 0, perr.join(' | '));

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
