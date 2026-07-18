// 비전 AI 변환 — 이미지 폴백 문항(규칙 파서 불가: 조판 인코딩 깨짐·분수/특수 조판)을 Claude 비전으로 구조화.
// 규칙 파서의 대안 경로다. 결과는 교사가 [확인 완료]로 확정해야 저장에 쓰인다.
//
// 안전장치
//  - ANTHROPIC_API_KEY 는 환경변수에서만 읽는다(코드·레포에 절대 넣지 않음). 키 없으면 503 로 안내.
//  - 하루 호출 상한(AI_DAILY_LIMIT, 기본 200) — 서버 프로세스 기준 소프트 캡.
//  - 문항당 1회 캐시(같은 조각 이미지 sha256) — 재변환은 force=true 로만(클라이언트가 확인창).
//  - (선택) TEACHER_TOKEN 이 설정돼 있으면 x-teacher-token 헤더 일치를 요구한다.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const MODEL = 'claude-sonnet-5';                 // 사용자 지정: 최신 Sonnet
const API_URL = 'https://api.anthropic.com/v1/messages';
const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '200', 10);

// 문항 구조 스키마 — 구조화 출력(output_config.format)으로 강제한다.
const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    stem: { type: 'string' },
    passage: { type: 'string' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        properties: { marker: { type: 'string' }, text: { type: 'string' } },
        required: ['marker', 'text'],
        additionalProperties: false,
      },
    },
    type: { type: 'string', enum: ['choice', 'short', 'essay', 'ox', 'order', 'unknown'] },
    has_figure: { type: 'boolean' },
  },
  required: ['number', 'stem', 'passage', 'choices', 'type', 'has_figure'],
  additionalProperties: false,
};

function buildPrompt(num) {
  return '이미지는 초등 수학 시험지의 한 문항입니다. 문항 번호는 ' + num + ' 번입니다.\n' +
    '이미지 속 문항을 JSON 으로 구조화하세요.\n' +
    '- number: ' + num + ' (그대로).\n' +
    '- stem: 발문(문제 질문). passage: 발문 앞의 지문·조건(없으면 빈 문자열).\n' +
    '- choices: 객관식 선지 배열 [{marker, text}]. 선지가 없으면 빈 배열.\n' +
    '- type: choice(객관식) / short(단답) / essay(서술) / ox / order(순서배열) / unknown 중 하나.\n' +
    '- has_figure: 그림·도형·그래프·표가 문항에 포함되면 true.\n' +
    '규칙: 분수는 "a/b" 또는 유니코드 분수로, 수식은 텍스트로 최대한 충실히 옮기세요. ' +
    '읽을 수 없는 부분은 [판독불가] 로 표기하고, 절대 지어내지 마세요.';
}

// 일별 호출 카운터(프로세스 메모리) — 날짜가 바뀌면 리셋
let dayKey = '';
let dayCount = 0;
function todayKey() { return new Date().toISOString().slice(0, 10); }
function bumpDaily() {
  const k = todayKey();
  if (k !== dayKey) { dayKey = k; dayCount = 0; }
  dayCount++;
  return dayCount;
}
function usedToday() { return todayKey() === dayKey ? dayCount : 0; }

const cache = new Map();          // sha256(image) -> parsed 결과(문항당 1회 캐시)
const reviewCache = new Map();    // sha256(image+text) -> 검수 결과(자가 검수 캐시)

function teacherOk(req) {
  const need = process.env.TEACHER_TOKEN;
  if (!need) return true;                                   // 미설정이면 열림(앱 나머지와 동일)
  return (req.headers['x-teacher-token'] || '') === need;
}

// GET /api/ai-status — 버튼 상태(키 유무·상한·사용량)
router.get('/ai-status', (req, res) => {
  res.json({
    ok: true,
    enabled: !!process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    limit: DAILY_LIMIT,
    used: usedToday(),
    remaining: Math.max(0, DAILY_LIMIT - usedToday()),
    authRequired: !!process.env.TEACHER_TOKEN,
  });
});

// POST /api/ai-convert  body: { image: dataURL, num, force? }
router.post('/ai-convert', async (req, res) => {
  if (!teacherOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized', message: '교사 인증이 필요합니다.' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(503).json({ ok: false, error: 'no_key', message: 'API 키 설정 필요 (ANTHROPIC_API_KEY 환경변수)' });
  }

  const { image, num, force } = req.body || {};
  if (!image || typeof image !== 'string' || !/^data:image\//.test(image)) {
    return res.status(400).json({ ok: false, error: 'bad_image', message: '이미지(data:image/...) 가 필요합니다.' });
  }
  const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!m) return res.status(400).json({ ok: false, error: 'bad_image', message: '지원하지 않는 이미지 형식입니다.' });
  const mediaType = m[1], b64 = m[2];

  const hash = crypto.createHash('sha256').update(b64).digest('hex');
  if (!force && cache.has(hash)) {
    return res.json({ ok: true, cached: true, parsed: cache.get(hash), used: usedToday(), limit: DAILY_LIMIT });
  }

  if (usedToday() >= DAILY_LIMIT) {
    return res.status(429).json({ ok: false, error: 'daily_limit', message: '하루 AI 변환 상한(' + DAILY_LIMIT + '회)에 도달했습니다.' });
  }

  const payload = {
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: 'disabled' },              // 구조화 추출 — 비용 예측 가능하게 사고 끔
    output_config: { format: { type: 'json_schema', schema: QUESTION_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: buildPrompt(parseInt(num, 10) || 0) },
      ],
    }],
  };

  try {
    bumpDaily();                                  // 실제 호출 직전에 카운트(캐시·상한 통과 후)
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('API 오류(' + r.status + ')');
      return res.status(502).json({ ok: false, error: 'api_error', status: r.status, message: msg });
    }
    if (data.stop_reason === 'refusal') {
      return res.status(422).json({ ok: false, error: 'refusal', message: 'AI 가 이 이미지 변환을 거부했습니다.' });
    }
    const textBlock = (data.content || []).find(function (b) { return b.type === 'text'; });
    if (!textBlock || !textBlock.text) {
      return res.status(502).json({ ok: false, error: 'empty', message: 'AI 응답이 비었습니다.' });
    }
    let parsed;
    try { parsed = JSON.parse(textBlock.text); }
    catch (e) { return res.status(502).json({ ok: false, error: 'parse', message: 'AI 응답 JSON 파싱 실패', raw: textBlock.text.slice(0, 500) }); }

    cache.set(hash, parsed);
    res.json({ ok: true, cached: false, parsed: parsed, used: usedToday(), limit: DAILY_LIMIT });
  } catch (err) {
    console.error('[ai-convert]', err);
    res.status(502).json({ ok: false, error: 'network', message: 'AI 서버 호출 실패: ' + err.message });
  }
});

