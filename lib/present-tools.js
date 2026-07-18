// 발표 모드 공용 도구 — 시험지·활동지 발표가 같은 것을 쓴다.
//
// 담긴 것: 오버레이 3겹 닫기 매니저(✕·바깥클릭·뒤로가기 정합) · 필기 · 교실 도우미(음성·신호음·TTS)
//          · 스포트라이트 · 타이머 · 전체화면 · 하단 도구 독(자동 숨김).
//
// 브라우저 전용. 서버가 만든 발표 페이지가 <script src="/lib/present-tools.js"> 로 읽고 window.PresentTools 로 쓴다.
// (require 로도 불러올 수 있게 IIFE 로 감싼다 — lib/ 의 다른 파일과 같은 규칙)

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PresentTools = api;
})(this, function () {
  'use strict';

  // ─────────────────────────── 오버레이 3겹 닫기 매니저 ───────────────────────────
  // 모든 발표 오버레이(확대·무작위 뽑기·타이머·스포트라이트·단축키 도움말)가 이걸 거친다.
  //  1) 보이는 ✕ 버튼(48px) — el 안에 자동 주입
  //  2) 바깥(배경) 클릭 — el 자신을 눌렀을 때
  //  3) 브라우저 뒤로가기 — 열 때 history.pushState, popstate 로 닫는다. 발표 모드는 유지된다.
  // ✕/배경/Esc 로 닫을 때는 history.back() 으로 히스토리를 동기화해 뒤로가기 항목이 쌓이지 않게 한다.
  var _stack = [];              // 열린 오버레이들(위가 최상단)
  var _suppressPop = false;     // 우리가 부른 history.back 이 만든 popstate 는 한 번 무시

  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', function () {
      if (_suppressPop) { _suppressPop = false; return; }   // ✕/배경/Esc 가 부른 back → 이미 닫음
      var top = _stack[_stack.length - 1];
      if (top) top._doClose(true);                          // 진짜 뒤로가기 → 최상단만 닫는다
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var top = _stack[_stack.length - 1];
      if (top) { e.preventDefault(); top.close(); }
    });
  }

  function createOverlay(el, opts) {
    opts = opts || {};
    injectCss();                 // ✕ 버튼·독 등 공용 CSS 보장(페이지가 오버레이만 써도)
    var api = { el: el, _open: false };

    // ✕ 버튼(48px, 반투명, 항상 보임) — 이미 있으면 다시 넣지 않는다
    if (opts.closeButton !== false && el && !el.querySelector('.pt-x')) {
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'pt-x';
      x.setAttribute('aria-label', '닫기');
      x.innerHTML = '✕ <span class="pt-x-lab">' + (opts.closeLabel || '닫기') + '</span>';
      el.appendChild(x);
      x.addEventListener('click', function (e) { e.stopPropagation(); api.close(); });
    }
    // 배경 클릭 = 닫기(콘텐츠 클릭은 제외 — el 자신을 눌렀을 때만)
    if (opts.backdrop !== false && el) {
      el.addEventListener('click', function (e) { if (e.target === el) api.close(); });
    }

    api.open = function () {
      if (api._open) return;
      api._open = true;
      if (el) el.style.display = opts.display || 'flex';
      _stack.push(api);
      try { history.pushState({ ptOverlay: opts.name || 'overlay' }, ''); } catch (e) {}
      if (opts.onOpen) opts.onOpen();
    };
    api._doClose = function (fromPop) {
      if (!api._open) return;
      api._open = false;
      if (el) el.style.display = 'none';
      var i = _stack.indexOf(api);
      if (i >= 0) _stack.splice(i, 1);
      if (opts.onClose) opts.onClose();
      if (!fromPop) { _suppressPop = true; try { history.back(); } catch (e) { _suppressPop = false; } }
    };
    api.close = function () { api._doClose(false); };
    api.isOpen = function () { return api._open; };
    return api;
  }

  // 매니저가 붙일 최소 CSS(페이지가 없어도 동작하게 여기서 1회 주입)
  function injectCss() {
    if (typeof document === 'undefined' || document.getElementById('pt-css')) return;
    var s = document.createElement('style');
    s.id = 'pt-css';
    s.textContent = [
      '.pt-x{box-sizing:border-box;position:absolute;top:14px;right:14px;z-index:20;min-width:48px;height:48px;padding:0 16px;',
      'display:inline-flex;align-items:center;gap:6px;font-size:16px;font-weight:800;cursor:pointer;',
      'color:#f8fafc;background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.5);border-radius:12px;}',
      '.pt-x:hover{background:rgba(30,41,59,.92);}',
      '.pt-x-lab{font-size:13px;font-weight:700;}',
      '@media(max-width:520px){.pt-x-lab{display:none;}}',
      // 하단 도구 독
      '.pt-dock{position:fixed;left:0;right:0;bottom:0;z-index:70;display:flex;justify-content:center;',
      'gap:8px;padding:10px 14px;background:rgba(15,23,42,.92);border-top:1px solid #334155;',
      'transition:transform .25s ease,opacity .25s ease;flex-wrap:wrap;}',
      '.pt-dock.hidden{transform:translateY(100%);opacity:0;pointer-events:none;}',
      '.pt-dock button,.pt-dock .pt-dock-item{height:44px;min-width:44px;padding:0 14px;font-size:14px;font-weight:800;',
      'border:1px solid #475569;background:#334155;color:#e2e8f0;border-radius:10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}',
      '.pt-dock button:hover{background:#3f4f66;}',
      '.pt-dock button.on{background:#3b82f6;border-color:#3b82f6;color:#fff;}',
      '.pt-dock-handle{position:fixed;left:50%;transform:translateX(-50%);bottom:6px;z-index:69;',
      'width:56px;height:6px;border-radius:999px;background:rgba(148,163,184,.5);cursor:pointer;transition:opacity .25s;}',
      '.pt-dock-handle.gone{opacity:0;pointer-events:none;}',
      // 스포트라이트
      '.pt-spot{position:fixed;inset:0;z-index:80;display:none;cursor:crosshair;}',
      // 타이머
      '.pt-timer{position:fixed;inset:0;z-index:82;display:none;align-items:center;justify-content:center;background:rgba(2,6,23,.55);}',
      '.pt-timer-box{position:absolute;text-align:center;user-select:none;}',
      '.pt-timer-num{font-size:min(28vw,240px);font-weight:800;color:#f8fafc;line-height:1;font-variant-numeric:tabular-nums;text-shadow:0 4px 24px rgba(0,0,0,.6);cursor:move;}',
      '.pt-timer-num.warn{color:#f59e0b;}.pt-timer-num.over{color:#ef4444;}',
      '.pt-timer-ctl{margin-top:18px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}',
      '.pt-timer-ctl button,.pt-timer-ctl input{height:44px;padding:0 14px;font-size:15px;font-weight:800;border:1px solid #475569;',
      'background:#1e293b;color:#e2e8f0;border-radius:10px;cursor:pointer;}',
      '.pt-timer-ctl input{width:92px;cursor:text;}',
      // 단축키 도움말
      '.pt-help{position:fixed;inset:0;z-index:84;display:none;align-items:center;justify-content:center;background:rgba(2,6,23,.8);}',
      '.pt-help-box{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:26px 30px;max-width:440px;color:#e2e8f0;}',
      '.pt-help-box h3{margin:0 0 14px;font-size:18px;}',
      '.pt-help-box .row{display:flex;justify-content:space-between;gap:20px;padding:7px 0;border-top:1px solid #33415588;font-size:14px;}',
      '.pt-help-box kbd{background:#0f172a;border:1px solid #475569;border-radius:6px;padding:2px 8px;font-family:ui-monospace,monospace;font-weight:700;}'
    ].join('');
    document.head.appendChild(s);
  }

  // ─────────────────────────── Web Audio 신호음 ───────────────────────────
  var _ac = null;
  function ac() {
    if (!_ac) { try { _ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { _ac = null; } }
    return _ac;
  }
  // kind: 'focus'(딩동) | 'start'(상승 2음) | 'end'(하강 3음)
  function beep(kind) {
    var c = ac(); if (!c) return;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    var seq = kind === 'start' ? [[660, 0], [990, .13]]
      : kind === 'end' ? [[880, 0], [660, .16], [440, .32]]
        : [[880, 0], [660, .14]];
    seq.forEach(function (pair) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = pair[0];
      var t0 = c.currentTime + pair[1];
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(.25, t0 + .02);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + .18);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + .2);
    });
  }

  // ─────────────────────────── 교실 도우미(음성/TTS) ───────────────────────────
  function createHelper(opts) {
    opts = opts || {};
    var voices = [], voice = null, rate = 1, vol = 1;
    function loadVoices() {
      try {
        voices = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
        var ko = voices.filter(function (v) { return /ko/i.test(v.lang); });
        if (!voice) voice = ko[0] || voices[0] || null;
      } catch (e) {}
      return voices;
    }
    if (window.speechSynthesis) {
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    function speak(text) {
      var t = String(text || '').trim(); if (!t) return;
      try {
        window.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(t);
        u.lang = 'ko-KR'; u.rate = rate; u.volume = vol;
        if (voice) u.voice = voice;
        window.speechSynthesis.speak(u);
      } catch (e) {}
    }
    return {
      voices: function () { return voices; },
      setVoice: function (v) { voice = v; },
      setRate: function (r) { rate = Number(r) || 1; },
      setVolume: function (v) { vol = Number(v); },
      speak: speak,
      stop: function () { try { window.speechSynthesis.cancel(); } catch (e) {} },
      beep: beep,
      presets: opts.presets || [
        '자, 여기 보세요', '조용히 해주세요', '5분 남았어요', '1분 남았어요',
        '이제 그만 쓰고 걷을게요', '다음 문제로 넘어갈게요', '짝과 이야기해 보세요', '다 한 사람 손 들어요'
      ]
    };
  }

  // ─────────────────────────── 필기(펜/지우개) ───────────────────────────
  // canvas 위에 그린다. 문항/필드가 바뀌면 자동으로 지운다(유지 토글로 끌 수 있다).
  function createDrawing(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var on = true, color = '#ef4444', size = 3, eraser = false, keep = false;
    var drawing = false, last = null, hasInk = false;

    function resize() {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var img = null;
      try { img = hasInk ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null; } catch (e) {}
      canvas.width = r.width; canvas.height = r.height;
      if (img) try { ctx.putImageData(img, 0, 0); } catch (e) {}
    }
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var p = (e.touches && e.touches[0]) || e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    }
    function start(e) { if (!on) return; drawing = true; last = pos(e); e.preventDefault(); }
    function move(e) {
      if (!on || !drawing) return;
      var p = pos(e);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (eraser) { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = size * 6; }
      else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = color; ctx.lineWidth = size; }
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; hasInk = true; e.preventDefault();
    }
    function end() { drawing = false; }

    canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    function clear() {
      try { ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e) {}
      hasInk = false;
    }
    function apply() { canvas.style.pointerEvents = on ? 'auto' : 'none'; }
    apply();
    return {
      setOn: function (v) { on = !!v; apply(); },
      isOn: function () { return on; },
      setColor: function (c) { color = c; eraser = false; },
      setSize: function (s) { size = Number(s) || 3; },
      setEraser: function (v) { eraser = !!v; },
      setKeep: function (v) { keep = !!v; },
      isKeep: function () { return keep; },
      clear: clear,
      // 문항/필드 전환 때 호출 — 유지 토글이 꺼져 있으면 지운다
      onContextChange: function () { if (!keep) clear(); },
      resize: resize,
      hasInk: function () { return hasInk; }
    };
  }

  // ─────────────────────────── 스포트라이트 ───────────────────────────
  // 화면을 어둡게 덮고 드래그한 사각형만 밝게 뚫는다. 재드래그로 이동, Esc/✕/뒤로가기로 해제.
  function createSpotlight() {
    injectCss();
    var el = document.createElement('div');
    el.className = 'pt-spot';
    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    el.appendChild(cv);
    document.body.appendChild(el);
    var ctx = cv.getContext('2d');
    var rect = null, dragging = false, s0 = null;

    function fit() { cv.width = window.innerWidth; cv.height = window.innerHeight; paint(); }
    function paint() {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = 'rgba(2,6,23,.82)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      if (rect) {
        ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = 'rgba(250,204,21,.9)'; ctx.lineWidth = 2;
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      }
    }
    function down(e) { dragging = true; var p = pt(e); s0 = p; rect = { x: p.x, y: p.y, w: 0, h: 0 }; e.preventDefault(); }
    function mv(e) {
      if (!dragging) return;
      var p = pt(e);
      rect = { x: Math.min(s0.x, p.x), y: Math.min(s0.y, p.y), w: Math.abs(p.x - s0.x), h: Math.abs(p.y - s0.y) };
      paint(); e.preventDefault();
    }
    function up() { dragging = false; }
    function pt(e) { var q = (e.touches && e.touches[0]) || e; return { x: q.clientX, y: q.clientY }; }
    cv.addEventListener('mousedown', down); cv.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    cv.addEventListener('touchstart', down, { passive: false }); cv.addEventListener('touchmove', mv, { passive: false }); cv.addEventListener('touchend', up);
    window.addEventListener('resize', function () { if (ov.isOpen()) fit(); });

    var ov = createOverlay(el, {
      name: 'spotlight', backdrop: false, closeLabel: '스포트라이트 끄기',
      onOpen: function () { rect = null; fit(); },
      onClose: function () {}
    });
    return { open: ov.open, close: ov.close, isOpen: ov.isOpen, el: el };
  }

  // ─────────────────────────── 타이머 ───────────────────────────
  function createTimer() {
    injectCss();
    var el = document.createElement('div');
    el.className = 'pt-timer';
    el.innerHTML =
      '<div class="pt-timer-box" id="ptTimerBox">' +
      '<div class="pt-timer-num" id="ptTimerNum">0:00</div>' +
      '<div class="pt-timer-ctl">' +
      '<button data-sec="30">30초</button><button data-sec="60">1분</button>' +
      '<button data-sec="120">2분</button><button data-sec="180">3분</button>' +
      '<input id="ptTimerMin" type="number" min="0" max="99" placeholder="분" />' +
      '<button id="ptTimerSetMin">직접</button>' +
      '<button id="ptTimerPause">⏸</button><button id="ptTimerReset">↺</button>' +
      '</div></div>';
    document.body.appendChild(el);

    var numEl = el.querySelector('#ptTimerNum');
    var boxEl = el.querySelector('#ptTimerBox');
    var remain = 0, total = 0, tid = null, paused = false, ended = false;

    function fmt(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
    function paint() {
      numEl.textContent = fmt(remain);
      numEl.className = 'pt-timer-num' + (remain <= 0 ? ' over' : remain <= 10 ? ' warn' : '');
    }
    function tick() {
      if (paused) return;
      remain -= 1; paint();
      if (remain <= 0 && !ended) { ended = true; beep('end'); }
    }
    function setSecs(s) {
      total = remain = s; ended = false; paused = false; paint();
      if (tid) clearInterval(tid);
      tid = setInterval(tick, 1000);
    }
    el.querySelectorAll('[data-sec]').forEach(function (b) {
      b.addEventListener('click', function () { setSecs(Number(b.getAttribute('data-sec'))); });
    });
    el.querySelector('#ptTimerSetMin').addEventListener('click', function () {
      var m = Number(el.querySelector('#ptTimerMin').value) || 0; if (m > 0) setSecs(m * 60);
    });
    el.querySelector('#ptTimerPause').addEventListener('click', function () {
      paused = !paused; el.querySelector('#ptTimerPause').textContent = paused ? '▶' : '⏸';
    });
    el.querySelector('#ptTimerReset').addEventListener('click', function () { setSecs(total || 0); });

    // 큰 숫자를 드래그해 위치를 옮긴다
    (function () {
      var dg = false, ox = 0, oy = 0;
      numEl.addEventListener('mousedown', function (e) {
        dg = true; var r = boxEl.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault();
      });
      window.addEventListener('mousemove', function (e) {
        if (!dg) return;
        boxEl.style.left = (e.clientX - ox) + 'px'; boxEl.style.top = (e.clientY - oy) + 'px';
      });
      window.addEventListener('mouseup', function () { dg = false; });
    })();

    var ov = createOverlay(el, {
      name: 'timer', backdrop: true, closeLabel: '타이머 닫기',
      onClose: function () { if (tid) { clearInterval(tid); tid = null; } }
    });
    return {
      open: function (secs) { ov.open(); if (secs) setSecs(secs); else paint(); },
      close: ov.close, isOpen: ov.isOpen, el: el
    };
  }

  // ─────────────────────────── 단축키 도움말 ───────────────────────────
  function createHelp(rows) {
    injectCss();
    var el = document.createElement('div');
    el.className = 'pt-help';
    el.innerHTML = '<div class="pt-help-box"><h3>⌨ 단축키</h3>' +
      (rows || []).map(function (r) { return '<div class="row"><span>' + r[1] + '</span><kbd>' + r[0] + '</kbd></div>'; }).join('') +
      '</div>';
    document.body.appendChild(el);
    var ov = createOverlay(el, { name: 'help', backdrop: true, closeLabel: '닫기' });
    return { open: ov.open, close: ov.close, isOpen: ov.isOpen, el: el };
  }

  // ─────────────────────────── 전체화면(F) ───────────────────────────
  function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
    } catch (e) {}
  }

  // ─────────────────────────── 하단 도구 독(자동 숨김) ───────────────────────────
  // dockEl 을 5초 무조작이면 감춘다(반투명 핸들만). 마우스 하단 이동·아무 키·터치로 복귀.
  function createDock(dockEl, opts) {
    opts = opts || {};
    injectCss();
    dockEl.classList.add('pt-dock');
    var handle = document.createElement('div');
    handle.className = 'pt-dock-handle';
    document.body.appendChild(handle);
    var idleMs = opts.idleMs || 5000, timer = null, hidden = false;

    function show() {
      hidden = false; dockEl.classList.remove('hidden'); handle.classList.add('gone');
      clearTimeout(timer); timer = setTimeout(hide, idleMs);
    }
    function hide() { hidden = true; dockEl.classList.add('hidden'); handle.classList.remove('gone'); }

    handle.addEventListener('click', show);
    dockEl.addEventListener('mousemove', show);
    document.addEventListener('keydown', show);
    document.addEventListener('mousemove', function (e) {
      if (e.clientY > window.innerHeight - 80) show();     // 마우스가 하단으로 오면 복귀
    });
    document.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches[0] && e.touches[0].clientY > window.innerHeight - 80) show();
    }, { passive: true });
    show();
    return { show: show, hide: hide, isHidden: function () { return hidden; } };
  }

  return {
    createOverlay: createOverlay,
    createHelper: createHelper,
    createDrawing: createDrawing,
    createSpotlight: createSpotlight,
    createTimer: createTimer,
    createHelp: createHelp,
    createDock: createDock,
    toggleFullscreen: toggleFullscreen,
    beep: beep,
    injectCss: injectCss,
    _stackDepth: function () { return _stack.length; }     // 테스트용: 열린 오버레이 수
  };
});
