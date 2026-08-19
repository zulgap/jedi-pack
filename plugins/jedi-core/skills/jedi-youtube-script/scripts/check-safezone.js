#!/usr/bin/env node
// check-safezone.js — 슬라이드 덱이 PiP 세이프존을 침범하는지 «재서» 판정한다.
//
// 쓰는 법
//   node check-safezone.js <슬라이드.html> [--safe 360] [--stage 1920x1080] [--margin 60]
//
// 판정
//   stage 좌표계에서 어떤 요소든 bottom > (높이 - safe) 이면 침범이다.
//   top < 0 이면 위로 잘린 것이다.
//
// @AI:INTENT 눈으로 보면 통과처럼 보이는데 얼굴 PiP 가 올라가면 가려진다. 2026-08-16 실측에서
//   68장 중 6장이 50px 씩 침범했고 전부 육안으로는 멀쩡했다. 그래서 사람 판단이 아니라 렌더 측정이다.
// @AI:CONSTRAINT LLM 0 — 전부 getBoundingClientRect 원본값 판정이다. 여기에 「대충 괜찮아 보임」
//   류의 유연한 해석을 넣지 말 것. 이 스크립트의 값어치는 그것을 안 하는 데 있다.
// @AI:DEPENDS Chrome 실행 파일 경로는 OS·설치 방식마다 다르다. 하드코딩하면 팀원 PC 에서 즉사하므로
//   후보를 순서대로 찾고, 하나도 없으면 «조용히 넘기지 않고» 안내와 함께 실패시킨다.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ─────────────────────────────────────────── 인자

const argv = process.argv.slice(2);
const SRC = argv.find((a) => !a.startsWith('--'));

function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

if (!SRC) {
  console.error('쓰는 법: node check-safezone.js <슬라이드.html> [--safe 360] [--stage 1920x1080] [--margin 60]');
  process.exit(2);
}
if (!fs.existsSync(SRC)) {
  console.error('[파일 없음] ' + SRC);
  process.exit(2);
}

// @AI:CONSTRAINT 세이프존 높이는 «채널마다 다르다»(PiP 크기·마진이 다르므로).
//   기본값을 조용히 쓰면 다른 채널에서 «잘못된 PASS»가 나오는데, 그건 이 스크립트가 막으려던 것과
//   정확히 같은 사고다(조용한 실패). 그래서 기본값을 쓸 때는 반드시 경고를 낸다.
const SAFE_EXPLICIT = argv.includes('--safe');
const SAFE = Number(opt('safe', 360));                 // 하단 세이프존 높이(px) — 정본 production 값
const MARGIN = Number(opt('margin', 60));              // 이 값 미만으로 붙으면 «통과지만 경고»
const [STAGE_W, STAGE_H] = String(opt('stage', '1920x1080')).split('x').map(Number);

if (!Number.isFinite(SAFE) || !Number.isFinite(STAGE_H) || !Number.isFinite(STAGE_W)) {
  console.error('[인자 오류] --safe / --stage 는 숫자여야 한다.');
  process.exit(2);
}

const LIMIT = STAGE_H - SAFE;

// ─────────────────────────────────────────── Chrome 조달 (이식성)

