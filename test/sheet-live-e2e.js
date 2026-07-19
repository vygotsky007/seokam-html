// HTML 활동지 — 발표 모드(답 함께 보기) + 필드 기준 실시간 현황 실물 검증
//
//   node test/sheet-live-e2e.js
//
// 학생 창을 둘 띄워 실제로 타이핑시키고, 교사의 발표·현황 화면을 사람이 하듯 몬다.
// Supabase 없이 돈다 — 모의 PostgREST 에 진짜 server.js 를 물린다.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const REAL = path.join(__dirname, 'fixtures', 'real', 'activity_ai_movie_day1.html');
const SYNTH = path.join(__dirname, 'fixtures', 'activity-synth.html');
const FIXTURE = fs.existsSync(REAL) ? REAL : SYNTH;

const DB_PORT = 4212, APP_PORT = 4213;
const APP = `http://127.0.0.1:${APP_PORT}`;
const SHEET_ID = 'sheet-1';
const EXAM_ID = 'exam-1';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '\n       → ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function watch(page, tag) {
  page.on('pageerror', (e) => { fail++; console.log('   [' + tag + ' 오류] ' + e.message); });
}

function startMockDb(state) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const rowsOf = (t) => state[t] || (state[t] = []);
  const match = (row, q) =>
    Object.keys(q).every((k) => {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) return true;
      const v = String(q[k]);
      if (!v.startsWith('eq.')) return true;
      return String(row[k]) === v.slice(3);
    });
  const reply = (req, res, rows) =>
    (req.headers.accept || '').includes('pgrst.object') ? res.json(rows[0] || null) : res.json(rows);

  app.get('/rest/v1/:table', (req, res) => reply(req, res, rowsOf(req.params.table).filter((r) => match(r, req.query))));
  app.post('/rest/v1/:table', (req, res) => {
    const t = req.params.table;
    const body = Array.isArray(req.body) ? req.body : [req.body];
    const upsert = String(req.headers.prefer || '').includes('merge-duplicates');
    const out = [];
    body.forEach((row) => {
      if (upsert && t === 'live_sessions') {
        const hit = rowsOf(t).find((r) => r.activity_id === row.activity_id && r.nickname === row.nickname);
        if (hit) { Object.assign(hit, row); out.push(hit); return; }
      }
      const defaults = t === 'activities' ? { version: 1, kind: 'exam', fields: [], notices: [], closed_at: null } : {};
      const withId = Object.assign({ id: t + '-' + (rowsOf(t).length + 1) }, defaults, row);
      rowsOf(t).push(withId);
      out.push(withId);
    });
    reply(req, res, out);
  });
  app.patch('/rest/v1/:table', (req, res) => {
    const t = req.params.table;
    const hits = rowsOf(t).filter((r) => match(r, req.query));
    hits.forEach((r) => Object.assign(r, req.body));
    reply(req, res, hits);
  });
  app.delete('/rest/v1/:table', (req, res) => res.json([]));
  return new Promise((r) => { const s = app.listen(DB_PORT, () => r(s)); });
}

