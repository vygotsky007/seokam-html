// 검증용 시험지 PDF 생성기.
//
// 왜 이렇게까지 하나: 실제 시험지 PDF 는 글자를 '낱개 아이템'으로 흩어 놓는다("것","입","니","까").
// 한 문자열을 통째로 drawText 하면 pdf.js 가 아이템 하나로 돌려주기 때문에, 실물에서 터지는
// 띄어쓰기 버그가 픽스처에서는 재현되지 않는다(= 픽스처만 통과하고 실물에서 깨지는 상황).
// 그래서 여기서는 글자를 하나씩, 실제 조판처럼 x 를 계산해 찍는다.
//
//   node test/make-fixture.js  →  test/fixtures/exam-synth.pdf
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const OUT = path.join(__dirname, 'fixtures', 'exam-synth.pdf');
const REG = 'C:/Windows/Fonts/malgun.ttf';
const BOLD = 'C:/Windows/Fonts/malgunbd.ttf';

const SIZE = 11;
const LEAD = 22;          // 줄 간격
const WORD_GAP = 4.2;     // 어절 사이 여백(= 인쇄된 띄어쓰기). 글자 사이(0)와 뚜렷이 구분돼야 한다.

// 한 줄을 '어절 단위'로 받아 글자 하나씩 찍는다. 반환: 그린 낱말들의 x 범위(밑줄 그을 때 쓴다)
function drawLine(page, words, x0, y, fonts) {
  let x = x0;
  const spans = [];
  for (const w of words) {
    const font = w.bold ? fonts.bold : fonts.reg;
    const start = x;
    for (const ch of w.t) {
      page.drawText(ch, { x, y, size: SIZE, font });
      x += font.widthOfTextAtSize(ch, SIZE);
    }
    spans.push({ t: w.t, x0: start, x1: x, y });
    x += w.gapAfter != null ? w.gapAfter : WORD_GAP;
  }
  return spans;
}
const W = (t, opt) => Object.assign({ t }, opt || {});

