// 실제 구동 검증(Playwright + 실제 브라우저).
//
//   node test/make-fixture.js && node test/e2e.js
//
// 1부 = 교사 화면: 실제 PDF 를 올려 자동 인식 → HTML 변환 → 직접 그리기까지 사람이 하듯 클릭·드래그로 몬다.
// 2부 = 학생 화면: 1부에서 '실제로 변환된 HTML' 을 그대로 DB(모의 PostgREST)에 넣고,
//        진짜 server.js 를 띄워 폰 뷰포트(390px)에서 선지 클릭·자동 넘김·제출까지 몬다.
//        → 학생이 고른 값이 서버에 어떤 형식으로 도착하는지, 채점이 맞는지까지 실물로 확인한다.
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { chromium } = require('playwright');

const PDF = path.join(__dirname, 'fixtures', 'exam-synth.pdf');
const ROOT = path.join(__dirname, '..');
const STATIC_PORT = 4101, DB_PORT = 4102, APP_PORT = 4103;
const ACT_ID = '11111111-1111-1111-1111-111111111111';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '\n       → ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 모의 PostgREST(학생 화면이 읽고 쓰는 DB) ----------------
// 진짜 server.js 를 그대로 띄우기 위한 최소 구현. 저장된 제출은 submissions 에 쌓아 두고 검사한다.
function startMockDb(state) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const single = (req, res, row) =>
    (req.headers.accept || '').includes('pgrst.object')
      ? res.json(row || null)
      : res.json(row ? [row] : []);

  app.get('/rest/v1/activities', (req, res) => single(req, res, state.activity));
  app.get('/rest/v1/questions', (req, res) => res.json(state.questions));
  app.post('/rest/v1/submissions', (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    rows.forEach((r) => state.submissions.push(r));
    single(req, res, { id: 'sub-' + state.submissions.length });
  });
  app.delete('/rest/v1/submissions', (req, res) => res.json([]));
  app.patch('/rest/v1/*', (req, res) => res.json([]));
  app.all('/rest/v1/*', (req, res) => res.json([]));
  return new Promise((r) => { const s = app.listen(DB_PORT, () => r(s)); });
}

function startStatic() {
  const app = express();
  app.use('/lib', express.static(path.join(ROOT, 'lib')));
  app.use(express.static(path.join(ROOT, 'public')));
  return new Promise((r) => { const s = app.listen(STATIC_PORT, () => r(s)); });
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

// 페이지 좌표(px) → 화면 좌표. 드래그·클릭에 쓴다.
// ※ 상단 내비(sticky)가 화면 위쪽을 덮고 있어, 목표 지점을 내비 아래로 스크롤한 뒤 좌표를 재야 한다.
async function pageBox(page, idx, focusY) {
  await page.locator('.slice-page').nth(idx).scrollIntoViewIfNeeded();
  if (focusY != null) {
    await page.evaluate(([i, y]) => {
      const el = document.querySelectorAll('.slice-page')[i];
      const r = el.querySelector('img.pageimg').getBoundingClientRect();
      const st = window.sliceState.pages[i];
      window.scrollBy(0, (r.top + (y / st.H) * r.height) - 260);   // 목표 y 를 내비 아래(260px)로
    }, [idx, focusY]);
  }
  return page.evaluate((i) => {
    const el = document.querySelectorAll('.slice-page')[i];
    const img = el.querySelector('img.pageimg');
    const r = img.getBoundingClientRect();
    const st = window.sliceState.pages[i];
    return { left: r.left, top: r.top, w: r.width, h: r.height, W: st.W, H: st.H };
  }, idx);
}
async function drag(page, box, x0, y0, x1, y1) {   // 페이지 px 좌표로 드래그
  const sx = box.left + (x0 / box.W) * box.w, sy = box.top + (y0 / box.H) * box.h;
  const ex = box.left + (x1 / box.W) * box.w, ey = box.top + (y1 / box.H) * box.h;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 6 });
  await page.mouse.move(ex, ey, { steps: 6 });
  await page.mouse.up();
}

