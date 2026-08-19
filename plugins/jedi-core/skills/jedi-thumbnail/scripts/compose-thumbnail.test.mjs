// compose-thumbnail.mjs 단위 테스트
// @AI:INTENT 2026-07-30까지 이 파일은 **무검증**이었다 — 테스트 53개는 전부 A/B 실험 스크립트용이고
//   실제 썸네일을 만드는 코드에는 테스트가 0건이었다(전수검수 D6). 같은 날 FONTS 맵·--font·fontVars를
//   크게 고쳤으므로 회귀 가드를 세운다.
// 순수 함수 assembleHtml만 검증한다(네트워크·토큰 불필요).

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
