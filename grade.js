// 자동채점 유틸 — choice/short 는 정답 대조, essay 는 채점 제외
// 정답 대조 규칙은 lib/match.js 한 곳에 모아 두고, 발표 모드·결과 화면도 같은 것을 쓴다
// (㉡=ㄴ, ①=1=(1), "5"="5개", "ㄱ,ㄷ"="ㄷ ㄱ", 정답 여러 개는 "㉡|28-(17+6)").
const { normalize, isCorrect } = require('./lib/match');

// questions: [{ num, type, answer, graded }], answers: { q1:'...', q2:'...' } 또는 { '1':'...' }
// 채점 제외 규칙: 서술형(essay) / graded===false / 정답(answer) 미입력 → correct=null, gradable 에서 제외
// 반환: { auto_score, gradable, results:[{ num, type, given, expected, correct|null, excluded }] }
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
      results.push({ num, type: q.type, given, expected: null, correct: null, excluded: false });
      continue;
    }

    // 채점 제외: 교사가 채점대상 해제(graded=false) 했거나 정답을 안 넣은 문항
    const hasAnswer = String(q.answer == null ? '' : q.answer).trim() !== '';
    const excluded = q.graded === false || !hasAnswer;
    if (excluded) {
      results.push({ num, type: q.type, given, expected: q.answer ?? '', correct: null, excluded: true });
      continue;
    }

    gradable += 1;
    // 교사가 발표 모드에서 손으로 인정한 답은 그대로 정답으로 친다
    const manual = q.manual_correct === true;
    // 순서 배열형만 순서를 따진다(복수 선택형은 순서 무시)
    const correct = manual || isCorrect(given, q.answer, { ordered: q.type === 'order' });
    if (correct) auto_score += 1;
    results.push({ num, type: q.type, given, expected: q.answer ?? '', correct, excluded: false });
  }

  return { auto_score, gradable, results };
}

module.exports = { grade, normalize };
