// 2단계 API: 교사 활동 등록/목록/상세/삭제 + 발표 모드 데이터 + 전문기능(입장코드·복제·대시보드)
const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { grade } = require('../grade');
const { sanitizeHtml } = require('../lib/sanitize');
const { sanitizeSheet } = require('../lib/sheet-sanitize');

// ---- HTML 활동지(kind='html_sheet') ----
// 시험지와 갈라지는 지점은 딱 둘이다: 정제기(문항용이 아니라 문서용)와 fields(문항표 대신).
// 나머지 수명주기(목록·복제·삭제·발행·입장코드·실시간·마감)는 시험지와 똑같이 흐른다.
const FIELD_TAGS = ['textarea', 'text', 'checkbox', 'rich'];
const MAX_LABEL = 160;

function isSheet(kind) { return kind === 'html_sheet'; }

function clipLabel(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > MAX_LABEL ? t.slice(0, MAX_LABEL - 1) + '…' : t;
}

// 교사 화면이 보낸 필드 목록을 그대로 믿지 않는다.
// 모양이 맞고, 정제를 통과한 HTML 안에 그 data-fid 가 실제로 남아 있는 것만 받는다.
// (정제기가 지워버린 칸을 계속 들고 있으면 학생 화면에 없는 열이 결과표에 생긴다)
function normalizeFields(fields, cleanHtml) {
  const list = Array.isArray(fields) ? fields : [];
  const out = [];
  const seen = {};
  list.forEach((f) => {
    const id = String((f && f.id) || '').trim();
    if (!/^f[0-9]{1,4}$/.test(id) || seen[id]) return;
    if (String(cleanHtml).indexOf('data-fid="' + id + '"') < 0) return;   // 문서에 없는 필드는 버린다
    seen[id] = 1;
    const row = {
      id: id,
      tag: FIELD_TAGS.indexOf(f.tag) >= 0 ? f.tag : 'text',
      label: clipLabel(f.label) || id,
      section: clipLabel(f.section),
      collect: f.collect === true,
    };
    if (Array.isArray(f.options)) row.options = f.options.slice(0, 60).map(clipLabel);
    out.push(row);
  });
  return out;
}

// (C) html_body 답칸(name="q…") 개수와 채점 문항 수 불일치 경고
function mismatchWarning(html_body, questions) {
  const qCount = Array.isArray(questions) ? questions.length : 0;
  if (qCount === 0) return null; // 자가채점 등 문항표 없음
  const names = (String(html_body || '').match(/name="q\d+"/g) || []);
  const answerCount = new Set(names).size; // 중복 name 방지
  if (answerCount !== qCount) {
    return '학생 화면 답칸(name=q) ' + answerCount + '개와 채점 문항 ' + qCount + '개가 서로 달라요. 문항 수를 맞춰 주세요.';
  }
  return null;
}

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
//        | { title, html_body, kind:'html_sheet', fields:[{id,label,tag,collect}], status? }
// status: 'draft'(임시저장) | 'open'(발행, 기본)
router.post('/activities', async (req, res) => {
  const { title, html_body, questions, status, view_mode, kind, fields } = req.body || {};

  if (!title || !html_body) {
    return res.status(400).json({ ok: false, error: 'title 과 html_body 가 필요합니다.' });
  }

  const st = status === 'draft' ? 'draft' : 'open';
  const vm = view_mode === 'single' ? 'single' : 'all';
  const join_code = await genUniqueJoinCode();

  // HTML 활동지: 문서째 정제해서 넣는다. 문항표·view_mode 는 쓰지 않는다.
  if (isSheet(kind)) {
    const clean = sanitizeSheet(html_body);
    const fs = normalizeFields(fields, clean);
    if (!fs.length) {
      return res.status(400).json({ ok: false, error: '수집할 응답 칸을 찾지 못했습니다. 활동지에 입력칸(textarea·input)이 있는지 확인하세요.' });
    }

    const { data: sheet, error: sErr } = await supabase
      .from('activities')
      .insert({ title, html_body: clean, status: st, join_code, kind: 'html_sheet', fields: fs })
      .select('id, join_code')
      .single();

    if (sErr) {
      console.error('[activities] 활동지 insert 실패:', sErr.message);
      return res.status(500).json({ ok: false, error: sErr.message });
    }
    return res.json({ ok: true, activityId: sheet.id, join_code: sheet.join_code, status: st, kind: 'html_sheet', fields: fs });
  }

  // 1) 활동 1행 insert
  const { data: act, error: actErr } = await supabase
    .from('activities')
    .insert({ title, html_body, status: st, join_code, view_mode: vm })
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
      graded: q.graded === false ? false : true,
      slice_image: q.slice_image ?? null,
      group_label: q.group_label ?? null,
      // 문항 HTML화 결과 — 저장 시점에 정제(허용 태그만). 없으면 null → 학생 화면은 이미지로 폴백
      html_content: q.html_content ? sanitizeHtml(q.html_content) : null,
    }));

    const { error: qErr } = await supabase.from('questions').insert(rows);
    if (qErr) {
      console.error('[activities] 문항 insert 실패:', qErr.message);
      // 활동은 롤백(문항 없이 남지 않도록 정리)
      await supabase.from('activities').delete().eq('id', activityId);
      return res.status(500).json({ ok: false, error: qErr.message });
    }
  }

  return res.json({ ok: true, activityId, join_code: act.join_code, status: st, warning: mismatchWarning(html_body, questions) });
});

