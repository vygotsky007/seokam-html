// 제출 저장 + 자동채점 + 조회
const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { grade } = require('../grade');

// POST /api/submit
// 두 방식 지원:
//  (A) 서버 정답표 채점: body = { activityId, nickname, answers }  answers 는 { "q1":"답", ... }
//  (B) HTML 자가채점:    body = { activityId, nickname, self_scored:true, score, total, detail }
//      → 서버 채점을 건너뛰고 auto_score=score. answers 컬럼에 {self_scored,score,total,detail} 통째로 저장.
router.post('/submit', async (req, res) => {
  const { activityId, nickname, answers, self_scored, score, total, detail } = req.body || {};

  if (!activityId) {
    return res.status(400).json({ ok: false, error: 'activityId 가 필요합니다.' });
  }

  // (B) 자가채점: 서버 채점 건너뜀
  if (self_scored) {
    const s = Number(score) || 0;
    const t = Number(total) || 0;
    const det = Array.isArray(detail) ? detail : [];
    const payload = { self_scored: true, score: s, total: t, detail: det };

    const { data, error } = await supabase
      .from('submissions')
      .insert({
        activity_id: activityId,
        nickname: nickname ?? null,
        answers: payload, // detail 등을 통째로 보관 (스키마 변경 없이)
        auto_score: s,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[submit] 자가채점 insert 실패:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    // 학생 페이지가 표시할 수 있게 detail 을 results 형태로도 반환
    const results = det.map((d) => ({ num: d.q, type: 'self', correct: !!d.ok }));
    return res.json({ ok: true, id: data.id, self_scored: true, auto_score: s, gradable: t, results });
  }

  // (A) 서버 정답표 채점 — 기존 방식 유지
  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('num, type, answer, graded')
    .eq('activity_id', activityId)
    .order('num', { ascending: true });

  if (qErr) {
    console.error('[submit] 문항 조회 실패:', qErr.message);
    return res.status(500).json({ ok: false, error: qErr.message });
  }

  const { auto_score, gradable, results } = grade(questions, answers);

  const { data, error } = await supabase
    .from('submissions')
    .insert({
      activity_id: activityId,
      nickname: nickname ?? null,
      answers: answers ?? {},
      auto_score,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[submit] insert 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, id: data.id, auto_score, gradable, results });
});

// GET /api/submissions?activityId=...  → 최신순 제출 목록 (auto_score, nickname, answers 포함)
router.get('/submissions', async (req, res) => {
  const { activityId } = req.query;

  if (!activityId) {
    return res.status(400).json({ ok: false, error: 'activityId 가 필요합니다.' });
  }

  const { data, error } = await supabase
    .from('submissions')
    .select('id, nickname, answers, auto_score, created_at')
    .eq('activity_id', activityId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[submissions] 조회 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, submissions: data });
});

module.exports = router;
