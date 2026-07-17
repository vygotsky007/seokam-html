// HTML 활동지 정제 — 교사가 만든 '문서 한 채'를 통째로 받아 안전하게 만든다.
//
// lib/sanitize.js 와 왜 따로 두는가:
//   sanitize.js 는 '문항 하나'의 조각용이라 허용 태그가 p·br·img 수준이고 style·section 을 전부 버린다.
//   활동지에 그걸 쓰면 원본 디자인이 통째로 날아간다. 여기서는 반대로 '구조·표현은 최대한 살리고
//   실행 가능한 것만 잘라낸다'.
//
// 방침
//   - <script> 는 내용째 전부 제거한다(문서 내 인터랙션용 인라인 스크립트 포함).
//     진행률 바·복사 버튼처럼 그래서 깨지는 부분은 학생 화면의 수집 스크립트가 대신 살려낸다.
//   - on* 이벤트 속성은 허용 목록 방식이라 저절로 탈락한다(따로 지우지 않는다).
//   - 외부 리소스는 https 만 허용한다(구글 폰트가 이 경로로 들어온다). 이미지에 한해 data:image 도 허용.
//   - <style> 은 살린다. 다만 CSS 안의 expression()·@import·url() 은 따로 훑는다.
//
// 정규식 기반이지만 전부 '허용 목록'이라, 모르는 태그·속성·URL 스킴은 통과하지 못한다.
//
// ※ 반드시 IIFE 로 싸 둔다. 교사 화면은 lib/sanitize.js 와 이 파일을 <script> 두 개로 나란히 읽는데,
//   둘 다 전역에 ALLOWED_TAGS·escapeText 같은 같은 이름을 두면 두 번째 파일이 통째로
//   SyntaxError('already been declared') 로 죽는다. 그러면 window.sanitizeSheet 이 아예 안 생긴다.
//   (node 의 require 는 파일마다 스코프가 따로라 이 사고가 안 보인다 — 브라우저에서만 터진다)

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.sanitizeSheet = api.sanitizeSheet;
})(this, function () {

// 문서를 이루는 뼈대 + 표현 태그. 여기 없는 태그는 '태그만' 버리고 안의 글자는 남긴다.
const ALLOWED_TAGS = [
  'html', 'head', 'body', 'meta', 'title', 'link',
  'header', 'footer', 'main', 'section', 'article', 'aside', 'nav', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sup', 'sub', 'mark', 'code', 'pre', 'blockquote',
  'figure', 'figcaption', 'img', 'a',
  'label', 'input', 'textarea', 'button', 'select', 'option', 'fieldset', 'legend', 'details', 'summary',
];

// 값이 코드로 실행될 여지가 없는 것만. on* · srcdoc · formaction 등은 목록에 없으니 전부 탈락한다.
const GLOBAL_ATTRS = ['class', 'id', 'style', 'lang', 'dir', 'role', 'title', 'hidden', 'tabindex', 'contenteditable'];
const ALLOWED_ATTRS = {
  meta: ['charset', 'name', 'content'],
  link: ['rel', 'href', 'type', 'as', 'crossorigin', 'media'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  a: ['href', 'target', 'rel'],
  input: ['type', 'name', 'value', 'placeholder', 'checked', 'disabled', 'readonly', 'maxlength', 'min', 'max', 'step', 'autocomplete', 'inputmode'],
  textarea: ['name', 'placeholder', 'rows', 'cols', 'disabled', 'readonly', 'maxlength', 'autocomplete', 'inputmode'],
  button: ['type', 'disabled'],
  select: ['name', 'disabled', 'multiple'],
  option: ['value', 'selected', 'disabled'],
  label: ['for'],
  ol: ['start', 'reversed'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'headers', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  details: ['open'],
  html: ['lang'],
};
const VOID_TAGS = ['br', 'hr', 'img', 'meta', 'link', 'input', 'col'];

// 이 태그들은 '내용째' 사라진다. 안에 든 것이 곧 실행물이라 글자만 남겨도 의미가 없다.
// svg·math 는 그 안에서 다시 스크립트를 열 수 있어 함께 버린다.
const STRIP_WHOLE = ['script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset', 'noframes', 'noscript', 'template', 'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track', 'form', 'base'];

function sanitizeSheet(input) {
  let html = String(input == null ? '' : input);

  // 0) 제어문자 제거 — `java(NUL)script:` 처럼 검사만 피해 가려는 수법을 먼저 없앤다.
  html = stripControls(html);

  // 1) doctype 은 토크나이저가 태그로 보지 못해 글자로 새어 나간다(&lt;!doctype…). 먼저 떼고 마지막에 우리가 붙인다.
  html = html.replace(/<!doctype[^>]*>/gi, '');

  // 2) 주석 — 조건부 주석(<!--[if IE]><script>…)까지 통째로
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 3) 실행/삽입 태그 — 내용째 제거. 닫는 태그가 없는 형태도 함께.
  const whole = STRIP_WHOLE.join('|');
  html = html.replace(new RegExp('<(' + whole + ')\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>', 'gi'), '');
  html = html.replace(new RegExp('<\\/?(' + whole + ')\\b[^>]*>', 'gi'), '');

  // 4) <style> 을 경계로 문서를 쪼갠다.
  //    쪼개는 이유: CSS 에는 `.steps>li` 처럼 '>' 가 흔하다. 그대로 태그 토크나이저에 넣으면
  //    선택자가 태그로 오인되고, 글자 이스케이프(&gt;)에 걸려 원본 디자인이 깨진다.
  //    자리표시자를 쓰지 않고 split 으로 나누므로, 본문 글자가 자리표시자와 겹칠 여지 자체가 없다.
  //    split 결과: [글자, CSS, 글자, CSS, …] — 홀수 칸이 <style> 안의 CSS.
  const parts = html.split(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi);

  const stack = [];          // 열린 태그 — 조각을 넘나들며 유지된다(<head> 열고 <style> 지나 </head> 닫기)
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const css = scrubCss(parts[i]);
      if (css.trim()) out += '<style>' + css + '</style>';
    } else {
      out += tokenize(String(parts[i] || '').replace(/<\/?style\b[^>]*>/gi, ''), stack);
    }
  }
  while (stack.length) out += '</' + stack.pop() + '>';   // 안 닫힌 태그 닫기

  return '<!doctype html>\n' + out.trim();
}

// 허용 목록 밖 태그는 '태그만' 버리고 글자는 남긴다. stack 은 호출 간에 이어진다.
function tokenize(html, stack) {
  let out = '';
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0, m;
  while ((m = tagRe.exec(html)) !== null) {
    out += escapeText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    const raw = m[0], tag = m[1].toLowerCase(), attrsRaw = m[2] || '';
    const closing = raw.charAt(1) === '/';
    if (ALLOWED_TAGS.indexOf(tag) < 0) continue;
    if (closing) {
      if (VOID_TAGS.indexOf(tag) >= 0) continue;
      const at = stack.lastIndexOf(tag);
      if (at < 0) continue;                                   // 짝 없는 닫기 태그 무시
      while (stack.length > at) out += '</' + stack.pop() + '>';
      continue;
    }
    const attrs = cleanAttrs(tag, attrsRaw);
    if (tag === 'img' && attrs.indexOf(' src="') < 0) continue;    // 허용 안 되는 src → 이미지째 버린다
    if (tag === 'link' && attrs.indexOf(' href="') < 0) continue;  // 허용 안 되는 href → 링크째 버린다
    if (VOID_TAGS.indexOf(tag) >= 0) { out += '<' + tag + attrs + ' />'; continue; }
    out += '<' + tag + attrs + '>';
    stack.push(tag);
  }
  out += escapeText(html.slice(last));
  return out;
}

function cleanAttrs(tag, raw) {
  const allowed = (ALLOWED_ATTRS[tag] || []).concat(GLOBAL_ATTRS);
  let out = '';
  const re = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*("([^"]*)"|'([^']*)')|([a-zA-Z][a-zA-Z0-9:_-]*)/g;
  const seen = {};
  let m;
  while ((m = re.exec(raw)) !== null) {
    const bare = m[5];
    const name = String(bare != null ? bare : m[1] || '').toLowerCase();
    if (!name || seen[name]) continue;
    let val = bare != null ? '' : (m[3] != null ? m[3] : m[4] != null ? m[4] : '');

    // data-fid 는 학생 화면이 '이 칸이 어느 필드인지' 알아야 해서 남긴다. 순수 데이터라 실행 여지가 없다.
    const isData = /^data-[a-z0-9-]+$/.test(name);
    const isAria = /^aria-[a-z-]+$/.test(name);
    if (!isData && !isAria && allowed.indexOf(name) < 0) continue;   // on* · srcdoc · formaction 등 여기서 탈락

    if (name === 'src' || name === 'href') {
      if (!isSafeUrl(val, tag === 'img')) continue;
    }
    if (name === 'style') {
      val = scrubCss(val);
      if (!val.trim()) continue;
    }
    seen[name] = 1;
    out += ' ' + name + '="' + String(val).replace(/"/g, '&quot;') + '"';
  }
  return out;
}

// 외부 리소스: https 만. 이미지는 data:image 도 허용(문서에서 잘라낸 조각).
// svg+xml 은 그 안에서 스크립트가 돌 수 있어 이미지라도 제외한다.
function isSafeUrl(u, allowDataImage) {
  const s = stripSpacesAndControls(String(u == null ? '' : u)).toLowerCase();
  if (!s) return false;
  if (s.charAt(0) === '#') return true;                        // 문서 내 앵커
  if (s.indexOf('https://') === 0) return true;                // 외부는 https 만 (//evil.com · http:// 는 탈락)
  if (allowDataImage && /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(s)) return true;
  return false;                                                // javascript: · data:text/html · vbscript: · 상대경로 전부 탈락
}

// CSS 안에서 코드가 되는 것들만 걷어낸다. 나머지는 디자인이라 손대지 않는다.
function scrubCss(css) {
  let s = stripControls(String(css == null ? '' : css));
  s = s.replace(/<\/?\s*style/gi, '');                         // style 속성으로 </style> 를 밀어 넣는 수법
  s = s.replace(/expression\s*\(/gi, 'void(');                 // IE expression()
  s = s.replace(/(behavior|-moz-binding)\s*:[^;}]*/gi, '');
  s = s.replace(/@import[^;]*;?/gi, (m) => (/https:\/\//i.test(m) ? m : ''));
  // url(...) — 따옴표형과, url(javascript:alert(1)) 처럼 괄호가 한 겹 더 있는 형태까지 통째로 잡는다.
  // (통째로 잡아야 `none)` 같은 닫는 괄호 찌꺼기가 남지 않는다)
  s = s.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|((?:[^()'"]|\([^()]*\))*))\s*\)/gi,
    (m, dq, sq, bare) => {
      const u = dq != null ? dq : sq != null ? sq : bare || '';
      return isSafeUrl(u, true) ? m : 'none';
    }
  );
  s = s.replace(/javascript\s*:/gi, '');
  return s;
}

// 제어문자(탭·줄바꿈은 유지)를 없앤다. 소스에 제어문자를 리터럴로 박지 않으려고 문자코드로만 판정한다.
function stripControls(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || c >= 32) out += s.charAt(i);
  }
  return out;
}

// URL 검사용 — 공백·제어문자를 전부 턴다(`java\nscript:` · `java script:` 차단).
function stripSpacesAndControls(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 32) out += s.charAt(i);
  }
  return out;
}

function escapeText(s) {
  return String(s).replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

  return { sanitizeSheet: sanitizeSheet, isSafeUrl: isSafeUrl, scrubCss: scrubCss };
});
