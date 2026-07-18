// HTML 활동지 입구 — 실물 구동 검증 (Playwright + 진짜 server.js)
//
//   node test/sheet-e2e.js
//
// 실물 활동지(test/fixtures/real/activity_ai_movie_day1.html)를 교사 화면에 올려서 발행하고,
// 학생 화면에서 폰 뷰포트로 입력·자동저장·제출까지 사람이 하듯 몬 다음, 교사 결과 화면을 확인한다.
// Supabase 없이 돈다 — 모의 PostgREST 를 띄우고 진짜 server.js 를 거기에 물린다.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');

// 실물이 있으면 실물로, 없으면 합성본으로 — 둘의 구조가 같아서 기대치는 그대로 성립한다.
// (test/fixtures/real/ 는 .gitignore 라 다른 환경·CI 에는 없다. 그때 통째로 죽으면 안 된다.)
const REAL = path.join(__dirname, 'fixtures', 'real', 'activity_ai_movie_day1.html');
const SYNTH = path.join(__dirname, 'fixtures', 'activity-synth.html');
const FIXTURE = fs.existsSync(REAL) ? REAL : SYNTH;

const DB_PORT = 4202, APP_PORT = 4203;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '\n       → ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 모의 PostgREST ----------------
// e2e.js 의 것과 같은 수법이되, activities 를 진짜 표로 둔다(교사 화면이 활동을 새로 만들기 때문).
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
      // DB 기본값 흉내 — 실제 컬럼 default 와 같게 둔다(kind 는 012 마이그레이션 기준).
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
      SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`,
      SUPABASE_SERVICE_KEY: 'test-key',
      PORT: String(APP_PORT),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stderr.write('[app] ' + s); });
  return new Promise((resolve) => {
    const tick = () => http.get(`http://127.0.0.1:${APP_PORT}/api/health`, () => resolve(p)).on('error', () => setTimeout(tick, 150));
    tick();
  });
}

const APP = `http://127.0.0.1:${APP_PORT}`;