/** Playwright 가 받아둔 chromium 은 버전 폴더명이 가변이라 스캔한다. */
function playwrightChromiums() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean);

  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries.filter((x) => x.startsWith('chromium')).sort().reverse()) {
      found.push(
        path.join(root, e, 'chrome-win64', 'chrome.exe'),
        path.join(root, e, 'chrome-win', 'chrome.exe'),
        path.join(root, e, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(root, e, 'chrome-linux', 'chrome')
      );
    }
  }
  return found;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveChrome() {
  // 명시 지정이 최우선이고, 지정했는데 없으면 «조용히 다른 것으로 넘어가지 않는다».
  // 사람이 특정 브라우저를 지목한 것이므로 다른 것으로 잰 결과는 그가 원한 답이 아니다.
  if (process.env.CHROME_PATH) {
    if (!exists(process.env.CHROME_PATH)) {
      throw new Error('[CHROME_PATH 없음] 지정한 경로에 실행 파일이 없다: ' + process.env.CHROME_PATH);
    }
    return process.env.CHROME_PATH;
  }

  const candidates = [
    ...playwrightChromiums(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',                        // Windows
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',                 // Edge 도 Chromium
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',                 // macOS
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',                                                       // Linux
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);

  const hit = candidates.find(exists);

  if (!hit) {
    throw new Error(
      '[브라우저 없음] 세이프존을 재려면 Chrome 계열 브라우저가 필요하다.\n' +
        '확인한 경로:\n' +
        candidates.map((p) => '  ' + p).join('\n') +
        '\n→ Chrome 을 설치하거나, 환경변수로 직접 지정할 것:  CHROME_PATH=<실행파일 경로>'
    );
  }
  return hit;
}

// ─────────────────────────────────────────── 측정 스크립트 주입

const PROBE = `
<script>
(function(){
  var LIMIT = ${LIMIT};
  var stage = document.getElementById('stage');
  if (!stage) {
    var pre0 = document.createElement('pre');
    pre0.id = 'SAFEZONE_RESULT';
    pre0.textContent = '@@' + JSON.stringify({ error: 'no-stage' }) + '@@';
    document.body.appendChild(pre0);
    return;
  }
  // 축소(scale)를 풀어 stage 원본 좌표계에서 잰다 — 화면 크기에 판정이 흔들리면 안 된다
  stage.style.transform = 'translate(-50%,-50%) scale(1)';

  var slides = [].slice.call(document.querySelectorAll('.slide'));
  var out = [];
  slides.forEach(function (s, i) {
    slides.forEach(function (x) { x.classList.remove('on'); });
    s.classList.add('on');
    void s.offsetHeight;                       // 강제 리플로우

    var sr = stage.getBoundingClientRect();
    var maxB = -1e9, minT = 1e9, lowest = '', highest = '';
    [].slice.call(s.querySelectorAll('*')).forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;   // 숨은 요소는 세지 않는다
      var top = r.top - sr.top, bot = r.bottom - sr.top;
      var name = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '');
      if (bot > maxB) { maxB = bot; lowest = name; }
      if (top < minT) { minT = top; highest = name; }
    });

    // ── 화면에 실제로 보이는 글자만 모은다 (data-* 속성·주석은 안 들어온다)
    var vis = (s.innerText || '').replace(/\\s+/g, ' ').trim();

    // ── ① 지시문 누수 — data-note 와 화면의 «공통 문장»
    //    @AI:INTENT 리터럴 목록 대신 이 대조를 쓰는 이유: 연출 지시는 이미 data-note 에
    //      선언돼 있다. 그 문장이 화면에도 있으면 «샌 것»이고, 이 판정은 오탐이 0이다.
    //      (리터럴 목록은 "여러분 ~하십시오" 같은 정당한 대사를 잡아 신호를 죽인다)
    var note = (s.getAttribute('data-note') || '').replace(/\\s+/g, ' ').trim();
    var leak = '';
    if (note.length >= 12 && vis.length >= 12) {
      // 12자 이상 겹치는 가장 긴 조각을 찾는다 — 우연히 겹칠 길이가 아니다
      for (var L = Math.min(note.length, 80); L >= 12 && !leak; L--) {
        for (var st = 0; st + L <= note.length; st++) {
          var frag = note.substr(st, L);
          if (vis.indexOf(frag) !== -1) { leak = frag; break; }
        }
      }
    }

    // ── ② 플레이스홀더 잔존 — 채우지 않고 찍으면 화면에 빈칸이 나간다
    var ph = (vis.match(/__+%?|<[A-Z][A-Z0-9_]{2,}>|\\bTODO\\b|\\bFIXME\\b/g) || []);

    // ── ③ 이미지 로드 실패 — 🔴 «측정 자체가 틀렸다»는 신호다
    //    @AI:INTENT 자리표시자일 때 통과하고 진짜 이미지에서 침범하는 사고가 실재했다
    //      (2026-08-16: 캡처를 넣자 bottom 715→735, 15px 침범). 안 실린 이미지는
    //      높이 0으로 재지므로 «통과»가 나오는데 그 통과는 거짓이다.
    var badImg = [];
    [].slice.call(s.querySelectorAll('img')).forEach(function (im) {
      if (!im.complete || im.naturalWidth === 0) {
        badImg.push((im.getAttribute('src') || '(src 없음)').split('/').pop());
      }
    });

    out.push({
      n: i + 1,
      top: Math.round(minT),
      bottom: Math.round(maxB),
      over: maxB > LIMIT,
      overBy: Math.max(0, Math.round(maxB - LIMIT)),
      above: minT < 0,
      lowest: lowest,
      highest: highest,
      leak: leak,
      placeholders: ph,
      badImg: badImg
    });
  });

  var pre = document.createElement('pre');
  pre.id = 'SAFEZONE_RESULT';
  pre.textContent = '@@' + JSON.stringify(out) + '@@';
  document.body.appendChild(pre);
})();
</script>
`;

// ─────────────────────────────────────────── 실행

let chrome;
try {
  chrome = resolveChrome();
} catch (e) {
  console.error(e.message);
  process.exit(3);
}

const html = fs.readFileSync(SRC, 'utf8');
if (!html.includes('</body>')) {
  console.error('[형식 오류] </body> 가 없다 — 슬라이드 덱 HTML 이 맞는지 확인할 것.');
  process.exit(2);
}

// 원본 옆에 임시 파일을 만든다 — 상대경로 자산(이미지·prompter.js)이 그대로 풀려야 하기 때문이다.
// @AI:CONSTRAINT tmpdir 로 옮기면 ../_capture 류 상대 참조가 전부 깨져 «빈 장»으로 측정된다.
const tmp = path.join(path.dirname(path.resolve(SRC)), '.safezone-check.tmp.html');
fs.writeFileSync(tmp, html.replace('</body>', PROBE + '</body>'));

let dom;
try {
  dom = execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=' + STAGE_W + ',' + STAGE_H,
      '--virtual-time-budget=8000',
      '--dump-dom',
      'file:///' + path.resolve(tmp).replace(/\\/g, '/'),
    ],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
} catch (e) {
  fs.unlinkSync(tmp);
  console.error('[렌더 실패] ' + chrome + '\n' + (e.message || e));
  process.exit(3);
}
fs.unlinkSync(tmp);

