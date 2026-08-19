/* ────────────────────────────────────────────────────────────────
   프롬프터 — 슬라이드 옆에 「지금 읽을 대본」을 띄운다.

   쓰는 법
     P 키  → 프롬프터 창이 새로 열립니다 (두 번째 모니터로 옮기세요)
     ← →   → 어느 창에서 눌러도 둘 다 같이 넘어갑니다
     T 키  → 타이머 시작/정지 (프롬프터 창)
     G 키  → 세이프존 가이드 (제작 확인용 · 촬영 중 금지)

   🔴 OBS는 「슬라이드 창」만 잡으십시오. 프롬프터 창이 녹화에 들어가면
      대본이 그대로 방송됩니다.
      모니터가 하나면 → 슬라이드를 전체화면(F11)으로 두고 프롬프터를 다른
      가상 데스크톱에 두거나, 태블릿 브라우저에서 여십시오.

   대본은 각 <section>의 data-script 속성에 있습니다 (문단 구분은 «|»).
   data-note 는 연출 지시(빨강)이고 읽는 내용이 아닙니다.

   @AI:CONSTRAINT 색을 여기에 적지 않는다 — 덱의 :root 변수에서 읽는다.
     프롬프터에 색 리터럴을 박으면 채널마다 이 파일을 복제하게 되고,
     공용 팩에 특정 회사 브랜드 색이 들어가 게이트(D-3)에 걸린다.
   ──────────────────────────────────────────────────────────────── */
