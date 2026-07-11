// 2단계 API: 교사 활동 등록/목록/상세/삭제
const express = require('express');
const router = express.Router();
const supabase = require('../db');

// POST /api/activities
// body = { title, html_body, questions:[{num,type,answer}] }
router.post('/activities', async (req, res) => {
  const { title, html_body, questions } = req.body || {};

  if (!title || !html_body) {
    return res.status(400).json({ ok: false, error: 'title 과 html_body 가 필요합니다.' });
  }

  // 1) 활동 1행 insert
  const { data: act, error: actErr } = await supabase
    .from('activities')
    .insert({ title, html_body, status: 'open' })
    .select('id')
    .single();

  if (actErr) {
    console.error('[activities] insert 실패:', actErr.message);
    return res.status(500).json({ ok: false, error: actErr.message });
  }

  const activityId = act.id;

  // 2) 문항 여러 행 insert (있을 때만)
  const list = Array.isArray(questions) ? questions : [];
  if (list.length) {
    const rows = list.map((q, i) => ({
      activity_id: activityId,
      num: Number(q.num) || i + 1,
      type: q.type || 'short',
      answer: q.type === 'essay' ? null : (q.answer ?? null),
    }));

    const { error: qErr } = await supabase.from('questions').insert(rows);
    if (qErr) {
      console.error('[activities] 문항 insert 실패:', qErr.message);
      // 활동은 롤백(문항 없이 남지 않도록 정리)
      await supabase.from('activities').delete().eq('id', activityId);
      return res.status(500).json({ ok: false, error: qErr.message });
    }
  }

  return res.json({ ok: true, activityId });
});

// GET /api/activities → 목록(최신순)
router.get('/activities', async (req, res) => {
  const { data, error } = await supabase
    .from('activities')
    .select('id, title, status, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[activities] 목록 조회 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
  return res.json({ ok: true, activities: data });
});

// GET /api/activities/:id → 활동 1개 + 문항 배열
router.get('/activities/:id', async (req, res) => {
  const { id } = req.params;

  const { data: activity, error: aErr } = await supabase
    .from('activities')
    .select('*')
    .eq('id', id)
    .single();

  if (aErr) {
    console.error('[activities] 상세 조회 실패:', aErr.message);
    return res.status(404).json({ ok: false, error: '활동을 찾을 수 없습니다.' });
  }

  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('*')
    .eq('activity_id', id)
    .order('num', { ascending: true });

  if (qErr) {
    console.error('[activities] 문항 조회 실패:', qErr.message);
    return res.status(500).json({ ok: false, error: qErr.message });
  }

  return res.json({ ok: true, activity, questions });
});

// DELETE /api/activities/:id → cascade 로 문항·제출 같이 삭제
router.delete('/activities/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from('activities').delete().eq('id', id);
  if (error) {
    console.error('[activities] 삭제 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
  return res.json({ ok: true });
});

module.exports = router;
