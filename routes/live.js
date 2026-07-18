// 실시간 교실 — 접속(하트비트) · 진행 상황 · 공지 · 마감
//
// 폴링으로 끝낸다(WebSocket 없음): 학생 5초, 교사 3초. 30명이면 초당 10요청 수준이라 부담이 없고,
// Railway 재배포로 연결이 끊겨도 다음 폴링에서 저절로 회복된다.
const express = require('express');
const router = express.Router();
const supabase = require('../db');
const { grade } = require('../grade');
const { attachGroups } = require('../lib/sheet-groups');

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

  // 학생 화면이 알아야 할 것만 되돌려준다 — 공지(최근 3개), 마감 여부, 그리고 '본인 앞으로 온' 메시지.
  // 개별 메시지는 그 학생의 세션 행에만 들어 있으므로, 폴링 응답에 남의 메시지가 섞일 수가 없다.
  const [{ data: act }, { data: me }] = await Promise.all([
    supabase.from('activities').select('notices, closed_at').eq('id', activityId).single(),
    supabase.from('live_sessions').select('messages')
      .eq('activity_id', activityId).eq('nickname', String(nickname).trim()).single(),
  ]);

  const mine = ((me && me.messages) || []).filter((m) => !m.seen_at);

  return res.json({
    ok: true,
    notices: ((act && act.notices) || []).slice(0, 3),
    closed: !!(act && act.closed_at),
    messages: mine,                       // 아직 확인하지 않은 개별 메시지만
  });
});

// ---- 교사 → 한 학생에게 보내는 개별 메시지 ----
// 연결이 끊긴 학생에게 보내도 세션 행에 남는다 → 재접속하면 다음 하트비트에서 그대로 받는다.
// type: 'text'(그냥 메시지) | 'goto'(문항 이동 요청 — q 번으로 가자고 '부탁'한다. 강제 이동은 하지 않는다)
async function pushMessage(activityId, nickname, msg) {
  const { data: sess, error: e1 } = await supabase
    .from('live_sessions').select('messages')
    .eq('activity_id', activityId).eq('nickname', nickname).single();
  if (e1) throw new Error(e1.message);

  const messages = ((sess && sess.messages) || []).concat([msg]);
  const { error } = await supabase
    .from('live_sessions').update({ messages })
    .eq('activity_id', activityId).eq('nickname', nickname);
  if (error) throw new Error(error.message);
  return messages;
}
function newMessage(fields) {
  return Object.assign({
    id: 'm' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    type: 'text',
    at: new Date().toISOString(),
    seen_at: null,                        // 학생이 [확인] 누르기 전까지 교사에겐 '미확인'
  }, fields);
}

router.post('/live/message', async (req, res) => {
  const { activityId, nickname, text } = req.body || {};
  const msg = String(text || '').trim();
  if (!activityId || !nickname || !msg) {
    return res.status(400).json({ ok: false, error: 'activityId·nickname·내용이 필요합니다.' });
  }
  try {
    const messages = await pushMessage(activityId, nickname, newMessage({ type: 'text', text: msg }));
    return res.json({ ok: true, messages });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- 문항 이동 요청 ----
// nicknames 를 주면 그 학생들에게, 없으면 이 활동의 모든 학생에게(= "다 같이 5번 보세요").
// 학생 화면은 배너로 '부탁'만 하고, 학생이 [가기] 를 눌러야 이동한다(작성 중인 답은 어떤 경우에도 보존).
router.post('/live/goto', async (req, res) => {
  const { activityId, nicknames, q } = req.body || {};
  const num = Number(q);
  if (!activityId || !num) return res.status(400).json({ ok: false, error: 'activityId·q 가 필요합니다.' });

  let targets = Array.isArray(nicknames) ? nicknames.filter(Boolean) : [];
  if (!targets.length) {
    const { data: sessions, error } = await supabase
      .from('live_sessions').select('nickname').eq('activity_id', activityId);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    targets = (sessions || []).map((s) => s.nickname).filter(Boolean);
  }

  let sent = 0;
  for (const nick of targets) {
    try {
      await pushMessage(activityId, nick, newMessage({
        type: 'goto', q: num, text: num + '번 문제로 이동을 요청했어요',
      }));
      sent++;
    } catch (e) {
      console.error('[live] 이동 요청 실패:', nick, e.message);
    }
  }
  return res.json({ ok: true, sent: sent, q: num });
});

// ---- 학생이 메시지를 확인함 ----
router.post('/live/message/seen', async (req, res) => {
  const { activityId, nickname, messageId } = req.body || {};
  if (!activityId || !nickname || !messageId) {
    return res.status(400).json({ ok: false, error: 'activityId·nickname·messageId 가 필요합니다.' });
  }

  const { data: sess, error: e1 } = await supabase
    .from('live_sessions').select('messages')
    .eq('activity_id', activityId).eq('nickname', nickname).single();
  if (e1) return res.status(500).json({ ok: false, error: e1.message });

  const now = new Date().toISOString();
  const messages = ((sess && sess.messages) || []).map((m) => (m.id === messageId ? Object.assign({}, m, { seen_at: now }) : m));

  const { error } = await supabase
    .from('live_sessions').update({ messages })
    .eq('activity_id', activityId).eq('nickname', nickname);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

// ---- 교사 대시보드가 3초마다 부르는 현황 ----
router.get('/live/state', async (req, res) => {
  const { activityId } = req.query;
  if (!activityId) return res.status(400).json({ ok: false, error: 'activityId 가 필요합니다.' });

  const [{ data: qs }, { data: sessions }, { data: subs }, { data: act }] = await Promise.all([
    supabase.from('questions').select('num, type, answer').eq('activity_id', activityId).order('num', { ascending: true }),
    supabase.from('live_sessions').select('nickname, current_q, answers, submitted, last_seen, messages').eq('activity_id', activityId),
    supabase.from('submissions').select('nickname, answers, auto_score').eq('activity_id', activityId),
    // kind·fields 를 함께 준다: 활동지는 진행 매트릭스의 열이 문항 번호가 아니라 수집 필드다.
    // html_body 로 fields[].group 을 채운다(다필드 활동지의 그룹별 진행 막대용).
    supabase.from('activities').select('notices, closed_at, kind, fields, html_body').eq('id', activityId).single(),
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
      messages: s.messages || [],          // 교사 화면 전용(학생 폴링에는 본인 것만 나간다)
    }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));

  return res.json({
    ok: true,
    kind: (act && act.kind) || 'exam',
    fields: attachGroups(act && act.html_body, (act && act.fields) || []),   // 그룹 포함(활동지)
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
