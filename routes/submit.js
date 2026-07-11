// 제출 저장 + 자동채점 + 조회
const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { grade } = require('../grade');

// POST /api/submit
// body = { activityId, nickname, answers }  answers 는 { "q1":"답", ... } 형태 객체
router.post('/submit', async (req, res) => {
  const { activityId, nickname, answers } = req.body || {};

  if (!activityId) {
    return res.status(400).json({ ok: false, error: 'activityId 가 필요합니다.' });
  }

  // 그 활동의 문항을 불러와 자동채점
  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('num, type, answer')
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
