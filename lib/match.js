// 정답 매칭 — 발표 모드·교사 정답표 채점·결과 화면이 모두 이 함수를 쓴다.
//
// 왜 필요한가: 정답이 ㉡ 인 문항에 아이들은 폰으로 "ㄴ" 이라고 쓴다(원문자를 칠 수 없다).
// 그렇다고 의미 추론(유의어 등)까지 하면 채점이 예측 불가능해진다. 그래서 '규칙 기반 동치'만 한다.
//
// 동치로 보는 것
//  · 마커 계열: ㉠=ㄱ=ᄀ, ①=1=(1)=1), ㉮=가=(가)
//  · 공백·대소문자·전각/반각·끝 문장부호
//  · 숫자 단위: 정답에 단위가 없으면 학생답의 단위를 허용("5" = "5개")
//  · 복수 답: 구분자·순서 무시("ㄱ,ㄷ" = "ㄷ ㄱ")
//  · 정답 여러 개: 파이프로 등록("㉡|28-(17+6)")
// 이 이상은 하지 않는다.

// ---- 마커 계열 매핑 ----
const SERIES = [];
const CIRCLED_NUM = '①②③④⑤⑥⑦⑧⑨⑩';
const CIRCLED_CONS = '㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭';
const PAREN_CONS = '㈀㈁㈂㈃㈄㈅㈆㈇㈈㈉㈊㈋㈌㈍';
const CONS = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JAMO = ['ᄀ', 'ᄂ', 'ᄃ', 'ᄅ', 'ᄆ', 'ᄇ', 'ᄉ', 'ᄋ', 'ᄌ', 'ᄎ', 'ᄏ', 'ᄐ', 'ᄑ', 'ᄒ'];
const CIRCLED_SYL = '㉮㉯㉰㉱㉲㉳㉴㉵㉶㉷㉸㉹㉺㉻';
const SYL = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하'];

for (let i = 0; i < 10; i++) {
  SERIES.push({ key: 'n' + (i + 1), forms: [CIRCLED_NUM[i], String(i + 1), '(' + (i + 1) + ')', (i + 1) + ')'] });
}
for (let i = 0; i < 14; i++) {
  SERIES.push({ key: 'h' + (i + 1), forms: [CIRCLED_CONS[i], PAREN_CONS[i], CONS[i], JAMO[i], '(' + CONS[i] + ')'] });
  SERIES.push({ key: 's' + (i + 1), forms: [CIRCLED_SYL[i], SYL[i], '(' + SYL[i] + ')'] });
}
const MARKER_MAP = new Map();
for (const s of SERIES) for (const f of s.forms) if (!MARKER_MAP.has(f)) MARKER_MAP.set(f, s.key);
// 'n1' 과 's1' 이 겹치지 않게: 숫자 계열이 먼저 등록되므로 "1" 은 n1, "가" 는 s1 이다.

// ---- 문자열 다듬기 ----
function toHalfWidth(s) {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
}
const TRAIL_PUNCT = /[.,!?;:·、。！？]+$/;