(function () {
  var W = null;          // 프롬프터 창
  var startedAt = null;  // 타이머
  var timerOn = false;

  function slides() { return [].slice.call(document.querySelectorAll('.slide')); }
  function cur() { return slides().findIndex(function (s) { return s.classList.contains('on'); }); }

  function title(sec) {
    var h = sec.querySelector('h1,h2,h3');
    return h ? h.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : '(제목 없음)';
  }

  /** 덱의 팔레트를 그대로 승계한다. 변수가 없으면 무채색으로 떨어진다. */
  function v(name, dflt) {
    var got = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return got || dflt;
  }

  function css() {
    var BG = v('--bg', '#0a0a0a');
    var FG = v('--fg', '#ffffff');
    var DIM = v('--dim', '#a1a1aa');
    var ACCENT = v('--accent', '#9ca3af');
    var BAD = v('--bad', '#fca5a5');
    var LINE = v('--line', '#26262b');
    var CARD = v('--card', '#141417');

    return [
      '*{margin:0;padding:0;box-sizing:border-box}',
      'body{background:' + BG + ';color:' + FG + ';font-family:Pretendard,"Malgun Gothic",system-ui,sans-serif;',
      '  height:100vh;display:flex;flex-direction:column;overflow:hidden}',
      'header{display:flex;align-items:center;gap:20px;padding:14px 26px;background:' + CARD + ';',
      '  border-bottom:2px solid ' + LINE + ';flex:0 0 auto}',
      'header .n{font-size:30px;font-weight:900;color:' + ACCENT + '}',
      'header .t{font-size:26px;color:' + DIM + ';flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      'header .clock{font-size:30px;font-weight:800;font-variant-numeric:tabular-nums}',
      'header .clock.run{color:#34d399}',
      // 낭독용이라 본문이 크다 — 줄이면 멀리서 못 읽어 프롬프터 구실을 못 한다
      '#script{flex:1;overflow-y:auto;padding:34px 40px;font-size:38px;line-height:1.65;font-weight:600}',
      '#script p{margin-bottom:26px}',
      '#script .note{color:' + BAD + ';font-size:27px;font-weight:800;line-height:1.5;',
      '  border-left:6px solid ' + BAD + ';padding:12px 0 12px 18px;margin:22px 0}',
      '#script .none{color:#52525b;font-size:30px;font-weight:500}',
      'footer{flex:0 0 auto;padding:14px 26px;background:' + CARD + ';border-top:2px solid ' + LINE + ';',
      '  display:flex;gap:20px;align-items:center;font-size:23px;color:#71717a}',
      'footer .next{flex:1;color:' + DIM + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      'footer b{color:' + ACCENT + '}',
      '#bar{height:6px;background:' + LINE + ';flex:0 0 auto}',
      '#bar i{display:block;height:100%;background:' + ACCENT + ';width:0}'
    ].join('\n');
  }

  function open() {
    W = window.open('', 'prompter', 'width=1100,height=880');
    if (!W) { alert('팝업이 차단됐습니다. 주소창의 팝업 허용을 켜 주세요.'); return; }
    W.document.write(
      '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
      '<title>프롬프터 — 읽을 대본</title><style>' + css() + '</style></head><body>' +
      '<header><span class="n" id="pn">1</span><span class="t" id="pt"></span>' +
      '<span class="clock" id="pc">00:00</span></header>' +
      '<div id="bar"><i id="pb"></i></div>' +
      '<div id="script"></div>' +
      '<footer><span>← → 넘김 · T 타이머</span><span class="next" id="px"></span></footer>' +
      '</body></html>'
    );
    W.document.close();
    W.addEventListener('keydown', relay);
    setTimeout(render, 60);
  }

  function relay(e) {
    if (['ArrowRight', ' ', 'PageDown', 'Enter'].indexOf(e.key) >= 0) { e.preventDefault(); go(1); }
    else if (['ArrowLeft', 'PageUp', 'Backspace'].indexOf(e.key) >= 0) { e.preventDefault(); go(-1); }
    else if (e.key === 't' || e.key === 'T') { toggleTimer(); }
  }

  function go(d) {
    var ev = new KeyboardEvent('keydown', { key: d > 0 ? 'ArrowRight' : 'ArrowLeft' });
    window.dispatchEvent(ev);
    setTimeout(render, 30);
  }

  function toggleTimer() {
    timerOn = !timerOn;
    if (timerOn && !startedAt) startedAt = Date.now();
    if (!timerOn) startedAt = null;
  }

  function render() {
    if (!W || W.closed) return;
    var all = slides(), i = cur();
    if (i < 0) i = 0;
    var sec = all[i];
    var d = W.document;
    var raw = sec.getAttribute('data-script') || '';
    var note = sec.getAttribute('data-note') || '';

    var html = '';
    if (raw.trim()) {
      raw.split('|').forEach(function (p) {
        if (p.trim()) html += '<p>' + p.trim() + '</p>';
      });
    } else {
      html += '<p class="none">(이 장은 읽을 대사가 없습니다 — 앞 장에서 이어서 말하거나, 화면만 보여주는 장입니다)</p>';
    }
    if (note.trim()) html += '<div class="note">🔴 ' + note.trim() + '</div>';

    d.getElementById('script').innerHTML = html;
    d.getElementById('script').scrollTop = 0;
    d.getElementById('pn').textContent = (i + 1) + ' / ' + all.length;
    d.getElementById('pt').textContent = title(sec);
    d.getElementById('pb').style.width = ((i + 1) / all.length * 100) + '%';
    d.getElementById('px').textContent = (i + 1 < all.length) ? '다음 ▸ ' + title(all[i + 1]) : '— 마지막 장 —';
  }

  setInterval(function () {
    if (!W || W.closed) return;
    var c = W.document.getElementById('pc');
    if (!c) return;
    if (timerOn && startedAt) {
      var s = Math.floor((Date.now() - startedAt) / 1000);
      c.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      c.className = 'clock run';
    } else { c.className = 'clock'; }
  }, 500);

  addEventListener('keydown', function (e) {
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); if (!W || W.closed) open(); else W.focus(); }
    else if (['ArrowRight', 'ArrowLeft', ' ', 'PageDown', 'PageUp', 'Enter', 'Backspace', 'Home', 'End'].indexOf(e.key) >= 0) {
      setTimeout(render, 30);
    }
  });

  addEventListener('beforeunload', function () { if (W && !W.closed) W.close(); });

  // 화면 좌상단 안내 (촬영 시작 전 확인용 · 5초 후 사라짐)
  function hintOnce() {
    var hint = document.createElement('div');
    hint.textContent = 'P = 프롬프터 창 열기';
    hint.style.cssText = 'position:fixed;left:16px;top:16px;z-index:99;' +
      'background:' + v('--accent', '#9ca3af') + ';color:' + v('--bg', '#0a0a0a') + ';' +
      'font:800 20px Pretendard,system-ui;padding:10px 16px;border-radius:10px';
    document.body.appendChild(hint);
    setTimeout(function () { hint.remove(); }, 5000);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', hintOnce);
  else hintOnce();
})();
