// 유사 문제 생성 — 원본 문항 1개를 받아 같은 개념·같은 유형·다른 숫자/소재의 쌍둥이 문항 2개를 만든다.
// 생성물은 그대로 발행되지 않는다. 교사 승인(approve)을 거쳐야 활동으로 나갈 수 있다(정답 오류 방지).
const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();

const MODEL = 'claude-opus-4-8';
const EFFORT = process.env.SIMILAR_EFFORT || 'medium'; // low | medium | high | xhigh | max
const MAX_TOKENS = 8000;

// ---------- 비용 상한 ----------
// 학교 앱이라 호출량이 크지 않다. 하루 단위로 출력 토큰 예산을 두고, 넘으면 생성을 막는다.
// (프로세스 메모리 기준 — 재시작하면 초기화된다. 여러 인스턴스로 늘릴 땐 DB 로 옮길 것.)
const DAILY_OUTPUT_TOKEN_BUDGET = parseInt(process.env.SIMILAR_DAILY_TOKENS || '200000', 10);
const budget = { day: null, spent: 0 };

function today() { return new Date().toISOString().slice(0, 10); }
function budgetLeft() {
  if (budget.day !== today()) { budget.day = today(); budget.spent = 0; }
  return DAILY_OUTPUT_TOKEN_BUDGET - budget.spent;
}
function chargeBudget(usage) {
  if (budget.day !== today()) { budget.day = today(); budget.spent = 0; }
  budget.spent += (usage && usage.output_tokens) || 0;
}

// ---------- 캐시(교사 간 공유) ----------
// 같은 문항이면 누가 눌러도 같은 결과를 준다 → 같은 시험지를 여러 교사가 열어도 한 번만 과금.
// key = 원본 문항의 정규화 해시. 서버 메모리에 두므로 인스턴스 간 공유는 아니다.
const CACHE_TTL_MS = parseInt(process.env.SIMILAR_CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const CACHE_MAX = 500;
const cache = new Map(); // key -> { at, items }

function cacheKey(src) {
  const norm = JSON.stringify({
    t: String(src.text || '').replace(/\s+/g, ' ').trim(),
    y: src.type || '',
    a: String(src.answer || '').trim(),
    c: (src.choices || []).map((s) => String(s).replace(/\s+/g, ' ').trim()),
  });
  return crypto.createHash('sha256').update(norm).digest('hex');
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.items;
}
function cacheSet(key, items) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // 가장 오래된 것부터
  cache.set(key, { at: Date.now(), items });
}

