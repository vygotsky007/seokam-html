// 문서 등급 A/B/C 판정 검증 ([1]).
//   node test/grade-e2e.js
// 등급 로직·배너·확인창·수동 재지정·키 미설정 안내는 실검증(키 무관).
// C등급 자동 AI 변환의 '실동작'은 ANTHROPIC_API_KEY 의존이라 /api/ai-status·/api/ai-convert 를 모킹해 흐름만 검증.
const path = require('path'), express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 4242;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 모킹 서버: 정적 + /api/ai-status(가변) + /api/ai-convert(가짜 성공)
let aiEnabled = false;
let convertCalls = 0;
function start() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.get('/api/ai-status', (req, res) => res.json({ ok: true, enabled: aiEnabled, model: 'mock', limit: 200, used: 0, remaining: 200, authRequired: false }));
  app.post('/api/ai-convert', (req, res) => {
    convertCalls++;
    res.json({ ok: true, num: req.body && req.body.num, parsed: { type: 'short', stem: '변환된 발문', passage: '', choices: [] }, cached: false });
  });
  app.get('/api/activities', (req, res) => res.json({ ok: true, activities: [] }));   // 목록 로더 소음 차단
  app.use('/lib', express.static(path.join(ROOT, 'lib')));
  app.use(express.static(path.join(ROOT, 'public')));
  return new Promise((r) => { const s = app.listen(PORT, () => r(s)); });
}

// 페이지 안에서 문서 등급 상태를 세팅하는 헬퍼(qHtml·lowConfidenceReport 스텁·aiStatus).
async function setup(page, opts) {
  await page.evaluate((o) => {
    // lowConfidenceReport 를 통제값으로 스텁 → 등급 로직만 격리 검증
    window.lowConfidenceReport = function () {
      return Object.assign({ pierce: 0, total: 10, ratio: 0, emptyCols: 0, broken: false, low: false }, o.rep || {});
    };
    // 변환 결과(qHtml) + 조각 이미지
    window.qHtml = {}; window.sliceImages = {};
    (o.q || []).forEach(function (r, i) {
      var num = i + 1;
      window.qHtml[num] = { parsed: {}, html: 'x', reason: r.reason || null, useImage: !!r.useImage };
      window.sliceImages[num] = 'data:image/png;base64,AAAA';
    });
    window.sliceState = { pages: [{}], imageMode: !!o.imageMode };
    window.aiStatus = { enabled: !!o.aiEnabled, checked: true, limit: 200, used: 0, message: '' };
    window.aiBatchRunning = false;
    window.gradeAlwaysConvert = false;
    try { localStorage.removeItem('gradeAlwaysConvert'); } catch (e) {}
  }, opts);
}
async function gradeOf(page) {
  return page.evaluate(() => window.documentGradeReport(window.sliceState.pages).grade);
}
async function render(page) {
  await page.evaluate(() => window.renderLowConfidence(window.sliceState.pages));
}

