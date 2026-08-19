#!/usr/bin/env node
// compose-thumbnail.mjs — 배경 URL + 확정 카피 → 레이아웃(A/B/C) 조립 → 백엔드 렌더 → 완성 썸네일 URL (팀원용, 의존성 0)
// 사용 예:
//   node compose-thumbnail.mjs --layout A \
//     --bg "<배경 image_url>" \
//     --title "월 500 노처녀들이|**상향혼**에 빠지는 과정"   (| = 줄바꿈, **강조** = 색)
//     --subtitle "33세 약사가 5년 만에 다시 상담받은 사연" \
//     --acc yellow --role 결혼전문가 --channel "<채널명>" \
//     --host "<진행자 얼굴 image_url>"        (레이아웃 A 우측 인물, 선택) \
//     --quote "제발 저리가!!@22,14" --quote "!여우?@40,10"   (인물 위 말풍선, x,y=%, ! = 빨강)
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

  // 외곽선 두께 + 폰트 override 주입 (head 끝 — 기존 <link>/base CSS보다 뒤라 이게 이긴다)
  if (strokeVars || fontVars) html = html.replace('</head>', `${fontVars}\n${strokeVars}\n</head>`);
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
