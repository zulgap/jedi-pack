// compose-thumbnail.mjs 단위 테스트
// @AI:INTENT 2026-07-30까지 이 파일은 **무검증**이었다 — 테스트 53개는 전부 A/B 실험 스크립트용이고
//   실제 썸네일을 만드는 코드에는 테스트가 0건이었다(전수검수 D6). 같은 날 FONTS 맵·--font·fontVars를
//   크게 고쳤으므로 회귀 가드를 세운다.
// 순수 함수 assembleHtml만 검증한다(네트워크·토큰 불필요).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assembleHtml } from './compose-thumbnail.mjs';

const BASE = { bg: 'https://example.com/bg.png', title: '가나다라마|**바사아자차**' };

// ── 레이아웃 ─────────────────────────────────────────────
test('레이아웃 A/B/C가 각각 올바른 캔버스 크기를 반환한다', () => {
  assert.deepEqual(
    ['A', 'B', 'C'].map((l) => {
      const { width, height } = assembleHtml({ ...BASE, layout: l });
      return `${width}x${height}`;
    }),
    ['1280x720', '1280x720', '1080x1920']
  );
});

test('알 수 없는 레이아웃은 throw한다', () => {
  assert.throws(() => assembleHtml({ ...BASE, layout: 'Z' }), /알 수 없는 레이아웃/);
});

test('layout 미지정 시 A로 폴백한다', () => {
  const { width, height } = assembleHtml({ ...BASE });
  assert.equal(`${width}x${height}`, '1280x720');
});

// ── 폰트 (2026-07-30 신규) ───────────────────────────────
test('--font 미지정 시 폰트 override를 주입하지 않는다 (기존 동작 보존)', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A' });
  assert.equal(/--font-family:'/.test(html), false, 'override style이 없어야 한다');
  // base CSS의 var() 기본값은 남아 있어야 함
  assert.match(html, /var\(--font-family/);
});

test('--font black|gothic|dohyeon가 각각 올바른 family와 weight를 주입한다', () => {
  // @AI:DEPENDS Google Fonts URL의 `+`는 정규식 메타문자다 — 반드시 이스케이프할 것.
  //   (2026-07-30: 'Black+Han+Sans'를 날것으로 써서 이 테스트가 오탐 FAIL 났다)
  const cases = [
    ['black', "'Black Han Sans'", '400', 'Black\\+Han\\+Sans'],
    ['gothic', "'Gothic A1'", '900', 'Gothic\\+A1'],
    ['dohyeon', "'Do Hyeon'", '400', 'Do\\+Hyeon'],
  ];
  for (const [font, family, weight, urlPart] of cases) {
    const { html } = assembleHtml({ ...BASE, layout: 'A', font });
    assert.ok(html.includes(`--font-family:${family}`), `${font}: family 주입 실패`);
    assert.ok(html.includes(`--font-weight:${weight}`), `${font}: weight 주입 실패`);
    assert.match(html, new RegExp(`fonts\\.googleapis[^"]*${urlPart}`), `${font}: <link> 누락`);
  }
});

test('단일 굵기 폰트에 weight 900을 주지 않는다 (가짜 굵기 방지)', () => {
  // Black Han Sans / Do Hyeon은 400 하나뿐 — 900을 주면 브라우저가 합성해 뭉갠다
  for (const font of ['black', 'dohyeon']) {
    const { html } = assembleHtml({ ...BASE, layout: 'A', font });
    assert.ok(html.includes('--font-weight:400'), `${font}은 weight 400이어야 한다`);
  }
});

test('알 수 없는 --font는 무시하고 기본값을 유지한다 (throw 아님)', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A', font: 'comic-sans' });
  assert.equal(/--font-family:'/.test(html), false);
});

test('--font는 대소문자를 가리지 않는다', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A', font: 'GOTHIC' });
  assert.ok(html.includes("--font-family:'Gothic A1'"));
});