(async () => {
  const srv = await start();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const perr = []; page.on('pageerror', (e) => perr.push(String(e)));
  await page.goto('http://127.0.0.1:' + PORT + '/teacher.html');
  await sleep(200);
  // 이 테스트는 renderLowConfidence 를 직접 부른다 — 배너 조상(#sliceCard)이 기본 숨김이라 버튼 클릭용으로 펼쳐 둔다.
  await page.evaluate(() => { var c = document.getElementById('sliceCard'); if (c) c.style.display = 'block'; });

  try {
    console.log('\n1부 · 등급 판정 로직(실검증)');
    // A: 전부 텍스트, 경계 깔끔
    await setup(page, { rep: { total: 20, ratio: 0.02, emptyCols: 0 }, q: Array.from({ length: 20 }, () => ({ useImage: false })) });
    ok('전부 텍스트·깔끔 → A', (await gradeOf(page)) === 'A');
    // B: 설계형 이미지 몇 개(reason 있음)
    await setup(page, { rep: { total: 20, ratio: 0.05, emptyCols: 0 }, q: Array.from({ length: 20 }, (_, i) => ({ useImage: i < 2, reason: i < 2 ? '선긋기 문항' : null })) });
    ok('이미지 소수(설계형) → B', (await gradeOf(page)) === 'B');
    // C: 인코딩 깨짐
    await setup(page, { rep: { broken: true, total: 20 }, imageMode: true, q: Array.from({ length: 20 }, () => ({ useImage: true, reason: '조판 인코딩' })) });
    ok('조판 인코딩 깨짐 → C', (await gradeOf(page)) === 'C');
    // C: 번호 못 찾음
    await setup(page, { rep: { total: 0 }, q: [] });
    ok('문항 번호 0개 → C', (await gradeOf(page)) === 'C');
    // C: 이미지 절반 이상 + 확인필요 다수(변환 실패)
    await setup(page, { rep: { total: 10, ratio: 0.1 }, q: Array.from({ length: 10 }, () => ({ useImage: true, reason: null })) });
    ok('이미지 과반·확인필요 다수 → C', (await gradeOf(page)) === 'C');
    // C: 경계 관통 심함
    await setup(page, { rep: { total: 10, ratio: 0.4, pierce: 4 }, q: Array.from({ length: 10 }, () => ({ useImage: false })) });
    ok('경계 관통 심함 → C', (await gradeOf(page)) === 'C');

    console.log('\n2부 · 배너(실검증)');
    await setup(page, { rep: { total: 20, ratio: 0.02 }, q: Array.from({ length: 20 }, (_, i) => ({ useImage: i < 2, reason: i < 2 ? '선긋기' : null })) });
    await render(page);
    const bx = await page.locator('#sliceLowConf');
    ok('배너에 등급 뱃지', /등급/.test(await bx.textContent()));
    ok('B등급 뱃지 색·클래스', await page.evaluate(() => document.getElementById('sliceLowConf').className.includes('grade-B')));
    ok('배너에 텍스트/이미지/확인필요 개수', /텍스트 18 · 이미지 2 · 확인 필요 0/.test(await bx.textContent()), await bx.textContent());
    // A 등급은 액션 없음
    await setup(page, { rep: { total: 20, ratio: 0.01 }, q: Array.from({ length: 20 }, () => ({ useImage: false })) });
    await render(page);
    ok('A등급은 액션 버튼 없음', (await page.locator('#gradeAct button').count()) === 0);

    console.log('\n3부 · 수동 재지정 + 키 미설정 안내(실검증)');
    // C등급 + 키 미설정 → 키 안내 + 직접 그리기(수동 재지정), 변환 버튼 없음
    await setup(page, { rep: { broken: true, total: 10 }, imageMode: true, aiEnabled: false, q: Array.from({ length: 10 }, () => ({ useImage: true, reason: '인코딩' })) });
    await render(page);
    ok('키 미설정 → 자동 변환 안내(버튼 없음)', (await page.locator('#gradeConvertBtn').count()) === 0 && /API 키/.test(await bx.textContent()));
    ok('수동 재지정 [직접 그리기] 버튼', (await page.locator('#gradeDrawBtn').count()) === 1);

    console.log('\n4부 · C등급 자동 변환 흐름(API 모킹)');
    // 키 설정됨(모킹) → 변환 버튼 + 확인창
    await setup(page, { rep: { broken: true, total: 6 }, imageMode: true, aiEnabled: true, q: Array.from({ length: 6 }, () => ({ useImage: true, reason: '인코딩' })) });
    await render(page);
    ok('키 설정 → [자동 텍스트 변환] 버튼', (await page.locator('#gradeConvertBtn').count()) === 1, await bx.textContent());
    // 확인창 취소 → 변환 안 함
    convertCalls = 0;
    page.once('dialog', (d) => d.dismiss());
    await page.click('#gradeConvertBtn'); await sleep(300);
    ok('확인창 취소 시 변환 안 함', convertCalls === 0);
    // 확인창 수락(+항상 진행 취소) → 변환 호출됨(모킹)
    convertCalls = 0;
    let dlgCount = 0;
    page.on('dialog', (d) => { dlgCount++; d.accept(); });   // 두 번(변환 확인 + 항상진행)
    await page.click('#gradeConvertBtn');
    await page.waitForFunction(() => window.aiBatchRunning === false, null, { timeout: 8000 }).catch(() => {});
    await sleep(500);
    ok('확인창 수락 → 확인창이 뜬다(비용·항상진행)', dlgCount >= 1, 'dialogs=' + dlgCount);
    ok('자동 변환이 /api/ai-convert 를 호출한다(문항당 1회, 모킹)', convertCalls === 6, 'calls=' + convertCalls);

    ok('JS 에러 없음', perr.length === 0, perr.join(' | '));
  } catch (e) {
    fail++; console.error('\n💥 예외:', e && e.stack ? e.stack : e);
  } finally {
    await browser.close(); srv.close();
  }
  console.log('\n──────────────────────────────');
  console.log('  통과 ' + pass + ' · 실패 ' + fail);
  console.log('──────────────────────────────');
  process.exit(fail ? 1 : 0);
})();