(async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = {
    reg: await doc.embedFont(fs.readFileSync(REG), { subset: true }),
    bold: await doc.embedFont(fs.readFileSync(BOLD), { subset: true }),
  };

  // ================= 1페이지: 2단 시험지 =================
  const p1 = doc.addPage([595, 842]);        // A4
  const L = 50, R = 320;                     // 왼단 / 오른단 좌측 기준선
  let y = 780;

  // --- 왼단: 16번(부정형 발문 + 선지 5개) ---
  // "옳지 않은" = 굵게 + 밑줄(원본 강조). 밑줄은 텍스트 레이어에 없으므로 '잉크'로 직접 긋는다.
  const s16 = drawLine(p1, [
    W('16.'), W('다음'), W('중'), W('옳지', { bold: true }), W('않은', { bold: true }), W('것입니까?'),
  ], L, y, fonts);
  const ul = s16.filter((s) => s.t === '옳지' || s.t === '않은');
  p1.drawLine({                                   // ← 실제 시험지의 밑줄(가는 수평선)
    start: { x: ul[0].x0, y: y - 2.2 }, end: { x: ul[ul.length - 1].x1, y: y - 2.2 },
    thickness: 0.9, color: rgb(0, 0, 0),
  });
  y -= LEAD;

  // 선지: ①~⑤. ①은 마침표 앞을 일부러 벌려 놓는다("...이다 ." 가 나오던 조판) → 공백 제거 규칙 검증용.
  const CH16 = [
    [W('①'), W('우리나라의'), W('최고법이다'), W('.', { gapAfter: 0 })],
    [W('②'), W('국민의'), W('권리를'), W('보장한다')],
    [W('③'), W('국회에서'), W('만든다')],
    [W('④'), W('재판의'), W('기준이'), W('된다')],
    [W('⑤'), W('개정할'), W('수'), W('없다')],
  ];
  // ① 의 마침표 앞 간격을 넓게(= 어절 경계로 보일 만큼) — 그래도 "이다." 로 붙어야 한다
  CH16[0][2].gapAfter = 9;
  for (const c of CH16) { drawLine(p1, c, L + 6, y, fonts); y -= LEAD; }
  y -= 8;

  // --- 왼단: 17번(답란 괄호 뒤에 지문이 붙어 나오던 문항) ---
  drawLine(p1, [W('17.'), W('한강의'), W('발원지는'), W('어디입니까?'), W('(     )')], L, y, fonts);
  y -= LEAD;
  drawLine(p1, [W('북한강과'), W('남한강이'), W('만나'), W('한강을'), W('이룬다.')], L, y, fonts);
  y -= LEAD * 2;

  // --- 왼단: 20번(원본에 강조가 없는 부정형 → 휴리스틱이 강조를 되살려야 한다) ---
  drawLine(p1, [W('20.'), W('다음'), W('중'), W('알맞지'), W('않은'), W('것은'), W('무엇입니까?')], L, y, fonts);
  y -= LEAD;
  for (const c of [
    [W('①'), W('물은'), W('얼면'), W('부피가'), W('준다')],
    [W('②'), W('물은'), W('100도에서'), W('끓는다')],
  ]) { drawLine(p1, c, L + 6, y, fonts); y -= LEAD; }

  // --- 오른단: 8~9 묶음(공통 지문 + 하위 2문항, 각 선지 5개) ---
  let ry = 780;
  drawLine(p1, [W('※'), W('다음'), W('글을'), W('읽고'), W('물음에'), W('답하시오.'), W('(8~9)')], R, ry, fonts); ry -= LEAD;
  for (const t of [
    [W('㉠'), W('석고'), W('가루를'), W('그릇에'), W('담는다.')],
    [W('㉡'), W('물을'), W('부어'), W('섞는다.')],
    [W('㉢'), W('굳을'), W('때까지'), W('기다린다.')],
  ]) { drawLine(p1, t, R + 6, ry, fonts); ry -= LEAD; }
  ry -= 6;

  drawLine(p1, [W('8.'), W('석고'), W('가루가'), W('물과'), W('만나면'), W('어떻게'), W('됩니까?')], R, ry, fonts); ry -= LEAD;
  for (const c of [
    [W('①'), W('굳는다')], [W('②'), W('녹는다')], [W('③'), W('끓는다')], [W('④'), W('언다')], [W('⑤'), W('타오른다')],
  ]) { drawLine(p1, c, R + 6, ry, fonts); ry -= LEAD; }
  ry -= 8;

  drawLine(p1, [W('9.'), W('위'), W('과정에서'), W('알'), W('수'), W('있는'), W('것은'), W('어느'), W('것입니까?')], R, ry, fonts); ry -= LEAD;
  for (const c of [
    [W('①'), W('상태가'), W('변한다')], [W('②'), W('색이'), W('변한다')], [W('③'), W('무게가'), W('준다')],
    [W('④'), W('냄새가'), W('난다')], [W('⑤'), W('소리가'), W('난다')],
  ]) { drawLine(p1, c, R + 6, ry, fonts); ry -= LEAD; }

  // 쪽번호(가운데 아래) — 본문에 섞여 들어오면 안 되는 것
  drawLine(p1, [W('1')], 295, 30, fonts);

  // ================= 2페이지: 표 기반 OX 학습지(자동 인식이 통하지 않는 양식) =================
  const p2 = doc.addPage([595, 842]);
  drawLine(p2, [W('OX'), W('퀴즈'), W('학습지')], 50, 790, fonts);

  // 왼쪽: 번호 | 문장 | 답칸 표 — 가로 괘선이 문항 경계처럼 보이는 게 오인의 원인이었다
  let ty = 750;
  const rows = [
    ['1', '지구는 둥글다'], ['2', '물은 100도에서 끓는다'], ['3', '해는 서쪽에서 뜬다'],
    ['4', '식물은 광합성을 한다'], ['5', '소금은 물에 녹는다'], ['6', '달은 스스로 빛난다'],
  ];
  for (const [n, s] of rows) {
    p2.drawLine({ start: { x: 45, y: ty + 15 }, end: { x: 290, y: ty + 15 }, thickness: 0.8, color: rgb(0, 0, 0) });
    drawLine(p2, [W(n)], 52, ty, fonts);
    drawLine(p2, s.split(' ').map((w) => W(w)), 75, ty, fonts);
    p2.drawLine({ start: { x: 250, y: ty + 15 }, end: { x: 250, y: ty - 8 }, thickness: 0.8, color: rgb(0, 0, 0) });
    ty -= 30;
  }
  p2.drawLine({ start: { x: 45, y: ty + 15 }, end: { x: 290, y: ty + 15 }, thickness: 0.8, color: rgb(0, 0, 0) });

  // 오른쪽: 번호 없는 문장 목록 — 자동 인식이 통째로 '빈 영역' 처리하던 자리
  let ry2 = 750;
  for (const s of [
    '고래는 물고기가 아니다', '식초는 산성이다', '공기는 무게가 있다',
    '얼음은 물보다 가볍다', '소리는 진공에서 전달된다', '자석은 철을 끌어당긴다',
  ]) {
    drawLine(p2, s.split(' ').map((w) => W(w)), 320, ry2, fonts);
    ry2 -= 30;
  }

  // ================= 3페이지: 수학 — 보기가 발문에 인라인으로 붙은 문항(㉠㉡㉢) =================
  // 실물에서 "기호를 쓰세요. ㉠ … ㉡ … ㉢ …" 가 한 줄로 뭉쳐 단답형으로 잡히던 자리.
  const p3 = doc.addPage([595, 842]);
  drawLine(p3, [
    W('21.'), W('계산'), W('순서가'), W('다른'), W('것의'), W('기호를'), W('쓰세요.'),
    W('㉠'), W('28-17+6'), W('㉡'), W('28-(17+6)'), W('㉢'), W('(28-17)+6'),
  ], 50, 780, fonts);

  // 회귀용: 같은 페이지에 (1)(2)(3) 꼴 보기도 하나
  drawLine(p3, [W('22.'), W('알맞은'), W('것을'), W('고르세요.')], 50, 730, fonts);
  drawLine(p3, [W('(1)'), W('참')], 56, 708, fonts);
  drawLine(p3, [W('(2)'), W('거짓')], 56, 686, fonts);

  // ============ 4페이지: 그림·위치가 본질인 문항들(텍스트로 옮기면 뜻이 부서진다) ============
  // 실화면 실패 사례 5종을 재현한다 — 이 문항들은 '변환하지 않고 이미지로 남기는 것'이 정답이다.
  const p4 = doc.addPage([595, 842]);

  // 31. 선긋기(좌우 박스 + ● 연결점)
  drawLine(p4, [W('31.'), W('관계있는'), W('것끼리'), W('선으로'), W('이으시오.')], 50, 790, fonts);
  [0, 1, 2].forEach((i) => {
    const y = 750 - i * 34;
    p4.drawRectangle({ x: 60, y: y - 6, width: 90, height: 22, borderWidth: 0.8, borderColor: rgb(0, 0, 0) });
    p4.drawRectangle({ x: 220, y: y - 6, width: 90, height: 22, borderWidth: 0.8, borderColor: rgb(0, 0, 0) });
    drawLine(p4, [W(['사자', '독수리', '상어'][i])], 70, y, fonts);
    drawLine(p4, [W(['하늘', '바다', '땅'][i])], 230, y, fonts);
    drawLine(p4, [W('●')], 158, y, fonts);
    drawLine(p4, [W('●')], 205, y, fonts);
  });

  // 32. 화살표 선지(선지 내용이 그림이라 텍스트로는 빈칸이 된다)
  drawLine(p4, [W('32.'), W('알맞은'), W('방향을'), W('고르시오.')], 50, 630, fonts);
  ['①', '②', '③'].forEach((m, i) => {
    drawLine(p4, [W(m), W('↑')], 60 + i * 60, 605, fonts);
  });

  // 33. □ 가 들어간 수식
  drawLine(p4, [W('33.'), W('□'), W('에'), W('알맞은'), W('수를'), W('구하시오.')], 50, 560, fonts);
  drawLine(p4, [W('3'), W('×'), W('□'), W('='), W('12')], 60, 535, fonts);

  // 34. 식 아래 ↑ 로 자리를 가리키는 문항
  drawLine(p4, [W('34.'), W('잘못'), W('계산한'), W('곳을'), W('찾으시오.')], 50, 490, fonts);
  drawLine(p4, [W('24'), W('÷'), W('6'), W('='), W('3')], 60, 465, fonts);
  drawLine(p4, [W('↑'), W('↑')], 100, 448, fonts);

  // 35. 정상 선다형(과잉 폴백 방지용 대조군 — 이건 텍스트로 변환돼야 한다)
  drawLine(p4, [W('35.'), W('다음'), W('중'), W('가장'), W('큰'), W('수는'), W('어느'), W('것입니까?')], 320, 790, fonts);
  [['①', '15'], ['②', '27'], ['③', '19'], ['④', '31'], ['⑤', '22']].forEach((c, i) => {
    drawLine(p4, [W(c[0]), W(c[1])], 326, 765 - i * 22, fonts);
  });

  // 36. 정상 선다형 하나 더(대조군)
  drawLine(p4, [W('36.'), W('삼각형의'), W('변은'), W('몇'), W('개입니까?')], 320, 640, fonts);
  [['①', '2개'], ['②', '3개'], ['③', '4개']].forEach((c, i) => {
    drawLine(p4, [W(c[0]), W(c[1])], 326, 615 - i * 22, fonts);
  });

  // ============ 5페이지: 초등 시험지에 실제로 나오는 유형들 ============
  const p5 = doc.addPage([595, 842]);

  // 41. 복수 선택형 — <보기> ㄱㄴㄷ 진술 + "모두 고르시오"
  drawLine(p5, [W('41.'), W('옳은'), W('것을'), W('모두'), W('고르시오.')], 50, 790, fonts);
  drawLine(p5, [W('ㄱ.'), W('물은'), W('100도에서'), W('끓는다')], 56, 768, fonts);
  drawLine(p5, [W('ㄴ.'), W('해는'), W('서쪽에서'), W('뜬다')], 56, 746, fonts);
  drawLine(p5, [W('ㄷ.'), W('지구는'), W('둥글다')], 56, 724, fonts);

  // 42. 순서 배열형
  drawLine(p5, [W('42.'), W('일이'), W('일어난'), W('순서대로'), W('기호를'), W('쓰시오.')], 50, 690, fonts);
  drawLine(p5, [W('㉠'), W('싹이'), W('튼다')], 56, 668, fonts);
  drawLine(p5, [W('㉡'), W('꽃이'), W('핀다')], 56, 646, fonts);
  drawLine(p5, [W('㉢'), W('씨를'), W('심는다')], 56, 624, fonts);

  // 43. OX형
  drawLine(p5, [W('43.'), W('고래는'), W('물고기입니다.'), W('맞으면'), W('○,'), W('틀리면'), W('×'), W('하시오.')], 50, 590, fonts);

  // 44. 밑줄 지시형 — 발문 속 ㉠ 은 지문 참조지 선지가 아니다
  drawLine(p5, [W('44.'), W('밑줄'), W('친'), W('㉠의'), W('뜻으로'), W('알맞은'), W('것은'), W('무엇입니까?')], 50, 556, fonts);
  drawLine(p5, [W('①'), W('기쁘다')], 56, 534, fonts);
  drawLine(p5, [W('②'), W('슬프다')], 56, 512, fonts);

  // 45. 빈칸 채우기 — 발문 중간의 ( ) 는 답란이 아니라 문제의 일부다
  drawLine(p5, [W('45.'), W('('), W(')'), W('안에'), W('알맞은'), W('수를'), W('쓰시오.')], 50, 478, fonts);
  drawLine(p5, [W('7'), W('+'), W('5'), W('='), W('12')], 56, 456, fonts);

  // 46. ㈎ / ㉮ / (가) 마커 — 채점 동치 확인용
  drawLine(p5, [W('46.'), W('알맞은'), W('것을'), W('고르시오.')], 320, 790, fonts);
  drawLine(p5, [W('㈎'), W('봄')], 326, 768, fonts);
  drawLine(p5, [W('㈏'), W('여름')], 326, 746, fonts);

  // 47. 서술형
  drawLine(p5, [W('47.'), W('그렇게'), W('생각한'), W('까닭을'), W('쓰시오.')], 320, 712, fonts);

  // ============ 6페이지: 실물에서 지목된 3유형 ============
  const p6 = doc.addPage([595, 842]);

  // 51. 마커-온리 — 식 위에 ↑ 와 ①~⑤ 만 있고 선지 텍스트가 없다
  drawLine(p6, [W('51.'), W('계산이'), W('잘못된'), W('곳은'), W('어디입니까?')], 50, 790, fonts);
  drawLine(p6, [W('24'), W('÷'), W('6'), W('+'), W('2'), W('×'), W('3'), W('='), W('10')], 60, 765, fonts);
  drawLine(p6, [W('①'), W('②'), W('③'), W('④'), W('⑤')], 60, 745, fonts);

  // 52. 복수 답 단답형 — "모두 구하시오"
  drawLine(p6, [W('52.'), W('8의'), W('약수를'), W('모두'), W('구하시오.')], 50, 705, fonts);

  // 53. 소문항 (1)(2)
  drawLine(p6, [W('53.'), W('빈칸에'), W('알맞은'), W('수를'), W('쓰시오.')], 50, 665, fonts);
  drawLine(p6, [W('(1)'), W('3'), W('+'), W('4'), W('='), W('(     )')], 60, 643, fonts);
  drawLine(p6, [W('(2)'), W('9'), W('-'), W('2'), W('='), W('(     )')], 60, 621, fonts);

  // 54. 기호 채우기 — "○ 안에 ×, ÷ 를 한 번씩 써넣으시오"
  drawLine(p6, [W('54.'), W('○'), W('안에'), W('×,'), W('÷'), W('를'), W('한'), W('번씩'), W('써넣으시오.')], 320, 790, fonts);
  drawLine(p6, [W('12'), W('○'), W('3'), W('○'), W('2'), W('='), W('8')], 330, 765, fonts);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, await doc.save());
  console.log('✅ 픽스처 생성:', OUT);
})();
