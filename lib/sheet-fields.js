// HTML 활동지의 '답을 적는 칸' 자동 감지 + 라벨 추출.
//
// 브라우저 DOM 위에서 돈다. 교사 화면은 업로드한 파일을 DOMParser 로 열어 여기에 넘기고,
// 학생 화면은 살아 있는 document 를 그대로 넘긴다. 같은 코드가 같은 순서로 같은 id 를 매기므로
// '교사가 확인한 f3' 과 '학생이 입력한 f3' 이 어긋날 수 없다.
//
// 왜 서버가 아니라 브라우저인가: 정규식으로 HTML 을 훑어 '가장 가까운 상위 제목'을 찾는 건 사실상
// DOM 을 다시 만드는 일이다. 교사가 어차피 브라우저에서 업로드하니, 진짜 DOM 이 있는 쪽에서 한다.
// 서버는 넘어온 목록의 모양(shape)과 data-fid 존재만 검증한다(routes/activities.js).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SheetFields = api;
})(this, function () {
  // 감지 대상. input 은 text 계열만 — submit/hidden 등은 답이 아니다.
  const SELECTOR = [
    'textarea',
    'input[type="text"]',
    'input:not([type])',
    'input[type="checkbox"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
  ].join(',');

  // 체크박스를 하나로 묶을 그릇 후보(가까운 것부터).
  const GROUP_SELECTOR = 'ul,ol,fieldset';

  const MAX_LABEL = 160;

  function detectFields(root) {
    const doc = root.ownerDocument || root;
    const nodes = toArray(root.querySelectorAll(SELECTOR));

    const fields = [];
    const groupSeen = new Map();   // 체크박스 그릇 → 이미 만든 필드
    let n = 0;

    nodes.forEach(function (el) {
      const kind = kindOf(el);

      if (kind === 'checkbox') {
        // 체크박스는 낱개가 아니라 '묶음' 하나로 센다(약속 5개 = 필드 1개).
        const box = groupBox(el, root);
        let f = groupSeen.get(box);
        if (!f) {
          f = {
            id: 'f' + ++n,
            tag: 'checkbox',
            label: labelForGroup(box, el),
            section: sectionOf(el),
            group: groupOf(el),
            collect: false,          // 미션 체크는 답이 아니다 → 기본 제외(교사가 켤 수 있다)
            options: [],
          };
          groupSeen.set(box, f);
          fields.push(f);
        }
        el.setAttribute('data-fid', f.id);
        el.setAttribute('data-fopt', String(f.options.length));
        f.options.push(optionLabel(el));
        return;
      }

      const f = {
        id: 'f' + ++n,
        tag: kind,
        label: labelOf(el, doc),
        section: sectionOf(el),
        group: groupOf(el),
        collect: true,
      };
      el.setAttribute('data-fid', f.id);
      fields.push(f);
    });

    return fields;
  }

  function kindOf(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return t === 'checkbox' ? 'checkbox' : 'text';
    }
    return 'rich';   // contenteditable
  }

  // 같은 묶음으로 볼 그릇: 체크박스를 2개 이상 품은 가장 가까운 ul/ol/fieldset.
  // 없으면 부모를, 그것도 없으면 자기 자신을 그릇으로 삼는다(낱개 체크박스 = 묶음 1개).
  function groupBox(el, root) {
    let p = el.parentElement;
    while (p && p !== root.body && p !== root) {
      if (matches(p, GROUP_SELECTOR) && p.querySelectorAll('input[type="checkbox"]').length > 1) return p;
      p = p.parentElement;
    }
    return el.parentElement || el;
  }

  // 묶음의 이름 — 그릇 위에 있는 가장 가까운 제목/라벨.
  // 그릇 바로 앞에 아무것도 없으면 한 겹 밖도 본다: 티켓·카드처럼 제목이 부모의 앞 형제로
  // 빠져 있는 경우가 흔하다(<div class="ticket-head">오늘의 최종 미션</div> 같은).
  function labelForGroup(box, firstEl) {
    const near = labelBefore(box);
    if (near) return near;
    const outer = box.parentElement ? labelBefore(box.parentElement) : '';
    if (outer) return outer;
    const sec = sectionOf(firstEl);
    if (sec) return sec;
    const first = optionLabel(firstEl);
    return first ? clip('체크: ' + first) : '체크 목록';
  }

  function optionLabel(el) {
    const wrap = closest(el, 'label');
    const t = wrap ? text(wrap) : text(el.parentElement);
    return clip(t || '');
  }

  // 라벨 찾기 — 가까운 것부터. 활동지는 사람이 손으로 만든 문서라 '바로 앞에 놓인 짧은 글'이 사실상 라벨이다.
  function labelOf(el, doc) {
    // 1) for= 로 명시적으로 묶인 label
    const id = el.getAttribute && el.getAttribute('id');
    if (id && doc.querySelector) {
      const byFor = doc.querySelector('label[for="' + cssQuote(id) + '"]');
      if (byFor) { const t = text(byFor); if (t) return clip(t); }
    }
    // 2) 감싸고 있는 label
    const wrap = closest(el, 'label');
    if (wrap) { const t = text(wrap); if (t) return clip(t); }
    // 3) aria-label / title
    const aria = attr(el, 'aria-label') || attr(el, 'title');
    if (aria) return clip(aria);
    // 4) 바로 앞에 놓인 라벨스러운 글 (.write-label 같은 것)
    const before = labelBefore(el);
    if (before) return before;
    // 5) placeholder — 예시문이라 라벨로는 마지막 순위
    const ph = attr(el, 'placeholder');
    if (ph) return clip(ph);
    // 6) 가장 가까운 상위 제목
    const sec = sectionOf(el);
    if (sec) return sec;
    return '';
  }

  // 바로 앞 형제(최대 3칸) 중 라벨스러운 것. 제목·label·짧은 글 순으로 본다.
  function labelBefore(el) {
    let p = el.previousElementSibling;
    let hops = 0;
    while (p && hops++ < 3) {
      if (isSkippable(p)) { p = p.previousElementSibling; continue; }
      const t = text(p);
      if (t && isLabelish(p, t)) return clip(t);
      p = p.previousElementSibling;
    }
    return '';
  }

  function isLabelish(el, t) {
    const tag = (el.tagName || '').toLowerCase();
    const cls = (el.getAttribute('class') || '').toLowerCase();
    if (tag === 'label' || /^h[1-6]$/.test(tag)) return true;
    if (/label|title|caption|ask|question|prompt/.test(cls)) return true;
    // 손으로 만든 활동지에서 칸 바로 앞 짧은 한 줄은 거의 라벨이다.
    if (/^(span|p|div|b|strong)$/.test(tag) && t.length <= MAX_LABEL) return true;
    return false;
  }

  // 글이 없는 장식(구분선·빈 div)은 건너뛴다.
  function isSkippable(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'br' || tag === 'hr') return true;
    return !text(el);
  }

  // 가장 가까운 상위 제목 — 조상을 타고 올라가며 그 안의 첫 h1~h6, 또는 조상 앞의 제목을 찾는다.
  function sectionOf(el) {
    let p = el.parentElement;
    let hops = 0;
    while (p && hops++ < 8) {
      const h = p.querySelector && p.querySelector('h1,h2,h3,h4,h5,h6');
      if (h && contains(p, el)) { const t = text(h); if (t) return clip(t); }
      const before = headingBefore(p);
      if (before) return clip(before);
      p = p.parentElement;
    }
    return '';
  }

  // 그룹(굵은 묶음) — h1/h2 수준의 상위 섹션 제목. 캠프 활동지의 SCENE 제목처럼 카드보다 한 단계 위.
  // section 은 바로 위 제목(h3 카드 제목)까지 잡지만, group 은 장면·단원 수준으로 더 굵게 묶는다.
  function groupOf(el) {
    let p = el.parentElement;
    let hops = 0;
    while (p && hops++ < 12) {
      const h = p.querySelector && p.querySelector('h1,h2');
      if (h && contains(p, el)) { const t = text(h); if (t) return clip(t); }
      const before = headingBeforeLevel(p);
      if (before) return clip(before);
      p = p.parentElement;
    }
    return sectionOf(el);                    // h1/h2 가 없으면 가까운 제목으로라도 묶는다
  }
  function headingBeforeLevel(el) {
    let p = el.previousElementSibling;
    let hops = 0;
    while (p && hops++ < 3) {
      const tag = (p.tagName || '').toLowerCase();
      if (/^h[12]$/.test(tag)) { const t = text(p); if (t) return t; }
      p = p.previousElementSibling;
    }
    return '';
  }

  function headingBefore(el) {
    let p = el.previousElementSibling;
    let hops = 0;
    while (p && hops++ < 3) {
      const tag = (p.tagName || '').toLowerCase();
      if (/^h[1-6]$/.test(tag)) { const t = text(p); if (t) return t; }
      p = p.previousElementSibling;
    }
    return '';
  }

  // ---- 잔손질 ----

  function text(el) {
    if (!el) return '';
    return stripLeadingIcon(collectText(el).replace(/\s+/g, ' ').trim());
  }

  // textContent 를 그대로 쓰지 않는 이유: 이웃한 두 요소의 글이 그대로 붙어버린다.
  // <span>오늘의 최종 미션</span><span>1일차</span> → "오늘의 최종 미션1일차".
  // 요소 경계마다 공백을 넣어 읽히는 대로 뽑는다.
  function collectText(el) {
    let s = '';
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.nodeType === 3) s += k.nodeValue;                  // 글자 노드
      else if (k.nodeType === 1) s += ' ' + collectText(k) + ' ';   // 요소 경계
    }
    return s;
  }

  // "🖊 나의 최종 로그라인" → "나의 최종 로그라인". 앞머리 아이콘만 떼고 글자는 건드리지 않는다.
  // (표 머리글로 쓸 때 아이콘이 폭만 잡아먹는다)
  function stripLeadingIcon(s) {
    let i = 0;
    while (i < s.length) {
      const c = s.codePointAt(i);
      const isIcon =
        (c >= 0x1f000 && c <= 0x1ffff) ||   // 그림 이모지
        (c >= 0x2190 && c <= 0x2bff) ||     // 화살표·기호
        (c >= 0xfe00 && c <= 0xfe0f) ||     // 변이 선택자
        c === 0x20e3 || c === 0x200d;       // 키캡·ZWJ
      if (!isIcon) break;
      i += c > 0xffff ? 2 : 1;
      while (i < s.length && s.charAt(i) === ' ') i++;
    }
    return i ? s.slice(i).trim() : s;
  }

  function clip(s) {
    const t = String(s || '').trim();
    return t.length > MAX_LABEL ? t.slice(0, MAX_LABEL - 1) + '…' : t;
  }

  function attr(el, name) {
    const v = el && el.getAttribute ? el.getAttribute(name) : null;
    return v ? String(v).replace(/\s+/g, ' ').trim() : '';
  }

  function cssQuote(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function toArray(nl) { return Array.prototype.slice.call(nl || []); }

  function matches(el, sel) {
    const f = el.matches || el.msMatchesSelector || el.webkitMatchesSelector;
    return f ? f.call(el, sel) : false;
  }

  function closest(el, sel) {
    if (el.closest) return el.closest(sel);
    let p = el;
    while (p) { if (matches(p, sel)) return p; p = p.parentElement; }
    return null;
  }

  function contains(a, b) { return a.contains ? a.contains(b) : false; }

  return { detectFields: detectFields, SELECTOR: SELECTOR };
});
