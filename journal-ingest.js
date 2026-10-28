#!/usr/bin/env node
// @AI:INTENT 팀 세션 저널 1행을 제디 백엔드에 벡터 인덱싱 → 나중에 검색·회상으로 찾을 수 있게 한다.
//   노션에만 쌓으면 검색 0이다. 이 호출이 있어야 `recall_prompts(source='journal')`와
//   컨텍스트 로더가 그 기록을 찾는다.
//   spec: ~/.claude/specs/2026-07-29-teampack-identity-ssot-and-journal-backfill.md PR-4
//
// 사용:
//   node journal-ingest.js "<notion_page_id 대시 UUID>" "<세션 제목>" "<한줄 요약>"          ← 노션 회사 (종전 그대로)
//   node journal-ingest.js "<page_id>" "<제목>" "<한줄 요약>" --body-file <5단락 본문.md>      ← 본문까지
//   node journal-ingest.js new "<제목>" "<한줄 요약>" --body-file <본문.md> --no-notion          ← 노션 없는 회사
//   … --whys-file <why.json>  「왜」 번호+구절(collect-prompts.js --why-pick 이 만든 파일 · 선택)
//   … --object <객체 uuid> [--object-alias "<본문 속 이름>"]  이 저널의 대상 객체(선택 · 2026-10-06)
//   … --object-none "<이유 한 줄>"  묶을 대상이 정말 없다고 사람이 정했다(2026-10-15 · 판단OS #4818)
//   … --project <섹션 uuid> [--scope <관리번호 uuid>]  어느 섹션·관리번호 일인가(선택 · 2026-10-10)
//   … --nature dev|partner|scm|brand|client|other  이 일의 성격(2026-10-17 · 판단OS #4929) — 브랜드 이름보다 먼저 정한다
//   … --dry-run   보내지 않고 조립 결과만 찍는다(네트워크·토큰 0)
//
// ── 대상 관문 (2026-10-15 · 사장님 「네」) ──
// @AI:CONSTRAINT 🔴 `--object <id>` 도 `--object-none "<이유>"` 도 없으면 보내지 않고 exit 3 (--dry-run 예외).
//   실측(대표 /저장 10/6~10/15): 저장 238번 중 대상을 고른 것 21번(9%) — 안 고르면 서버 매처가 낱말로 추측해
//   엉뚱한 대상에 붙였다(고객사 A 채널 작업 → 고객사 B). 「건너뜀」과 「진짜 없음」을 가르려고 이유를 값으로 받는다.
// @AI:DEPENDS 🔴 관문은 «이 규칙을 아는 jedi-save 가 설치된 PC» 에서만 막는다(objectGateActive). 이 파일은 서버 /pack 으로
//   main 머지 즉시 고객 PC 에도 가지만, 고객의 jedi-save 문구는 jedi-pack(별도 배포 · 사장님 결정)에서 온다 →
//   옛 문구만 있는 PC 에서 막으면 저장이 영문 모르게 멈춘다. 그 PC 는 경고 한 줄만 하고 종전대로 보낸다.
//
// ── 일의 성격 관문 (2026-10-17 · 판단OS #4929) ──
// @AI:CONSTRAINT 🔴 `--nature` 가 없으면 보내지 않고 exit 3 (--dry-run 예외) — 사장님 「캠핑오너스이긴 하지만 개발인 경우도 있고
//   파트너인 경우도 있고 SCM인 경우도 있고 이런 거 다 구분해야 됩니다」. 창고 알림 세션이 제목의 브랜드 이름만 보고 브랜드 칸에 들어갔다.
//   값이 6개 중 하나가 아니면 관문이 꺼진 PC 에서도 멈춘다(새 문구를 쓰다 틀린 것이므로).
// @AI:DEPENDS 판정은 서버 한 벌(unified-agent/shared/journal-nature.js) — 여기서 성격과 섹션이 맞는지 다시 판정하지 않는다.
//   서버가 고른 섹션 종류와 안 맞으면 HTTP 422 {error, hint} → 저장 안 됨 · exit 3. 같은 회사 안에서 칸을 바꿔 다시 보내면
//   응답 refile.refiled 에 함께 옮겨진 행 수가 온다 — 0 이거나 error 면 「옮겼다」고 말하지 않는다.
// @AI:DEPENDS 대상 관문과 같은 이유로 «이 규칙을 아는 jedi-save/wrapup-dev 가 설치된 PC» 에서만 막는다(표식 '--nature').
//
// ── 맥락 계층 (2026-10-06 · 판단OS #4331 · #4335 의 팀팩 쪽) ──
// @AI:INTENT session_uuid — Claude Code 가 주는 CLAUDE_CODE_SESSION_ID 를 함께 보낸다. 서버가 이 세션의 사람 발화와
//   «핵심 결정» 줄의 인용을 글자 대조해, 원문 인용이 없는 줄에 [AI 제안] · 맞지 않는 인용에 [원문 미확인] 꼬리표를 붙인다.
//   AI 의견이 «확정»으로 적혀 다음 세션이 그대로 따르는 길을 끊는다. 없으면 서버는 표식 없이 종전 그대로.
// @AI:INTENT --object — 판단이 맞는 대상(고객사·상품)에 묶여야 «같은 대상 안의 최신순»이 돈다. 서버가 같은 회사 칸
//   객체인지 확인하고 묶는다(아니면 무시). 별칭은 본문에 낱말로 나온 이름만 그 객체에 쌓인다.
//
// ── 노션 없는 회사 (2026-09-30 · spec 2026-09-30-journal-server-save-why.md S2·S3) ──
// 노션을 안 쓰는 회사는 이 호출이 **저널 저장 그 자체**다(서버 → 미니앱에서 본다).
//   · page_id 자리에 `new` → 새 UUID 를 만들고 `source_id=<uuid>` 로 찍는다. 🔴 재시도는 그 uuid 로 —
//     `new` 로 다시 부르면 같은 저널이 두 행이 된다(서버 멱등 키 = source_id).
//   · `--no-notion` → 실패하면 종료코드 1 + 「저장 안 됐다」를 크게 말한다(노션 사본이 없으므로).
//
// @AI:TENANT 🔐 tenant는 **토큰에서만** 파생된다(서버 `req._mcpAuth.actor`). 클라이언트가 지정할 수 없다.
//   → 팀원 토큰으로 부르면 그 회사 tenant에 적재되고, 그 회사 사람만 검색된다.
//
// @AI:INTENT 작성자 귀속은 **서버가 결정론으로** 한다 — 토큰 actor → `person_actor` 링크 → `person_id`.
//   이름 문자열 매칭은 하지 않는다(Migration 441 @AI:CONSTRAINT). 즉 이 스크립트는 "누구"를 보내지 않는다.
//
// @AI:CONSTRAINT 노션 회사 경로(--no-notion 없음)는 실패해도 종료코드 0 — 저널은 이미 노션에 있고,
//   인덱싱 실패가 스킬 진행을 막아선 안 된다. 다만 **조용히 넘기지 않고** stdout 에 남긴다.
// @AI:CONSTRAINT 🔴 3인자 호출(본문 없음)의 source_id·title·text 는 옛 판과 **바이트 동일**해야 한다 —
//   서버의 「content 같으면 재임베딩 skip」 멱등이 이것에 기대고, 이미 적재된 저널이 재임베딩되지 않는다.
//   그래서 본문 조립은 --body-file 이 있을 때만 한다(검사: scripts/_test-journal-ingest.js).
//   session_uuid 는 그 뒤에 «키만» 붙는다 — 서버 멱등 키(content_text = 제목+text)에 들어가지 않는다.
//   세션 번호가 없으면(옛 Claude Code·검사) 전송 문자열 전체가 옛 판과 바이트 동일.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// @AI:DEPENDS 서버 shared/journal-content.js CONTENT_CAP — 서버가 `title + "\n" + text` 를 이 길이에서
//   조용히 자른다. 값이 갈리면 「안 잘렸다고 보고했는데 잘리는」 침묵이 생긴다.
const CONTENT_CAP = 8000;
// 「어디서 이어받나」를 담는 섹션. 5단락의 마지막이라 그냥 이어붙이면 가장 먼저 잘린다.
const PRIORITY_HEADING_RE = /^##\s*.*(미해결|다음|잔여)/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS_WITH_VALUE = new Set(['--body-file', '--whys-file', '--object', '--object-alias', '--object-none', '--project', '--scope', '--nature', '--business']);
// 🔴 아는 플래그만 플래그로 본다 — 「--」로 시작하는 요약 문장도 옛 판처럼 위치 인자로 남아야 바이트 동일이다.
const KNOWN_FLAGS = new Set(['--body-file', '--no-notion', '--dry-run', '--whys-file', '--object', '--object-alias', '--object-none', '--project', '--scope', '--nature', '--business', '--folder-ok']);
// @AI:DEPENDS 서버 shared/journal-nature.js 의 성격 6개 — 서버가 받는 값과 같아야 한다(판단OS #4929)
const NATURE_KEYS = ['dev', 'partner', 'scm', 'brand', 'client', 'other'];
// 누구의 사업 이름표 — 모양만 본다. 어떤 이름표가 있는지는 서버 한 곳이 정한다(모르는 값이면 422 business_invalid 로 멈춘다).
// @AI:CONSTRAINT 회사 이름표 목록을 여기 적지 않는다 — 이 파일은 모든 고객 PC 에 깔린다(회사 고유값 금지).
const BUSINESS_RE = /^[a-z][a-z0-9-]{1,30}$/;
const NATURE_GUIDE = [
  '  브랜드 이름이 아니라 이 일이 «실제로 무엇이었나»로 고르세요:',
  '    --nature dev      판단OS·고객 서비스 프로그램을 만들거나 고침 → 「… 개발」 섹션',
  '    --nature partner  창고·포워딩·관세사와 주고받는 일 → 그 파트너 섹션',
  '    --nature scm      발주·입고·재고·수입 원가 → 파트너·물류 섹션',
  '    --nature brand    광고·상세페이지·카피·가격·리뷰 → 그 브랜드 섹션',
  '    --nature client   고객사 대행·마케팅 → 그 고객 섹션',
  '    --nature other    재무·영업·지원사업 등 그 밖',
];
// @AI:DEPENDS 서버 server.js /mcp/ext/journal-ingest object_alias .slice(0, 40) — 넘으면 서버가 잘라 «본문에 없는 이름»이 된다
const MAX_OBJECT_ALIAS = 40;
// @AI:DEPENDS 서버 /mcp/ext/journal-ingest object_none_reason ≤200자(판단OS #4818)
const MAX_OBJECT_NONE_REASON = 200;
const GATE_EXIT = 3;
// 관문을 켜는 표식 — 설치된 jedi-save / wrapup-dev 문구에 이 낱말이 있으면 «규칙을 아는 PC»다.
const GATE_MARKER = '--object-none';
const NATURE_GATE_MARKER = '--nature';
const GATE_SKILLS = [['jedi-core@', 'jedi-save'], ['dev-pack@', 'wrapup-dev']];