// ---------- 생성 ----------
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stem: { type: 'string', description: '문제 본문(발문). 순수 텍스트.' },
          choices: { type: 'array', items: { type: 'string' }, description: '선다형이면 선지 배열, 아니면 빈 배열.' },
          answer: { type: 'string', description: '정답. 선다형이면 1-based 번호 문자열.' },
          solution: { type: 'string', description: '풀이 과정.' },
        },
        required: ['stem', 'choices', 'answer', 'solution'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const SYSTEM = [
  '너는 한국 초등학교 시험 문항을 만드는 선생님이다.',
  '원본 문항을 받아 "쌍둥이 문항" 2개를 만든다.',
  '',
  '규칙:',
  '1. 같은 개념·같은 풀이 절차·같은 문항 유형을 유지한다. 새 개념을 넣지 않는다.',
  '2. 숫자와 소재(등장인물·사물·상황)는 바꾼다. 원본을 그대로 베끼지 않는다.',
  '3. 학년 수준을 유지한다. 원본보다 어렵거나 쉬워지면 안 된다.',
  '4. 답이 자연수 또는 깔끔한 값(분수/소수로 지저분하게 떨어지지 않는 값)이 되도록 숫자를 고른다.',
  '5. 두 문항의 정답은 서로 달라야 하고, 원본의 정답과도 달라야 한다.',
  '6. 선다형이면 선지를 4~5개 만들고 answer 는 정답 선지의 1-based 번호 문자열로 준다.',
  '   선다형이 아니면 choices 는 빈 배열로 두고 answer 에 답 자체를 쓴다.',
  '7. solution 에는 학생이 따라올 수 있는 풀이 과정을 쓴다.',
  '8. 반드시 2개를 만든다.',
].join('\n');

function buildUserPrompt(src) {
  const lines = ['[원본 문항]', src.text || ''];
  if (src.choices && src.choices.length) {
    lines.push('', '[원본 선지]');
    src.choices.forEach((c, i) => lines.push((i + 1) + ') ' + c));
  }
  if (src.answer) lines.push('', '[원본 정답] ' + src.answer);
  if (src.type) lines.push('[원본 유형] ' + src.type);
  lines.push('', '위 문항의 쌍둥이 문항 2개를 만들어라.');
  return lines.join('\n');
}

let client = null;
function getClient() {
  // ANTHROPIC_API_KEY 또는 `ant auth login` 프로필을 SDK 가 알아서 찾는다.
  if (!client) client = new Anthropic();
  return client;
}

async function generate(src) {
  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    thinking: { type: 'adaptive' },   // 정답이 틀리면 안 되는 작업이라 생각을 켠다
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: RESULT_SCHEMA },
    },
    messages: [{ role: 'user', content: buildUserPrompt(src) }],
  });

  if (resp.stop_reason === 'refusal') {
    const err = new Error('모델이 이 문항에 대한 생성을 거절했습니다.');
    err.status = 422;
    throw err;
  }
  if (resp.stop_reason === 'max_tokens') {
    const err = new Error('생성이 길어져 잘렸습니다. 다시 시도해 주세요.');
    err.status = 502;
    throw err;
  }

  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) {
    const err = new Error('모델이 빈 응답을 돌려줬습니다.');
    err.status = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    const err = new Error('생성 결과를 읽지 못했습니다.');
    err.status = 502;
    throw err;
  }

  const items = (parsed.items || []).slice(0, 2).map((it) => ({
    stem: String(it.stem || '').trim(),
    choices: Array.isArray(it.choices) ? it.choices.map(String) : [],
    answer: String(it.answer || '').trim(),
    solution: String(it.solution || '').trim(),
    ai_generated: true,
    approved: false,        // 교사가 승인해야 발행 가능
  })).filter((it) => it.stem && it.answer);

  return { items, usage: resp.usage };
}

// POST /api/similar
// body = { text, type?, answer?, choices?, nocache? }
router.post('/similar', async (req, res) => {
  const { text, type, answer, choices, nocache } = req.body || {};

  if (!text || !String(text).trim()) {
    return res.status(400).json({ ok: false, error: '문항 텍스트가 필요합니다. 이미지 전용 문항은 텍스트로 변환한 뒤 사용하세요.' });
  }

  const src = { text: String(text), type: type || '', answer: answer || '', choices: choices || [] };
  const key = cacheKey(src);

  // [다시 생성]은 캐시를 건너뛴다 — 교사가 결과가 마음에 안 들어 누른 것이므로.
  if (!nocache) {
    const hit = cacheGet(key);
    if (hit) return res.json({ ok: true, cached: true, items: hit });
  }

  const left = budgetLeft();
  if (left <= 0) {
    return res.status(429).json({
      ok: false,
      error: '오늘 유사 문제 생성 한도를 다 썼습니다. 내일 다시 시도하거나 관리자에게 한도 상향을 요청하세요.',
    });
  }

  try {
    const { items, usage } = await generate(src);
    chargeBudget(usage);

    if (!items.length) {
      return res.status(502).json({ ok: false, error: '유사 문항을 만들지 못했습니다. 다시 시도해 주세요.' });
    }

    cacheSet(key, items);
    res.json({ ok: true, cached: false, items, usage: { output_tokens: usage.output_tokens } });
  } catch (err) {
    const status = err.status || (err.status === 0 ? 500 : (err.constructor && err.constructor.name === 'RateLimitError' ? 429 : 500));
    res.status(status >= 400 && status < 600 ? status : 500)
      .json({ ok: false, error: err.message || '생성 실패' });
  }
});

// GET /api/similar/budget — 남은 한도(교사 화면 표시용)
router.get('/similar/budget', (req, res) => {
  res.json({ ok: true, left: budgetLeft(), total: DAILY_OUTPUT_TOKEN_BUDGET });
});

module.exports = router;
