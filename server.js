// 진입점 — 학생 응답 수집 앱 (1단계 뼈대)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const submitRouter = require('./routes/submit');

const app = express();
const PORT = process.env.PORT || 4002;

app.use(cors()); // 학생 HTML이 다른 출처에서 fetch 가능하도록 허용
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 배포 확인용
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// 제출/조회 API
app.use('/api', submitRouter);

app.listen(PORT, () => {
  console.log(`[server] 학생 응답 수집 앱 실행 중 → http://localhost:${PORT}`);
});