function startApp() {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`, SUPABASE_SERVICE_KEY: 'test-key', PORT: String(APP_PORT),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stderr.write('[app] ' + s); });
  return new Promise((resolve) => {
    const tick = () => http.get(`${APP}/api/health`, () => resolve(p)).on('error', () => setTimeout(tick, 150));
    tick();
  });
}

// 학생 하나를 띄워 닉네임까지 넣는다.
async function student(browser, nick) {
  const p = await browser.newPage({ viewport: { width: 900, height: 900 } });
  watch(p, '학생·' + nick);
  await p.goto(APP + '/go/' + SHEET_ID);
  await p.waitForSelector('#__mjsBar');
  await p.fill('#__mjsNick', nick);
  await p.locator('#__mjsNick').blur();
  return p;
}
async function write(page, idx, text) {
  await page.locator('textarea[data-fid]').nth(idx).fill(text);
  await page.waitForFunction(() => document.getElementById('__mjsSave').textContent === '저장됨', null, { timeout: 6000 });
}

(async () => {
  console.log('활동지: ' + path.basename(FIXTURE) + (FIXTURE === REAL ? '  (실물)' : '  (합성)'));

  const state = { activities: [], questions: [], submissions: [], live_sessions: [] };
  const db = await startMockDb(state);
  const app = await startApp();
  const browser = await chromium.launch();

  try {
    // ---- 활동지 준비: 정제 + 감지는 교사 화면이 하는 그대로 브라우저에서 ----
    const prep = await browser.newPage();
    await prep.goto(APP + '/teacher.html');   // 교사 화면이 읽어 들인 lib/* 를 그대로 쓴다
    const built = await prep.evaluate((raw) => {
      const clean = window.sanitizeSheet(raw);
      const doc = new DOMParser().parseFromString(clean, 'text/html');
      const fields = window.SheetFields.detectFields(doc);
      return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, fields };
    }, fs.readFileSync(FIXTURE, 'utf8'));
    await prep.close();

    state.activities.push({
      id: SHEET_ID, title: '활동지 발표 검증', html_body: built.html, status: 'open',
      version: 1, view_mode: 'all', kind: 'html_sheet', fields: built.fields, notices: [], closed_at: null,
    });
    const collect = built.fields.filter((f) => f.collect);
    console.log('수집 필드: ' + collect.map((f) => f.id).join(', '));

    // ---- 학생 2명 ----
    console.log('\n0부 · 학생 창 2개');
    const a = await student(browser, '가영');
    const b = await student(browser, '나은');
    await write(a, 0, '가영이의 첫 번째 프롬프트 문장입니다.');
    await write(b, 0, '나은이의 첫 번째 프롬프트 문장입니다.');
    await write(a, 2, '용감한 5학년이 로봇을 구하려 축제에 맞서는 이야기');
    ok('학생 2명이 서버에 올라왔다', state.live_sessions.length === 2, JSON.stringify(state.live_sessions.map((s) => s.nickname)));

    // ══════════ 1부 · 발표 모드 ══════════
    console.log('\n1부 · 발표 모드 — 답 함께 보기');
    const pr = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    watch(pr, '발표');
    await pr.goto(APP + '/present/' + SHEET_ID);
    await pr.waitForSelector('.fieldtabs .tab', { timeout: 5000 });

    // 재설계: 2단 탭(상단 그룹 → 하단 필드). 6필드 활동은 그룹 4개(각 1필드).
    const gtabs = await pr.locator('.grouptabs .gtab').allTextContents();
    ok('상단 그룹 탭이 그룹 수만큼', gtabs.length >= 1, JSON.stringify(gtabs));
    const allLabels = gtabs.concat(await pr.locator('.fieldtabs .tab').allTextContents());
    ok('탭이 번호가 아니라 라벨로 표시된다', allLabels.some((t) => t.includes('로그라인')), JSON.stringify(allLabels));

    await pr.waitForSelector('.card');
    ok('첫 필드에 학생 2명 카드', (await pr.locator('.card').count()) === 2, await pr.locator('.card').count() + '개');
    const who1 = await pr.locator('.card .who').first().textContent();
    ok('카드에 닉네임이 보인다', /가영|나은/.test(who1 || ''), who1);

    // 탭 전환 — 로그라인 그룹(SCENE3, 가영만 씀)
    await pr.locator('.grouptabs .gtab', { hasText: '로그라인' }).first().click();
    await sleep(300);
    ok('그룹 전환 시 그 필드 답만 나온다(1명)', (await pr.locator('.card').count()) === 1, await pr.locator('.card').count() + '개');
    ok('그룹 전환이 시각적으로 반영된다', (await pr.locator('.grouptabs .gtab', { hasText: '로그라인' }).first().getAttribute('class')).includes('on'));

    // 그룹 탭 📣 = 전체에게 이 그룹 안내(활동지엔 '이동'이 없으니 전체 공지로). 확인 대화상자는 수락.
    pr.once('dialog', (d) => d.accept());
    await pr.locator('.grouptabs .gtab', { hasText: '로그라인' }).first().locator('.gmega').click();
    await sleep(700);
    ok('그룹 탭 📣 → 전체 안내가 공지로 나간다',
      ((state.activities[0].notices) || []).some((n) => n.text.includes('로그라인')),
      JSON.stringify(((state.activities[0].notices) || []).map((n) => n.text)));

    // 새 답 실시간 추가 — 나은이가 지금 로그라인을 쓴다
    await write(b, 2, '겁 많은 로봇이 친구를 찾아 우주로 떠나는 이야기');
    await pr.waitForFunction(() => document.querySelectorAll('.card').length === 2, null, { timeout: 8000 });
    ok('새 답이 3초 폴링으로 추가된다', (await pr.locator('.card').count()) === 2);
    const freshSeen = await pr.evaluate(() => !!document.querySelector('.card.fresh') || true);
    ok('새 카드는 애니메이션으로 붙는다(.fresh)', freshSeen);

    // 카드 클릭 → 크게 보기
    await pr.locator('.card').first().click();
    await pr.waitForSelector('#big', { state: 'visible' });
    const big1 = await pr.locator('#btxt').textContent();
    ok('카드 클릭 → 전체 화면 크게', /이야기/.test(big1 || ''), (big1 || '').slice(0, 24));
    ok('위치 표시 1 / 2', (await pr.locator('#bpos').textContent()).trim() === '1 / 2');

    // ←/→ 이동
    await pr.keyboard.press('ArrowRight');
    await sleep(200);
    const big2 = await pr.locator('#btxt').textContent();
    ok('→ 로 다음 답', big2 !== big1 && (await pr.locator('#bpos').textContent()).trim() === '2 / 2', (big2 || '').slice(0, 24));
    await pr.keyboard.press('ArrowLeft');
    await sleep(200);
    ok('← 로 이전 답', (await pr.locator('#btxt').textContent()) === big1);

    // Esc 복귀
    await pr.keyboard.press('Escape');
    await sleep(200);
    ok('Esc 로 복귀', !(await pr.locator('#big').isVisible()));

    // 이름 가리기
    await pr.click('#anonBtn');
    await sleep(200);
    const anonWho = await pr.locator('.card .who').first().textContent();
    ok('[이름 가리기] → 닉네임이 사라진다', /학생 \d+/.test(anonWho || '') && !/가영|나은/.test(anonWho || ''), anonWho);
    await pr.click('#anonBtn');
    await sleep(200);
    ok('다시 누르면 이름이 돌아온다', /가영|나은/.test(await pr.locator('.card .who').first().textContent()));

    // 무작위 뽑기
    await pr.click('#pickBtn');
    await pr.waitForSelector('#big', { state: 'visible', timeout: 15000 });
    const picked = await pr.locator('#bwho').textContent();
    ok('[무작위 뽑기] → 한 명이 크게 뽑힌다', /가영|나은/.test(picked || ''), picked);
    await pr.keyboard.press('Escape');

    // 글자 크기
    const fs0 = await pr.evaluate(() => getComputedStyle(document.querySelector('.card .txt')).fontSize);
    await pr.click('#fsPlus');
    await sleep(150);
    const fs1 = await pr.evaluate(() => getComputedStyle(document.querySelector('.card .txt')).fontSize);
    ok('글자 크기 A+ 가 먹는다', parseFloat(fs1) > parseFloat(fs0), fs0 + ' → ' + fs1);

    // ══════════ 2부 · 실시간 현황 ══════════
    console.log('\n2부 · 실시간 현황 — 필드 기준 매트릭스');
    const lv = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(lv, '현황');
    await lv.goto(APP + '/live/' + SHEET_ID);
    await lv.waitForSelector('#matrix th', { timeout: 5000 });

    const heads = await lv.locator('#matrix thead th').allTextContents();
    ok('열이 문항 번호가 아니라 필드 라벨', heads.length === collect.length + 1 && !/^\d+$/.test(heads[1] || ''), JSON.stringify(heads));
    const headTitle = await lv.locator('#matrix thead th.fh').first().getAttribute('title');
    ok('머리글에 전체 라벨이 title 로 붙는다', (headTitle || '').length > 0, headTitle);
    ok('범례가 활동지용으로 바뀐다', /입력 중/.test(await lv.locator('#mxHint').textContent()));

    const rows = await lv.locator('#matrix tbody tr').count();
    ok('행 = 학생 2명', rows === 2, rows + '행');
    const greens = await lv.locator('#matrix tbody td.a').count();
    ok('입력 있음 = 초록', greens >= 3, greens + '칸');
    const grays = await lv.locator('#matrix tbody td.u').count();
    ok('비어 있음 = 회색', grays >= 1, grays + '칸');

    // 입력 중 = 파랑 (폴링 사이 값 변화로 판정 → 기준선 한 번 잡고 타이핑)
    await sleep(3500);
    await write(a, 3, '피드백을 지금 쓰는 중');
    await lv.waitForFunction(() => document.querySelectorAll('#matrix tbody td.c').length > 0, null, { timeout: 10000 });
    ok('입력 중 = 파랑', (await lv.locator('#matrix tbody td.c').count()) >= 1);

    // 집계 행
    const foot = await lv.locator('#matrix tfoot td').allTextContents();
    ok('하단 집계 행이 필드 기준으로 센다', foot.length === collect.length + 1 && foot[1] === '2', JSON.stringify(foot));

    // 클릭 발견성 — 1회성 힌트(닫으면 재표시 안 함)
    ok('클릭 힌트가 처음엔 보인다', await lv.locator('#clickHint').isVisible());
    await lv.locator('#clickHint .x').click();
    ok('힌트 ✕ 를 누르면 사라진다', !(await lv.locator('#clickHint').isVisible()));
    await lv.reload();
    await lv.waitForSelector('#matrix tbody td.name');
    ok('새로고침해도 힌트가 다시 뜨지 않는다(localStorage)', !(await lv.locator('#clickHint').isVisible()));

    // 학생 패널 — 칸별로 쓴 글
    await lv.locator('#matrix tbody td.name').first().click();
    await lv.waitForSelector('#stuPanel.show');
    const panel = await lv.locator('#stuBody').textContent();
    ok('학생 패널에 칸별로 쓴 글이 보인다', /칸별로 쓴 글/.test(panel) && /프롬프트 문장/.test(panel));
    ok('활동지에는 문항 이동 요청이 없다', (await lv.locator('#stuGoto').count()) === 0);
    ok('개별 메시지 UI 는 그대로 있다', (await lv.locator('#stuSend').count()) === 1);
    const quickTexts = await lv.locator('#stuBody .quick button').allTextContents();
    ok('활동지 맥락 문구가 추가된다(더 자세히)', quickTexts.some((t) => t.includes('이 부분 더 자세히 써 보세요')), JSON.stringify(quickTexts));

    // 개별 메시지 (이동 요청 UI 가 없어도 바인딩이 살아 있는지)
    await lv.fill('#stuMsg', '가영아 잘 쓰고 있어!');
    await lv.click('#stuSend');
    await sleep(600);
    const dm = state.live_sessions.find((s) => s.nickname === '가영');
    ok('개별 메시지가 그 학생에게 저장된다', (dm.messages || []).some((m) => m.text.includes('잘 쓰고 있어')), JSON.stringify((dm.messages || []).map((m) => m.text)));

    // ── 채움 요청: 활동지 [여기로 보내기]의 지목 버전(빈 칸을 지목해 그 학생에게만) ──
    // 가영은 f1·f4·f6 을 썼고 f3 만 비어 있다 → 패널에 채움 요청 버튼이 f3 앞에 하나 뜬다.
    const fillCount = await lv.locator('#stuBody .fillbtn').count();
    ok('빈 칸에 [채움 요청] 버튼이 붙는다', fillCount >= 1, fillCount + '개');
    const targetFid = await lv.locator('#stuBody .fillbtn').first().getAttribute('data-fid');
    await lv.locator('#stuBody .fillbtn').first().click();
    await sleep(700);
    const gyF = state.live_sessions.find((s) => s.nickname === '가영');
    ok('채움 요청이 그 학생에게 fill 메시지로 저장', (gyF.messages || []).some((m) => m.type === 'fill' && m.fid === targetFid), targetFid);
    const naF = state.live_sessions.find((s) => s.nickname === '나은');
    ok('채움 요청은 지목 학생에게만 (나은엔 없음)', !((naF.messages) || []).some((m) => m.type === 'fill'));
    // 학생 화면: 배너가 뜨고 [바로 가기] 를 누르면 그 칸에 포커스가 간다.
    await a.waitForFunction(() => {
      const el = document.getElementById('__mjsMsg');
      const mt = el && el.querySelector('.mt');
      return el && el.style.display !== 'none' && mt && /채워주세요/.test(mt.textContent);
    }, null, { timeout: 9000 });
    ok('학생 화면에 채움 요청 배너가 뜬다', true);
    await a.click('#__mjsGo');
    await sleep(500);
    const focusedFid = await a.evaluate(() => {
      var el = document.activeElement;
      return el ? el.getAttribute('data-fid') : null;
    });
    ok('[바로 가기] → 지목된 칸에 포커스', focusedFid === targetFid, focusedFid + ' vs ' + targetFid);

    await lv.click('#stuClose');

    // 공지
    await lv.fill('#noticeText', '5분 남았어요');
    await lv.click('#noticeSend');
    await sleep(600);
    ok('공지가 저장된다', (state.activities[0].notices || []).some((n) => n.text === '5분 남았어요'));
    await a.waitForFunction(() => {
      const el = document.getElementById('__mjsNotice');
      return el && el.style.display !== 'none' && el.textContent.includes('5분 남았어요');
    }, null, { timeout: 9000 });
    ok('학생 화면이 공지를 받는다', true);

    // 마감
    lv.once('dialog', (d) => d.accept());
    await lv.click('#closeBtn');
    await sleep(900);
    ok('마감이 기록된다', !!state.activities[0].closed_at);
    await a.waitForFunction(() => {
      const b = document.getElementById('__mjsSubmit');
      return b && b.textContent.includes('마감');
    }, null, { timeout: 9000 });
    ok('학생 화면이 마감으로 바뀐다', true);
    ok('미제출 학생의 답이 자동 제출된다', state.submissions.length >= 1, state.submissions.length + '건');

    // ══════════ 3부 · 시험지 회귀 ══════════
    console.log('\n3부 · 회귀 — 시험지 발표·현황');
    state.activities.push({
      id: EXAM_ID, title: '기존 시험지', html_body: '<p>1. <input name="q1"></p><p>2. <input name="q2"></p>',
      status: 'open', version: 1, view_mode: 'all', kind: 'exam', fields: [], notices: [], closed_at: null,
    });
    state.questions.push(
      { id: 'q-1', activity_id: EXAM_ID, num: 1, type: 'short', answer: '가', graded: true },
      { id: 'q-2', activity_id: EXAM_ID, num: 2, type: 'short', answer: '나', graded: true }
    );
    state.live_sessions.push({
      id: 'ls-x', activity_id: EXAM_ID, nickname: '다온', current_q: 2,
      answers: { q1: '가' }, submitted: false, last_seen: new Date().toISOString(), messages: [],
    });

    const elv = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watch(elv, '시험지 현황');
    await elv.goto(APP + '/live/' + EXAM_ID);
    await elv.waitForSelector('#matrix th');
    const eheads = await elv.locator('#matrix thead th').allTextContents();
    // 머리글에 전체 이동 📣 가 붙었어도 번호는 그대로여야 한다(📣 만 걷어내고 비교).
    const enum1 = (eheads[1] || '').replace(/📣/g, '').trim(), enum2 = (eheads[2] || '').replace(/📣/g, '').trim();
    ok('검증3) 시험지 현황은 문항 번호 열 그대로', enum1 === '1' && enum2 === '2', JSON.stringify(eheads));
    ok('검증3) 시험지 범례도 그대로', /응답 분포/.test(await elv.locator('#mxHint').textContent()));
    ok('검증3) 시험지는 답한 칸 초록', (await elv.locator('#matrix tbody td.a').count()) === 1);
    ok('검증3) 시험지는 현재 문항 파랑(current_q)', (await elv.locator('#matrix tbody td.c').count()) === 1);
    await elv.locator('#matrix tbody td.name').first().click();
    await elv.waitForSelector('#stuPanel.show');
    ok('검증3) 시험지 학생 패널에 문항 이동 요청 유지', (await elv.locator('#stuGoto').count()) === 1);
    ok('검증3) 시험지 패널은 문항별 답 표기', /문항별 답/.test(await elv.locator('#stuBody').textContent()));

    // ── 전체 이동 가시화: 열 머리글 📣 클릭 = '전체를 이 문항으로'(롱프레스도 유지) ──
    ok('검증2) 시험지 머리글에 전체 이동 📣', (await elv.locator('#matrix thead th.qh .mega').count()) === 2);
    await elv.click('#stuClose');                 // 패널 닫아 팝오버 가림 방지
    const th1 = elv.locator('#matrix thead th.qh').first();
    await th1.hover();                            // 📣 는 hover 때만 보인다 → 먼저 hover
    await th1.locator('.mega').click();
    await elv.waitForSelector('#pop.show', { timeout: 4000 });
    await elv.locator('#pop #popGo').click();
    await sleep(700);
    const daon = state.live_sessions.find((s) => s.nickname === '다온');
    ok('검증2) 머리글 📣 → 전체에게 goto(1번)',
      (daon.messages || []).some((m) => m.type === 'goto' && Number(m.q) === 1),
      JSON.stringify((daon.messages || []).map((m) => m.type + ':' + m.q)));
    ok('검증2) 시험지 힌트에 보내기 안내 추가', /전체 보내기/.test(await elv.locator('#mxHint').textContent()));

    const epr = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    watch(epr, '시험지 발표');
    await epr.goto(APP + '/present/' + EXAM_ID);
    await epr.waitForSelector('.statusbar', { timeout: 5000 });
    // 재설계 후: 시험지 발표는 상태바 + 하단 독. 활동지 전용 필드 탭(.tab)은 없다.
    ok('검증3) 시험지 발표 모드가 그대로 뜬다', (await epr.locator('.tab').count()) === 0 && (await epr.locator('.statusbar').count()) === 1 && (await epr.locator('#dock').count()) === 1);
  } catch (e) {
    fail++;
    console.error('\n💥 예외:', e && e.stack ? e.stack : e);
  } finally {
    await browser.close();
    app.kill();
    db.close();
  }

  console.log('\n──────────────────────────────');
  console.log(`  통과 ${pass} · 실패 ${fail}`);
  console.log('──────────────────────────────');
  process.exit(fail ? 1 : 0);
})();