/**
 * 대상 관문 문구 — 통과면 null. 순수 함수(검사용).
 * --object 또는 --object-none 이 있거나 --dry-run 이면 통과.
 */
function objectGateMessage(argv) {
  if (argv.includes('--object') || argv.includes('--object-none') || argv.includes('--dry-run')) return null;
  return [
    'journal-ingest: 🔴 대상(이름표) 단계를 건너뛰었습니다 — 저장하지 않고 멈춥니다.',
    '  1) 찾기: search_business_objects{keyword:"<고객사·상품·브랜드 이름>"}  (별칭도 찾아짐)',
    '  2) 있으면: 같은 명령 끝에 --object <id> --object-alias "<본문 속 이름>"',
    '  3) 묶을 대상이 정말 없으면: --object-none "<이유 한 줄>" (예: "회사 내부 일" · "이름표 없음: <이름>")',
  ];
}

/**
 * 일의 성격 관문 문구 — 통과면 null. 순수 함수(검사용). --nature 가 있거나 --dry-run 이면 통과
 * (값이 맞는지는 buildRequest 가 본다).
 */
function natureGateMessage(argv) {
  if (argv.includes('--nature') || argv.includes('--dry-run')) return null;
  return ['journal-ingest: 🔴 일의 성격 단계를 건너뛰었습니다 — 저장하지 않고 멈춥니다.', ...NATURE_GUIDE];
}

