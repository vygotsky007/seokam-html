// 1단계 API: 제출 저장 + 조회 (자동채점은 2단계)
const express = require('express');
const router = express.Router();
const supabase = require('../db');

// POST /api/submit
// body = { activityId, nickname, answers }  answers 는 { "문항번호": "답" } 형태 객체
router.post('/submit', async (req, res) => {
  const { activityId, nickname, answers } = req.body || {};

  if (!activityId) {
    return res.status(400).json({ ok: false, error: 'activityId 가 필요합니다.' });
  }

  const { data, error } = await supabase
    .from('submissions')
    .insert({
      activity_id: activityId,
      nickname: nickname ?? null,
      answers: answers ?? {},
      auto_score: null, // 채점은 2단계
    })
    .select('id')
    .single();

  if (error) {
    console.error('[submit] insert 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, id: data.id });
});

// GET /api/submissions?activityId=...  → 최신순 제출 목록 (저장 확인용)
router.get('/submissions', async (req, res) => {
  const { activityId } = req.query;

  if (!activityId) {
    return res.status(400).json({ ok: false, error: 'activityId 가 필요합니다.' });
  }

  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('activity_id', activityId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[submissions] 조회 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, submissions: data });
});

module.exports = router;
