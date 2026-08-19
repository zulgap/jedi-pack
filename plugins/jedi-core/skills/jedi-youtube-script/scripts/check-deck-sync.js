#!/usr/bin/env node
// check-deck-sync.js — 슬라이드가 «지금 대본» 을 담고 있는지, 그리고 «실물 증거» 가 들어갔는지 잰다.
//
// 쓰는 법
//   node check-deck-sync.js <대본.md> <슬라이드.html> [--min-shots 1] [--max-textonly 0.7]
//
// 재는 것 둘
//   ① 낭독 동기화 — 슬라이드 data-script(프롬퍼터가 읽는 원고)가 대본과 어긋나지 않았는가
//   ② 시각물     — 실제 화면 캡처가 한 장이라도 들어갔는가 / 글자만인 장이 너무 많지 않은가
//
// @AI:INTENT 2026-08-17 실사고 두 건이 이 스크립트의 존재 이유다.
//   ① 대본에서 여섯 곳을 고치고 CTA 를 지웠는데 «슬라이드는 그대로» 였다. 프롬퍼터는 대본 파일이
//      아니라 data-script 를 읽으므로, 그대로 찍었으면 지운 CTA 를 낭독하고 옛 낱말을 말하게 된다.
//      화면상으로는 아무 이상이 없어서 눈으로는 절대 안 걸린다.
//   ② 시각물 위계 규정은 SKILL.md 에 있었는데 1편 35장에 실제 캡처가 «0장» 이었다.
//      원칙만 있고 «세는 사람» 이 없으면 그 원칙은 지켜지지 않는다.
// @AI:CONSTRAINT LLM 0 — 문자열 대조와 개수 세기뿐이다. 「비슷하니 넘어가자」 류의 판단을 넣지 말 것.

'use strict';

const fs = require('fs');

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--') && !isVal(a));
const VAL_OPTS = new Set(['min-shots', 'max-textonly', 'head']);
function isVal(a) {
  const i = argv.indexOf(a);
  return i > 0 && argv[i - 1].startsWith('--') && VAL_OPTS.has(argv[i - 1].slice(2));
}
function opt(n, d) {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
}

const MD = files.find((f) => /\.md$/i.test(f));
const HTML = files.find((f) => /\.html?$/i.test(f));
const MIN_SHOTS = Number(opt('min-shots', 1));
const MAX_TEXTONLY = Number(opt('max-textonly', 0.7));
const HEAD = Number(opt('head', 25)); // 문장 앞 몇 글자로 대조할지

if (!MD || !HTML) {
  console.error('쓰는 법: node check-deck-sync.js <대본.md> <슬라이드.html> [--min-shots 1] [--max-textonly 0.7]');
  process.exit(2);
}
for (const f of [MD, HTML]) if (!fs.existsSync(f)) { console.error('[파일 없음] ' + f); process.exit(2); }

const md = fs.readFileSync(MD, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');

// ── 정규화: 대본은 마크다운, data-script 는 평문이라 그대로 비교하면 전부 어긋난 것처럼 나온다.
//    «표기» 차이는 지우고 «낱말» 차이만 남긴다.
function norm(s) {
  return s
    .replace(/\[출처[^\]]*\]/g, ' ')          // [출처: …] 는 화면 자막용이라 낭독에 없다
    .replace(/`[^`]*`/g, ' ')
    .replace(/[*_~]/g, '')                     // 볼드·이탤릭
    // @AI:FRAGILE 따옴표는 대본(마크다운)과 data-script(HTML 속성) 에서 «반드시» 달라진다 —
    //   속성 안에는 큰따옴표를 못 쓰므로 작은따옴표로 바꿔 적기 때문이다. 이걸 안 지우면
    //   멀쩡한 문장 절반이 「어긋났다」로 잡히고, 그러면 사람이 이 게이트를 안 믿게 된다.
    .replace(/[「」『』«»“”‘’"'`]/g, '')
    .replace(/[.,!?·—–\-…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 대본에서 «낭독되는» 줄만 남긴다(인용블록·헤딩·체크리스트·표는 지시문이라 낭독 대상이 아니다)
const spokenMd = norm(
  md.split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      // @AI:FRAGILE 인용블록(>)을 통째로 빼면 «결론 세 문장» 처럼 실제로 낭독하는 것까지 빠져
      //   멀쩡한 원고가 「어긋났다」로 잡힌다(오탐). 지시 표지가 붙은 것만 뺀다.
      if (t.startsWith('>')) {
        const inner = t.replace(/^>+\s*/, '');
        if (!inner) return false;
        return !/🔴|⚠️|🔑|🎙|📐|촬영|금지|말 것|하지 마|하지 말|CTA|주의|규칙|확정|개정|삭제됨|되살리지|출처 표기|시그니처|클로징 시그/.test(inner);
      }
      // 헤딩도 소제목은 낭독한다(«### 그런데 하나가 남았습니다» 류). 구간 표시만 뺀다.
      if (t.startsWith('#')) return !/[①②③④⑤⑥⑦⑧⑨]|\d+\s*[~-]\s*\d+\s*분|^#{1,2}\s/.test(t);
      if (t.startsWith('|')) return false;      // 표
      if (/^-\s*\[[ x]\]/.test(t)) return false; // 체크리스트
      if (/^(---|\*\*\*)$/.test(t)) return false;
      return true;
    })
    .join(' ')
);