test('폰트 override는 </head> 앞에 주입된다 (base CSS보다 뒤라 이긴다)', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A', font: 'gothic' });
  // @AI:DEPENDS base CSS에도 `--font-family: 'Noto...'`(공백 있는 기본값)가 있으므로
  //   indexOf('--font-family:')는 그걸 먼저 잡는다. override는 공백 없는 형태로 찾아야 한다.
  const overrideAt = html.indexOf("--font-family:'Gothic A1'");
  const baseDefaultAt = html.indexOf("--font-family: 'Noto");
  const headEndAt = html.indexOf('</head>');
  assert.ok(overrideAt > 0, 'override 주입 자체가 없다');
  assert.ok(overrideAt < headEndAt, 'override가 head 안에 있어야 한다');
  assert.ok(overrideAt > baseDefaultAt, 'base CSS 기본값보다 뒤여야 덮어쓴다');
});

// ── 제목 파싱 ────────────────────────────────────────────
test('| 는 줄바꿈, ** ** 는 강조(em)로 변환된다', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A', title: '첫줄|**둘째줄**' });
  assert.match(html, /첫줄/);
  assert.match(html, /<span class="l2"><em>둘째줄<\/em><\/span>/);
});

test('제목의 HTML 특수문자는 이스케이프된다 (강조 마커는 보존)', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A', title: '<script>|**a&b**' });
  assert.equal(html.includes('<script>|'), false, 'raw <script>가 남으면 안 된다');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<em>a&amp;b<\/em>/);
});

// ── 조건부 블록 ──────────────────────────────────────────
test('subtitle/role/channel은 값이 있을 때만 렌더된다', () => {
  const off = assembleHtml({ ...BASE, layout: 'A' }).html;
  assert.equal(/class="subtitle"/.test(off), false);
  assert.equal(/class="role-label"/.test(off), false);
  assert.equal(/class="watermark"/.test(off), false);

  const on = assembleHtml({
    ...BASE, layout: 'A', subtitle: '서브', role: '역할', channel: '채널',
  }).html;
  assert.match(on, /class="subtitle"/);
  assert.match(on, /class="role-label"/);
  assert.match(on, /class="watermark"/);
  assert.match(on, /\(역할\)/);
});

test('{{ }} 플레이스홀더가 남지 않는다', () => {
  const { html } = assembleHtml({
    ...BASE, layout: 'A', subtitle: '서브', role: '역할', channel: '채널', host: 'https://h.png',
  });
  assert.equal(/\{\{/.test(html), false, `치환 안 된 자리: ${(html.match(/\{\{[^}]*\}\}/g) || []).join(', ')}`);
});

// ── 부품 ─────────────────────────────────────────────────
test('--acc가 강조색 클래스를 바꾼다 (미지정 시 yellow)', () => {
  assert.match(assembleHtml({ ...BASE, layout: 'A', acc: 'red' }).html, /class="thumb acc-red"/);
  assert.match(assembleHtml({ ...BASE, layout: 'A' }).html, /class="thumb acc-yellow"/);
});

test('--stroke가 외곽선 두께를 override한다', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A', stroke: '4px' });
  assert.match(html, /--stroke:4px/);
});

test('--quote가 좌표와 색상을 반영한다 (! 접두 = 빨강)', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A', quotes: ['!아이고@22,14'] });
  assert.match(html, /class="quote red"/);
  assert.match(html, /left:22%;top:14%/);
  assert.match(html, /아이고/);
});

test('프레임 테두리는 A/B/C 전부에 자동 포함된다', () => {
  for (const layout of ['A', 'B', 'C']) {
    assert.match(assembleHtml({ ...BASE, layout }).html, /class="frame"/, `${layout}에 frame 누락`);
  }
});

// ── 회귀 가드: 2026-07-30 수리 항목 ──────────────────────
test('[회귀] 서브카피 폴백 34px이 base CSS에 남아 있다', () => {
  // JS가 안 도는 경로(폰트 로드 실패 등)에서 16px로 떨어지는 것을 막는 폴백
  assert.match(assembleHtml({ ...BASE, layout: 'A' }).html, /font-size:\s*34px/);
});

test('[회귀] 어절 공백을 좁히지 않는다 (word-spacing: normal)', () => {
  // -0.12em까지 좁혔다가 어절이 뭉개져 원복한 이력. 다시 음수로 바뀌면 이 테스트가 깨진다.
  assert.match(assembleHtml({ ...BASE, layout: 'A' }).html, /word-spacing:\s*var\(--word-spacing,\s*normal\)/);
});

