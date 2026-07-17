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

// GET /api/sheet/:id/results
// → { activity:{id,title,kind,fields,closed_at}, rows:[{nickname,answers,submitted,filled,at}] }
router.get('/sheet/:id/results', async (req, res) => {
  const { id } = req.params;

  const { data: activity, error: aErr } = await supabase
    .from('activities')
    .select('id, title, kind, fields, closed_at, join_code, status')
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

  const fields = Array.isArray(activity.fields) ? activity.fields : [];
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

  const rows = Array.from(byName.values()).map((r) => ({
    ...r,
    filled: countFilled(r.answers, collected),
  }));

  // 제출 먼저, 그 안에서는 최근 순
  rows.sort((a, b) => (a.submitted === b.submitted ? String(b.at || '').localeCompare(String(a.at || '')) : a.submitted ? -1 : 1));

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
