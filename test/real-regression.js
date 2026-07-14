// 실물 시험지 상시 회귀 — test/fixtures/real/ 안의 모든 PDF 를 실제 파이프라인에 태운다.
//
//   node test/real-regression.js            (전부)
//   node test/real-regression.js --table    (문항별 결과표까지 출력)
//
// 합성 픽스처(e2e.js)가 잡지 못하는 것을 잡는 게 목적이다 — 실물 조판은 늘 다르다.
// 기준선(baseline)은 test/fixtures/real/baseline.json 에 저장하고, 값이 나빠지면 실패시킨다.
// (문항 수·텍스트 변환 수가 줄거나 JS 오류가 나면 회귀)
const fs = require('fs');
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'fixtures', 'real');
const BASE = path.join(DIR, 'baseline.json');
const PORT = 4132;
const SHOW_TABLE = process.argv.includes('--table');

async function analyze(page, pdf) {
  await page.goto(`http://127.0.0.1:${PORT}/teacher.html`);
  await page.setInputFiles('#fileInput', pdf);
  await page.waitForSelector('#sliceBtn', { state: 'visible', timeout: 30000 });
  await page.click('#sliceBtn');
  await page.waitForSelector('.slice-page', { timeout: 60000 });
  await page.waitForFunction(() => window.sliceState && window.sliceState.pages.length > 0, null, { timeout: 60000 });

  await page.click('#sliceSaveBtn');
  if (!(await page.isVisible('#toHtmlBtn'))) return { slices: 0, rows: [] };
  await page.click('#toHtmlBtn');
  await page.waitForSelector('#htmlCards .qcard', { timeout: 60000 });

  return page.evaluate(() => {
    const rows = Object.keys(window.qHtml).map(Number).sort((a, b) => a - b).map((n) => {
      const rec = window.qHtml[n], q = rec.parsed;
      return {
        num: n, type: q.type, useImage: !!rec.useImage, reason: rec.reason || '',
        choices: (q.choices || []).length, stem: (q.stem || '').slice(0, 40),
      };
    });
    return { slices: rows.length, rows: rows };
  });
}

(async () => {
  if (!fs.existsSync(DIR)) {
    console.log('ℹ 실물 시험지 폴더가 없습니다(test/fixtures/real/) — 건너뜁니다.');
    process.exit(0);
  }
  const pdfs = fs.readdirSync(DIR).filter((f) => /\.pdf$/i.test(f)).sort();
  if (!pdfs.length) {
    console.log('ℹ test/fixtures/real/ 에 PDF 가 없습니다 — 건너뜁니다.');
    process.exit(0);
  }

  const app = express();
  app.use('/lib', express.static(path.join(ROOT, 'lib')));
  app.use(express.static(path.join(ROOT, 'public')));
  const srv = app.listen(PORT);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const s = String(e); if (!/is not valid JSON/.test(s)) errors.push(s); });

  const baseline = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : {};
  const now = {};
  let fail = 0;

  for (const f of pdfs) {
    errors.length = 0;
    const r = await analyze(page, path.join(DIR, f));
    const text = r.rows.filter((x) => !x.useImage).length;
    const img = r.rows.filter((x) => x.useImage).length;
    now[f] = { slices: r.slices, text, image: img, types: r.rows.reduce((a, x) => { a[x.type] = (a[x.type] || 0) + 1; return a; }, {}) };

    console.log(`\n📄 ${f}`);
    console.log(`   문항 ${r.slices}개 · 텍스트 ${text} · 이미지 ${img}`);
    if (SHOW_TABLE) {
      console.log('   번호 | 유형          | 표시   | 선지 | 사유/발문');
      r.rows.forEach((x) => {
        console.log('   ' + String(x.num).padEnd(4) + ' | ' + String(x.type).padEnd(13) + ' | ' +
          (x.useImage ? '이미지' : '텍스트') + ' | ' + String(x.choices).padEnd(4) + ' | ' + (x.reason || x.stem));
      });
    }

    if (errors.length) { console.log('   ❌ JS 오류:', errors.join(' | ')); fail++; }

    const b = baseline[f];
    if (b) {
      // 문항이 사라지거나 텍스트 변환이 줄면 회귀다(늘어나는 건 통과 — 개선이다)
      if (r.slices < b.slices) { console.log(`   ❌ 문항 인식 감소: ${b.slices} → ${r.slices}`); fail++; }
      else if (text < b.text) { console.log(`   ❌ 텍스트 변환 감소: ${b.text} → ${text}`); fail++; }
      else console.log(`   ✅ 기준선 유지(문항 ${b.slices}→${r.slices}, 텍스트 ${b.text}→${text})`);
    } else {
      console.log('   ℹ 기준선 없음 — 이번 값을 기준선으로 저장합니다.');
    }
  }

  await browser.close();
  srv.close();

  // 기준선 갱신: 처음이거나 개선된 값만 올린다(악화는 위에서 이미 실패 처리)
  const merged = Object.assign({}, baseline);
  Object.keys(now).forEach((f) => {
    const b = merged[f];
    if (!b || (now[f].slices >= b.slices && now[f].text >= b.text)) merged[f] = now[f];
  });
  fs.writeFileSync(BASE, JSON.stringify(merged, null, 2) + '\n');

  console.log(`\n${fail ? '❌' : '✅'} 실물 회귀 ${pdfs.length}개 · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