test('[회귀] 3개 레이아웃 모두 양방향 auto-fit을 갖는다', () => {
  // C만 축소-only로 남아 짧은 카피가 안 커지던 결함(D1) 재발 방지
  for (const layout of ['A', 'B', 'C']) {
    const { html } = assembleHtml({ ...BASE, layout });
    assert.match(html, /ceil/, `${layout}: 확대 로직(ceil) 누락 — 축소만 하면 짧은 카피가 폭을 못 채운다`);
  }
});

// ── 회귀 가드: 2026-08-20 수리 항목 ──────────────────────
test('[회귀] 레이아웃 B의 제목이 nowrap이다 (폭 판정의 전제)', () => {
  // nowrap이 없으면 줄바꿈 시 scrollWidth === clientWidth 가 되어 폭 넘침을 영영 못 재고,
  // 폰트가 높이 상한까지 커지며 2줄 카피가 3~4줄로 갈라진다.
  const { html } = assembleHtml({ ...BASE, layout: 'B' });
  assert.match(html, /\.title\s*\{[^}]*white-space:\s*nowrap/);
});

test('--sub-size / --sub-gap 이 CSS 변수로 주입된다', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A', 'sub-size': '52', 'sub-gap': '60' });
  assert.match(html, /--sub-size:\s*52px/);
  assert.match(html, /--sub-gap:\s*60px/);
});

// @AI:DEPENDS 템플릿 JS 자체가 `getPropertyValue('--sub-size')` 라는 문자열을 갖고 있으므로
//   변수명만으로 검사하면 항상 걸린다. **주입된 선언**(`--sub-size: 52px`)만 골라 본다.
const DECL = { size: /--sub-size:\s*\d+px/, gap: /--sub-gap:\s*\d+px/ };

test('--sub-size / --sub-gap 미지정 시 변수를 주입하지 않는다 (기존 자동 계산 보존)', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A' });
  assert.doesNotMatch(html, DECL.size);
  assert.doesNotMatch(html, DECL.gap);
});

test('[보안] --sub-size 에 정수가 아닌 값이 오면 무시한다 (CSS 주입 차단)', () => {
  // `52px} .thumb{display:none` 같은 문자열이 그대로 보간되면 :root{} 밖으로 빠져나가 임의 CSS가 된다.
  for (const bad of ['52px} .thumb{display:none', '-10', '0', 'abc', '12.5']) {
    const { html } = assembleHtml({ ...BASE, layout: 'A', 'sub-size': bad });
    assert.doesNotMatch(html, DECL.size, `주입 차단 실패: ${bad}`);
    assert.doesNotMatch(html, /display:none/, `주입 차단 실패(CSS 탈출): ${bad}`);
  }
});

test('A·B 템플릿이 --sub-size / --sub-gap 을 읽는다', () => {
  for (const layout of ['A', 'B']) {
    const { html } = assembleHtml({ ...BASE, layout });
    assert.match(html, /getPropertyValue\('--sub-size'\)/, `${layout}: --sub-size 미참조`);
    assert.match(html, /getPropertyValue\('--sub-gap'\)/, `${layout}: --sub-gap 미참조`);
  }
});

// ── 지목 세트: --tag / --arrow-to / --inset (2026-08-27 신규) ─────────────
// @AI:INTENT 이 세트는 「사장님이 두 번 확인하지 않게」가 요구사항이었다. 가장 중요한 회귀 가드는
//   «인자를 안 주면 아무것도 달라지지 않는다»이다 — 기존 썸네일 전부가 여기에 걸려 있다.

test('--tag/--inset 미지정 시 지목 세트를 전혀 주입하지 않는다 (기존 동작 보존)', () => {
  const { html } = assembleHtml({ ...BASE, layout: 'A' });
  for (const cls of ['tag-wrap', 'tag-arrow', 'tag-inset-cut', 'tag-inset-circle']) {
    assert.equal(html.includes(`class="${cls}"`), false, `${cls}가 없어야 한다`);
  }
  assert.equal(/Nanum\+Pen\+Script/.test(html), false, '손글씨 웹폰트를 받지 않아야 한다');
});

