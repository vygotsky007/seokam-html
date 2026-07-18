// HTML 활동지 — 결과 조회 API
//
// 시험지의 대시보드(점수·정답률)는 활동지에 의미가 없다. 활동지는 점수가 없고 '무엇을 썼는가'가 전부다.
// 그래서 결과는 딱 한 가지 모양으로 준다: 행=학생, 열=필드.
//
// 제출본(submissions)과 아직 쓰는 중인 것(live_sessions)을 함께 준다.
// 제출 전에도 교사가 화면에서 진행을 볼 수 있어야 하고("실시간 현황"), 마감 때 미제출 답도 살려야 한다.
// 같은 닉네임이 양쪽에 있으면 제출본이 이긴다(제출이 최종 기록).
const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { attachGroups } = require('../lib/sheet-groups');

// GET /api/sheet/:id/results
// → { activity:{id,title,kind,fields,closed_at}, rows:[{nickname,answers,submitted,filled,at}] }
router.get('/sheet/:id/results', async (req, res) => {
  const { id } = req.params;

  const { data: activity, error: aErr } = await supabase
    .from('activities')
    .select('id, title, kind, fields, closed_at, join_code, status, html_body, hidden_sessions, session_merges')
    .eq('id', id)
    .single();

  if (aErr || !activity) {
    return res.status(404).json({ ok: false, error: '활동을 찾을 수 없습니다.' });
  }
  if (activity.kind !== 'html_sheet') {
    return res.status(400).json({ ok: false, error: 'HTML 활동지가 아닙니다.' });
  }

  const [{ data: subs }, { data: live }] = await Promise.all([
    supabase.from('submissions').select('nickname, answers, created_at')
      .eq('activity_id', id).order('created_at', { ascending: false }),
    supabase.from('live_sessions').select('nickname, answers, submitted, last_seen')
      .eq('activity_id', id).order('last_seen', { ascending: false }),
  ]);

  // 기존 활동도 저장된 원본 HTML 로 그룹을 채운다(fields 에 group 이 없어도).
  const fields = attachGroups(activity.html_body, Array.isArray(activity.fields) ? activity.fields : []);
  const collected = fields.filter((f) => f.collect);

  const byName = new Map();

  // 아직 쓰는 중 — 먼저 깔고
  (live || []).forEach((s) => {
    const name = String(s.nickname || '').trim();
    if (!name) return;
    byName.set(name, {
      nickname: name,
      answers: s.answers && typeof s.answers === 'object' ? s.answers : {},
      submitted: !!s.submitted,
      at: s.last_seen,
      live: true,
    });
  });

  // 제출본으로 덮는다 — 같은 이름이면 제출이 최종. 최신순으로 왔으니 첫 행만 쓴다.
  const tookSub = new Set();
  (subs || []).forEach((s) => {
    const name = String(s.nickname || '').trim() || '(이름없음)';
    if (tookSub.has(name)) return;
    tookSub.add(name);
    byName.set(name, {
      nickname: name,
      answers: s.answers && typeof s.answers === 'object' ? s.answers : {},
      submitted: true,
      at: s.created_at,
      live: false,
    });
  });

  // 병합: from 의 답을 into 로 접어 넣는다(into 의 빈 칸만 채움 — 덮어쓰지 않는다). from 행은 사라진다.
  const merges = Array.isArray(activity.session_merges) ? activity.session_merges : [];
  merges.forEach((m) => {
    const into = byName.get(String(m && m.into || '').trim());
    const from = byName.get(String(m && m.from || '').trim());
    if (!into || !from) return;
    Object.keys(from.answers || {}).forEach((k) => {
      const iv = into.answers[k];
      const empty = iv == null || (Array.isArray(iv) ? iv.length === 0 : String(iv).trim() === '');
      if (empty) into.answers[k] = from.answers[k];
    });
    into.submitted = into.submitted || from.submitted;
    byName.delete(from.nickname);
  });

  // 숨김: 발표·통계에서 빠지되 응답 보기에는 회색으로 남긴다(hidden 표시).
  const hiddenSet = new Set((Array.isArray(activity.hidden_sessions) ? activity.hidden_sessions : []).map((n) => String(n).trim()));

  const rows = Array.from(byName.values()).map((r) => ({
    ...r,
    hidden: hiddenSet.has(r.nickname),
    filled: countFilled(r.answers, collected),
  }));

  // 제출 먼저, 그 안에서는 최근 순 (숨긴 건 맨 뒤)
  rows.sort((a, b) => (a.hidden !== b.hidden ? (a.hidden ? 1 : -1)
    : a.submitted === b.submitted ? String(b.at || '').localeCompare(String(a.at || '')) : a.submitted ? -1 : 1));

  return res.json({
    ok: true,
    activity: {
      id: activity.id, title: activity.title, kind: activity.kind,
      fields, closed_at: activity.closed_at, join_code: activity.join_code, status: activity.status,
    },
    total: collected.length,
    rows,
  });
});

// POST /api/sheet/:id/session — 유령 세션 정리(교사 판단, 되돌릴 수 있게 활동에 배열로 저장)
//   { action: 'hide'|'unhide', nickname } | { action: 'merge'|'unmerge', into, from }
router.post('/sheet/:id/session', async (req, res) => {
  const { id } = req.params;
  const { action, nickname, into, from } = req.body || {};

  const { data: act, error } = await supabase
    .from('activities').select('hidden_sessions, session_merges, kind').eq('id', id).single();
  if (error || !act) return res.status(404).json({ ok: false, error: '활동을 찾을 수 없습니다.' });
  if (act.kind !== 'html_sheet') return res.status(400).json({ ok: false, error: 'HTML 활동지가 아닙니다.' });

  let hidden = Array.isArray(act.hidden_sessions) ? act.hidden_sessions.slice() : [];
  let merges = Array.isArray(act.session_merges) ? act.session_merges.slice() : [];
  const patch = {};

  if (action === 'hide' && nickname) {
    if (hidden.indexOf(nickname) < 0) hidden.push(nickname);
    patch.hidden_sessions = hidden;
  } else if (action === 'unhide' && nickname) {
    patch.hidden_sessions = hidden.filter((n) => n !== nickname);
  } else if (action === 'merge' && into && from && into !== from) {
    // 자동 병합 아님 — 교사가 두 카드를 골라 누른 것만. 같은 쌍 중복 방지.
    if (!merges.some((m) => m.into === into && m.from === from)) merges.push({ into, from });
    patch.session_merges = merges;
  } else if (action === 'unmerge' && from) {
    patch.session_merges = merges.filter((m) => m.from !== from);
  } else {
    return res.status(400).json({ ok: false, error: '잘못된 요청입니다.' });
  }

  const { error: upErr } = await supabase.from('activities').update(patch).eq('id', id);
  if (upErr) return res.status(500).json({ ok: false, error: upErr.message });
  return res.json({ ok: true, hidden_sessions: patch.hidden_sessions || hidden, session_merges: patch.session_merges || merges });
});

// 채운 칸 수 — 진행 표시의 분자. 체크박스 묶음은 하나라도 체크했으면 1칸으로 친다.
function countFilled(answers, collected) {
  let n = 0;
  collected.forEach((f) => {
    if (!isEmptyAnswer(answers[f.id])) n++;
  });
  return n;
}

function isEmptyAnswer(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

module.exports = router;
