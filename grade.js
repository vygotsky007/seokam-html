// 자동채점 유틸 — choice/short 는 정답 대조, essay 는 채점 제외
// 비교는 관대하게: 공백·괄호·마침표·쉼표 제거, 소문자화, 원문자(①②③④⑤)→숫자 정규화

function normalize(v) {
  if (v == null) return '';
  let s = String(v);
  // 원문자 동그라미 숫자 → 일반 숫자 (①=1 ...)
  const circled = { '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5',
                    '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10' };
  s = s.replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, (m) => circled[m]);
  s = s.toLowerCase();
  // 공백·괄호·마침표·쉼표·기타 흔한 기호 제거
  s = s.replace(/[\s().,·、。！!?？'"“”‘’\-_/\\]/g, '');
  return s;
}

// questions: [{ num, type, answer }], answers: { q1:'...', q2:'...' } 또는 { '1':'...' }
// 반환: { auto_score, gradable, results:[{ num, type, given, expected, correct|null }] }
function grade(questions, answers) {
  const a = answers || {};
  const results = [];
  let auto_score = 0;
  let gradable = 0;

  for (const q of questions || []) {
    const num = q.num;
    // name 규칙 q1,q2... 우선, 없으면 순수 숫자 키도 허용
    const given = a['q' + num] ?? a[String(num)] ?? a[num] ?? '';

    if (q.type === 'essay') {
      results.push({ num, type: q.type, given, expected: null, correct: null });
      continue;
    }

    gradable += 1;
    const correct = normalize(given) !== '' && normalize(given) === normalize(q.answer);
    if (correct) auto_score += 1;
    results.push({ num, type: q.type, given, expected: q.answer ?? '', correct });
  }

  return { auto_score, gradable, results };
}

module.exports = { grade, normalize };