/**
 * 이 PC 에 «대상 규칙을 아는» jedi-save(또는 wrapup-dev)가 설치돼 있나. 설치 장부(installed_plugins.json)의
 * 설치 폴더에서 스킬 문구를 읽어 표식을 찾는다. 못 읽으면 false(= 막지 않음 — 위 @AI:DEPENDS).
 * env JOURNAL_OBJECT_GATE=on|off 가 있으면 그 값(검사·비상 끄기용).
 */
function objectGateActive(deps = {}) {
  return skillGateActive(deps, GATE_MARKER, 'JOURNAL_OBJECT_GATE');
}

/** 일의 성격 관문 켜짐 — 설치된 jedi-save/wrapup-dev 문구에 '--nature' 가 있을 때만. env JOURNAL_NATURE_GATE=on|off. */
function natureGateActive(deps = {}) {
  return skillGateActive(deps, NATURE_GATE_MARKER, 'JOURNAL_NATURE_GATE');
}

function skillGateActive(deps, marker, envKey) {
  const env = deps.env || process.env;
  const forced = String(env[envKey] || '').toLowerCase();
  if (forced === 'on') return true;
  if (forced === 'off') return false;
  const home = deps.home || os.homedir();
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  try {
    const reg = JSON.parse(readFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json')));
    const plugins = (reg && reg.plugins) || {};
    for (const [key, entries] of Object.entries(plugins)) {
      const hit = GATE_SKILLS.find(([prefix]) => key.startsWith(prefix));
      if (!hit) continue;
      for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || !e.installPath) continue;
        try {
          if (readFile(path.join(e.installPath, 'skills', hit[1], 'SKILL.md')).includes(marker)) return true;
        } catch (_) { /* 다음 설치본 */ }
      }
    }
  } catch (_) { /* 장부 없음 → 막지 않음 */ }
  return false;
}

/**
 * 5단락 본문을 «미해결·다음 먼저» 순서로 재배열한다. 결정론 — LLM 0.
 * 헤딩(`## `)이 없거나 해당 섹션이 없으면 원문 그대로.
 */
