#!/usr/bin/env node
// compose-thumbnail.mjs — 배경 URL + 확정 카피 → 레이아웃(A/B/C) 조립 → 백엔드 렌더 → 완성 썸네일 URL (팀원용, 의존성 0)
// 사용 예:
//   node compose-thumbnail.mjs --layout A \
//     --bg "<배경 image_url>" \
//     --title "월 500 노처녀들이|**상향혼**에 빠지는 과정"   (| = 줄바꿈, **강조** = 색)
//     --subtitle "33세 약사가 5년 만에 다시 상담받은 사연" \
//     --acc yellow --role 결혼전문가 --channel "<채널명>" \
//     --host "<진행자 얼굴 image_url>"        (레이아웃 A 우측 인물, 선택) \
//     --sub-size 52 --sub-gap 60             (서브카피 크기·제목과의 간격, px 정수, 선택) \
//     --quote "제발 저리가!!@22,14" --quote "!여우?@40,10"   (인물 위 말풍선, x,y=%, ! = 빨강)
//     --tag "20년차 매니저" --tag-style hand      (지목 라벨: hand=손글씨 / card=명함, 선택)
//       --tag-x 69 --tag-y 26 --tag-size 62 --tag-rot -4 --tag-color "#ffe08a"
//     --arrow-to 84,45 --arrow-from-x 72 --arrow-from-y 36 --arrow-bend -45   (라벨 → 대상 화살표)
//     --inset <투명PNG url> --inset-shape cut     (보조 인물: cut=누끼 / circle=원형 액자)
//       --inset-x 76 --inset-y 46 --inset-h 400 --inset-outline 0 --inset-tone "sepia(.26)"
//     --punch 1                                   (배경 채도·대비 보정 강도, 0=끔)
// 출력: 마지막 줄 = 완성 썸네일 image_url
//
// 왜 이 스크립트인가: 텍스트를 GPT 이미지 안에 그리면 한글이 깨진다.
// 배경만 AI로 만들고(ext_generate_image), 글자는 HTML/CSS로 픽셀 정확히 얹어(card-renderer) 렌더한다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(__dirname, '..', 'templates');
const BASE = process.env.JEDI_BASE_URL || 'https://judgmentos-unified-agent-production.up.railway.app';

const LAYOUTS = {
  A: { file: 'layout-A-bottom.html', width: 1280, height: 720 },
  B: { file: 'layout-B-split.html',  width: 1280, height: 720 },
  C: { file: 'layout-C-shorts.html', width: 1080, height: 1920 },
};
// 채널 강조색 클래스 (실측: 고객사 채널=빨강, 한방언니풍=노랑, 가연=핑크)
const ACC = { yellow: 'acc-yellow', red: 'acc-red', pink: 'acc-pink' };

// @AI:INTENT --font 후보 (전부 Google Fonts 무료). weight가 폰트마다 다른 게 핵심 —
//   Black Han Sans·Do Hyeon은 굵기가 400 하나뿐이라 900을 주면 브라우저가 가짜 굵기를 만들어 뭉갠다.
const FONTS = {
  noto:    { css: "'Noto Sans KR'",  weight: 900, url: 'Noto+Sans+KR:wght@400;700;900' }, // 현행 기본 — 본문용, 임팩트 약함
  black:   { css: "'Black Han Sans'", weight: 400, url: 'Black+Han+Sans' },               // 유튜브 썸네일 표준, 굵고 납작
  gothic:  { css: "'Gothic A1'",     weight: 900, url: 'Gothic+A1:wght@700;900' },        // Noto보다 각지고 힘 있음
  dohyeon: { css: "'Do Hyeon'",      weight: 400, url: 'Do+Hyeon' },                      // 둥글고 친근, 멘토 톤
};

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// --title "1줄|2줄" + **강조** → title_html (윗줄 흰 / 아랫줄 .l2, **x** → <em>x</em>)
function buildTitleHtml(raw) {
  const lines = String(raw).split(/\||\\n|\n/).map((s) => s.trim()).filter(Boolean);
  const mark = (l) => esc(l).replace(/\*\*(.+?)\*\*/g, '<em>$1</em>');
  if (!lines.length) return '';
  return mark(lines[0]) + lines.slice(1).map((l) => `<span class="l2">${mark(l)}</span>`).join('');
}