// ── 슬라이드에서 낭독 원고(data-script)를 꺼낸다
const scripts = [...html.matchAll(/data-script="([^"]*)"/g)].map((m) => m[1]);
const sentences = [];
scripts.forEach((s, si) => {
  s.split('|').forEach((one) => {
    const t = norm(one.replace(/&quot;/g, '').replace(/&amp;/g, '&'));
    if (t.length >= 12) sentences.push({ slide: si + 1, text: t });
  });
});

const missing = sentences.filter((s) => !spokenMd.includes(s.text.slice(0, HEAD)));

// @AI:INTENT 낭독 원고는 숫자를 «한글로» 적는 것이 정상이다(31% → 서른한 퍼센트). 대본은 숫자로
//   적으므로 이 둘은 «반드시» 어긋나 보인다. 이걸 실패로 세면 매번 걸려서 사람이 게이트를 무시하게
//   된다. 그래서 숫자·수사가 든 문장은 «확인 대상» 으로 갈라 두고, 실패는 나머지만 센다.
const NUMISH = /[0-9]|퍼센트|포인트|하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|스물|서른|마흔|쉰|예순|일흔|여든|아흔/;
const hardMiss = missing.filter((s) => !NUMISH.test(s.text));
const softMiss = missing.filter((s) => NUMISH.test(s.text));

// ── 시각물 세기
const slides = html.split(/<section[^>]*class="slide"/i).slice(1);
let shots = 0, svgs = 0, textOnly = 0;
slides.forEach((raw) => {
  const body = raw.split(/<\/section>/i)[0].replace(/<!--[\s\S]*?-->/g, '');
  const hasImg = /<img\s/i.test(body);
  const hasSvg = /<svg\s/i.test(body);
  if (hasImg) shots++;
  if (hasSvg) svgs++;
  if (!hasImg && !hasSvg) textOnly++;
});
const textOnlyRatio = slides.length ? textOnly / slides.length : 0;

// ── 이미지 파일이 실제로 있는지 (경로가 어긋나면 촬영 때 빈칸이 된다)
const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const path = require('path');
const base = path.dirname(HTML);
const brokenSrc = srcs.filter((s) => !/^https?:/i.test(s) && !fs.existsSync(path.resolve(base, s)));

// ─────────────────────────────────────────── 출력

const fails = [];
console.log('');
console.log('  덱 동기화 — 슬라이드가 «지금 대본» 을 담고 있나');
console.log('  ' + '─'.repeat(60));
console.log(`  슬라이드 ${slides.length}장 · 낭독 문장 ${sentences.length}개`);
console.log('');

if (!sentences.length) {
  console.log('  ⚠️  data-script 가 하나도 없다 — 프롬퍼터가 읽을 원고가 슬라이드에 없다');
} else if (missing.length === 0) {
  console.log('  ✅ 낭독 원고가 대본과 일치한다 (어긋난 문장 0개)');
} else {
  if (hardMiss.length) {
    console.log(`  🔴 대본에 없는 낭독 문장 ${hardMiss.length}개 — 슬라이드가 «옛 대본» 을 갖고 있다`);
    hardMiss.slice(0, 10).forEach((m) => console.log(`     ${m.slide}장: ${m.text.slice(0, 52)}…`));
    if (hardMiss.length > 10) console.log(`     … 외 ${hardMiss.length - 10}개`);
    console.log('     → 대본을 고쳤으면 data-script 도 같이 고쳐야 한다. 프롬퍼터는 «이쪽» 을 읽는다');
    fails.push(`낭독 원고 ${hardMiss.length}개가 대본과 어긋남`);
  } else {
    console.log('  ✅ 낭독 원고에 «내용» 이 어긋난 문장은 없다');
  }
  if (softMiss.length) {
    console.log(`  ⚠️  숫자 표기가 다른 문장 ${softMiss.length}개 (통과지만 눈으로 확인)`);
    softMiss.slice(0, 5).forEach((m) => console.log(`     ${m.slide}장: ${m.text.slice(0, 48)}…`));
    console.log('     → 낭독 원고가 숫자를 한글로 적으면 대본(숫자)과 달라 보인다. 대개 정상이다');
  }
}

console.log('');
console.log(`  시각물 — 실제 캡처 ${shots}장 · 도식 ${svgs}장 · 글자만 ${textOnly}장 (${Math.round(textOnlyRatio * 100)}%)`);
if (shots < MIN_SHOTS) {
  console.log(`  🔴 실제 화면 캡처가 ${shots}장 — 최소 ${MIN_SHOTS}장은 있어야 한다`);
  console.log('     → 화면녹화 채널에서 가장 센 증거는 «실제 화면» 이다. 텍스트 슬라이드로 채우지 않는다');
  fails.push(`실제 캡처 ${shots}장 (최소 ${MIN_SHOTS})`);
} else {
  console.log(`  ✅ 실제 화면 캡처 ${shots}장`);
}
if (textOnlyRatio > MAX_TEXTONLY) {
  console.log(`  ⚠️  글자만인 장이 ${Math.round(textOnlyRatio * 100)}% — 기준 ${Math.round(MAX_TEXTONLY * 100)}% 초과 (통과지만 확인 대상)`);
}

if (brokenSrc.length) {
  console.log('');
  console.log(`  🔴 이미지 파일이 없다 ${brokenSrc.length}개 — 촬영 때 빈칸으로 찍힌다`);
  brokenSrc.forEach((s) => console.log('     · ' + s));
  fails.push(`이미지 경로 ${brokenSrc.length}개 깨짐`);
}

console.log('');
if (fails.length) {
  console.log('  판정: 실패 ' + fails.length + '건');
  fails.forEach((f) => console.log('    · ' + f));
  console.log('');
  process.exit(1);
}
console.log('  판정: 통과');
console.log('');
process.exit(0);