const m = dom.match(/<pre id="SAFEZONE_RESULT">@@(.*?)@@<\/pre>/s);
if (!m) {
  console.error('[결과 없음] 측정 스크립트가 실행되지 않았다. 덱에 #stage 와 .slide 가 있는지 확인할 것.');
  process.exit(3);
}

const parsed = JSON.parse(m[1]);
if (parsed && parsed.error === 'no-stage') {
  console.error('[구조 불일치] #stage 요소가 없다 — templates/deck.html 골격을 쓰고 있는지 확인할 것.');
  process.exit(3);
}

const rows = parsed;
if (!rows.length) {
  console.error('[슬라이드 0장] .slide 요소를 찾지 못했다.');
  process.exit(3);
}

// ─────────────────────────────────────────── 리포트

const over = rows.filter((r) => r.over);
const above = rows.filter((r) => r.above);
const tight = rows.filter((r) => !r.over && r.bottom > LIMIT - MARGIN);

console.log('━━━━━ ' + path.basename(SRC) + ' · 슬라이드 ' + rows.length + '장 ━━━━━');
console.log('  무대 ' + STAGE_W + '×' + STAGE_H + ' · 세이프존 하단 ' + SAFE + 'px → 기준선 bottom ≤ ' + LIMIT + 'px');
// 어느 브라우저로 쟀는지 남긴다 — 렌더러가 다르면 값이 미세하게 다를 수 있다
console.log('  렌더: ' + path.basename(chrome) + (/msedge/i.test(chrome) ? ' (Chrome 대체본)' : ''));
if (!SAFE_EXPLICIT) {
  console.log('  ⚠️ --safe 를 안 주셔서 기본 ' + SAFE + 'px 로 쟀습니다.');
  console.log('     세이프존은 채널마다 다릅니다 — 정본 production 값을 확인해 --safe 로 주세요.');
  console.log('     값이 다르면 이 «통과» 는 틀린 것입니다.');
}
console.log('  가장 아래까지 간 장: ' + Math.max(...rows.map((r) => r.bottom)) + 'px');
console.log('  가장 위로 간 장:     ' + Math.min(...rows.map((r) => r.top)) + 'px (0 미만이면 위로 잘림)');
console.log('');

