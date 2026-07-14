// 실물 시험지 분석기 — 교사 화면의 실제 파이프라인(나누기 → 신뢰도 판정 → HTML 변환)을 그대로 태운다.
//
//   node test/analyze-real.js "C:/path/to/exam.pdf"
//
// 출력: ① 페이지별 원문 텍스트(개인정보 확인용) ② 문항별 결과표 ③ 자동 감지율 요약
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PDF = process.argv[2];
const PORT = 4131;

if (!PDF) { console.error('사용법: node test/analyze-real.js <pdf 경로>'); process.exit(1); }

(async () => {
  const app = express();
  app.use('/lib', express.static(path.join(ROOT, 'lib')));
  app.use(express.static(path.join(ROOT, 'public')));
  const srv = app.listen(PORT);

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => { const s = String(e); if (!/is not valid JSON/.test(s)) errors.push(s); });

  await page.goto(`http://127.0.0.1:${PORT}/teacher.html`);
  await page.setInputFiles('#fileInput', PDF);
  await page.waitForSelector('#sliceBtn', { state: 'visible', timeout: 30000 });
  await page.click('#sliceBtn');
  await page.waitForSelector('.slice-page', { timeout: 60000 });
  await page.waitForFunction(() => window.sliceState && window.sliceState.pages.length > 0, null, { timeout: 60000 });

  // ---- ① 원문 텍스트(개인정보 확인) ----
  const pagesText = await page.evaluate(() =>
    window.sliceState.pages.map((pg) =>
      window.groupLinesX(pg.items || []).sort((a, b) => a.y - b.y).map((l) => l.text).join('\n')
    )
  );

  // ---- 자동 인식 신뢰도 ----
  const conf = await page.evaluate(() => window.lowConfidenceReport(window.sliceState.pages));
  const slices = await page.evaluate(() =>
    window.sliceState.pages.flatMap((pg, pi) => pg.slices.map((s) => ({ page: pi + 1, col: s.col, num: s.num })))
  );

  // ---- ② 저장 → HTML 변환 ----
  await page.click('#sliceSaveBtn');
  const hasSlices = await page.isVisible('#toHtmlBtn');
  let rows = [];
  if (hasSlices) {
    await page.click('#toHtmlBtn');
    await page.waitForSelector('#htmlCards .qcard', { timeout: 60000 });
    rows = await page.evaluate(() => {
      const out = [];
      Object.keys(window.qHtml).map(Number).sort((a, b) => a - b).forEach((n) => {
        const rec = window.qHtml[n], q = rec.parsed;
        out.push({
          num: n,
          label: (window.sliceNums[n] && window.sliceNums[n].length > 1)
            ? window.sliceNums[n][0] + '~' + window.sliceNums[n][window.sliceNums[n].length - 1] : String(n),
          type: q.type,
          useImage: !!rec.useImage,
          reason: rec.reason || '',
          stem: (q.stem || '').slice(0, 44),
          choices: (q.choices || []).length,
          matchCand: !!q.matchCand,
          meta: rec.meta || null,
        });
      });
      return out;
    });
  }

  const summary = await page.textContent('#htmlSummary').catch(() => '');

  await browser.close();
  srv.close();

  // ================= 보고 =================
  console.log('\n================ 원문 텍스트(개인정보 확인용) ================');
  pagesText.forEach((t, i) => {
    console.log(`\n----- ${i + 1}페이지 -----`);
    console.log(t);
  });

  console.log('\n================ 문항별 결과표 ================');
  console.log('번호   | 유형          | 표시     | 선지 | 판정 사유 / 발문');
  console.log('-------|---------------|----------|------|------------------------------------------');
  rows.forEach((r) => {
    const num = r.label.padEnd(6);
    const type = String(r.type).padEnd(13);
    const mode = (r.useImage ? '이미지' : '텍스트').padEnd(8);
    const ch = String(r.choices).padEnd(4);
    const why = r.reason || r.stem;
    console.log(`${num} | ${type} | ${mode} | ${ch} | ${why}`);
  });

  const text = rows.filter((r) => !r.useImage).length;
  const img = rows.filter((r) => r.useImage).length;
  console.log('\n================ 요약 ================');
  console.log('영역(조각) 수      :', slices.length, '| 페이지', pagesText.length);
  console.log('변환 요약          :', summary);
  console.log('텍스트 / 이미지    :', text, '/', img);
  console.log('자동 인식 신뢰도   :', JSON.stringify(conf));
  console.log('선긋기 후보 감지   :', rows.filter((r) => r.matchCand).map((r) => r.label).join(', ') || '없음');
  console.log('기호 채우기 감지   :', rows.filter((r) => r.type === 'fill_symbol').map((r) => r.label).join(', ') || '없음');
  console.log('유형 분포          :', JSON.stringify(rows.reduce((a, r) => { a[r.type] = (a[r.type] || 0) + 1; return a; }, {})));
  if (errors.length) console.log('JS 오류            :', errors.join(' | '));
})();