// --quote "텍스트@x,y" (x,y = % 좌표, 접두 ! = 빨강) → 절대배치 div
function buildQuotes(quoteArgs) {
  return (quoteArgs || []).map((q) => {
    const m = String(q).match(/^(!?)(.*)@(\d+),(\d+)$/);
    if (!m) return '';
    const [, red, text, x, y] = m;
    return `<div class="quote${red ? ' red' : ''}" style="left:${x}%;top:${y}%">${esc(text)}</div>`;
  }).join('');
}

// @AI:CONSTRAINT esc()는 style/src 같은 **속성 안**에 쓰기엔 부족하다 — 따옴표를 안 막아서
//   값 하나로 속성을 닫고 다른 속성을 끼워 넣을 수 있다. 새 코드는 전부 escAttr을 쓴다.
function escAttr(s) { return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

const numOr = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);

/**
 * 지목 세트 — 누끼/원형 인서트 + 화살표 + 손글씨(또는 명함) 라벨.
 *
 * @AI:INTENT 「이 사람이 누구인지」를 화면 안에서 가리킨다. 역할라벨(--role)은 우상단 괄호
 *   한 줄이라 **누구를** 가리키는지 못 나타낸다. 2026-08-27 진행자 채널 실작업에서 확정된 형태다.
 * @AI:CONSTRAINT 좌표는 전부 캔버스 대비 %다 — 레이아웃 C(1080×1920)에서도 같은 인자가 그대로 먹는다.
 * @AI:DEPENDS 그리는 순서 = 화살표 → 인서트 → 라벨. 화살촉이 인물 뒤로 들어가야 «가리키는» 것처럼 보인다.
 */