if (over.length) {
  console.log('  🔴 세이프존 침범 ' + over.length + '장 — 얼굴에 가려집니다');
  over.forEach((r) => console.log('     ' + r.n + '장: bottom ' + r.bottom + 'px (' + r.overBy + 'px 초과) · ' + r.lowest));
} else {
  console.log('  ✅ 세이프존 침범 0장');
}

if (above.length) {
  console.log('  🔴 상단 잘림 ' + above.length + '장');
  above.forEach((r) => console.log('     ' + r.n + '장: top ' + r.top + 'px · ' + r.highest));
} else {
  console.log('  ✅ 상단 잘림 0장');
}

if (tight.length) {
  console.log('  ⚠️ 여유 ' + MARGIN + 'px 미만 ' + tight.length + '장 (통과지만 실촬영에서 확인 대상)');
  tight.forEach((r) => console.log('     ' + r.n + '장: bottom ' + r.bottom + 'px · ' + r.lowest));
}

// ─────────────────────────────────────────── 촬영 전 3종 (세이프존과 «같은 렌더»로 함께 잰다)
// @AI:INTENT 스크립트를 둘로 나누면 사람이 두 번 돌려야 하고, 한 번은 빠뜨린다.
//   입력·도구·시점이 같으므로 한 번에 낸다.

const leaked = rows.filter((r) => r.leak);
const holed = rows.filter((r) => r.placeholders && r.placeholders.length);
const imgBad = rows.filter((r) => r.badImg && r.badImg.length);

console.log('');
if (leaked.length) {
  console.log('  🔴 촬영 지시가 화면에 보입니다 ' + leaked.length + '장 — 시청자가 그대로 봅니다');
  leaked.forEach((r) => console.log('     ' + r.n + '장: "' + r.leak + '"'));
  console.log('     → 연출 지시는 data-note 에만 씁니다. 화면 요소(.note 등)에서 지우세요');
} else {
  console.log('  ✅ 화면에 샌 촬영 지시 0장');
}

if (holed.length) {
  console.log('  🔴 안 채운 자리 ' + holed.length + '장 — 빈칸이 그대로 나갑니다');
  holed.forEach((r) => console.log('     ' + r.n + '장: ' + r.placeholders.join(' , ')));
} else {
  console.log('  ✅ 안 채운 자리 0장');
}

// 🔴 이미지 미로드는 «측정이 틀렸다»는 뜻이므로 통과/실패와 별도로 가장 시끄럽게 알린다
if (imgBad.length) {
  console.log('');
  console.log('  🔴🔴 이미지가 안 실린 장이 ' + imgBad.length + '장 있습니다 — 위 세이프존 값은 «틀렸습니다»');
  imgBad.forEach((r) => console.log('     ' + r.n + '장: ' + r.badImg.join(' , ')));
  console.log('     안 실린 이미지는 높이 0으로 재집니다. 파일을 넣고 «반드시 다시 재세요».');
  console.log('     (2026-08-16 실측: 자리표시자일 땐 통과 → 진짜 캡처를 넣자 15px 침범)');
}

console.log('');
// 침범·잘림·지시문누수·빈칸·이미지미로드 중 하나라도 있으면 실패로 끝낸다 — 게이트로 쓸 수 있게
process.exit(over.length || above.length || leaked.length || holed.length || imgBad.length ? 1 : 0);
