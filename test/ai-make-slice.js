// 실 API 확인용 준비: 실물 PDF 1장에서 (1) 문항 영역 이미지(data:image/png) (2) 페이지 텍스트를 뽑아
// test/fixtures/real/ai-sample.json 에 저장한다. 앱의 실제 경로(teacher.html)와 동일하게 pdf.js 로 렌더한다.
// 결과 파일은 test/fixtures/real/ 아래라 .gitignore 대상(실물 자료) — 커밋되지 않는다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REAL = path.join(__dirname, 'fixtures', 'real');
// C등급(이미지 폴백)이 나올 법한 실물 수학지 — 그림·조판이 섞인 문항이 많다.
const PDF = path.join(REAL, '5-1_수학_중간평가_4회_문제.pdf');
const OUT = path.join(REAL, 'ai-sample.json');
const PNG = path.join(REAL, 'ai-slice.png');            // 육안 확인용

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

(async () => {
  if (!fs.existsSync(PDF)) { console.error('실물 PDF 없음:', PDF); process.exit(1); }
  const b64 = fs.readFileSync(PDF).toString('base64');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('about:blank');
  await page.addScriptTag({ url: PDFJS });

  const result = await page.evaluate(async ({ b64, worker }) => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = worker;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pg = await pdf.getPage(1);
    const scale = 2.0;
    const vp = pg.getViewport({ scale });

    // 전체 페이지 렌더
    const full = document.createElement('canvas');
    full.width = Math.ceil(vp.width); full.height = Math.ceil(vp.height);
    await pg.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise;

    // 상단 헤더를 건너뛰고 첫 문항 영역만 크롭(대략 12%~46% 높이)
    const y0 = Math.round(full.height * 0.12);
    const y1 = Math.round(full.height * 0.46);
    const crop = document.createElement('canvas');
    crop.width = full.width; crop.height = y1 - y0;
    crop.getContext('2d').drawImage(full, 0, y0, full.width, y1 - y0, 0, 0, full.width, y1 - y0);
    const dataUrl = crop.toDataURL('image/png');

    // 페이지 1 텍스트(정답·풀이 라우트 텍스트 입력용)
    const tc = await pg.getTextContent();
    const text = tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();

    return { dataUrl, text, w: crop.width, h: crop.height };
  }, { b64, worker: WORKER });

  await browser.close();
  if (errs.length) console.warn('page errors:', errs.join(' | '));

  if (!result.dataUrl || !/^data:image\/png;base64,/.test(result.dataUrl)) {
    console.error('슬라이스 실패: dataUrl 이 비었거나 형식 오류'); process.exit(1);
  }

  // 육안 확인용 PNG 도 남긴다
  const pngB64 = result.dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(PNG, Buffer.from(pngB64, 'base64'));
  fs.writeFileSync(OUT, JSON.stringify({
    source: path.basename(PDF),
    slice: { w: result.w, h: result.h, dataUrl: result.dataUrl },
    pageText: result.text,
  }, null, 2));

  console.log('슬라이스 완료:', result.w + 'x' + result.h + 'px',
    '· 이미지 bytes=' + Buffer.from(pngB64, 'base64').length,
    '· 텍스트 ' + result.text.length + '자');
  console.log('저장:', path.relative(process.cwd(), OUT), '·', path.relative(process.cwd(), PNG));
})();
