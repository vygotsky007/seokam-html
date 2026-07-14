// 문항 HTML 정제 — 허용 태그·속성만 남긴다(서버 저장 시점의 최종 관문).
// 정규식 기반이지만 '허용 목록(whitelist)' 방식이라 모르는 태그·속성은 전부 버린다.
// 이미지는 본문에서 잘라낸 조각(data:image/...)만 허용 — 외부 URL 로 새는 것을 막는다.

const ALLOWED_TAGS = ['p', 'br', 'strong', 'u', 'sup', 'sub', 'img', 'ol', 'li', 'div', 'span'];
// data-num(문항 번호) · data-marker(선지 마커)는 학생 화면이 '어느 문항의 어느 선지인지' 알아야 해서 남긴다.
// 값이 코드로 실행될 여지가 없는 순수 데이터 속성이다.
const ALLOWED_ATTRS = { img: ['src', 'alt'], '*': ['class', 'data-num', 'data-marker'] };
const VOID_TAGS = ['br', 'img'];

function sanitizeHtml(input) {
  let html = String(input == null ? '' : input);

  // 스크립트·스타일·주석 등은 내용째로 제거
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<(script|style|iframe|object|embed|link|meta|form|input|button|svg)[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(/<(script|style|iframe|object|embed|link|meta|form|input|button|svg)\b[^>]*\/?>/gi, '');

  const openStack = [];
  let out = '';
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0, m;
  while ((m = tagRe.exec(html)) !== null) {
    out += escapeText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    const raw = m[0], tag = m[1].toLowerCase(), attrsRaw = m[2] || '';
    const closing = raw[1] === '/';
    if (ALLOWED_TAGS.indexOf(tag) < 0) continue;            // 허용 목록 밖 → 태그만 버리고 내용은 유지
    if (closing) {
      if (VOID_TAGS.indexOf(tag) >= 0) continue;
      const at = openStack.lastIndexOf(tag);
      if (at < 0) continue;                                  // 짝 없는 닫기 태그 무시
      while (openStack.length > at) out += '</' + openStack.pop() + '>';
      continue;
    }
    const attrs = cleanAttrs(tag, attrsRaw);
    if (tag === 'img' && !/\ssrc="/.test(attrs)) continue;   // 허용 안 되는 src(외부 URL 등) → 이미지째 버린다
    if (VOID_TAGS.indexOf(tag) >= 0) { out += '<' + tag + attrs + ' />'; continue; }
    out += '<' + tag + attrs + '>';
    openStack.push(tag);
  }
  out += escapeText(html.slice(last));
  while (openStack.length) out += '</' + openStack.pop() + '>';   // 안 닫힌 태그 닫기
  return out.trim();
}

function cleanAttrs(tag, raw) {
  const allowed = (ALLOWED_ATTRS[tag] || []).concat(ALLOWED_ATTRS['*']);
  let out = '';
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const val = (m[3] != null ? m[3] : m[4] != null ? m[4] : '');
    if (allowed.indexOf(name) < 0) continue;                       // on* 이벤트·style 등은 여기서 전부 탈락
    if (name === 'src' && !/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i.test(val)) continue;
    out += ' ' + name + '="' + val.replace(/"/g, '&quot;') + '"';
  }
  return out;
}

function escapeText(s) {
  return String(s).replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { sanitizeHtml };
if (typeof window !== 'undefined') window.sanitizeHtml = sanitizeHtml;
