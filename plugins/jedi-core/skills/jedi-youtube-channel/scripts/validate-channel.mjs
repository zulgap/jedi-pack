#!/usr/bin/env node
// 채널 정본 파일 결정론 검사 — 필수 6항목 + 기둥 개수 + 플레이스홀더 잔존.
// LLM 판단 0. 통과/불통과는 오직 파일 내용이 정한다.
//
// 사용:  node validate-channel.mjs "<채널파일 경로>"
//        node validate-channel.mjs --test      (자체 검증)
// 종료:  0 = PASS / 1 = FAIL

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const REQUIRED = ['channel', 'positioning', 'target', 'tone', 'pillars', 'forbidden'];
const MAX_PILLARS = 3;

/** frontmatter만 읽는 최소 파서 — 의존성 0. 스칼라와 `- ` 리스트만 다룬다. */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(strip(item[1]));
      continue;
    }
    const kv = raw.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = strip(kv[2]);
      out[key] = v === '' ? [] : v;   // 값이 없으면 리스트가 이어질 자리
    }
  }
  return out;
}

function strip(s) {
  const t = String(s).trim().replace(/\s+#.*$/, '').trim();
  return t.replace(/^["'](.*)["']$/, '$1').trim();
}

/** 값이 비었는가 — 빈 문자열·빈 배열·미치환 플레이스홀더(`<...>`)를 전부 '빈 것'으로 본다. */
function isBlank(v) {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0 || v.every(isBlank);
  const s = String(v).trim();
  return s === '' || /^<.*>$/.test(s);
}

export function validate(text) {
  const errors = [];
  const fm = parseFrontmatter(text);
  if (!fm) return { ok: false, errors: ['frontmatter(--- 블록)가 없습니다'] };

  for (const k of REQUIRED) {
    if (!(k in fm)) errors.push(`필수 항목 누락: ${k}`);
    else if (isBlank(fm[k])) errors.push(`필수 항목이 비었거나 양식 그대로입니다: ${k}`);
  }

  const pillars = fm.pillars;
  if (Array.isArray(pillars)) {
    if (pillars.length > MAX_PILLARS) {
      errors.push(`pillars ${pillars.length}개 — 최대 ${MAX_PILLARS}개 (넘기면 채널 정체성이 흐려진다)`);
    }
  } else if ('pillars' in fm && !isBlank(pillars)) {
    errors.push('pillars는 목록이어야 합니다 (- 항목으로 나열)');
  }

  if ('forbidden' in fm && !Array.isArray(fm.forbidden) && !isBlank(fm.forbidden)) {
    errors.push('forbidden은 목록이어야 합니다 (- 항목으로 나열)');
  }

  return { ok: errors.length === 0, errors, fields: fm };
}

// ───────────────────────────────── 자체 검증
const OK_FIXTURE = `---
channel: 테스트채널
positioning: 저는 A가 아닙니다. B입니다.
target: 0~1K 시작자 / 1K~10K 실전가 / 10K~100K 전문가
tone: 겪은 것만 말한다. 겁주지 않는다.
pillars:
  - 교두보
  - 차별 무기
  - 확장 엔진
forbidden:
  - 광폭 어휘 금지 — 타깃 밖 시청자가 와서 알고리즘이 오분류한다
---
본문`;

const CASES = [
  ['정상', OK_FIXTURE, true],
  ['필수 누락(positioning)', OK_FIXTURE.replace(/^positioning:.*$/m, ''), false],
  ['기둥 4개', OK_FIXTURE.replace('  - 확장 엔진', '  - 확장 엔진\n  - 넷째 기둥'), false],
  ['양식 그대로(플레이스홀더)', OK_FIXTURE.replace(/^tone:.*$/m, 'tone: <말투 + 하지 않는 말>'), false],
  ['frontmatter 없음', '# 제목만 있는 파일', false],
];

function selfTest() {
  let fail = 0;
  for (const [name, fixture, expected] of CASES) {
    const got = validate(fixture).ok;
    const pass = got === expected;
    if (!pass) fail++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} (기대 ${expected}, 실제 ${got})`);
  }
  console.log(fail === 0 ? `\n자체 검증 ${CASES.length}/${CASES.length} PASS` : `\n${fail}건 FAIL`);
  return fail === 0 ? 0 : 1;
}

// ───────────────────────────────── CLI
const arg = process.argv[2];
if (!arg) {
  console.error('사용: node validate-channel.mjs "<채널파일 경로>" | --test');
  process.exit(1);
}
if (arg === '--test') {
  process.exit(selfTest());
}

const path = arg.startsWith('~') ? arg.replace(/^~/, homedir()) : arg;
let text;
try {
  text = readFileSync(path, 'utf8');
} catch {
  console.error(`FAIL  파일을 열 수 없습니다: ${path}`);
  process.exit(1);
}

const r = validate(text);
if (r.ok) {
  console.log(`PASS  ${r.fields.channel} — 필수 6항목 충족 / 기둥 ${(r.fields.pillars || []).length}개`);
  process.exit(0);
}
console.error(`FAIL  ${path}`);
for (const e of r.errors) console.error(`  - ${e}`);
process.exit(1);