// 복수 답 구분자: 쉼표·가운뎃점·슬래시·"와/과/및"·공백
function splitAnswers(s) {
  return s
    .replace(/\s*(?:와|과|및)\s*/g, ',')
    .split(/[,、·/\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// 토큰 하나 → 비교용 표준형. 숫자는 {n, unit} 로 쪼갠다("5개" → 5 + "개").
const PLAIN_NUM = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
function canonToken(raw) {
  let t = toHalfWidth(String(raw)).trim().toLowerCase().replace(TRAIL_PUNCT, '');
  if (!t) return null;
  // 맨숫자("5")는 마커 표보다 숫자로 먼저 읽는다 — 그래야 "5" 와 "5개" 가 같은 계열로 비교된다.
  // (마커로 먼저 잡으면 "5"=마커n5, "5개"=숫자 가 되어 서로 다른 종류가 돼버린다)
  if (!PLAIN_NUM.test(t)) {
    if (MARKER_MAP.has(t)) return { kind: 'mark', v: MARKER_MAP.get(t) };
    const inner = t.replace(/^[([{]|[)\]}]$/g, '');   // 괄호를 벗겨 본다
    if (inner !== t && MARKER_MAP.has(inner)) return { kind: 'mark', v: MARKER_MAP.get(inner) };
  }
  const m = t.match(/^(\d+(?:\.\d+)?|\.\d+)\s*([^\d\s]*)$/);
  if (m) {
    let num = m[1];
    if (num.startsWith('.')) num = '0' + num;          // ".5" → "0.5"
    return { kind: 'num', v: String(parseFloat(num)), unit: m[2] || '' };
  }
  return { kind: 'text', v: t.replace(/\s+/g, '') };
}
// 정수 1~10 인 숫자는 마커 계열(n1~n10)과도 통한다("1" = "①")
function markOfNum(t) {
  const n = Number(t.v);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? 'n' + n : null;
}

// 답 하나 → 정렬된 토큰 배열(순서 무시 비교용)
function tokenize(v) {
  if (v == null) return [];
  return splitAnswers(toHalfWidth(String(v)))
    .map(canonToken)
    .filter(Boolean)
    .sort((a, b) => (a.kind + a.v).localeCompare(b.kind + b.v));
}

// 사람이 읽는 표준형(디버깅·표시용). 채점 자체는 tokenize 로 한다.
function normalize(v) {
  return tokenize(v).map((t) => (t.kind === 'num' ? t.v + (t.unit || '') : t.v)).join(',');
}

function tokenEq(g, e) {
  if (e.kind === 'mark') {
    if (g.kind === 'mark') return g.v === e.v;
    if (g.kind === 'num') return markOfNum(g) === e.v;   // "3"·"3개" = "③" (정답 ③ 에는 단위가 없다)
    return false;
  }
  if (e.kind === 'num') {
    if (g.kind === 'num') return g.v === e.v && (e.unit === '' || e.unit === g.unit);
    if (g.kind === 'mark') return e.unit === '' && markOfNum(e) === g.v;   // "③" = "3"
    return false;
  }
  return g.kind === e.kind && g.v === e.v;
}

// 정답 하나(파이프 없는)와 학생답 비교
function matchesOne(given, expected) {
  const g = tokenize(given), e = tokenize(expected);
  if (!e.length || g.length !== e.length) return false;
  return e.every((t, i) => tokenEq(g[i], t));
}

// 정답(파이프로 여러 개 등록 가능)과 학생답 비교
function isCorrect(given, expected) {
  if (given == null || String(given).trim() === '') return false;
  return String(expected == null ? '' : expected)
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean)
    .some((alt) => matchesOne(given, alt));
}

// ---- 애매 판정(교사 눈에 띄게만, 자동 정답 처리는 하지 않는다) ----
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(Array(n).fill(0)));
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}
// 정답은 아니지만 편집거리 1 이내 — 오타일 수 있으니 교사가 보고 판단한다.
// ※ 마커끼리는 근접 판정에서 뺀다: ㉡ 자리에 ㉢ 을 쓴 건 오타가 아니라 '다른 선지를 고른 것'이다.
//   (표준형이 h2/h3 라 편집거리가 1 이 되어 버리므로 명시적으로 막아야 한다)
const allMarks = (toks) => toks.length > 0 && toks.every((t) => t.kind === 'mark');
function isNearMiss(given, expected) {
  if (isCorrect(given, expected)) return false;
  const gt = tokenize(given);
  const g = normalize(given);
  if (!g) return false;
  return String(expected == null ? '' : expected).split('|').map((x) => x.trim()).filter(Boolean)
    .some((alt) => {
      const et = tokenize(alt);
      if (allMarks(gt) && allMarks(et)) return false;    // 선지 선택 실수는 오타가 아니다
      const e = normalize(alt);
      return e && editDistance(g, e) <= 1;
    });
}

const api = { normalize, tokenize, isCorrect, isNearMiss, editDistance };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.answerMatch = api;
