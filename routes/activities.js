// 2단계 API: 교사 활동 등록/목록/상세/삭제 + 발표 모드 데이터 + 전문기능(입장코드·복제·대시보드)
const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { grade } = require('../grade');

// 4자리 숫자 입장 코드 생성(중복 회피). 최대 20회 재시도 후 실패하면 null.
async function genUniqueJoinCode() {
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000)); // 1000~9999
    const { data, error } = await supabase
      .from('activities')
      .select('id')
      .eq('join_code', code)
      .limit(1);
    if (error) continue;
    if (!data || data.length === 0) return code;
  }
  return null;
}

// POST /api/activities
// body = { title, html_body, questions:[{num,type,answer}], status? }
// status: 'draft'(임시저장) | 'open'(발행, 기본)
router.post('/activities', async (req, res) => {
  const { title, html_body, questions, status } = req.body || {};

  if (!title || !html_body) {
    return res.status(400).json({ ok: false, error: 'title 과 html_body 가 필요합니다.' });
  }

  const st = status === 'draft' ? 'draft' : 'open';
  const join_code = await genUniqueJoinCode();

  // 1) 활동 1행 insert
  const { data: act, error: actErr } = await supabase
    .from('activities')
    .insert({ title, html_body, status: st, join_code })
    .select('id, join_code')
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

  return res.json({ ok: true, activityId, join_code: act.join_code, status: st });
});

// POST /api/activities/:id/duplicate → 활동 복제(제목+html_body+문항). 제출은 복사 안 함, 새 join_code, status='draft'.
router.post('/activities/:id/duplicate', async (req, res) => {
  const { id } = req.params;

  const { data: src, error: sErr } = await supabase
    .from('activities')
    .select('title, html_body')
    .eq('id', id)
    .single();

  if (sErr || !src) {
    return res.status(404).json({ ok: false, error: '원본 활동을 찾을 수 없습니다.' });
  }

  const { data: srcQs, error: qErr } = await supabase
    .from('questions')
    .select('num, type, answer')
    .eq('activity_id', id)
    .order('num', { ascending: true });

  if (qErr) {
    return res.status(500).json({ ok: false, error: qErr.message });
  }

  const join_code = await genUniqueJoinCode();
  const { data: newAct, error: insErr } = await supabase
    .from('activities')
    .insert({ title: (src.title || '') + ' (복제본)', html_body: src.html_body, status: 'draft', join_code })
    .select('id, join_code')
    .single();

  if (insErr) {
    console.error('[activities] 복제 insert 실패:', insErr.message);
    return res.status(500).json({ ok: false, error: insErr.message });
  }

  const list = Array.isArray(srcQs) ? srcQs : [];
  if (list.length) {
    const rows = list.map((q) => ({ activity_id: newAct.id, num: q.num, type: q.type, answer: q.answer }));
    const { error: qInsErr } = await supabase.from('questions').insert(rows);
    if (qInsErr) {
      await supabase.from('activities').delete().eq('id', newAct.id);
      return res.status(500).json({ ok: false, error: qInsErr.message });
    }
  }

  return res.json({ ok: true, activityId: newAct.id, join_code: newAct.join_code });
});