// 브라우저 쪽 에러는 조용히 죽는다(핸들러 안에서 던지면 화면만 안 바뀐다).
// 터지는 즉시 보이게 해 둔다 — 이게 없으면 "왜 안 뜨지"로 한참 헤맨다.
function watch(page, tag, sink) {
  page.on('pageerror', (e) => { sink.push(String(e)); console.log('   [' + tag + ' 오류] ' + e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('   [' + tag + ' console] ' + m.text()); });
}

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error('활동지 fixture 를 찾지 못했습니다: ' + FIXTURE);
    process.exit(1);
  }
  console.log('활동지: ' + path.basename(FIXTURE) + (FIXTURE === REAL ? '  (실물)' : '  (합성 — 실물은 .gitignore)'));

  const state = { activities: [], questions: [], submissions: [], live_sessions: [] };
  const db = await startMockDb(state);
  const app = await startApp();
  const browser = await chromium.launch();

  let activityId = null;

  try {
    // ══════════ 1부 · 교사: 업로드 → 감지 → 발행 ══════════
    console.log('\n1부 · 교사 화면 — 업로드 · 감지 · 발행');
    const t = await browser.newPage();
    const tErrors = [];
    watch(t, '교사', tErrors);
    await t.goto(APP + '/teacher.html');

    // 활동지 탭으로
    await t.click('#kindSheet');
    ok('HTML 활동지 탭이 열린다', await t.locator('#paneSheet').isVisible());
    ok('시험지 탭은 가려진다(입구가 갈린다)', !(await t.locator('#paneExam').isVisible()));

    // 실물 파일 업로드
    await t.setInputFiles('#sheetFile', FIXTURE);
    await t.waitForSelector('#sheetFieldsBox', { state: 'visible', timeout: 5000 });

    const rows = await t.locator('#sheetBody tr').count();
    ok('감지 필드 6개 행(textarea 4 + 체크묶음 2)', rows === 6, '행 수: ' + rows);

    const detected = await t.evaluate(() => window.sheetFields.map((f) => ({ id: f.id, tag: f.tag, label: f.label, collect: f.collect })));
    const tas = detected.filter((f) => f.tag === 'textarea');
    const cbs = detected.filter((f) => f.tag === 'checkbox');
    ok('검증1) textarea 4개 감지', tas.length === 4, JSON.stringify(tas.map((x) => x.id)));
    ok('검증1) 체크박스 기본 제외', cbs.length === 2 && cbs.every((f) => !f.collect));
    ok('검증1) textarea 는 기본 수집', tas.every((f) => f.collect));
    ok('검증1) 라벨에 "로그라인"', detected.some((f) => f.label.includes('로그라인')), JSON.stringify(detected.map((f) => f.label)));
    ok('검증1) 문맥에 "프롬프트"', await t.evaluate(() => window.sheetFields.some((f) => (f.label + ' ' + f.section).includes('프롬프트'))));
    ok('제목이 문서 title 로 자동 채워짐', (await t.inputValue('#sheetTitle')).trim().length > 0, await t.inputValue('#sheetTitle'));

    // 라벨 수정이 먹는가
    const firstLabel = t.locator('#sheetBody tr').first().locator('input[type=text]');
    await firstLabel.fill('첫 프롬프트 연습');
    ok('라벨 수정이 반영된다', (await t.evaluate(() => window.sheetFields[0].label)) === '첫 프롬프트 연습');

    // 수집 체크 토글
    await t.locator('#sheetBody tr').nth(1).locator('input[type=checkbox]').check();
    ok('체크박스 묶음을 수집으로 켤 수 있다', await t.evaluate(() => window.sheetFields[1].collect === true));
    await t.locator('#sheetBody tr').nth(1).locator('input[type=checkbox]').uncheck();

    // 미리보기가 원본 디자인인가 — 히어로가 살아 있고, 원본 색까지 그대로여야 한다.
    const pv = await t.frameLocator('#sheetPreview').locator('header.hero h1').first().textContent();
    const pvBg = await t.frameLocator('#sheetPreview').locator('header.hero').first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    ok('미리보기에 원본 히어로 헤더가 산다', (pv || '').trim().length > 0 && pvBg === 'rgb(34, 48, 31)', pv + ' / ' + pvBg);

    await t.click('#sheetPublishBtn');
    await t.waitForSelector('#sheetPublishBox.show', { timeout: 5000 });
    activityId = state.activities[0] && state.activities[0].id;
    ok('발행되어 활동이 생긴다', !!activityId);
    ok('kind=html_sheet 로 저장', state.activities[0].kind === 'html_sheet');
    ok('fields 가 저장된다(수집 4개)', (state.activities[0].fields || []).filter((f) => f.collect).length === 4);
    ok('저장된 html_body 에 data-fid 가 박혀 있다', /data-fid="f1"/.test(state.activities[0].html_body));
    ok('교사 화면 JS 에러 없음', tErrors.length === 0, tErrors.join(' | '));

    // ══════════ 2부 · 학생: 원본 디자인 + 입력 → 자동저장 → 제출 ══════════
    console.log('\n2부 · 학생 화면 — 폰 뷰포트(390px)');
    const s = await browser.newPage({ viewport: { width: 390, height: 780 } });
    const sErrors = [];
    s.on('pageerror', (e) => sErrors.push(String(e)));
    await s.goto(APP + '/go/' + activityId);
    await s.waitForSelector('#__mjsBar');

    // 검증2) 원본 디자인이 그대로인가
    const hero = await s.evaluate(() => {
      const h = document.querySelector('header.hero');
      if (!h) return null;
      const cs = getComputedStyle(h);
      return { bg: cs.backgroundColor, color: cs.color };
    });
    ok('검증2) 히어로 헤더가 원본 색으로 산다', hero && hero.bg === 'rgb(34, 48, 31)', JSON.stringify(hero));

    const bodyBg = await s.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok('검증2) 본문 배경이 원본(크림스크린)', bodyBg === 'rgb(250, 246, 236)', bodyBg);

    ok('검증5) 모바일 반응형 — 가로 스크롤 없음', await s.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      await s.evaluate(() => document.documentElement.scrollWidth + ' vs ' + window.innerWidth));

    const grid = await s.evaluate(() => {
      const g = document.querySelector('.grid2');
      return g ? getComputedStyle(g).gridTemplateColumns : 'none';
    });
    ok('검증5) @media 반응형 규칙이 살아 있다', grid === 'none' || !/ /.test(grid.trim()), grid);

    // 검증4) 위험 스크립트 제거
    const scripts = await s.evaluate(() => Array.from(document.querySelectorAll('script')).map((x) => x.textContent.slice(0, 40)));
    ok('검증4) 원본 인라인 스크립트 제거됨', !scripts.some((x) => x.includes('boxes.forEach')), JSON.stringify(scripts.length));
    ok('검증4) on* 속성 없음', await s.evaluate(() => !document.body.innerHTML.match(/\son[a-z]+\s*=/i)));
    ok('검증4) 수집 스크립트만 남음(1개)', scripts.length === 1, '스크립트 ' + scripts.length + '개');

    // 진행률 바 되살리기
    const before = await s.evaluate(() => document.getElementById('pfill').style.width);
    await s.locator('input.mission').first().check();
    await sleep(150);
    const after = await s.evaluate(() => ({ w: document.getElementById('pfill').style.width, t: document.getElementById('ppct').textContent }));
    ok('원본 진행률 바를 수집 스크립트가 되살린다', after.w === '10%' && after.t === '10%', JSON.stringify(after) + ' (before=' + before + ')');

    // 입력 → 자동저장
    await s.fill('#__mjsNick', '남건');
    const tas2 = s.locator('textarea[data-fid]');
    await tas2.nth(0).fill('축구를 좋아하는 12살 주인공이 로봇 골키퍼와 대결하는 이야기를 써줘');
    await tas2.nth(1).fill('②번이 제일 중요해요. 개인정보가 새면 되돌릴 수 없으니까요.');
    await tas2.nth(2).fill('겁 많은 5학년이 전학생 로봇의 비밀을 지키려 학교 축제에 맞서는 이야기');
    await tas2.nth(3).fill('로그라인이 재밌대요!');

    await s.waitForFunction(() => document.getElementById('__mjsSave').textContent === '저장됨', null, { timeout: 6000 });
    ok('검증2) 자동 임시저장이 "저장됨" 으로 바뀐다', true);

    const sess = state.live_sessions[0];
    ok('검증2) 제출 전에도 서버에 답이 남는다(유실 방지)', !!sess && Object.keys(sess.answers || {}).length >= 4,
      sess ? JSON.stringify(Object.keys(sess.answers)) : 'no session');
    ok('검증2) 필드 ID 기준으로 저장된다', !!sess && typeof sess.answers.f1 === 'string' && sess.answers.f1.includes('로봇 골키퍼'));

    ok('진행 표시가 4/4', (await s.locator('#__mjsCount').textContent()) === '4/4');

    // 새로고침해도 살아 있나(localStorage 복원)
    await s.reload();
    await s.waitForSelector('#__mjsBar');
    const restored = await s.locator('textarea[data-fid]').nth(2).inputValue();
    ok('검증2) 새로고침해도 쓰던 내용이 살아 있다', restored.includes('겁 많은 5학년'), restored.slice(0, 30));

    // 제출
    await s.click('#__mjsSubmit');
    await s.waitForFunction(() => document.getElementById('__mjsSubmit').textContent.includes('제출 완료'), null, { timeout: 6000 });
    ok('검증2) 제출된다', state.submissions.length === 1, '제출 행 ' + state.submissions.length + '개');
    // 문서 순서로 번호를 매기므로 textarea 4개는 f1·f3·f4·f6 이다(f2·f5 는 체크박스 묶음).
    // 그 어긋남까지 그대로 확인한다 — 여기가 틀리면 교사가 본 라벨과 다른 칸에 답이 들어간다.
    const got = state.submissions[0] ? state.submissions[0].answers : {};
    ok('검증2) 제출 내용이 필드 ID 로 정확히 들어간다',
      got.f1 && got.f1.includes('로봇 골키퍼') &&
      got.f3 && got.f3.includes('②번이 제일 중요') &&
      got.f4 && got.f4.includes('겁 많은 5학년') &&
      got.f6 === '로그라인이 재밌대요!',
      JSON.stringify(got));
    ok('검증2) 수집 제외한 체크박스 묶음은 제출에 없다', got.f2 === undefined && got.f5 === undefined, JSON.stringify(Object.keys(got)));
    ok('학생 화면 JS 에러 없음', sErrors.length === 0, sErrors.join(' | '));

    // ══════════ 3부 · 교사 결과 ══════════
    console.log('\n3부 · 교사 결과 — 표 · 모아보기 · CSV');
    const r = await browser.newPage();
    const rErrors = [];
    r.on('pageerror', (e) => rErrors.push(String(e)));
    await r.goto(APP + '/sheet/' + activityId);
    await r.waitForSelector('#stList .st-row', { timeout: 5000 });

    // 기본 = 학생별 보기: 목록 + 개별 그룹별 읽기
    ok('검증3) 기본 탭이 학생별 보기', await r.locator('#paneStudent').isVisible());
    ok('검증3) 학생 목록에 이름·진행', /남건/.test(await r.locator('#stList').textContent()));
    await r.locator('#stList .st-row', { hasText: '남건' }).first().click();
    const detTxt = await r.locator('#stDetail').textContent();
    ok('검증3) 학생 클릭 → 그 학생 답을 그룹별로', /로봇 골키퍼/.test(detTxt) && /첫 프롬프트 연습/.test(detTxt), detTxt.slice(0, 40));
    ok('검증3) 학생별 보기에 그룹 제목이 있다', (await r.locator('#stDetail .st-grp h4').count()) >= 1);
    await r.click('#stNext');   // ←/→ 이동
    ok('검증3) 다음 학생으로 이동', (await r.locator('#stDetail .head .nm').textContent()) !== '남건' || (await r.locator('#stList .st-row').count()) === 1);

    // 표 보기(그룹 헤더 + 접기)
    await r.click('#tabTable');
    await r.waitForSelector('#tbl thead', { state: 'visible' });
    ok('검증3) 표에 그룹 헤더가 있다', (await r.locator('#tbl th.grp').count()) >= 1);
    // 접힌 그룹 전부 펼치기(▸ 인 것 클릭)
    for (let i = 0; i < 10; i++) { const c = r.locator('#tbl th.grp', { hasText: '▸' }).first(); if (await c.count() === 0) break; await c.click(); }
    const heads = await r.locator('#tbl th.fld').allTextContents();
    ok('검증3) 열 이름이 수정한 라벨로 나온다', heads.some((h) => h.includes('첫 프롬프트 연습')), JSON.stringify(heads));
    ok('검증3) 체크박스 묶음은 열에 없다(수집 제외)', !heads.some((h) => h.includes('약속 5')));

    // 셀 클릭 → 전체 보기
    await r.locator('#tbl td.cell').first().click();
    await r.waitForSelector('#modal', { state: 'visible' });
    const modal = await r.locator('#mTxt').textContent();
    ok('검증3) 셀 클릭 시 전체 보기', (modal || '').length > 0, (modal || '').slice(0, 30));
    await r.click('#mClose');

    // 필드별 모아보기
    await r.click('#tabField');
    ok('검증3) 필드별 모아보기 탭이 열린다', await r.locator('#paneField').isVisible());
    const picks = await r.locator('#pick button').count();
    ok('검증3) 필드 고르기 버튼 4개', picks === 4, '버튼 ' + picks + '개');
    const listTxt = await r.locator('#list').textContent();
    ok('검증3) 한 필드의 전원 답변이 세로로 나열된다', /남건/.test(listTxt) && /로봇 골키퍼/.test(listTxt));

    // CSV
    const dl = await Promise.all([r.waitForEvent('download'), r.click('#csvBtn')]);
    const csvPath = await dl[0].path();
    const csv = fs.readFileSync(csvPath, 'utf8');
    ok('검증3) CSV 다운로드', csv.length > 0);
    ok('검증3) CSV 에 BOM(엑셀 한글)', csv.charCodeAt(0) === 0xfeff);
    ok('검증3) CSV 머리글에 라벨', csv.includes('첫 프롬프트 연습'), csv.split('\r\n')[0]);
    ok('검증3) CSV 에 학생 답', csv.includes('로봇 골키퍼'));
    ok('교사 결과 화면 JS 에러 없음', rErrors.length === 0, rErrors.join(' | '));

    // ══════════ 4부 · 마감(기존 기능이 이 유형에도) ══════════
    console.log('\n4부 · 기존 기능 연동');
    const liveRes = await fetch(APP + '/api/live/state?activityId=' + activityId).then((x) => x.json());
    ok('검증3) 실시간 현황 API 가 이 유형에도 동작', liveRes.ok && liveRes.students.length >= 1,
      JSON.stringify(liveRes).slice(0, 120));

    const closeRes = await fetch(APP + '/api/live/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId }),
    }).then((x) => x.json());
    ok('마감이 동작한다', closeRes.ok === true, JSON.stringify(closeRes));

    // ══════════ 5부 · 회귀: 시험지 경로 ══════════
    console.log('\n5부 · 회귀 — 시험지 경로가 그대로인가');
    state.activities.push({
      id: 'exam-1', title: '기존 시험지', html_body: '<p>1. 답: <input name="q1"></p>',
      status: 'open', version: 1, view_mode: 'all', kind: 'exam', fields: [], notices: [], closed_at: null,
    });
    const ex = await browser.newPage();
    const exErrors = [];
    ex.on('pageerror', (e) => exErrors.push(String(e)));
    await ex.goto(APP + '/go/exam-1');
    ok('검증5) 기존 시험지 학생 화면이 그대로 뜬다', await ex.locator('#__activityBody').isVisible());
    ok('검증5) 시험지는 활동지 바를 얹지 않는다', (await ex.locator('#__mjsBar').count()) === 0);
    ok('검증5) 시험지 화면 JS 에러 없음', exErrors.length === 0, exErrors.join(' | '));

    const te = await browser.newPage();
    const teErrors = [];
    te.on('pageerror', (e) => teErrors.push(String(e)));
    await te.goto(APP + '/teacher.html');
    ok('검증5) 교사 화면 기본 탭은 시험지', await te.locator('#paneExam').isVisible());
    ok('검증5) 기존 PDF 업로드 UI 그대로', await te.locator('#fileInput').count() === 1 && await te.locator('#qtable').count() === 1);
    ok('검증5) 교사 화면 JS 에러 없음', teErrors.length === 0, teErrors.join(' | '));
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