export function buildTagLayer(o, W, H) {
  if (!o.tag && !o.inset) return { layer: '', head: '' };

  const color = o['tag-color'] || '#ffe08a';
  const tx = numOr(o['tag-x'], 40);
  const ty = numOr(o['tag-y'], 8);
  const parts = [];

  // ── 화살표 (2차 베지어) — --arrow-to 가 있을 때만
  const at = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(String(o['arrow-to'] || ''));
  if (at) {
    const fx = (numOr(o['arrow-from-x'], tx + 8) / 100) * W;
    const fy = (numOr(o['arrow-from-y'], ty + 9) / 100) * H;
    const gx = (+at[1] / 100) * W;
    const gy = (+at[2] / 100) * H;
    // 시작·끝의 중점에서 법선 방향으로 bend 만큼 밀어 곡선을 만든다 (음수면 반대쪽으로 휜다)
    const dx = gx - fx, dy = gy - fy;
    const len = Math.hypot(dx, dy) || 1;
    const bend = numOr(o['arrow-bend'], 50);
    const cx = (fx + gx) / 2 + (-dy / len) * bend;
    const cy = (fy + gy) / 2 + (dx / len) * bend;
    // 화살촉 각도 = 제어점 → 끝점 방향의 접선
    const ang = Math.atan2(gy - cy, gx - cx);
    const head = 26;
    const hx1 = gx + Math.cos(ang + Math.PI - 0.42) * head;
    const hy1 = gy + Math.sin(ang + Math.PI - 0.42) * head;
    const hx2 = gx + Math.cos(ang + Math.PI + 0.42) * head;
    const hy2 = gy + Math.sin(ang + Math.PI + 0.42) * head;
    const n = (v) => v.toFixed(1);
    const curve = `M ${n(fx)} ${n(fy)} Q ${n(cx)} ${n(cy)} ${n(gx)} ${n(gy)}`;
    const tip = `M ${n(hx1)} ${n(hy1)} L ${n(gx)} ${n(gy)} L ${n(hx2)} ${n(hy2)}`;
    // 검은 밑선을 먼저 깔아 밝은 배경에서도 화살표가 사라지지 않게 한다
    parts.push(
      `<svg class="tag-arrow" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`
      + `<g fill="none" stroke="#0a0a0a" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity=".55">`
      + `<path d="${curve}"/><path d="${tip}"/></g>`
      + `<g fill="none" stroke="${escAttr(color)}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">`
      + `<path d="${curve}"/><path d="${tip}"/></g></svg>`,
    );
  }

  // ── 인서트
  if (o.inset) {
    const ix = numOr(o['inset-x'], 4);
    const iy = numOr(o['inset-y'], 5);
    if (String(o['inset-shape'] || 'cut').toLowerCase() === 'circle') {
      const d = numOr(o['inset-size'], 210);
      parts.push(
        `<div class="tag-inset-circle" style="left:${ix}%;top:${iy}%;width:${d}px;height:${d}px;`
        + `border:6px solid ${escAttr(color)};box-shadow:0 12px 32px rgba(0,0,0,.6),0 0 0 3px rgba(10,10,10,.45)">`
        + `<img src="${escAttr(o.inset)}" alt=""></div>`,
      );
    } else {
      const ih = numOr(o['inset-h'], 300);
      const rot = numOr(o['inset-rot'], 0);
      const ol = numOr(o['inset-outline'], 0);
      // @AI:INTENT 기본은 «자연스러운 합성»이다 — 실사 인물에 흰 테두리를 두르면 붙여넣은 티가 난다
      //   (2026-08-27 반려). 스티커 외곽선이 필요하면 --inset-outline 3 처럼 굵기를 준다.
      // @AI:DEPENDS border 로는 못 한다 — 투명 PNG 는 사각 박스에 테두리가 생긴다.
      //   filter 는 앞 결과에 다시 적용되므로 4방향 drop-shadow 를 쌓아 윤곽선을 만든다.
      const stroke = ol > 0
        ? `drop-shadow(${ol}px 0 0 #fff) drop-shadow(-${ol}px 0 0 #fff) `
          + `drop-shadow(0 ${ol}px 0 #fff) drop-shadow(0 -${ol}px 0 #fff) `
        : '';
      const tone = o['inset-tone'] ? `${escAttr(o['inset-tone'])} ` : '';
      parts.push(
        `<div class="tag-inset-cut" style="left:${ix}%;top:${iy}%;height:${ih}px;transform:rotate(${rot}deg)">`
        + `<img src="${escAttr(o.inset)}" alt="" `
        + `style="height:${ih}px;filter:${stroke}${tone}drop-shadow(0 18px 26px rgba(0,0,0,.55))"></div>`,
      );
    }
  }

  // ── 라벨
  let head = '';
  if (o.tag) {
    const size = numOr(o['tag-size'], 66);
    const rot = numOr(o['tag-rot'], -4);
    const isCard = String(o['tag-style'] || 'hand').toLowerCase() === 'card';
    const label = isCard
      ? `<div class="tag-card" style="border-left:9px solid ${escAttr(color)}">`
        + `<span class="tag-card-name" style="font-size:${Math.round(size * 0.62)}px">${esc(o.tag)}</span></div>`
      : `<div class="tag-hand" style="font-size:${size}px;color:${escAttr(color)};`
        + `-webkit-text-stroke:5px rgba(10,10,10,.8)">${esc(o.tag)}</div>`;
    parts.push(`<div class="tag-wrap" style="left:${tx}%;top:${ty}%;transform:rotate(${rot}deg)">${label}</div>`);
    // 손글씨일 때만 웹폰트를 받는다 — 명함형은 base CSS 의 Noto 를 그대로 쓴다
    if (!isCard) {
      head = '<link href="https://fonts.googleapis.com/css2?family=Nanum+Pen+Script&family=Gaegu:wght@700&display=swap" rel="stylesheet">';
    }
  }

  return { layer: parts.join('\n    '), head };
}