function hoistPrioritySection(body) {
  const lines = String(body || '').split('\n');
  const heads = [];
  lines.forEach((l, i) => { if (/^##\s+/.test(l)) heads.push(i); });
  const target = heads.find((i) => PRIORITY_HEADING_RE.test(lines[i]));
  if (target === undefined) return { hoisted: '', rest: String(body || '').trim() };
  const nextIdx = heads.find((i) => i > target);
  const end = nextIdx === undefined ? lines.length : nextIdx;
  return {
    hoisted: lines.slice(target, end).join('\n').trim(),
    rest: [...lines.slice(0, target), ...lines.slice(end)].join('\n').trim(),
  };
}

/**
 * 인자 → 보낼 요청. 순수 함수(파일 읽기·UUID 는 주입) — 검사가 네트워크 없이 조립 결과를 대조한다.
 * @returns {{ok:true, sourceId, title, text, body, noNotion, dryRun, generated, projectedLength, willTruncate, hoistedLength, payload}
 *          | {ok:false, usage?:true, error:string}}
 */
function buildRequest(argv, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const newId = deps.newId || (() => crypto.randomUUID());
  const sessionId = deps.sessionId !== undefined ? deps.sessionId : (process.env.CLAUDE_CODE_SESSION_ID || '');

  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (KNOWN_FLAGS.has(a)) {
      if (FLAGS_WITH_VALUE.has(a)) {
        const v = argv[i + 1];
        // 🔴 값 없이 플래그만 오면 멈춘다 — 조용히 무시하면 「묶였다」고 믿는다
        if (!v || v.startsWith('--')) {
          if (a === '--object-none') return { ok: false, error: '--object-none 뒤에 이유가 없습니다(예: "회사 내부 일" · "이름표 없음: <이름>")' };
          if (a === '--nature') {
            if (argv.includes('--dry-run')) { flags[a] = ''; continue; }
            return { ok: false, gate: true, error: ['--nature 뒤에 일의 성격이 없습니다 — 저장하지 않고 멈춥니다.', ...NATURE_GUIDE].join('\n') };
          }
          return { ok: false, error: `${a} 뒤에 ${a.startsWith('--object') ? '값' : '경로'}이 없습니다` };
        }
        flags[a] = v; i++;
      } else {
        flags[a] = true;
      }
    } else {
      positional.push(a);
    }
  }
  let [sourceId, title, summary] = positional;
  if (!sourceId || !title) return { ok: false, usage: true, error: 'usage' };

  const noNotion = !!flags['--no-notion'];
  const dryRun = !!flags['--dry-run'];
  let generated = false;
  if (sourceId === 'new') { sourceId = newId(); generated = true; }
  // 노션 회사 경로는 종전처럼 검증하지 않는다(동작 변화 0). 노션 없는 회사는 이 번호가 저널의 유일한
  // 신원이라 형식이 틀리면 보내기 전에 멈춘다.
  if (noNotion && !UUID_RE.test(sourceId)) {
    return { ok: false, error: `source_id 가 UUID 형식이 아닙니다: ${sourceId} (새로 저장하려면 new)` };
  }

  let text;
  let body = '';
  let hoistedLength = 0;
  if (flags['--body-file']) {
    // 🔴 경로를 줬는데 못 읽으면 «본문 없음»으로 조용히 진행하지 않는다 — fail-closed.
    try { body = readFile(flags['--body-file']); }
    catch (e) { return { ok: false, error: `--body-file 읽기 실패: ${flags['--body-file']} (${e.message})` }; }
    const { hoisted, rest } = hoistPrioritySection(body);
    hoistedLength = hoisted.length;
    // 우선순위: ①한줄요약 ②미해결·다음 ③나머지 섹션(원래 순서) — 잘려도 앞 둘은 남는다.
    text = [summary || '', hoisted, rest].filter((p) => p && p.trim()).join('\n\n');
  } else {
    text = summary || ''; // 🔴 옛 3인자 — 바이트 동일(위 @AI:CONSTRAINT)
  }

  // ── 「왜」 (2026-09-30 · 저널 「왜」 v3.1) — collect-prompts.js --why-pick 이 만든 파일 ──
  // @AI:INTENT 사람이 이유를 댄 말의 «번호 + 구절»만 보낸다. 원문은 서버가 자기 사본(대화 원장)에서 꺼내 대조한다.
  // @AI:CONSTRAINT 🔴 파일이 없거나 깨졌으면 「왜」만 빼고 저널은 그대로 보낸다 — 「왜」 하나 때문에 저널 저장을 막지 않는다.
  //   파일이 없으면 payload 에 whys 키 자체를 안 넣는다(옛 호출 바이트 동일 · 위 @AI:CONSTRAINT).
  let whys = null;
  let whysWarning = '';
  if (flags['--whys-file']) {
    try {
      const arr = JSON.parse(readFile(flags['--whys-file']));
      const clean = (Array.isArray(arr) ? arr : [])
        .filter((w) => w && UUID_RE.test(String(w.turn_uuid || '')) && typeof w.reason_quote === 'string' && w.reason_quote.trim())
        .slice(0, 3)
        // source:"ai_proposal" — 「좋아요」로 승인한 AI 제안(서버가 직전 AI 답 사본으로 대조 → «AI 제안 → 사람 승인»). 그 외 값은 버린다.
        .map((w) => ({ turn_uuid: String(w.turn_uuid).toLowerCase(), reason_quote: w.reason_quote.trim(), ...(w.source === 'ai_proposal' ? { source: 'ai_proposal' } : {}) }));
      if (clean.length) whys = clean;
    } catch (e) {
      whysWarning = `--whys-file 읽기 실패 — 「왜」 없이 저널만 보냅니다 (${e.message})`;
    }
  }

  // ── 대상 객체 (선택) — 서버가 같은 회사 칸 객체인지 확인한다. 여기서는 모양만 본다(fail-closed)
  let objectId = null;
  let objectAlias = null;
  if (flags['--object']) {
    if (!UUID_RE.test(flags['--object'])) return { ok: false, error: `--object 값이 객체 번호(uuid) 형식이 아닙니다: ${flags['--object']}` };
    objectId = flags['--object'].toLowerCase();
  }
  if (flags['--object-alias']) {
    if (!objectId) return { ok: false, error: '--object-alias 는 --object 와 함께만 씁니다' };
    objectAlias = flags['--object-alias'].trim();
    if (objectAlias.length > MAX_OBJECT_ALIAS) return { ok: false, error: `--object-alias 가 ${MAX_OBJECT_ALIAS}자를 넘습니다` };
  }
  // ── 대상 없음 (2026-10-15 · 판단OS #4818) — 서버는 이 저널·「왜」 항목에서 기계 추측(매처)을 돌리지 않는다.
  // @AI:CONSTRAINT --object 와 함께 오면 멈춘다(서버는 object_id 가 이기지만, 둘 다 쓴 것은 사람이 헷갈린 것이다).
  let objectNoneReason = null;
  if (flags['--object-none']) {
    if (flags['--object']) return { ok: false, error: '--object-none 과 --object 는 함께 쓰지 않습니다 — 대상이 있으면 --object 만' };
    objectNoneReason = String(flags['--object-none']).trim().slice(0, MAX_OBJECT_NONE_REASON);
    if (!objectNoneReason) return { ok: false, error: '--object-none 뒤에 이유가 없습니다(예: "회사 내부 일" · "이름표 없음: <이름>")' };
  }
  // ── 섹션·관리번호 (선택 · 2026-10-10 판단OS #4613) — 서버가 «이 회사의 사용 중 섹션»·«그 섹션의 사용 중
  //   관리번호»인지 확인하고 붙인다(아니면 무시 — 관리번호는 빈칸). 여기서는 모양만 본다(fail-closed).
  let projectId = null;
  let scopeId = null;
  if (flags['--project']) {
    if (!UUID_RE.test(flags['--project'])) return { ok: false, error: `--project 값이 섹션 번호(uuid) 형식이 아닙니다: ${flags['--project']}` };
    projectId = flags['--project'].toLowerCase();
  }
  if (flags['--scope']) {
    if (!projectId) return { ok: false, error: '--scope 는 --project 와 함께만 씁니다(관리번호는 섹션 안의 칸)' };
    if (!UUID_RE.test(flags['--scope'])) return { ok: false, error: `--scope 값이 관리번호(uuid) 형식이 아닙니다: ${flags['--scope']}` };
    scopeId = flags['--scope'].toLowerCase();
  }
  // ── 일의 성격 (2026-10-17 · 판단OS #4929) — 모르는 값이면 멈춘다(exit 3). --dry-run 은 경고만 하고 키를 뺀다.
  let workNature = null;
  let natureWarning = '';
  if (flags['--nature'] !== undefined) {
    const v = String(flags['--nature']).trim().toLowerCase();
    if (NATURE_KEYS.includes(v)) workNature = v;
    else if (dryRun) natureWarning = `일의 성격 «${flags['--nature']}» 은 모르는 값입니다(${NATURE_KEYS.join('·')}) — 실제로 보내면 멈춥니다`;
    else return { ok: false, gate: true, error: [`일의 성격 «${flags['--nature']}» 은 모르는 값입니다 — 저장하지 않고 멈춥니다.`, ...NATURE_GUIDE].join('\n') };
  }
  // ── 누구의 사업 (선택 · 2026-10-18 · 판단OS #4966) — 내 회사가 아닌 회사의 사업이면 그 회사 이름표를 보낸다.
  // @AI:INTENT 서버가 «그 회사에도 소속(겸직)인가»를 확인한 뒤에만 그 회사 칸에 넣는다 — 아니면 저장하지 않고 403.
  // @AI:CONSTRAINT 회사 번호(uuid)가 아니라 이름표만 보낸다 — 이름표 → 칸은 서버 한 곳(journal-nature BUSINESSES)이 정한다.
  let workBusiness = null;
  if (flags['--business'] !== undefined) {
    const v = String(flags['--business']).trim().toLowerCase();
    if (!BUSINESS_RE.test(v)) return { ok: false, error: `--business 값 «${flags['--business']}» 은 회사 이름표 모양이 아닙니다(영문 소문자 이름표 — 관리자가 알려준 값)` };
    workBusiness = v;
  }
  const sessionUuid = UUID_RE.test(String(sessionId || '')) ? String(sessionId).toLowerCase() : null;

  const projected = `${title}\n${text}`.trim();
  // 키 순서 = 옛 판 3키 → whys → 새 키. 새 값이 없으면 키 자체를 안 넣는다(옛 전송 문자열 바이트 동일).
  const obj = { source_id: sourceId, title, text };
  if (whys) obj.whys = whys;
  if (objectId) obj.object_id = objectId;
  if (objectAlias) obj.object_alias = objectAlias;
  if (objectNoneReason) { obj.object_none = true; obj.object_none_reason = objectNoneReason; }
  if (projectId) obj.project_id = projectId;
  if (scopeId) obj.scope_id = scopeId;
  if (workNature) obj.work_nature = workNature;
  if (workBusiness) obj.work_business = workBusiness;
  // 같은 고객 섹션 여럿 관문 (2026-10-26 · 판단OS #5313) — 섹션을 골랐으면 서버가 형제 섹션을 확인하게 한다.
  // @AI:HUMAN_ONLY --folder-ok 는 사람이 카드에서 형제 섹션을 보고 「네」 한 뒤에만 붙인다.
  if (projectId) { obj.folder_check = true; if (flags['--folder-ok']) obj.folder_confirmed = true; }
  if (sessionUuid) obj.session_uuid = sessionUuid;
  const payload = JSON.stringify(obj);
  return {
    ok: true, sourceId, title, summary: summary || '', text, body, noNotion, dryRun, generated,
    projectedLength: projected.length,
    willTruncate: projected.length > CONTENT_CAP,
    hoistedLength,
    whys, whysWarning,
    objectId, objectAlias, objectNoneReason, projectId, scopeId, workNature, natureWarning, workBusiness, sessionUuid,
    payload,
  };
}

// @AI:CONSTRAINT 홈 경로는 os.homedir() — USERPROFILE은 맥/리눅스에서 undefined.
function readCreds() {
  const candidates = [
    path.join(os.homedir(), '.claude.json'),
    path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'),
  ];
  for (const f of candidates) {
    try {
      const env = JSON.parse(fs.readFileSync(f, 'utf8'))?.mcpServers?.jedi?.env;
      if (env && env.JUDGMENTOS_TOKEN) {
        return { token: env.JUDGMENTOS_TOKEN, url: env.JUDGMENTOS_URL || 'https://judgmentos-unified-agent-production.up.railway.app' };
      }
    } catch (_) { /* 다음 후보 */ }
  }
  return null;
}

function main() {
  const r = buildRequest(process.argv.slice(2));
  const noNotionArg = process.argv.includes('--no-notion');
  if (!r.ok) {
    if (r.usage) {
      console.error('usage: node journal-ingest.js "<notion_page_id|new>" "<title>" "<summary>" [--body-file <path>] [--whys-file <path>] (--object <uuid> [--object-alias <name>] | --object-none "<이유>") [--project <uuid> [--scope <uuid>]] --nature <dev|partner|scm|brand|client|other> [--business <회사 이름표>] [--no-notion] [--dry-run]');
    } else {
      console.error(`journal-ingest: ${r.error}`);
    }
    if (r.gate) process.exit(GATE_EXIT); // 일의 성격 값이 틀림 — 노션 회사도 멈춘다(관문과 같은 이유)
    // 노션 회사: 사용법 오류도 스킬을 막지 않는다(종전). 노션 없는 회사: 저장이 안 됐으니 실패로 끝낸다.
    process.exit(noNotionArg ? 1 : 0);
  }

  // 대상 관문 — 노션 회사 경로도 멈춘다(exit 3): 노션 사본은 남지만, 건너뛴 채 색인되면 서버가 대상을 낱말로 추측한다.
  // 일의 성격 관문도 같은 자리 — 둘 다 빠졌으면 한 번에 둘 다 알려 한 번에 고치게 한다.
  const stops = [];
  const gate = objectGateMessage(process.argv.slice(2));
  if (gate) {
    if (objectGateActive()) stops.push(gate.join('\n'));
    else console.log('journal-ingest: ⚠️ 대상(--object 또는 --object-none "<이유>")이 없습니다 — 이번엔 그대로 보냅니다');
  }
  const ngate = natureGateMessage(process.argv.slice(2));
  if (ngate && natureGateActive()) stops.push(ngate.join('\n'));
  if (stops.length) {
    console.error(stops.join('\n'));
    process.exit(GATE_EXIT);
  }
  if (r.objectNoneReason) console.log(`journal-ingest: 대상 없음 — ${r.objectNoneReason}`);
  if (r.workNature) console.log(`journal-ingest: 일의 성격 — ${r.workNature}`);
  if (r.workBusiness) console.log(`journal-ingest: 누구의 사업 — ${r.workBusiness}`);
  if (r.natureWarning) console.log(`journal-ingest: ⚠️ ${r.natureWarning}`);

  if (r.whysWarning) console.log(`journal-ingest: ⚠️ ${r.whysWarning}`);
  if (r.whys) console.log(`journal-ingest: 「왜」 ${r.whys.length}건 함께 보냄 — 서버가 대화 원장과 대조해 확인된 것만 판단 기록으로 남깁니다`);
  if (r.generated) console.log(`journal-ingest: source_id=${r.sourceId}  (다시 보낼 때는 new 대신 이 번호로)`);
  if (r.body) {
    console.log(
      `journal-ingest: 요약 ${r.summary.length}자 · 본문 ${r.body.length}자` +
      `${r.hoistedLength ? ` (미해결·다음 ${r.hoistedLength}자 선순위)` : ' (미해결·다음 섹션 없음)'} → 전송 ${r.projectedLength}자`
    );
    if (r.willTruncate) {
      console.log(`⚠️ 절단 예고: ${r.projectedLength}자 > 상한 ${CONTENT_CAP}자 — 뒤 ${r.projectedLength - CONTENT_CAP}자는 검색에서 빠집니다(요약·미해결/다음은 앞에 있어 보존).`);
    }
  }

  if (r.dryRun) {
    console.log('--- DRY RUN (전송 안 함) ---');
    console.log(`length=${r.projectedLength} willTruncate=${r.willTruncate}`);
    console.log(`PAYLOAD ${r.payload}`);
    process.exit(0);
  }

  // 노션 회사 경로의 안내문은 옛 문구 그대로 둔다(이미 설치된 PC·문서와 같은 말).
  const tail = r.noNotion ? '' : ' (노션 기록은 정상)';
  let failed = false;
  const fail = (msg) => {
    if (failed) return; // timeout 뒤 destroy 가 error 를 한 번 더 낸다 — 두 번 말하지 않는다
    failed = true;
    if (r.noNotion) {
      console.log(`journal-ingest: ❌ 저장되지 않았습니다 — ${msg}`);
      console.log(`   다시 보내려면: node journal-ingest.js ${r.sourceId} "<제목>" "<한줄 요약>" --body-file <같은 파일> --no-notion${r.objectId ? ` --object ${r.objectId}` : ''}${r.objectNoneReason ? ` --object-none ${JSON.stringify(r.objectNoneReason)}` : ''}${r.projectId ? ` --project ${r.projectId}` : ''}${r.scopeId ? ` --scope ${r.scopeId}` : ''}${r.workNature ? ` --nature ${r.workNature}` : ''}${r.workBusiness ? ` --business ${r.workBusiness}` : ''}`);
      process.exitCode = 1;
    } else {
      console.log(`journal-ingest: ⚠️ ${msg}${tail}`);
    }
  };

  const creds = readCreds();
  if (!creds) {
    if (r.noNotion) { fail('제디 연결 정보(토큰)가 없습니다. 관리자에게 연결을 요청하세요'); return; }
    console.log('journal-ingest: 제디 토큰 없음 — 인덱싱 skip (노션 기록은 정상). 관리자에게 토큰 발급 요청');
    process.exit(0);
  }

  let u;
  try { u = new URL('/mcp/ext/journal-ingest', creds.url); } catch (_) {
    if (r.noNotion) { fail('서버 주소를 읽지 못했습니다'); return; }
    console.log('journal-ingest: URL 해석 실패 — skip');
    process.exit(0);
  }

  const lib = u.protocol === 'http:' ? http : https;
  const req = lib.request(u, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.token}`,
      'Content-Length': Buffer.byteLength(r.payload),
    },
    timeout: 15000, // 임베딩 생성이 있어 teampack-config(4s)보다 넉넉히
  }, (res) => {
    let s = '';
    res.on('data', (c) => { s += c; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        let deduped = false;
        let ai = null;
        let refile = null;
        try { const j = JSON.parse(s); deduped = !!j.deduped; ai = j.ai_proposal || null; refile = j.refile || null; } catch (_) {}
        if (r.noNotion) {
          console.log(deduped
            ? 'journal-ingest: ✅ 이미 같은 내용으로 저장돼 있습니다'
            : 'journal-ingest: ✅ 저장 완료 — 미니앱에서 볼 수 있고, 다음 /jedi-start 에서 이어받습니다');
        } else {
          console.log(deduped
            ? 'journal-ingest: ✅ 이미 동일 내용 (재임베딩 skip)'
            : 'journal-ingest: ✅ 인덱싱 완료 — 이제 검색·회상에서 찾을 수 있습니다');
        }
        // 표식 결과 — 사람이 정한 것인데 꼬리표가 붙었으면 원문을 따옴표로 붙여 다시 보낸다(jedi-save «핵심 결정» 줄 쓰는 법)
        if (ai && ai.applied) {
          console.log(`journal-ingest: 핵심 결정 ${ai.checked}줄 — 원문 확인 ${ai.grounded} · [AI 제안] ${ai.marked_ai} · [원문 미확인] ${ai.marked_mismatch}`);
        }
        // 칸 옮김 (2026-10-17 · 판단OS #4929) — 같은 회사 안에서 섹션·칸을 바꿔 다시 보냈을 때 «정말 옮겨졌나»의 유일한 증거
        if (refile && refile.refiled > 0) {
          console.log(`journal-ingest: 칸 옮김 ${refile.refiled}행 — 이 기록에 딸린 근거·초안·판단도 새 섹션으로 함께 옮겼습니다`);
        } else if (refile && refile.error) {
          console.log(`journal-ingest: ⚠️ 칸 옮기기 실패 — ${refile.error} · 「옮겼다」고 말하지 마세요`);
        }
      } else if (res.statusCode === 422 && /"folder_has_siblings"/.test(s)) {
        // 같은 고객의 섹션이 여럿 — 서버가 저장하지 않았다. 형제 섹션·프로젝트·옮긴 이력을 그대로 보여 사람 확인을 받는다.
        let j = {};
        try { j = JSON.parse(s) || {}; } catch (_) {}
        const fmt = (p) => `«${p.name}»${p.managed && p.managed.length ? ` (진행 중: ${p.managed.join(' · ')})` : ''}`;
        console.error('journal-ingest: 🔴 같은 고객의 섹션이 여럿이라 저장하지 않았습니다 — 어느 섹션 일인지 확인받으세요');
        if (j.chosen) console.error(`   고른 섹션: ${fmt(j.chosen)}`);
        for (const sb of j.siblings || []) console.error(`   같은 고객의 다른 섹션: ${fmt(sb)}  → --project ${sb.project_id}`);
        for (const m of j.moved_away || []) console.error(`   ⚠️ 지난번 이 섹션에 넣었다가 사람이 «${m.name}»로 옮긴 기록 ${m.count}건`);
        console.error('   위 줄을 그대로 보여 드리고 「네」를 받은 뒤, 맞는 --project 에 --folder-ok 를 붙여 같은 명령으로 다시 보내세요.');
        process.exitCode = GATE_EXIT;
      } else if (res.statusCode === 422) {
        // 일의 성격과 고른 섹션이 안 맞음 — 서버가 저장하지 않았다. 노션 회사도 멈춘다(넘어가면 고칠 기회를 잃는다).
        let j = {};
        try { j = JSON.parse(s) || {}; } catch (_) {}
        console.error(`journal-ingest: 🔴 일의 성격과 고른 섹션이 맞지 않아 저장하지 않았습니다 — ${j.hint || j.error || '섹션을 다시 고르세요'}`);
        console.error('   성격(--nature)이나 섹션(--project)을 고쳐 같은 명령으로 다시 보내세요.');
        process.exitCode = GATE_EXIT;
      } else if (res.statusCode === 403 && r.workBusiness) {
        // 그 회사 소속(겸직)이 확인되지 않음 — 서버가 저장하지 않았다. 내 회사 칸으로 조용히 바꿔 넣지 않는다.
        console.error(`journal-ingest: 🔴 «${r.workBusiness}» 회사에 소속이 확인되지 않아 저장하지 않았습니다 — 관리자에게 그 회사 배정을 요청하거나, 내 회사 일이면 --business 를 빼고 다시 보내세요.`);
        process.exitCode = GATE_EXIT;
      } else if (r.noNotion) {
        fail(`서버 응답 ${res.statusCode} ${s.slice(0, 200)}`);
      } else {
        console.log(`journal-ingest: ⚠️ 실패 ${res.statusCode} ${s.slice(0, 200)} (노션 기록은 정상)`);
      }
    });
  });
  req.on('timeout', () => { fail('15s 초과 — skip'); req.destroy(); });
  req.on('error', (e) => { fail(`${e.code || e.message} — skip`); });
  req.write(r.payload);
  req.end();
}

module.exports = { buildRequest, hoistPrioritySection, objectGateMessage, objectGateActive, natureGateMessage, natureGateActive, NATURE_KEYS, CONTENT_CAP };
if (require.main === module) main();