// POST /api/activities/:id/duplicate → 활동 복제(제목+html_body+문항). 제출은 복사 안 함, 새 join_code, status='draft'.
router.post('/activities/:id/duplicate', async (req, res) => {
  const { id } = req.params;

  const { data: src, error: sErr } = await supabase
    .from('activities')
    .select('title, html_body, kind, fields')
    .eq('id', id)
    .single();

  if (sErr || !src) {
    return res.status(404).json({ ok: false, error: '원본 활동을 찾을 수 없습니다.' });
  }

  const join_code = await genUniqueJoinCode();

  // HTML 활동지 복제 — kind·fields 를 함께 옮긴다. 빠뜨리면 kind 가 기본값 'exam' 이 되어
  // 문항도 정답표도 없는 '빈 시험지'로 되살아난다(화면이 통째로 어긋난다).
  if (isSheet(src.kind)) {
    const { data: dup, error: dErr } = await supabase
      .from('activities')
      .insert({
        title: (src.title || '') + ' (복제본)',
        html_body: src.html_body,
        status: 'draft',
        join_code,
        kind: 'html_sheet',
        fields: Array.isArray(src.fields) ? src.fields : [],
      })
      .select('id, join_code')
      .single();
    if (dErr) {
      console.error('[activities] 활동지 복제 실패:', dErr.message);
      return res.status(500).json({ ok: false, error: dErr.message });
    }
    return res.json({ ok: true, activityId: dup.id, join_code: dup.join_code, kind: 'html_sheet' });
  }

  const { data: srcQs, error: qErr } = await supabase
    .from('questions')
    .select('num, type, answer, graded')
    .eq('activity_id', id)
    .order('num', { ascending: true });

  if (qErr) {
    return res.status(500).json({ ok: false, error: qErr.message });
  }

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
    const rows = list.map((q) => ({ activity_id: newAct.id, num: q.num, type: q.type, answer: q.answer, graded: q.graded === false ? false : true }));
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
    .select('id, title, status, join_code, created_at, kind')
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
    .select('num, type, answer, graded')
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
  const { title, html_body, questions, status, view_mode, kind, fields } = req.body || {};

  if (!title || !html_body) {
    return res.status(400).json({ ok: false, error: 'title 과 html_body 가 필요합니다.' });
  }

  // 현재 version 조회 후 +1 (컬럼이 있다고 가정)
  const { data: cur, error: curErr } = await supabase
    .from('activities')
    .select('version, kind')
    .eq('id', id)
    .single();

  if (curErr || !cur) {
    return res.status(404).json({ ok: false, error: '활동을 찾을 수 없습니다.' });
  }
  const nextVersion = (Number(cur.version) || 1) + 1;

  // HTML 활동지 수정 — 종류는 저장된 값을 따른다(요청이 kind 를 바꿔 시험지↔활동지로 둔갑시키지 못하게).
  if (isSheet(cur.kind)) {
    const clean = sanitizeSheet(html_body);
    const fs = normalizeFields(fields, clean);
    if (!fs.length) {
      return res.status(400).json({ ok: false, error: '수집할 응답 칸을 찾지 못했습니다.' });
    }
    const sheetPatch = { title, html_body: clean, fields: fs, version: nextVersion };
    if (status === 'draft' || status === 'open') sheetPatch.status = status;

    const { error: sErr } = await supabase.from('activities').update(sheetPatch).eq('id', id);
    if (sErr) {
      console.error('[activities] 활동지 수정 실패:', sErr.message);
      return res.status(500).json({ ok: false, error: sErr.message });
    }
    return res.json({ ok: true, activityId: id, version: nextVersion, kind: 'html_sheet', fields: fs });
  }

  const patch = { title, html_body, version: nextVersion };
  if (status === 'draft' || status === 'open') patch.status = status; // 발행/임시저장 전환 허용
  if (view_mode === 'single' || view_mode === 'all') patch.view_mode = view_mode;

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
      graded: q.graded === false ? false : true,
      slice_image: q.slice_image ?? null,
      group_label: q.group_label ?? null,
      // 문항 HTML화 결과 — 저장 시점에 정제(허용 태그만). 없으면 null → 학생 화면은 이미지로 폴백
      html_content: q.html_content ? sanitizeHtml(q.html_content) : null,
    }));
    const { error: insErr } = await supabase.from('questions').insert(rows);
    if (insErr) {
      console.error('[activities] 문항 재삽입 실패:', insErr.message);
      return res.status(500).json({ ok: false, error: insErr.message });
    }
  }

  return res.json({ ok: true, version: nextVersion, warning: mismatchWarning(html_body, questions) });
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
    .select('num, type, answer, graded, meta')
    .eq('activity_id', id)
    .order('num', { ascending: true });

  if (qErr) {
    return res.status(500).json({ ok: false, error: qErr.message });
  }

  const { data: subs, error: sErr } = await supabase
    .from('submissions')
    .select('id, nickname, answers, manual_correct, created_at')
    .eq('activity_id', id)
    .order('created_at', { ascending: true }); // 제출 순서대로 익명 번호 부여

  if (sErr) {
    return res.status(500).json({ ok: false, error: sErr.message });
  }

  // 각 제출을 grade.js 로 채점해 문항번호별 {given, correct} 매핑.
  // 발표 모드는 정답을 즉석에서 바꿔 가며 채점하므로 판정은 화면에서 다시 계산한다(lib/match.js 공용).
  // 여기서는 원문 답과 '수동 인정' 여부를 그대로 실어 보낸다.
  const students = (subs || []).map((s, i) => {
    const manual = s.manual_correct || {};
    const { results } = grade(
      (questions || []).map((q) => Object.assign({}, q, { manual_correct: manual[String(q.num)] === true })),
      s.answers || {}
    );
    const byNum = {};
    results.forEach((r) => { byNum[r.num] = { given: r.given, correct: r.correct }; });
    return { no: i + 1, id: s.id, nickname: s.nickname || null, byNum, manual };
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

// POST /api/present/answer — 발표 중 교사가 정답을 입력·수정한다(교사 정답표에 그대로 저장)
// 다음에 다시 열어도 유지되고, 정답표에 이미 있던 정답은 발표 진입 시 그대로 채점에 쓰인다.
router.post('/present/answer', async (req, res) => {
  const { activityId, num, answer } = req.body || {};
  if (!activityId || num == null) return res.status(400).json({ ok: false, error: 'activityId·num 이 필요합니다.' });

  const { error } = await supabase
    .from('questions')
    .update({ answer: answer == null ? '' : String(answer) })
    .eq('activity_id', activityId)
    .eq('num', Number(num));
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// POST /api/present/manual — 애매 판정(⚠)을 교사가 손으로 정답 인정/취소. 그 학생 그 문항에만 저장.
router.post('/present/manual', async (req, res) => {
  const { submissionId, num, correct } = req.body || {};
  if (!submissionId || num == null) return res.status(400).json({ ok: false, error: 'submissionId·num 이 필요합니다.' });

  const { data: sub, error: e1 } = await supabase
    .from('submissions').select('manual_correct').eq('id', submissionId).single();
  if (e1) return res.status(500).json({ ok: false, error: e1.message });

  const manual = Object.assign({}, (sub && sub.manual_correct) || {});
  if (correct) manual[String(num)] = true; else delete manual[String(num)];

  const { error } = await supabase.from('submissions').update({ manual_correct: manual }).eq('id', submissionId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, manual });
});

module.exports = router;