test('--tag hand는 손글씨 라벨과 웹폰트 link를 넣는다', () => {
  const { html } = assembleHtml({ ...BASE, tag: '20년차 매니저' });
  assert.match(html, /class="tag-hand"/);
  assert.match(html, /20년차 매니저/);
  assert.match(html, /Nanum\+Pen\+Script/);
});

test('--tag-style card는 명함 배지를 쓰고 손글씨 폰트를 받지 않는다', () => {
  const { html } = assembleHtml({ ...BASE, tag: '20년차 매니저', 'tag-style': 'card' });
  assert.match(html, /class="tag-card"/);
  assert.equal(/Nanum\+Pen\+Script/.test(html), false, '명함형은 Noto를 쓰므로 웹폰트가 불필요하다');
});

test('--arrow-to가 있을 때만 화살표 SVG를 그린다', () => {
  const without = assembleHtml({ ...BASE, tag: 'x' }).html;
  assert.equal(without.includes('class="tag-arrow"'), false);

  const withArrow = assembleHtml({ ...BASE, tag: 'x', 'arrow-to': '84,45' }).html;
  assert.match(withArrow, /class="tag-arrow"/);
  assert.match(withArrow, /<path d="M [\d.]+ [\d.]+ Q /, '2차 베지어 곡선이어야 한다');
});

test('화살표 좌표는 캔버스 크기 기준 %다 — 레이아웃 C(1080×1920)에서도 같은 인자가 먹는다', () => {
  const a = assembleHtml({ ...BASE, layout: 'A', tag: 'x', 'arrow-to': '50,50' }).html;
  const c = assembleHtml({ ...BASE, layout: 'C', tag: 'x', 'arrow-to': '50,50' }).html;
  assert.match(a, /viewBox="0 0 1280 720"/);
  assert.match(c, /viewBox="0 0 1080 1920"/);
  // C의 끝점은 (540, 960) — 캔버스의 절반
  assert.match(c, /Q [\d.]+ [\d.]+ 540\.0 960\.0"/);
});

test('--inset 기본은 누끼(cut)이고 흰 외곽선이 없다 (자연스러운 합성)', () => {
  const { html } = assembleHtml({ ...BASE, inset: 'https://example.com/cut.png' });
  assert.match(html, /class="tag-inset-cut"/);
  assert.equal(/drop-shadow\(3px 0 0 #fff\)/.test(html), false, '기본은 테두리 없음이어야 한다');
  assert.match(html, /drop-shadow\(0 18px 26px/, '그림자는 항상 있어야 한다');
});

test('--inset-outline은 4방향 drop-shadow로 스티커 외곽선을 만든다', () => {
  const { html } = assembleHtml({ ...BASE, inset: 'https://example.com/cut.png', 'inset-outline': '3' });
  for (const d of ['3px 0 0 #fff', '-3px 0 0 #fff', '0 3px 0 #fff', '0 -3px 0 #fff']) {
    assert.ok(html.includes(`drop-shadow(${d})`), `${d} 방향이 있어야 한다`);
  }
});

test('--inset-shape circle은 원형 액자로 그린다', () => {
  const { html } = assembleHtml({ ...BASE, inset: 'https://example.com/p.png', 'inset-shape': 'circle', 'inset-size': '210' });
  assert.match(html, /class="tag-inset-circle"/);
  assert.match(html, /width:210px;height:210px/);
});

// @AI:CONSTRAINT 순서 검증은 반드시 `class="..."` 로 찾는다. 클래스 «이름»으로 찾으면
//   HTML 안에 인라인된 _base.css 의 선택자가 먼저 잡혀서, 마크업이 아니라 CSS 순서를 재게 된다
//   (2026-08-27: 이 실수로 테스트 하나가 우연히 통과하고 하나가 실패했다).
test('지목 세트는 .frame 직전에 들어간다 (프레임 선이 항상 맨 위)', () => {
  const { html } = assembleHtml({ ...BASE, tag: 'x', inset: 'https://example.com/p.png' });
  const frame = html.indexOf('<div class="frame">');
  assert.ok(html.indexOf('class="tag-inset-cut"') < frame, '인서트가 frame보다 앞');
  assert.ok(html.indexOf('class="tag-wrap"') < frame, '라벨이 frame보다 앞');
});

test('그리는 순서는 화살표 → 인서트 → 라벨이다 (화살촉이 인물 뒤로)', () => {
  const { html } = assembleHtml({
    ...BASE, tag: 'x', 'arrow-to': '80,40', inset: 'https://example.com/p.png',
  });
  const arrow = html.indexOf('class="tag-arrow"');
  const inset = html.indexOf('class="tag-inset-cut"');
  const label = html.indexOf('class="tag-wrap"');
  assert.ok(arrow > 0 && inset > arrow, '화살표가 인서트보다 앞');
  assert.ok(label > inset, '라벨이 인서트보다 뒤');
});

// ── --punch (2026-08-27 신규) ────────────────────────────
test('--punch 미지정/0이면 배경 보정을 주입하지 않는다 (기존 동작 보존)', () => {
  assert.equal(/\.bg\{filter:/.test(assembleHtml({ ...BASE }).html), false);
  assert.equal(/\.bg\{filter:/.test(assembleHtml({ ...BASE, punch: '0' }).html), false);
});

test('--punch 1은 saturate 1.12 / contrast 1.05를 준다 (실무 확정값)', () => {
  const { html } = assembleHtml({ ...BASE, punch: '1' });
  assert.match(html, /\.bg\{filter:saturate\(1\.120\) contrast\(1\.050\)\}/);
});

// ── 보안: 속성 이스케이프 ────────────────────────────────
test('--inset-tone에 따옴표가 들어가도 style 속성을 닫지 못한다', () => {
  const { html } = assembleHtml({
    ...BASE, inset: 'https://example.com/p.png', 'inset-tone': '" onerror="alert(1)',
  });
  assert.equal(html.includes('onerror="alert(1)"'), false, '속성 탈출이 없어야 한다');
  assert.match(html, /&quot; onerror=&quot;/);
});

// ── 색·프레임을 채널이 정한다 (2026-09-05) ────────────────
// @AI:INTENT 이 절이 지키는 것은 «이 스킬이 채널을 모른다»는 것이다. 종전에는 채널 3벌의 색이
//   _base.css 의 .acc-yellow/red/pink 로 박혀 있어, 그 셋에 없는 색을 쓰는 채널이 오면
//   공용 파일에 프리셋을 한 벌 더 넣어야 했다. SKILL.md § 3층 경계는 「강조색 = 채널이 채우는
//   슬롯」이라 선언해 두었는데 구현만 반대였다 — 선언과 구현이 갈라진 자리를 테스트로 잠근다.

// @AI:DEPENDS _base.css 의 :root 에도 같은 변수명이 «기본값»으로 있다. 그래서 html 전체를 훑으면
//   주입 여부를 못 가른다 — compose 가 덧붙인 override 블록만 떼어 본다.
const injected = (html) => (html.match(/<style>:root\{--acc-color:[^}]*\}<\/style>/) || [''])[0];

test('색 인자가 없으면 --acc 프리셋 값이 들어간다 (기존 동작 보존)', () => {
  const { html } = assembleHtml({ ...BASE, acc: 'red' });
  assert.match(html, /--acc-color:#ff3b30;--sub-color:#ffe08a;/);
  assert.equal(/--frame-color/.test(injected(html)), false, '프레임은 미지정 시 주입하지 않는다');
});

test('--acc 자체가 없으면 노랑이 기본이다', () => {
  const { html } = assembleHtml({ ...BASE });
  assert.match(html, /--acc-color:#ffd400;--sub-color:#ffd400;/);
});

test('--acc-color / --sub-color 가 프리셋을 이긴다', () => {
  const { html } = assembleHtml({ ...BASE, acc: 'red', 'acc-color': '#f11e8f', 'sub-color': '#00ff00' });
  assert.match(html, /--acc-color:#f11e8f;--sub-color:#00ff00;/);
});

test('--frame-* 로 테두리 색·두께·안쪽여백을 정한다 (inset 0 허용)', () => {
  const { html } = assembleHtml({
    ...BASE, 'frame-color': '#f11e8f', 'frame-width': '9', 'frame-inset': '0',
  });
  assert.match(html, /--frame-color:#f11e8f;/);
  assert.match(html, /--frame-width:9px;/);
  assert.match(html, /--frame-inset:0px;/, 'inset 0(가장자리에 붙이기)이 무시되면 안 된다');
});

test('[보안] 색 인자가 hex 형식이 아니면 무시한다 (CSS 주입 차단)', () => {
  const { html } = assembleHtml({
    ...BASE, 'acc-color': 'red}body{display:none', 'frame-color': 'url(javascript:1)',
  });
  assert.equal(html.includes('body{display:none'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.match(html, /--acc-color:#ffd400;/, '무시하고 기본값으로 떨어져야 한다');
});

test('[보안] --frame-width 가 정수가 아니면 무시한다', () => {
  const { html } = assembleHtml({ ...BASE, 'frame-width': '9px;}html{opacity:0' });
  assert.equal(html.includes('opacity:0'), false);
  assert.equal(/--frame-width/.test(injected(html)), false);
});

test('_base.css 는 채널 색을 모른다 — 색 리터럴이 :root 밖에 없다', () => {
  const css = fs.readFileSync(new URL('../templates/_base.css', import.meta.url), 'utf8');
  // :root 블록(기본값 선언)을 떼어내고, 나머지 «규칙» 안에 채널이 정할 색이 남아 있는지 본다.
  // @AI:DEPENDS `.quote.red` 는 제외한다 — 그 빨강은 채널색이 아니라 --quote 의 `!` 접두가 고르는
  //   «말풍선 강조 표시»이고, 값이 .acc-red 와 우연히 같을 뿐이다. 채널이 말풍선 색을 정해야 할
  //   일이 생기면 그때 --quote-color 를 따로 열 것 (지금 열면 읽는 곳이 0인 인자가 된다).
  const withoutRoot = css
    .replace(/:root\s*\{[\s\S]*?\}/g, '')
    .replace(/\.quote\.red\s*\{[^}]*\}/g, '');
  for (const banned of ['#ffd400', '#ff3b30', '#ff2d78', '#ffe08a']) {
    assert.equal(
      withoutRoot.includes(banned), false,
      `${banned} 가 규칙 안에 도로 박혔다 — 채널 색은 --acc-color/--sub-color 로만 준다`
    );
  }
  assert.equal(/\.acc-(yellow|red|pink)\s+\./.test(withoutRoot), false, '채널별 색 클래스를 되살리지 말 것');
});

// ── 숫자 크기 (2026-09-05) ────────────────────────────────
// @AI:INTENT 한글 제목 폰트는 숫자 글리프가 한글보다 작다(실측 4종 84~91%). 가장 중요한 숫자가
//   가장 안 읽히는 자리라, 크기를 값으로 조절한다. 기본 1em = 종전 동작.

test('제목의 숫자를 .num 으로 감싼다', () => {
  const { html } = assembleHtml({ ...BASE, title: '6주 만에|**4배**가 됐다' });
  assert.match(html, /<span class="num">6<\/span>주 만에/);
  assert.match(html, /<em><span class="num">4<\/span>배<\/em>/);
});

test('소수·쉼표·퍼센트가 한 덩어리로 묶인다 (4.3% 가 세 조각으로 갈라지면 안 된다)', () => {
  const { html } = assembleHtml({ ...BASE, title: '인용률 4.3%|1,200건' });
  assert.match(html, /<span class="num">4\.3%<\/span>/);
  assert.match(html, /<span class="num">1,200<\/span>건/);
});

test('🔴 줄바꿈 span 의 «2» 를 숫자로 잡지 않는다 (감싸는 순서 가드)', () => {
  const { html } = assembleHtml({ ...BASE, title: '첫 줄|둘째 줄' });
  assert.match(html, /<span class="l2">/, 'l2 클래스가 온전해야 한다');
  assert.equal(html.includes('class="l<span class="num">2'), false, '태그 속성이 깨지면 안 된다');
});

test('--num-scale 이 CSS 변수로 들어간다', () => {
  const { html } = assembleHtml({ ...BASE, 'num-scale': '1.15' });
  assert.match(html, /--num-scale:1\.15em;/);
});

test('--num-scale 미지정 시 주입하지 않는다 (기본 1em = 기존 동작)', () => {
  const { html } = assembleHtml({ ...BASE });
  assert.equal(/--num-scale/.test(injected(html)), false);
});

test('[보안] --num-scale 은 1.0~1.6 밖이거나 숫자가 아니면 무시한다', () => {
  for (const bad of ['9', '0.5', '2.0', '1.15;}html{opacity:0', 'abc']) {
    const { html } = assembleHtml({ ...BASE, 'num-scale': bad });
    assert.equal(/--num-scale/.test(injected(html)), false, `${bad} 가 통과하면 안 된다`);
  }
  assert.equal(assembleHtml({ ...BASE, 'num-scale': '1.15;}html{opacity:0' }).html.includes('opacity:0'), false);
});

test('_base.css 가 .num 을 --num-scale 로 그린다 (배선 확인)', () => {
  const css = fs.readFileSync(new URL('../templates/_base.css', import.meta.url), 'utf8');
  assert.match(css, /\.title \.num\s*\{\s*font-size:\s*var\(--num-scale, 1em\)/);
});

// ── 배치·그라데이션 (2026-09-05) ──────────────────────────
// @AI:INTENT 「글자가 얹힌 것처럼 보인다」를 고치는 값들. 발행 썸네일과 픽셀로 대조해 신설했다 —
//   가로 점유 88~94% ↔ 57% · 아래 여백 5.0% ↔ 9.1% · 줄 간격 2.1% ↔ 4.0%.
//   기본값은 전부 종전 동작이라 인자를 안 주면 아무것도 안 바뀐다.

test('--line-height / --title-bottom / --title-maxh 가 주입된다', () => {
  const { html } = assembleHtml({
    ...BASE, 'line-height': '0.9', 'title-bottom': '26', 'title-maxh': '300',
  });
  assert.match(html, /--line-height:0\.9/);
  assert.match(html, /--title-maxh:300px/);
  assert.match(html, /\.title-box\{bottom:26px !important\}/);
});

test('--scrim-h / --scrim-o 가 하단 그라데이션을 바꾼다', () => {
  const { html } = assembleHtml({ ...BASE, 'scrim-h': '470', 'scrim-o': '0.96' });
  assert.match(html, /\.scrim-bottom\{height:470px;background:linear-gradient\(0deg,rgba\(0,0,0,0\.96\)/);
  assert.match(html, /rgba\(0,0,0,0\.47\) 55%/, '중간 지점은 하단 진하기에 비례해야 한다');
});

test('배치 인자 미지정 시 아무것도 주입하지 않는다 (기존 동작 보존)', () => {
  const { html } = assembleHtml({ ...BASE });
  assert.equal(/--line-height:/.test(html.split('</head>')[0].split('<style>:root{--acc-color')[1] || ''), false);
  assert.equal(/\.title-box\{bottom:/.test(html), false);
  assert.equal(/\.scrim-bottom\{height:/.test(html), false);
});

test('[보안] 배치 인자가 범위 밖이거나 숫자가 아니면 무시한다', () => {
  for (const bad of ['0.5', '2.0', 'abc', '0.9;}html{opacity:0']) {
    const { html } = assembleHtml({ ...BASE, 'line-height': bad });
    assert.equal(/--line-height:/.test(injected(html)), false, `line-height ${bad}`);
    assert.equal(html.includes('opacity:0'), false);
  }
});

test('레이아웃 A·B·C 가 --title-maxh 를 읽는다 (배선 확인)', () => {
  // @AI:DEPENDS 이 상한이 폭을 결정한다 — 못 읽으면 인자를 줘도 글자가 안 커진다.
  for (const layout of ['A', 'B', 'C']) {
    const { html } = assembleHtml({ ...BASE, layout });
    assert.match(html, /getPropertyValue\("--title-maxh"\)/, `${layout}: 상한을 CSS 변수에서 안 읽는다`);
  }
});

test('넓적한 폰트 2종(jua·gasoek)이 등록돼 있다', () => {
  // 한글 제목 폰트가 세로로 서 있으면 짧은 카피가 폭을 못 채워 «얹은 글자»로 보인다.
  for (const [font, family] of [['jua', "'Jua'"], ['gasoek', "'Gasoek One'"]]) {
    const { html } = assembleHtml({ ...BASE, font });
    assert.ok(html.includes(`--font-family:${family}`), `${font} 미등록`);
  }
});