// ================= AI 자가 검수 =================
// 변환된 텍스트가 원본 조각 이미지와 정말 일치하는지 Claude 가 대조한다.
// 조용히 고치지 않는다 — match/불일치와 근거를 돌려주고, 불일치면 '제안'만 한다. 반영은 교사가 결정.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    match: { type: 'boolean' },                    // 변환 텍스트가 이미지에 충실히 일치하는가
    reason: { type: 'string' },                    // 판단 근거(불일치면 무엇이 어떻게 다른지)
    suggestion: { type: 'string' },                // 불일치면 올바른 발문/선지 제안(일치면 빈 문자열)
  },
  required: ['match', 'reason', 'suggestion'],
  additionalProperties: false,
};
function buildReviewPrompt(num, text) {
  return '이미지는 시험지 ' + num + '번 문항의 원본입니다.\n' +
    '아래는 이 문항을 자동으로 옮긴 텍스트입니다:\n"""\n' + String(text || '').slice(0, 2000) + '\n"""\n\n' +
    '이 텍스트가 이미지 속 문항과 충실히 일치하는지 검수하세요.\n' +
    '- match: 발문·선지·수식이 이미지와 의미상 일치하면 true, 빠짐/오독/뒤바뀜이 있으면 false.\n' +
    '- reason: 판단 근거를 한 문장으로. 불일치면 무엇이 어떻게 다른지 구체적으로.\n' +
    '- suggestion: 불일치면 올바른 발문(또는 선지)을 제안. 일치하면 빈 문자열.\n' +
    '사소한 띄어쓰기·문장부호 차이는 일치로 봅니다. 지어내지 말고 이미지에 보이는 것만 근거로 하세요.';
}

// POST /api/ai-review  body: { image: dataURL, num, text }
router.post('/ai-review', async (req, res) => {
  if (!teacherOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized', message: '교사 인증이 필요합니다.' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'no_key', message: 'API 키 설정 필요 (ANTHROPIC_API_KEY 환경변수)' });

  const { image, num, text } = req.body || {};
  if (!image || typeof image !== 'string' || !/^data:image\//.test(image)) {
    return res.status(400).json({ ok: false, error: 'bad_image', message: '이미지(data:image/...) 가 필요합니다.' });
  }
  const m = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!m) return res.status(400).json({ ok: false, error: 'bad_image', message: '지원하지 않는 이미지 형식입니다.' });
  const mediaType = m[1], b64 = m[2];

  // 검수 캐시 키 = 이미지 + 변환 텍스트(텍스트가 바뀌면 다시 검수해야 하므로 함께 해시)
  const hash = crypto.createHash('sha256').update(b64 + '::' + String(text || '')).digest('hex');
  if (reviewCache.has(hash)) {
    return res.json({ ok: true, cached: true, parsed: reviewCache.get(hash), used: usedToday(), limit: DAILY_LIMIT });
  }
  if (usedToday() >= DAILY_LIMIT) {
    return res.status(429).json({ ok: false, error: 'daily_limit', message: '하루 AI 상한(' + DAILY_LIMIT + '회)에 도달했습니다.' });
  }

  const payload = {
    model: MODEL,
    max_tokens: 1000,
    thinking: { type: 'disabled' },
    output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: buildReviewPrompt(parseInt(num, 10) || 0, text) },
      ],
    }],
  };

  try {
    bumpDaily();
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('API 오류(' + r.status + ')');
      return res.status(502).json({ ok: false, error: 'api_error', status: r.status, message: msg });
    }
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) return res.status(502).json({ ok: false, error: 'empty', message: 'AI 응답이 비었습니다.' });
    let parsed;
    try { parsed = JSON.parse(textBlock.text); }
    catch (e) { return res.status(502).json({ ok: false, error: 'parse', message: 'AI 응답 JSON 파싱 실패' }); }

    reviewCache.set(hash, parsed);
    res.json({ ok: true, cached: false, parsed: parsed, used: usedToday(), limit: DAILY_LIMIT });
  } catch (err) {
    console.error('[ai-review]', err);
    res.status(502).json({ ok: false, error: 'network', message: 'AI 서버 호출 실패: ' + err.message });
  }
});

module.exports = router;
