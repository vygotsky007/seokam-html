// 실 API 확인 러너 — 실제 routes/ai.js 라우터를 그대로 마운트해 3종을 호출한다.
//   ① C등급 자동 변환(ai-convert)  ② 자가 검수(ai-review)  ③ 정답·풀이(ai-answer)
// 응답시간·토큰(입력/출력)·건당 비용·3건 합산·일 200건 기준 월 최대 비용을 출력한다.
// 토큰은 라우터가 남기는 [ai] usage 로그를 같은 프로세스에서 가로채 수집한다(응답 스키마 무변경).
// 키 값은 어디에도 출력하지 않는다 — 존재 여부만 확인하고, 실패 시 에러 본문만(키는 응답/에러에 없음) 보고.
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

// ---- 단가(claude-sonnet-5). 오늘 기준 도입가 적용 여부는 실행 시 안내 ----
// 정가: 입력 $3 / 출력 $15 (per 1M). 도입가(~2026-08-31): 입력 $2 / 출력 $10.
// cache_read 는 입력가의 0.1x. 아래는 도입가 기준(현행). 정가로도 함께 환산 출력.
const PRICE = {
  intro: { in: 2.0, out: 10.0 },
  list:  { in: 3.0, out: 15.0 },
};
const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '200', 10);

function cost(inTok, outTok, p) {
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

// ---- [ai] usage 로그 가로채기(같은 프로세스) ----
const usageByTag = {};
const origLog = console.log.bind(console);
console.log = function (...args) {
  const line = args.join(' ');
  const m = /^\[ai\] usage (\w+) in=(\d+) out=(\d+) cache_read=(\d+)/.exec(line);
  if (m) usageByTag[m[1]] = { in: +m[2], out: +m[3], cache_read: +m[4] };
  origLog(...args);
};

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    origLog('중단: ANTHROPIC_API_KEY 가 환경(.env)에 없습니다. 실 API 호출 불가.');
    process.exit(2);
  }
  origLog('키 감지: 있음 (값은 출력하지 않음). 모델=claude-sonnet-5, 일일 상한=' + DAILY_LIMIT);

  const SAMPLE = path.join(__dirname, 'fixtures', 'real', 'ai-sample.json');
  if (!fs.existsSync(SAMPLE)) { origLog('준비 파일 없음:', SAMPLE, '— 먼저 node test/ai-make-slice.js'); process.exit(1); }
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  const image = sample.slice.dataUrl;
  // ③ 정답·풀이용 실물 문항 텍스트(1번). 페이지 텍스트에서 1번 발췌가 어려우면 안전한 실물 문구 사용.
  const q1text = '계산 결과가 나머지와 다른 하나를 찾아 기호를 쓰세요. ㉠ 28-17+6  ㉡ 28-(17+6)  ㉢ (28-17)+6';

  // ---- 실 라우터 마운트 ----
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api', require('../routes/ai'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  const BASE = 'http://127.0.0.1:' + port;

  async function call(name, endpoint, body) {
    const t0 = Date.now();
    let res, data;
    try {
      res = await fetch(BASE + endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await res.json();
    } catch (e) {
      return { name, ms: Date.now() - t0, ok: false, error: 'fetch: ' + e.message };
    }
    const ms = Date.now() - t0;
    return { name, endpoint, ms, status: res.status, ok: !!(data && data.ok), data };
  }

  const results = [];

  // ① C등급 자동 변환
  origLog('\n① ai-convert (C등급 자동 변환) 호출…');
  const r1 = await call('convert', '/api/ai-convert', { image, num: 1 });
  results.push(r1);
  if (r1.ok) origLog('  → parsed:', JSON.stringify(r1.data.parsed).slice(0, 400));
  else origLog('  → 실패:', r1.status, JSON.stringify(r1.data || r1.error));

  // ② 자가 검수 — ①의 변환 텍스트를 원본 이미지와 대조(의심 큐 항목 1건에 해당)
  const convText = r1.ok && r1.data.parsed
    ? [r1.data.parsed.stem, ...((r1.data.parsed.choices || []).map((c) => c.marker + ' ' + c.text))].join(' ')
    : q1text;
  origLog('\n② ai-review (자가 검수) 호출…');
  const r2 = await call('review', '/api/ai-review', { image, num: 1, text: convText });
  results.push(r2);
  if (r2.ok) origLog('  → parsed:', JSON.stringify(r2.data.parsed).slice(0, 400));
  else origLog('  → 실패:', r2.status, JSON.stringify(r2.data || r2.error));

  // ③ 정답·풀이 — 실물 문항 텍스트로 정답 생성(승인제: confidence 로 대기/자동확정 여부 결정)
  origLog('\n③ ai-answer (정답·풀이) 호출…');
  const r3 = await call('answer', '/api/ai-answer', { num: 1, text: q1text });
  results.push(r3);
  if (r3.ok) origLog('  → parsed:', JSON.stringify(r3.data.parsed).slice(0, 400));
  else origLog('  → 실패:', r3.status, JSON.stringify(r3.data || r3.error));

  server.close();

  // ---- 집계 ----
  origLog('\n================= 실 API 3건 집계 =================');
  origLog('건       시간(ms)  입력tok  출력tok  cache_read  건당비용(도입가)  (정가)');
  let sumMs = 0, sumIn = 0, sumOut = 0, sumIntro = 0, sumList = 0;
  const tagMap = { convert: '① 변환', review: '② 검수', answer: '③ 정답' };
  for (const r of results) {
    const u = usageByTag[r.name] || { in: 0, out: 0, cache_read: 0 };
    const ci = cost(u.in, u.out, PRICE.intro);
    const cl = cost(u.in, u.out, PRICE.list);
    sumMs += r.ms; sumIn += u.in; sumOut += u.out; sumIntro += ci; sumList += cl;
    origLog(
      (tagMap[r.name] || r.name).padEnd(8),
      String(r.ms).padStart(8),
      String(u.in).padStart(8),
      String(u.out).padStart(8),
      String(u.cache_read).padStart(11),
      ('$' + ci.toFixed(6)).padStart(16),
      ('$' + cl.toFixed(6)).padStart(10),
      r.ok ? '' : '  [실패]'
    );
  }
  origLog('-------------------------------------------------');
  origLog('합계    ', String(sumMs).padStart(8), String(sumIn).padStart(8), String(sumOut).padStart(8),
    ' '.repeat(11), ('$' + sumIntro.toFixed(6)).padStart(16), ('$' + sumList.toFixed(6)).padStart(10));

  const okCount = results.filter((r) => r.ok).length;
  const avgIntro = okCount ? sumIntro / okCount : 0;
  const avgList = okCount ? sumList / okCount : 0;

  origLog('\n----- 월 최대 비용 추정(일 ' + DAILY_LIMIT + '건 상한 × 30일) -----');
  origLog('성공 건수:', okCount + '/3', '· 성공분 평균 건당비용(도입가) $' + avgIntro.toFixed(6) + ' / (정가) $' + avgList.toFixed(6));
  origLog('일 최대(도입가): $' + (avgIntro * DAILY_LIMIT).toFixed(4) + '  · 월 최대(×30): $' + (avgIntro * DAILY_LIMIT * 30).toFixed(2));
  origLog('일 최대(정가)  : $' + (avgList * DAILY_LIMIT).toFixed(4) + '  · 월 최대(×30): $' + (avgList * DAILY_LIMIT * 30).toFixed(2));
  origLog('\n주: DAILY_LIMIT 는 서버 프로세스 기준 소프트 캡(재시작 시 리셋). 실제 청구는 호출량에 비례.');

  process.exit(okCount === 3 ? 0 : 1);
})().catch((e) => { origLog('러너 예외:', e.message); process.exit(1); });