// GET /api/activities → 목록(최신순)
router.get('/activities', async (req, res) => {
  const { data, error } = await supabase
    .from('activities')
    .select('id, title, status, join_code, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[activities] 목록 조회 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
  return res.json({ ok: true, activities: data });
});

// GET /api/dashboard/:id → 결과 대시보드 데이터
// 요약(인원·평균·최고·최저), 문항별 정답률·보기분포, 학생별 점수/정오, 서술형 답 모음
router.get('/dashboard/:id', async (req, res) => {
  const { id } = req.params;

  const { data: activity, error: aErr } = await supabase
    .from('activities')
    .select('id, title')
    .eq('id', id)
    .single();

  if (aErr || !activity) {
    return res.status(404).json({ ok: false, error: '활동을 찾을 수 없습니다.' });
  }

  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('num, type, answer')
    .eq('activity_id', id)
    .order('num', { ascending: true });
  if (qErr) return res.status(500).json({ ok: false, error: qErr.message });

  const { data: subs, error: sErr } = await supabase
    .from('submissions')
    .select('id, nickname, answers, auto_score, created_at')
    .eq('activity_id', id)
    .order('created_at', { ascending: true });
  if (sErr) return res.status(500).json({ ok: false, error: sErr.message });

  const qs = questions || [];
  const students = (subs || []).map((s, i) => {
    // 자가채점 제출이면 answers 에 {self_scored, detail} 형태
    const isSelf = s.answers && s.answers.self_scored;
    let byNum = {};
    let score = Number(s.auto_score) || 0;
    if (isSelf) {
      (s.answers.detail || []).forEach((d) => { byNum[d.q] = { given: '', correct: !!d.ok }; });
    } else {
      const { results } = grade(qs, s.answers || {});
      results.forEach((r) => { byNum[r.num] = { given: r.given, correct: r.correct }; });
    }
    return { no: i + 1, nickname: s.nickname || null, self_scored: !!isSelf, score, byNum };
  });

  // 문항별 통계
  const perQuestion = qs.map((q) => {
    let answered = 0, correct = 0, gradable = 0;
    const dist = {}; // 보기/답 분포
    students.forEach((s) => {
      const cell = s.byNum[q.num];
      if (!cell) return;
      const given = String(cell.given || '').trim();
      if (given !== '') { answered++; dist[given] = (dist[given] || 0) + 1; }
      if (cell.correct !== null && cell.correct !== undefined) {
        if (q.type !== 'essay') { gradable++; if (cell.correct) correct++; }
      }
    });
    return {
      num: q.num, type: q.type, answer: q.answer || '',
      answered, correct, gradable,
      rate: gradable ? Math.round((correct / gradable) * 100) : null,
      distribution: dist,
    };
  });

  // 요약
  const scored = students.filter((s) => qs.length > 0 || s.self_scored);
  const scores = students.map((s) => s.score);
  const summary = {
    submissions: students.length,
    avg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0,
    max: scores.length ? Math.max(...scores) : 0,
    min: scores.length ? Math.min(...scores) : 0,
    questionCount: qs.length,
  };

  return res.json({ ok: true, activity, questions: qs, students, perQuestion, summary });
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

// GET /api/activities/:id/version → { version } 만 가볍게 (학생 페이지 폴링용)
router.get('/activities/:id/version', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('activities')
    .select('version')
    .eq('id', id)
    .single();

  if (error || !data) {
    return res.status(404).json({ ok: false, error: '활동을 찾을 수 없습니다.' });
  }
  return res.json({ ok: true, version: data.version });
});

// PUT /api/activities/:id → title·html_body·questions 수정 + version +1
// questions 는 기존 삭제 후 재삽입.
router.put('/activities/:id', async (req, res) => {
  const { id } = req.params;
  const { title, html_body, questions, status } = req.body || {};

  if (!title || !html_body) {
    return res.status(400).json({ ok: false, error: 'title 과 html_body 가 필요합니다.' });
  }

  // 현재 version 조회 후 +1 (컬럼이 있다고 가정)
  const { data: cur, error: curErr } = await supabase
    .from('activities')
    .select('version')
    .eq('id', id)
    .single();

  if (curErr || !cur) {
    return res.status(404).json({ ok: false, error: '활동을 찾을 수 없습니다.' });
  }
  const nextVersion = (Number(cur.version) || 1) + 1;

  const patch = { title, html_body, version: nextVersion };
  if (status === 'draft' || status === 'open') patch.status = status; // 발행/임시저장 전환 허용

  const { error: upErr } = await supabase
    .from('activities')
    .update(patch)
    .eq('id', id);

  if (upErr) {
    console.error('[activities] 수정 실패:', upErr.message);
    return res.status(500).json({ ok: false, error: upErr.message });
  }

  // 문항: 기존 삭제 후 재삽입
  const { error: delErr } = await supabase.from('questions').delete().eq('activity_id', id);
  if (delErr) {
    console.error('[activities] 기존 문항 삭제 실패:', delErr.message);
    return res.status(500).json({ ok: false, error: delErr.message });
  }

  const list = Array.isArray(questions) ? questions : [];
  if (list.length) {
    const rows = list.map((q, i) => ({
      activity_id: id,
      num: Number(q.num) || i + 1,
      type: q.type || 'short',
      answer: q.type === 'essay' ? null : (q.answer ?? null),
    }));
    const { error: insErr } = await supabase.from('questions').insert(rows);
    if (insErr) {
      console.error('[activities] 문항 재삽입 실패:', insErr.message);
      return res.status(500).json({ ok: false, error: insErr.message });
    }
  }

  return res.json({ ok: true, version: nextVersion });
});

// GET /api/present/:id → 발표 모드 데이터
// 활동 + 문항 + 제출(제출순 익명번호, 문항별 정오 판정 포함) 반환. 발표 화면이 5초마다 폴링.
router.get('/present/:id', async (req, res) => {
  const { id } = req.params;

  const { data: activity, error: aErr } = await supabase
    .from('activities')
    .select('id, title')
    .eq('id', id)
    .single();

  if (aErr || !activity) {
    return res.status(404).json({ ok: false, error: '활동을 찾을 수 없습니다.' });
  }

  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('num, type, answer')
    .eq('activity_id', id)
    .order('num', { ascending: true });

  if (qErr) {
    return res.status(500).json({ ok: false, error: qErr.message });
  }

  const { data: subs, error: sErr } = await supabase
    .from('submissions')
    .select('id, nickname, answers, created_at')
    .eq('activity_id', id)
    .order('created_at', { ascending: true }); // 제출 순서대로 익명 번호 부여

  if (sErr) {
    return res.status(500).json({ ok: false, error: sErr.message });
  }

  // 각 제출을 grade.js 로 채점해 문항번호별 {given, correct} 매핑
  const students = (subs || []).map((s, i) => {
    const { results } = grade(questions || [], s.answers || {});
    const byNum = {};
    results.forEach((r) => { byNum[r.num] = { given: r.given, correct: r.correct }; });
    return { no: i + 1, nickname: s.nickname || null, byNum };
  });

  return res.json({ ok: true, activity, questions: questions || [], students });
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
