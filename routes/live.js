// 실시간 교실 — 접속(하트비트) · 진행 상황 · 공지 · 마감
//
// 폴링으로 끝낸다(WebSocket 없음): 학생 5초, 교사 3초. 30명이면 초당 10요청 수준이라 부담이 없고,
// Railway 재배포로 연결이 끊겨도 다음 폴링에서 저절로 회복된다.
const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { grade } = require('../grade');

const STALE_MS = 15000;         // 15초 무응답 = 연결 끊김
const NOTICE_KEEP = 10;         // 공지는 최근 10개만 보관(화면에는 3개)

// ---- 학생 하트비트: 살아 있음 + 현재 문항 + 지금까지의 답 ----
// 답을 함께 올려 두는 이유: [마감] 때 미제출 학생의 '화면에 있던 답'을 서버가 대신 제출할 수 있어야 한다.
router.post('/live/heartbeat', async (req, res) => {
  const { activityId, nickname, currentQ, answers } = req.body || {};
  if (!activityId || !nickname) return res.status(400).json({ ok: false, error: 'activityId·nickname 이 필요합니다.' });

  const { error } = await supabase
    .from('live_sessions')
    .upsert(
      {
        activity_id: activityId,
        nickname: String(nickname).trim(),
        current_q: currentQ == null ? null : Number(currentQ),
        answers: answers && typeof answers === 'object' ? answers : {},
        last_seen: new Date().toISOString(),
      },
      { onConflict: 'activity_id,nickname' }
    );
  if (error) {
    console.error('[live] heartbeat 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // 학생 화면이 알아야 할 것만 되돌려준다 — 공지(최근 3개)와 마감 여부
  const { data: act } = await supabase
    .from('activities').select('notices, closed_at').eq('id', activityId).single();

  return res.json({
    ok: true,
    notices: ((act && act.notices) || []).slice(0, 3),
    closed: !!(act && act.closed_at),
  });
});

// ---- 교사 대시보드가 3초마다 부르는 현황 ----
router.get('/live/state', async (req, res) => {
  const { activityId } = req.query;
  if (!activityId) return res.status(400).json({ ok: false, error: 'activityId 가 필요합니다.' });

  const [{ data: qs }, { data: sessions }, { data: subs }, { data: act }] = await Promise.all([
    supabase.from('questions').select('num, type, answer').eq('activity_id', activityId).order('num', { ascending: true }),
    supabase.from('live_sessions').select('nickname, current_q, answers, submitted, last_seen').eq('activity_id', activityId),
    supabase.from('submissions').select('nickname, answers, auto_score').eq('activity_id', activityId),
    supabase.from('activities').select('notices, closed_at').eq('id', activityId).single(),
  ]);

  const now = Date.now();
  const submitted = new Set((subs || []).map((s) => s.nickname).filter(Boolean));
  const students = (sessions || [])
    .map((s) => ({
      nickname: s.nickname,
      current_q: s.current_q,
      // 제출한 학생은 제출된 답을, 아직이면 화면에 있는 답을 보여준다
      answers: (submitted.has(s.nickname) && (subs || []).find((x) => x.nickname === s.nickname)?.answers) || s.answers || {},
      submitted: submitted.has(s.nickname),
      last_seen: s.last_seen,
      online: now - new Date(s.last_seen).getTime() < STALE_MS,
    }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));

  return res.json({
    ok: true,
    questions: (qs || []).map((q) => ({ num: q.num, type: q.type, answer: q.answer })),
    students,
    online: students.filter((s) => s.online).length,
    submitted: students.filter((s) => s.submitted).length,
    notices: ((act && act.notices) || []).slice(0, 3),
    closed: !!(act && act.closed_at),
    at: new Date().toISOString(),
  });
});

// ---- 공지 보내기(최신이 앞) ----
router.post('/live/notice', async (req, res) => {
  const { activityId, text } = req.body || {};
  const msg = String(text || '').trim();
  if (!activityId || !msg) return res.status(400).json({ ok: false, error: '공지 내용이 필요합니다.' });

  const { data: act, error: e1 } = await supabase
    .from('activities').select('notices').eq('id', activityId).single();
  if (e1) return res.status(500).json({ ok: false, error: e1.message });

  const notices = [{ text: msg, at: new Date().toISOString() }]
    .concat((act && act.notices) || [])
    .slice(0, NOTICE_KEEP);

  const { error } = await supabase.from('activities').update({ notices }).eq('id', activityId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, notices: notices.slice(0, 3) });
});

// ---- 마감: 미제출 학생의 '화면에 있던 답'을 서버가 대신 제출한다 ----
// (학생 브라우저가 닫혀 있어도 답이 남는다 — 그래서 하트비트에 답을 실어 둔 것이다)
router.post('/live/close', async (req, res) => {
  const { activityId } = req.body || {};
  if (!activityId) return res.status(400).json({ ok: false, error: 'activityId 가 필요합니다.' });

  const { error: e1 } = await supabase
    .from('activities').update({ closed_at: new Date().toISOString() }).eq('id', activityId);
  if (e1) return res.status(500).json({ ok: false, error: e1.message });

  const [{ data: qs }, { data: sessions }, { data: subs }] = await Promise.all([
    supabase.from('questions').select('num, type, answer, graded').eq('activity_id', activityId),
    supabase.from('live_sessions').select('nickname, answers').eq('activity_id', activityId),
    supabase.from('submissions').select('nickname').eq('activity_id', activityId),
  ]);

  const already = new Set((subs || []).map((s) => s.nickname).filter(Boolean));
  const pending = (sessions || []).filter((s) => s.nickname && !already.has(s.nickname));

  let autoSubmitted = 0;
  for (const s of pending) {
    const answers = s.answers || {};
    const { auto_score } = grade(qs || [], answers);
    const { error } = await supabase
      .from('submissions')
      .insert({ activity_id: activityId, nickname: s.nickname, answers, auto_score });
    if (error) { console.error('[live] 자동 제출 실패:', s.nickname, error.message); continue; }
    autoSubmitted++;
  }

  return res.json({ ok: true, closed: true, auto_submitted: autoSubmitted });
});

module.exports = router;