/** 레이아웃 HTML + 공유 base CSS 조립 → 완성 HTML 문자열 (테스트 하네스와 공유) */
export function assembleHtml(opts) {
  const L = LAYOUTS[opts.layout || 'A'];
  if (!L) throw new Error(`알 수 없는 레이아웃: ${opts.layout} (A/B/C만)`);
  const baseCss = fs.readFileSync(path.join(TEMPLATES, '_base.css'), 'utf8');
  let html = fs.readFileSync(path.join(TEMPLATES, L.file), 'utf8');

  const accClass = ACC[opts.acc] || ACC.yellow;
  const strokeVars = opts.stroke
    ? `<style>:root{--stroke:${opts.stroke}}</style>`
    : ''; // 프리셋이 외곽선 두께 덮을 때 (채널에 따라 얇게 4px, 한방언니풍=6px 기본)

  // @AI:INTENT --font 로 채널별 폰트 교체. 미지정 시 _base.css 기본값(Noto 900) 그대로 = 기존 동작 보존.
  //   weight가 폰트마다 다르다 — Black Han Sans·Do Hyeon은 단일 굵기(400)라 900을 주면 가짜 굵기가 된다.
  const f = FONTS[(opts.font || '').toLowerCase()];
  const fontVars = f
    ? `<link href="https://fonts.googleapis.com/css2?family=${f.url}&display=swap" rel="stylesheet">`
      + `<style>:root{--font-family:${f.css},sans-serif;--font-weight:${f.weight}}</style>`
    : '';

  // @AI:INTENT --sub-size(px) / --sub-gap(px) 로 서브카피 크기·간격을 값으로 지정. 미지정 시 기존 자동 계산 그대로.
  //   템플릿 JS가 서브의 font-size·bottom을 **인라인 style로 박기 때문에** 바깥 CSS로는 못 이긴다.
  //   그래서 CSS 변수로 넘기고 템플릿 JS가 그 값을 읽어 쓰게 한다.
  // @AI:CONSTRAINT 반드시 양의 정수로만 파싱한다 — 문자열을 그대로 보간하면 `:root{}` 밖으로 빠져나가는
  //   CSS 주입이 된다(실제로 --stroke 에 CSS를 끼워 넣어 서브 크기를 덮는 편법이 쓰이고 있었다, 2026-08-20).
  const px = (v) => (v !== undefined && /^\d+$/.test(String(v)) && +v > 0 ? `${+v}px` : null);
  const subSize = px(opts['sub-size']);
  const subGap = px(opts['sub-gap']);
  const subVars = (subSize || subGap)
    ? `<style>:root{${subSize ? `--sub-size:${subSize};` : ''}${subGap ? `--sub-gap:${subGap};` : ''}}</style>`
    : '';

  // @AI:INTENT --punch — 원본 사진 그대로면 피드에서 밋밋하다. 채도·대비만 살짝 올린다.
  // @AI:CONSTRAINT 기본은 0(끔)이다. 켜는 것을 기본값으로 하면 기존 썸네일이 전부 달라진다.
  //   1.0 을 넘기면 피부가 붉게 뜨므로 실무 권장 상한은 1.
  const punch = numOr(opts.punch, 0);
  const punchVars = punch > 0
    ? `<style>.bg{filter:saturate(${(1 + 0.12 * punch).toFixed(3)}) contrast(${(1 + 0.05 * punch).toFixed(3)})}</style>`
    : '';

  const tagSet = buildTagLayer(opts, L.width, L.height);

  html = html
    .replace('/* {{BASE_CSS}} */', baseCss)
    .replace(/\{\{ACC_CLASS\}\}/g, accClass)
    .replace(/\{\{background_url\}\}/g, esc(opts.bg || ''))
    .replace(/\{\{\{title_html\}\}\}/g, buildTitleHtml(opts.title))
    .replace(/\{\{QUOTES\}\}/g, buildQuotes(opts.quotes))
    // {{#if key}}...{{/if}} 블록 (host_url/subtitle/role/channel)
    .replace(/\{\{#if host_url\}\}([\s\S]*?)\{\{\/if\}\}/g, opts.host ? '$1' : '')
    .replace(/\{\{#if subtitle\}\}([\s\S]*?)\{\{\/if\}\}/g, opts.subtitle ? '$1' : '')
    .replace(/\{\{#if role\}\}([\s\S]*?)\{\{\/if\}\}/g, opts.role ? '$1' : '')
    .replace(/\{\{#if channel\}\}([\s\S]*?)\{\{\/if\}\}/g, opts.channel ? '$1' : '')
    .replace(/\{\{host_url\}\}/g, esc(opts.host || ''))
    .replace(/\{\{subtitle\}\}/g, esc(opts.subtitle || ''))
    .replace(/\{\{role\}\}/g, esc(opts.role || ''))
    .replace(/\{\{channel\}\}/g, esc(opts.channel || ''));

  // 외곽선 두께 + 폰트 + 서브카피 override 주입 (head 끝 — 기존 <link>/base CSS보다 뒤라 이게 이긴다)
  if (strokeVars || fontVars || subVars || punchVars || tagSet.head) {
    html = html.replace('</head>', `${tagSet.head}\n${fontVars}\n${strokeVars}\n${subVars}\n${punchVars}\n</head>`);
  }

  // @AI:DEPENDS .frame(흰 테두리)은 A/B/C 세 템플릿에 모두 있고 항상 맨 위에 그려진다.
  //   지목 세트를 그 **직전**에 넣어야 프레임 선 아래로 들어간다.
  if (tagSet.layer) {
    html = html.replace('<div class="frame"></div>', `${tagSet.layer}\n    <div class="frame"></div>`);
  }
  return { html, width: L.width, height: L.height };
}

// ---- CLI (팀원 실행 경로: 백엔드 /mcp/ext/render-thumbnail로 HTTP 렌더) ----
function parseArgs(argv) {
  const o = { quotes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quote') { o.quotes.push(argv[++i]); continue; }
    if (a.startsWith('--')) { o[a.slice(2)] = argv[++i]; }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.bg) fail('--bg <배경 image_url> 필수 (ext_generate_image로 먼저 배경 생성)');
  if (!o.title) fail('--title "확정 메인카피" 필수');
  o.layout = (o.layout || 'A').toUpperCase();

  let assembled;
  try { assembled = assembleHtml(o); } catch (e) { fail(e.message); }

  // 토큰 (upload-image.mjs와 동일 위치)
  let token = process.env.JUDGMENTOS_TOKEN || null;
  if (!token) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
      token = cfg?.mcpServers?.jedi?.env?.JUDGMENTOS_TOKEN || null;
    } catch (_) { /* 아래 안내 */ }
  }
  if (!token) fail('JEDI_TOKEN 없음 — ~/.claude.json의 jedi MCP 설정(JUDGMENTOS_TOKEN)이 필요합니다.');

  const res = await fetch(`${BASE}/mcp/ext/render-thumbnail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ html: assembled.html, width: assembled.width, height: assembled.height, format: 'png' }),
  }).catch((e) => fail(`네트워크 오류: ${e.message}`));

  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) fail('토큰 인증 실패 — 사장님께 확인');
  if (res.status === 404) fail('render-thumbnail 엔드포인트 없음 — 백엔드 배포 미완. 사장님/개발자에게 문의.');
  if (!res.ok || !body?.success || !body?.data?.image_url) fail(`렌더 실패 (HTTP ${res.status}): ${body?.error || '알 수 없음'}`);

  console.error(`✅ 썸네일 완성 — 레이아웃 ${o.layout}, ${assembled.width}×${assembled.height}`);
  console.log(body.data.image_url);
}

// CLI로 실행될 때만 main (import 시엔 assembleHtml만 노출)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