(async () => {
  const state = { activity: null, questions: [], submissions: [] };
  const staticSrv = await startStatic();
  const dbSrv = await startMockDb(state);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  // 정적 검증 서버에는 백엔드 API 가 없다 → 교사 페이지의 활동 목록 fetch 가 HTML(404)을 받는다.
  // 이건 이 하네스만의 잡음이므로 코드 오류로 세지 않는다.
  page.on('pageerror', (e) => { const s = String(e); if (!/is not valid JSON/.test(s)) errors.push(s); });

  // =========================================================
  console.log('\n[1부] 교사 화면 — 실제 PDF 업로드 → 자동 인식 → HTML 변환');
  // =========================================================
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/teacher.html`);
  await page.setInputFiles('#fileInput', PDF);
  await page.waitForSelector('#sliceBtn', { state: 'visible', timeout: 20000 });
  await page.click('#sliceBtn');
  await page.waitForSelector('.slice-page .qbox', { timeout: 30000 });
  await page.waitForFunction(() => window.sliceState && window.sliceState.pages.length === 3, null, { timeout: 20000 });

  // --- 자동 인식 품질 배너(표 학습지 페이지 때문에 낮게 나와야 한다) ---
  const banner = await page.isVisible('#sliceLowConf');
  const bannerText = banner ? (await page.textContent('#sliceLowConf')) : '';
  ok('표 학습지가 섞이면 "자동 인식 어려움" 배너가 뜬다', banner && /직접 그리기|자동 인식이 어려워요/.test(bannerText), bannerText.slice(0, 90));

  // --- 공통 지문(※ ㉠~㉢)은 8번 박스 '위쪽 빈 영역'에 있다 → [↓ 아래 문항에 붙이기] (실제 교사 동선) ---
  const gaps = page.locator('.slice-page').first().locator('.gapbox');
  let gi = -1, gx = -1;
  for (let i = 0; i < (await gaps.count()); i++) {
    const b = await gaps.nth(i).boundingBox();
    if (b && b.x > gx) { gx = b.x; gi = i; }        // 오른단(지문이 있는 쪽)의 빈 영역
  }
  ok('지문 위 빈 영역이 [빈 영역]으로 표시된다', gi >= 0);
  await gaps.nth(gi).locator('button').click();

  // --- 8~9 묶기: 두 박스를 클릭해 선택 → [선택 묶기] (사람이 하는 그대로) ---
  await page.click('.slice-page .qbox[data-num="8"]');
  await page.click('.slice-page .qbox[data-num="9"]');
  await page.click('#sliceMergeBtn');
  await page.waitForSelector('.qbox[data-num="8"] .qbox-label');
  const groupLabel = await page.textContent('.qbox[data-num="8"] .qbox-label');
  ok('8·9 를 묶으면 "8~9번" 묶음이 된다', /8~9/.test(groupLabel), groupLabel);

  // --- 저장 → HTML 변환 ---
  await page.click('#sliceSaveBtn');
  await page.waitForSelector('#toHtmlBtn', { state: 'visible' });
  await page.click('#toHtmlBtn');
  await page.waitForSelector('#htmlCards .qcard');

  const parsed = await page.evaluate(() => {
    const out = {};
    Object.keys(window.qHtml).forEach((n) => {
      out[n] = { html: window.qHtml[n].html, type: window.qHtml[n].parsed.type, p: window.qHtml[n].parsed };
    });
    return out;
  });

  // --- [선지 마커] 16번: ①~⑤ 가 화면에 보이고, 데이터에도 남아 있어야 한다 ---
  const q16 = parsed['16'] || { html: '', p: {} };
  const markers16 = (q16.html.match(/data-marker="(.)"/g) || []).map((m) => m[13]);
  ok('16번 선지 5개에 ①~⑤ 마커가 붙는다', markers16.join('') === '①②③④⑤', 'markers=' + markers16.join('') || '(없음)');
  ok('16번 선지 마커가 화면에도 보인다(.cmark)', (q16.html.match(/class="cmark"/g) || []).length === 5);

  // --- [강조 서식] 원본 밑줄 + 굵게 복원 ---
  const stem16 = (q16.html.match(/<p class="stem">([\s\S]*?)<\/p>/) || [])[1] || '';
  ok('16번 발문의 "않은"이 강조된다(<u> 복원)', /<u>[^<]*않은|않은[^<]*<\/u>/.test(stem16) || /<strong>[\s\S]*않은[\s\S]*<\/strong>/.test(stem16), stem16);

  // --- [띄어쓰기] 어절 복원 + 문장부호 앞 공백 제거 ---
  ok('"것입니까"가 붙어 나온다(글자 단위 분해 복원)', /것입니까/.test(q16.p.stem) && !/것 입 니 까/.test(q16.p.stem), 'stem=' + q16.p.stem);
  const c1 = (q16.p.choices || [])[0] || {};
  ok('"최고법이다." 처럼 마침표 앞 공백이 없다', /최고법이다\./.test(c1.text || '') && !/이다 \./.test(c1.text || ''), 'choice①=' + JSON.stringify(c1));

  // --- [발문/지문 분리] 17번: "( )" 뒤 문장은 지문으로 ---
  const q17 = parsed['17'] || { html: '', p: {} };
  ok('17번 발문이 답란 "( )" 에서 끝난다', /어디입니까\?/.test(q17.p.stem) && !/북한강/.test(q17.p.stem), 'stem=' + q17.p.stem);
  ok('17번 "( )" 뒤 문장이 지문 박스로 간다', /북한강/.test(q17.p.passage || '') && /class="passage"/.test(q17.html), 'passage=' + q17.p.passage);

  // --- [부정형 휴리스틱] 20번: 원본에 강조가 없어도 살려낸다 ---
  const q20 = parsed['20'] || { html: '' };
  const stem20 = (q20.html.match(/<p class="stem">([\s\S]*?)<\/p>/) || [])[1] || '';
  ok('20번(원본 강조 없음)의 "않은"을 굵게+밑줄로 보정한다', /<strong><u>[^<]*않은/.test(stem20), stem20);

  // --- [묶음 회귀] 8~9: 지문 1개 + 하위 문항 2개, 각 선지 5개, 답칸 q8·q9 ---
  const g = parsed['8'] || { html: '', p: {} };
  const subNums = (g.html.match(/class="subq" data-num="(\d+)"/g) || []).map((m) => m.match(/\d+/)[0]);
  ok('묶음 8~9 가 하위 문항 8·9 로 갈라진다', subNums.join(',') === '8,9', 'subq=' + subNums.join(',') + ' type=' + g.p.type);
  const per = g.html.split('class="subq"').slice(1).map((s) => (s.match(/data-marker=/g) || []).length);
  ok('8번·9번이 각각 선지 5개를 갖는다(10개 합체 아님)', per.join(',') === '5,5', 'choices/문항=' + per.join(','));
  ok('묶음에 공통 지문이 있다(㉠~㉢)', /㉠/.test(g.p.passage || ''), 'passage=' + (g.p.passage || '').slice(0, 60));
  ok('본문에 쪽번호 "1" 이 섞이지 않는다', !/(^|\s)1(\s|$)/.test((g.p.passage || '')), g.p.passage);

  // --- [기호 선지] 21번: 발문에 인라인으로 붙은 ㉠㉡㉢ 를 선지로 떼어낸다 ---
  const q21 = parsed['21'] || { html: '', p: {} };
  const mk21 = ((q21.p.choices) || []).map((c) => c.marker).join('');
  ok('21번이 선다형으로 잡힌다(단답형 아님)', q21.p.type === 'choice', 'type=' + q21.p.type);
  ok('21번 보기 ㉠㉡㉢ 3개가 선지로 갈라진다', mk21 === '㉠㉡㉢', 'markers=' + mk21);
  ok('21번 발문에서 보기가 빠진다', /기호를 쓰세요\.?$/.test((q21.p.stem || '').trim()) && !/㉠/.test(q21.p.stem || ''), 'stem=' + q21.p.stem);
  ok('21번 선지 본문이 살아 있다(28-17+6)', /28-17\+6/.test(((q21.p.choices || [])[0] || {}).text || ''), JSON.stringify(q21.p.choices));

  // --- (1)(2) 꼴 보기도 선지로 ---
  const q22 = parsed['22'] || { p: {} };
  const mk22 = ((q22.p.choices) || []).map((c) => c.marker).join(',');
  ok('22번 "(1) (2)" 꼴 보기도 선지가 된다', q22.p.type === 'choice' && mk22 === '(1),(2)', 'type=' + q22.p.type + ' markers=' + mk22);

  // --- [유형 수동 전환] 편집기 드롭다운으로 선다형 ↔ 단답형 ---
  await page.selectOption('.qcard[data-num="21"] .qtype-sel', 'short');
  const asShort = await page.evaluate(() => window.qHtml['21'].html);
  ok('편집기에서 단답형으로 바꾸면 클릭 선지가 사라진다', !/data-marker=/.test(asShort) && /㉠/.test(asShort), asShort.slice(0, 80));
  await page.selectOption('.qcard[data-num="21"] .qtype-sel', 'choice');
  const asChoice = await page.evaluate(() => window.qHtml['21'].html);
  ok('다시 선다형으로 바꾸면 클릭 선지가 돌아온다', (asChoice.match(/data-marker=/g) || []).length === 3, asChoice.slice(0, 80));

  // 학생 화면 검증에 쓸 실제 변환 결과를 DB(모의)에 적재 — '교사가 만든 그대로' 학생에게 간다
  const answersKey = { 16: '3', 17: '태백산', 8: '1', 9: '1', 20: '1', 21: '㉡', 22: '(1)' };
  state.activity = { id: ACT_ID, title: '검증용 시험지', html_body: '', status: 'published', version: 1, view_mode: 'single' };
  state.questions = await page.evaluate((key) => {
    const rows = [];
    Object.keys(window.sliceImages).forEach((n) => {
      const nums = window.sliceNums[n] || [Number(n)];
      const rec = window.qHtml[n];
      nums.forEach((num) => {
        rows.push({
          num: num,
          type: rec && rec.parsed.type === 'group'
            ? ((rec.parsed.questions.find((q) => q.number === num) || {}).type || 'short')
            : (rec ? rec.parsed.type : 'short'),
          slice_image: window.sliceImages[n],
          group_label: nums.length > 1 ? nums[0] + '~' + nums[nums.length - 1] : null,
          html_content: rec && !rec.useImage ? rec.html : null,
          answer: key[String(num)] || null,
          graded: true,
        });
      });
    });
    return rows.sort((a, b) => a.num - b.num);
  }, answersKey);
  ok('교사 변환 결과가 문항 행으로 저장된다', state.questions.length >= 5, 'rows=' + state.questions.map((q) => q.num).join(','));

  // =========================================================
  console.log('\n[2부] 직접 그리기(수동 영역) — 빈 페이지에서 드래그 3회');
  // =========================================================
  await page.reload();
  await page.setInputFiles('#fileInput', PDF);
  await page.waitForSelector('#sliceBtn', { state: 'visible', timeout: 20000 });
  await page.click('#sliceBtn');
  await page.waitForSelector('.slice-page .qbox', { timeout: 30000 });

  page.on('dialog', (d) => d.accept());          // "자동 인식 결과를 지울까요?" 확인창
  await page.click('#sliceBlankBtn');
  await page.waitForFunction(() => window.drawMode === true);
  const cleared = await page.evaluate(() => window.sliceState.pages.every((p) => p.slices.length === 0));
  ok('[처음부터 직접 그리기] 가 자동 인식 결과를 모두 버린다', cleared);

  // 2페이지(표 OX 학습지) 위에 직접 그린다 — 그릴 때마다 목표 지점을 화면 안으로 스크롤
  let box2 = await pageBox(page, 1, 60);
  await drag(page, box2, 60, 60, 560, 200);
  box2 = await pageBox(page, 1, 220);
  await drag(page, box2, 60, 220, 560, 360);
  box2 = await pageBox(page, 1, 380);
  await drag(page, box2, 60, 380, 560, 520);
  await page.waitForFunction(() => window.sliceState.pages[1].slices.length === 3);
  const nums = await page.evaluate(() => window.sliceState.pages[1].slices.map((s) => s.num));
  ok('드래그 3회 → 영역 3개, 번호는 그린 순서대로 1·2·3', nums.join(',') === '1,2,3', 'nums=' + nums.join(','));
  const selAfterDraw = await page.evaluate(() => window.sliceSel.length === 1 && window.sliceSel[0].num === 3);
  ok('그린 직후 자동 선택 상태가 된다', selAfterDraw);
  ok('그리는 중 미리보기 유령 박스가 남지 않는다', (await page.locator('.drawghost').count()) === 0);

  // 미리보기가 그린 영역대로 잘리는지(가로:세로 비율로 확인 — 500 x 140 로 그렸다)
  const previewOk = await page.evaluate(() => {
    const img = document.querySelector('#slicePreviewBody img');
    if (!img) return null;
    return { r: img.naturalWidth / img.naturalHeight };
  });
  ok('미리보기 조각이 그린 사각형 비율(500x140≈3.6)로 잘린다',
    previewOk && Math.abs(previewOk.r - 500 / 140) < 0.5, JSON.stringify(previewOk));

  // --- 리사이즈(8방향): 선택된 박스의 남쪽 핸들을 끌어 높이를 늘린다 ---
  const before = await page.evaluate(() => { const s = window.sliceState.pages[1].slices[2]; return { y: s.y, yEnd: s.yEnd }; });
  await page.locator('.slice-page').nth(1).locator('.qbox[data-num="3"]').scrollIntoViewIfNeeded();
  const hb = await page.locator('.slice-page').nth(1).locator('.qbox[data-num="3"] .rz-s').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 60, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => { const s = window.sliceState.pages[1].slices[2]; return { y: s.y, yEnd: s.yEnd }; });
  ok('그린 영역을 리사이즈할 수 있다(아래로 늘림)', after.yEnd > before.yEnd + 20 && after.y === before.y,
    JSON.stringify(before) + ' → ' + JSON.stringify(after));

  // --- 되돌리기(Ctrl+Z) ---
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => { const s = window.sliceState.pages[1].slices[2]; return s.yEnd; });
  ok('Ctrl+Z 로 리사이즈를 되돌린다', Math.abs(undone - before.yEnd) < 1, 'yEnd=' + undone);

  // --- 묶기 / 삭제 ---
  await page.click('.slice-page:nth-of-type(2) .qbox[data-num="1"]');
  await page.click('.slice-page:nth-of-type(2) .qbox[data-num="2"]');
  await page.click('#sliceMergeBtn');
  const merged = await page.evaluate(() => {
    const s = window.sliceState.pages[1].slices;
    return s[0].groupId && s[0].groupId === s[1].groupId;
  });
  ok('그린 영역끼리 묶을 수 있다', !!merged);
  await page.click('.slice-page:nth-of-type(2) .qbox[data-num="3"] .qbox-del');
  const left = await page.evaluate(() => window.sliceState.pages[1].slices.length);
  ok('그린 영역을 삭제할 수 있다', left === 2, 'slices=' + left);

  // --- 저장: 그린 좌표 그대로 잘리는가 ---
  await page.click('#sliceSaveBtn');
  const savedOk = await page.evaluate(() => {
    const keys = Object.keys(window.sliceImages);
    return { keys: keys, hasParts: keys.every((k) => (window.sliceParts[k] || []).length > 0) };
  });
  ok('직접 그린 영역이 조각으로 저장된다', savedOk.keys.length === 1 && savedOk.hasParts, JSON.stringify(savedOk));

  ok('교사 화면에서 자바스크립트 오류가 없다', errors.length === 0, errors.join(' | '));

  // =========================================================
  console.log('\n[3부] 학생 화면 — 진짜 server.js + 폰 뷰포트(390px)');
  // =========================================================
  const app = await startApp();
  const mob = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const sp = await mob.newPage();
  const serrors = [];
  sp.on('pageerror', (e) => serrors.push(String(e)));
  await sp.goto(`http://127.0.0.1:${APP_PORT}/go/${ACT_ID}`);
  await sp.waitForSelector('#slide .qhtml, #slide img');

  // 16번 슬라이드로 이동(칩 클릭)
  await sp.click('.chip:has-text("16")');
  await sp.waitForSelector('#slide ol.choices li.pick');
  const liCount = await sp.locator('#slide ol.choices li.pick').count();
  ok('학생 화면에서 선지가 누를 수 있는 버튼이 된다', liCount === 5, 'li.pick=' + liCount);

  const h = await sp.locator('#slide ol.choices li.pick').first().boundingBox();
  ok('선지 터치 영역이 44px 이상이다(폰)', h.height >= 44, 'height=' + h.height);
  ok('객관식엔 "답 입력" 텍스트칸이 없다', (await sp.locator('#slide .arow input').count()) === 0);

  // 3번째 선지 클릭 → 마커 ③ 기록 + 강조
  await sp.locator('#slide ol.choices li.pick').nth(2).click();
  await sp.waitForSelector('#slide ol.choices li.pick.on');
  const picked = await sp.textContent('#slide .picked');
  ok('선지를 누르면 강조되고 "선택: ③" 이 표시된다', /선택:\s*③/.test(picked), picked);
  const stored = await sp.evaluate(() => document.querySelector('#slide .picked .mk').textContent);
  ok('저장값이 마커 기준(③)이다', /③/.test(stored), stored);

  // 자동 넘김(기본 켬) → 다음 문항으로 이동해 있어야 한다
  await sp.waitForFunction(() => !document.querySelector('.chip.cur') || document.querySelector('.chip.cur').textContent !== '16', null, { timeout: 3000 });
  const curNow = await sp.textContent('.chip.cur');
  ok('자동 넘김 켬: 답을 고르면 다음 문항으로 넘어간다', curNow !== '16', 'cur=' + curNow);

  // 번호바 동기화 + 카운터
  const chip16 = await sp.locator('.chip:has-text("16")').getAttribute('class');
  ok('번호바: 답한 문항이 초록(answered)으로 바뀐다', /answered/.test(chip16), chip16);
  const counter = await sp.textContent('#counter');
  ok('"n/N 답함" 카운터가 맞는다', /^1\/\d+ 답함$/.test(counter.trim()), counter);

  // 자동 넘김 끄기 → 선택해도 그대로
  await sp.click('#autoNextBtn');
  await sp.click('.chip:has-text("20")');
  await sp.waitForSelector('#slide ol.choices li.pick');
  await sp.locator('#slide ol.choices li.pick').first().click();
  await sleep(900);
  const stay = await sp.textContent('.chip.cur');
  ok('자동 넘김 끔: 답을 골라도 그 문항에 머문다', stay === '20', 'cur=' + stay);

  // 재클릭 = 해제
  await sp.locator('#slide ol.choices li.pick').first().click();
  const cleared20 = await sp.locator('#slide ol.choices li.pick.on').count();
  const picked20 = await sp.textContent('#slide .picked');
  ok('같은 선지를 다시 누르면 선택이 해제된다', cleared20 === 0 && /선지를 눌러/.test(picked20), picked20);

  // 설정 유지(localStorage) — 새로고침해도 '끔'
  await sp.reload();
  await sp.waitForSelector('#autoNextBtn');
  const btnTxt = await sp.textContent('#autoNextBtn');
  ok('자동 넘김 설정이 새로고침 뒤에도 유지된다', /끔/.test(btnTxt), btnTxt);

  // 새로고침으로 응답이 초기화됐으므로(응답은 서버 제출 전까지 화면에만 있다) 16번을 다시 고른다
  await sp.click('.chip:has-text("16")');
  await sp.waitForSelector('#slide ol.choices li.pick');
  await sp.locator('#slide ol.choices li.pick').nth(2).click();
  await sp.waitForSelector('#slide ol.choices li.pick.on');

  // 발문/지문 분리가 학생 화면에도 그대로
  await sp.click('.chip:has-text("17")');
  await sp.waitForSelector('#slide .qhtml');
  const psg = await sp.locator('#slide .qhtml .passage').count();
  const psgText = psg ? await sp.textContent('#slide .qhtml .passage') : '';
  ok('17번: "( )" 뒤 문장이 학생 화면에서도 지문 박스다', psg > 0 && /북한강/.test(psgText), psgText);
  ok('17번(단답형)은 입력칸이 그대로 있다', (await sp.locator('#slide .arow input').count()) === 1);
  await sp.fill('#slide .arow input', '태백산');   // 단답형 회귀

  // 묶음 8·9 — 한 슬라이드에 답칸 두 개, 서로 독립
  await sp.click('.chip:has-text("8")');
  await sp.waitForSelector('#slide .qhtml');
  const groupRows = await sp.locator('#slide .picked').count();
  ok('묶음 8~9: 한 화면에 답 자리가 8번·9번 두 개', groupRows === 2, 'rows=' + groupRows);
  await sp.locator('#slide .qhtml [data-num="8"] li.pick').first().click();
  const g8 = await sp.textContent('#slide .picked[data-num="8"]');
  const g9 = await sp.textContent('#slide .picked[data-num="9"]');
  ok('8번을 답해도 9번은 그대로다(독립)', /선택:\s*①/.test(g8) && /선지를 눌러/.test(g9), g8 + ' / ' + g9);

  // ---- 기호 선지(㉠㉡㉢): 초등학생이 원문자를 타이핑할 수 없으니 반드시 클릭이어야 한다 ----
  await sp.click('.chip:has-text("21")');
  await sp.waitForSelector('#slide ol.choices li.pick');
  ok('21번이 학생 화면에서 클릭 선지 3개가 된다', (await sp.locator('#slide ol.choices li.pick').count()) === 3);
  ok('21번엔 텍스트 입력칸이 없다(원문자 타이핑 불가)', (await sp.locator('#slide .arow input').count()) === 0);
  await sp.locator('#slide ol.choices li.pick').nth(1).click();
  const p21 = await sp.textContent('#slide .picked');
  ok('㉡ 을 눌러 답할 수 있다(저장값 "㉡")', /선택:\s*㉡/.test(p21), p21);

  // ---- 연습장(스케치패드) ----
  const padDraw = async () => {
    const b = await sp.locator('#padCanvas').boundingBox();
    await sp.mouse.move(b.x + 20, b.y + 20);
    await sp.mouse.down();
    await sp.mouse.move(b.x + 120, b.y + 90, { steps: 8 });
    await sp.mouse.up();
  };
  const inkOf = () => sp.evaluate(() => {
    const cv = document.querySelector('#padCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 13) if (d[i] > 10) n++;   // 알파값이 있는 픽셀 = 그린 자국
    return n;
  });

  ok('연습장은 기본으로 접혀 있다', (await sp.locator('#padCanvas').count()) === 0);
  await sp.click('#padToggle');
  await sp.waitForSelector('#padCanvas');
  ok('[✏️ 연습장]을 누르면 캔버스가 펼쳐진다', (await sp.locator('#padCanvas').count()) === 1);
  const ta = await sp.evaluate(() => getComputedStyle(document.querySelector('#padCanvas')).touchAction);
  ok('그리는 동안 화면이 스크롤되지 않는다(touch-action:none)', ta === 'none', 'touch-action=' + ta);

  await padDraw();
  const ink21 = await inkOf();
  ok('연습장에 그림이 그려진다', ink21 > 0, 'ink=' + ink21);

  // 다른 문항으로 갔다 오면 — 남의 그림은 안 보이고, 내 그림은 그대로
  await sp.click('.chip:has-text("22")');
  await sp.waitForSelector('#padToggle');
  ok('다른 문항에는 그 문항의 연습장이 뜬다(접힘 상태)', (await sp.locator('#padCanvas').count()) === 0);
  await sp.click('#padToggle');
  await sp.waitForSelector('#padCanvas');
  const ink22 = await inkOf();
  ok('22번 연습장은 비어 있다(21번 그림이 새지 않는다)', ink22 === 0, 'ink=' + ink22);

  await sp.click('.chip:has-text("21")');
  await sp.waitForSelector('#padCanvas');           // 펼침 상태가 문항별로 기억된다
  await sp.waitForFunction(() => {
    const cv = document.querySelector('#padCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 4 * 13) if (d[i] > 10) return true;
    return false;
  }, null, { timeout: 3000 }).catch(() => {});
  const back21 = await inkOf();
  ok('21번으로 돌아오면 그림이 그대로 있다', back21 > 0, 'ink=' + back21);

  // 실행취소 → 그림이 지워진다
  await sp.click('.pad [data-undo]');
  await sleep(300);
  const padUndone = await inkOf();
  ok('실행취소로 마지막 획이 지워진다', padUndone === 0, 'ink=' + padUndone);

  // 지우개·전체 지우기 동작(그린 뒤 전체 지우기)
  await padDraw();
  await sp.click('.pad [data-clear]');
  await sleep(200);
  ok('전체 지우기가 동작한다', (await inkOf()) === 0);
  await sp.click('.pad [data-eraser]');
  ok('지우개 도구를 고를 수 있다', (await sp.locator('.pad [data-eraser].on').count()) === 1);
  await sp.click('.pad [data-big]');
  const bigH = await sp.evaluate(() => document.querySelector('#padCanvas').style.height);
  ok('[더 크게] 로 480px 로 넓어진다', bigH === '480px', bigH);
  await sp.click('#padToggle');
  ok('연습장을 접을 수 있다', (await sp.locator('#padCanvas').count()) === 0);

  // 미답 상태로 제출 → 확인창에 번호가 나오고, 번호를 누르면 그 문항으로 간다
  await sp.click('#nextBtn');                     // 마지막까지 가면 finish()
  for (let i = 0; i < 8; i++) { if (await sp.isVisible('#finishOverlay.show')) break; await sp.click('#nextBtn'); }
  const sheet = await sp.textContent('#finishSheet');
  ok('미답 제출: "n개를 안 풀었어요(…번)" 확인창', /안 풀었어요/.test(sheet) && /번\)/.test(sheet), sheet.slice(0, 80));
  const goBtn = sp.locator('#finishSheet button[data-go]').first();
  const goNum = await goBtn.textContent();
  await goBtn.click();
  const jumped = await sp.textContent('.chip.cur');
  ok('확인창의 번호를 누르면 그 문항으로 이동한다', jumped === goNum, goNum + ' → ' + jumped);

  // 제출 → 서버에 도착한 값 확인(마커 형식 + 채점)
  await sp.fill('#nick', '검증학생');
  for (let i = 0; i < 30; i++) { if (await sp.isVisible('#finishOverlay.show')) break; await sp.click('#nextBtn'); }
  await sp.click('#fSubmit');
  await sp.waitForSelector('#resultOverlay.show', { timeout: 8000 });
  const sub = state.submissions[state.submissions.length - 1] || {};
  const sent = sub.answers || {};
  ok('제출값이 마커 형식(③)으로 서버에 저장된다', sent.q16 === '③', JSON.stringify(sent));
  ok('기호 선지 답도 마커 그대로(㉡) 저장된다', sent.q21 === '㉡', JSON.stringify(sent));
  ok('단답형 답도 함께 저장된다', sent.q17 === '태백산', JSON.stringify(sent));
  // 연습장은 답이 아니다 — 제출 페이로드에 절대 들어가면 안 된다
  const payloadStr = JSON.stringify(sub);
  ok('연습장 그림이 제출 페이로드에 포함되지 않는다', !/data:image\/png/.test(payloadStr) && !/sketch|pad/i.test(payloadStr), payloadStr.slice(0, 100));
  ok('마커(③)가 교사 정답표(3)와 맞아 채점된다(auto_score≥1)', Number(sub.auto_score) >= 1, 'auto_score=' + sub.auto_score);
  ok('학생 화면에서 자바스크립트 오류가 없다', serrors.length === 0, serrors.join(' | '));

  // ---- 정리 ----
  await browser.close();
  app.kill();
  staticSrv.close(); dbSrv.close();

  console.log(`\n${fail ? '❌' : '✅'} 통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('테스트 실행 오류:', e); process.exit(1); });
