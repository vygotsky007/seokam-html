// AI 자가 검수 검증 ([2]).
//   node test/review-e2e.js
// 검수 흐름·의심 큐·요약·원본보기·제안적용·무시·이미지전환·뱃지·키 미설정 안내는 실검증(로직·UI).
// 실제 Claude 호출만 /api/ai-status·/api/ai-review 모킹(키 의존).
const path = require('path'), express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 4252;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let aiEnabled = true;
let reviewCalls = 0;
// 3번 문항만 불일치로 응답(모킹) — 나머지는 일치
function start() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.get('/api/ai-status', (req, res) => res.json({ ok: true, enabled: aiEnabled, model: 'mock', limit: 200, used: reviewCalls, remaining: 200 - reviewCalls }));
  app.post('/api/ai-review', (req, res) => {
    reviewCalls++;
    const num = req.body && req.body.num;
    if (Number(num) === 3) res.json({ ok: true, parsed: { match: false, reason: '선지 ②가 이미지와 다릅니다', suggestion: '3번 발문 올바른 텍스트' }, used: reviewCalls, limit: 200 });
    else res.json({ ok: true, parsed: { match: true, reason: '이미지와 일치', suggestion: '' }, used: reviewCalls, limit: 200 });
  });
  app.get('/api/activities', (req, res) => res.json({ ok: true, activities: [] }));
  app.use('/lib', express.static(path.join(ROOT, 'lib')));
  app.use(express.static(path.join(ROOT, 'public')));
  return new Promise((r) => { const s = app.listen(PORT, () => r(s)); });
}

// 변환 완료 상태를 페이지에 심는다: 텍스트 문항 5개(3번은 불일치 예정) + 슬라이스 이미지.
async function seed(page) {
  await page.evaluate(() => {
    window.qHtml = {}; window.sliceImages = {}; window.sliceNums = {}; window.reviewStatus = {}; window.reviewRunning = false;
    for (var n = 1; n <= 5; n++) {
      window.qHtml[n] = { parsed: { number: n, stem: n + '번 발문', passage: '', choices: [{ marker: '①', text: '가' }, { marker: '②', text: '나' }], type: 'choice', images: [] }, html: '<p>' + n + '번</p>', reason: null, useImage: false };
      window.sliceImages[n] = 'data:image/png;base64,AAAA';
    }
    window.sliceState = { pages: [{}], imageMode: false };
    window.aiStatus = { enabled: true, checked: true, limit: 200, used: 0 };
    window.aiBatchRunning = false;
    // 이 테스트는 검수만 본다 — 등급 판정(실제 page 구조 필요)은 통째로 스텁해 우회
    window.documentGradeReport = function () { return { grade: 'A', why: [], total: 5, txt: 5, img: 0, need: 0, converted: true, rep: {} }; };
    // 슬라이스 카드가 필요 없는 htmlCard 로 바로 렌더
    document.getElementById('htmlCard').style.display = 'block';
    window.renderHtmlEditor();
  });
}

(async () => {
  const srv = await start();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const perr = []; page.on('pageerror', (e) => perr.push(String(e)));
  page.on('dialog', (d) => d.accept());   // 검수 확인창 자동 수락
  await page.goto('http://127.0.0.1:' + PORT + '/teacher.html');
  await sleep(200);

  try {
    console.log('\n1부 · 검수 버튼 + 키 안내(실검증)');
    await seed(page);
    ok('[AI 자가 검수] 버튼(텍스트 문항 5개)', /자가 검수 \(5\)/.test(await page.locator('#aiReviewBtn').textContent()));
    // 키 미설정 → 안내
    await page.evaluate(() => { window.aiStatus = { enabled: false, checked: true, limit: 0, used: 0 }; window.renderHtmlEditor(); });
    ok('키 미설정 → 버튼 비활성 + 안내', await page.locator('#aiReviewBtn').isDisabled() && /API 키/.test(await page.locator('#aiReviewBtn').textContent()));
    await page.evaluate(() => { window.aiStatus = { enabled: true, checked: true, limit: 200, used: 0 }; window.renderHtmlEditor(); });

    console.log('\n2부 · 검수 실행 → 요약·의심 큐(흐름 모킹, UI 실검증)');
    reviewCalls = 0;
    await page.click('#aiReviewBtn');
    await page.waitForFunction(() => window.reviewRunning === false && document.getElementById('reviewQueue') && document.getElementById('reviewQueue').style.display !== 'none', null, { timeout: 8000 });
    ok('문항당 1회 호출(5회)', reviewCalls === 5, 'calls=' + reviewCalls);
    const sum = await page.locator('#reviewQueue .rvsum').textContent();
    ok('요약 "N개 중 M개 일치"', /5개 중/.test(sum) && /4개 일치/.test(sum), sum);
    ok('의심 1개(3번)', (await page.locator('#reviewQueue .rvitem').count()) === 1);
    ok('의심에 사유 표시', /선지 ②가 이미지와 다릅니다/.test(await page.locator('#reviewQueue .rvitem').textContent()));
    ok('의심에 제안 표시', /3번 발문 올바른 텍스트/.test(await page.locator('#reviewQueue .rvsug').textContent()));
    // 일치 문항은 뱃지 ✓
    ok('일치 문항에 ✓ 검수됨 뱃지', (await page.locator('.qcard[data-num="1"] .rvbadge.ok').count()) === 1);
    ok('불일치 문항에 ⚠ 의심 뱃지', (await page.locator('.qcard[data-num="3"] .rvbadge.susp').count()) === 1);

    console.log('\n3부 · 큐 액션(실검증)');
    // 원본 보기 → 카드 하이라이트
    await page.locator('#reviewQueue button[data-rv="see"]').first().click();
    await sleep(200);
    ok('원본 보기 → 해당 카드 하이라이트', (await page.locator('.qcard[data-num="3"].rvflash').count()) === 1);
    // 제안 적용 → 발문 반영 + 일치로
    await page.locator('#reviewQueue button[data-rv="apply"]').first().click();
    await sleep(200);
    ok('제안 적용 → 발문에 반영', await page.evaluate(() => window.qHtml[3].parsed.stem === '3번 발문 올바른 텍스트'));
    ok('제안 적용 → 의심 큐에서 빠짐(일치 처리)', (await page.locator('#reviewQueue .rvitem').count()) === 0);
    ok('제안 적용 후 요약 5개 일치', /5개 일치/.test(await page.locator('#reviewQueue .rvsum').textContent()));

    // 무시 테스트: 3번을 다시 불일치로 만들고 무시
    await page.evaluate(() => { window.reviewStatus[3] = { match: false, reason: '다시 의심', suggestion: '', ignored: false }; window.renderReviewQueue(); window.renderHtmlEditor(); });
    ok('무시 전 의심 1개', (await page.locator('#reviewQueue .rvitem').count()) === 1);
    await page.locator('#reviewQueue button[data-rv="ignore"]').first().click();
    await sleep(150);
    ok('무시 → 큐에서 빠짐', (await page.locator('#reviewQueue .rvitem').count()) === 0);

    // 이미지로 전환 테스트
    await page.evaluate(() => { window.reviewStatus[4] = { match: false, reason: '변환 이상', suggestion: '수정본', ignored: false }; window.renderReviewQueue(); window.renderHtmlEditor(); });
    await page.locator('#reviewQueue .rvitem[data-n="4"] button[data-rv="image"]').click();
    await sleep(200);
    ok('이미지로 전환 → useImage=true', await page.evaluate(() => window.qHtml[4].useImage === true));

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
