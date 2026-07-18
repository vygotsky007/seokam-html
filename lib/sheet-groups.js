// 필드 그룹 — 서버(Node)에서 저장된 원본 HTML 로 fields[].group 을 채운다.
//
// 왜 서버에서 다시 계산하나: 새 업로드는 브라우저 감지기(sheet-fields.js)가 group 을 넣지만,
// '이미 발행된' 활동(캠프 활동 포함)의 fields 에는 group 이 없다. 원본 HTML(html_body)은 저장돼 있으니,
// data-fid 위치보다 앞에 있는 가장 가까운 h1/h2 제목을 그 필드의 그룹으로 준다.
// (브라우저 DOM 없이 문자열 스캔 — 정확한 DOM 트리 대신 '문서 순서상 앞선 제목'으로 근사한다.
//  활동지는 위→아래로 읽는 문서라 이 근사가 잘 맞는다.)

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// 앞머리 아이콘·번호 장식을 살짝 걷어낸다(그룹명이 깔끔하게).
function tidy(s) {
  var t = stripTags(s);
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

// html 안의 h1/h2 위치와 data-fid 위치를 문서 순서로 훑어, 각 필드의 '바로 앞 제목'을 group 으로.
function groupsFromHtml(html) {
  var s = String(html || '');
  var events = [];
  var re = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1\s*>|data-fid\s*=\s*"(f\d+)"/gi;
  var m;
  while ((m = re.exec(s)) !== null) {
    if (m[3]) events.push({ pos: m.index, fid: m[3] });
    else events.push({ pos: m.index, heading: tidy(m[2]) });
  }
  events.sort(function (a, b) { return a.pos - b.pos; });
  var cur = '', out = {};
  events.forEach(function (e) {
    if (e.heading != null) { if (e.heading) cur = e.heading; }
    else if (e.fid && out[e.fid] == null) out[e.fid] = cur;   // 그 필드 이전의 마지막 h1/h2
  });
  return out;   // { f1: '그룹명', ... }
}

// fields 에 group 을 채운다(이미 있으면 그대로 둔다). 원본 HTML 이 있으면 그걸로, 없으면 section 으로 대체.
function attachGroups(html, fields) {
  var list = Array.isArray(fields) ? fields : [];
  var byFid = html ? groupsFromHtml(html) : {};
  return list.map(function (f) {
    if (f && f.group) return f;                         // 이미 그룹이 있으면 유지(새 업로드)
    var g = (f && byFid[f.id]) || (f && f.section) || '';
    return Object.assign({}, f, { group: g });
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { attachGroups: attachGroups, groupsFromHtml: groupsFromHtml };
if (typeof window !== 'undefined') window.SheetGroups = { attachGroups: attachGroups, groupsFromHtml: groupsFromHtml };
