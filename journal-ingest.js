#!/usr/bin/env node
// @AI:INTENT 팀 세션 저널 1행을 제디 백엔드에 벡터 인덱싱 → 나중에 검색·회상으로 찾을 수 있게 한다.
//   노션에만 쌓으면 검색 0이다. 이 호출이 있어야 `recall_prompts(source='journal')`와
//   컨텍스트 로더가 그 기록을 찾는다.
//   spec: ~/.claude/specs/2026-07-29-teampack-identity-ssot-and-journal-backfill.md PR-4
//
// 사용:
//   node journal-ingest.js "<notion_page_id 대시 UUID>" "<세션 제목>" "<한줄 요약>"          ← 노션 회사 (종전 그대로)
//   node journal-ingest.js "<page_id>" "<제목>" "<한줄 요약>" --body-file <5섹션 본문.md>      ← 본문까지
//   node journal-ingest.js new "<제목>" "<한줄 요약>" --body-file <본문.md> --no-notion          ← 노션 없는 회사
//   … --dry-run   보내지 않고 조립 결과만 찍는다(네트워크·토큰 0)
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
// @AI:CONSTRAINT 🔴 3인자 호출(본문 없음)의 전송 문자열은 옛 판과 **바이트 동일**해야 한다 —
//   서버의 「content 같으면 재임베딩 skip」 멱등이 이것에 기대고, 이미 적재된 저널이 재임베딩되지 않는다.
//   그래서 본문 조립은 --body-file 이 있을 때만 한다(검사: scripts/_test-journal-ingest.js).

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
// 「어디서 이어받나」를 담는 섹션. 5섹션의 마지막이라 그냥 이어붙이면 가장 먼저 잘린다.
const PRIORITY_HEADING_RE = /^##\s*.*(미해결|다음|잔여)/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS_WITH_VALUE = new Set(['--body-file']);
// 🔴 아는 플래그만 플래그로 본다 — 「--」로 시작하는 요약 문장도 옛 판처럼 위치 인자로 남아야 바이트 동일이다.
const KNOWN_FLAGS = new Set(['--body-file', '--no-notion', '--dry-run']);

/**
 * 5섹션 본문을 «미해결·다음 먼저» 순서로 재배열한다. 결정론 — LLM 0.
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

  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (KNOWN_FLAGS.has(a)) {
      if (FLAGS_WITH_VALUE.has(a)) {
        const v = argv[i + 1];
        if (!v || v.startsWith('--')) return { ok: false, error: `${a} 뒤에 경로가 없습니다` };
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

  const projected = `${title}\n${text}`.trim();
  const payload = JSON.stringify({ source_id: sourceId, title, text });
  return {
    ok: true, sourceId, title, summary: summary || '', text, body, noNotion, dryRun, generated,
    projectedLength: projected.length,
    willTruncate: projected.length > CONTENT_CAP,
    hoistedLength,
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
      console.error('usage: node journal-ingest.js "<notion_page_id|new>" "<title>" "<summary>" [--body-file <path>] [--no-notion] [--dry-run]');
    } else {
      console.error(`journal-ingest: ${r.error}`);
    }
    // 노션 회사: 사용법 오류도 스킬을 막지 않는다(종전). 노션 없는 회사: 저장이 안 됐으니 실패로 끝낸다.
    process.exit(noNotionArg ? 1 : 0);
  }

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
      console.log(`   다시 보내려면: node journal-ingest.js ${r.sourceId} "<제목>" "<한줄 요약>" --body-file <같은 파일> --no-notion`);
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
        try { deduped = !!JSON.parse(s).deduped; } catch (_) {}
        if (r.noNotion) {
          console.log(deduped
            ? 'journal-ingest: ✅ 이미 같은 내용으로 저장돼 있습니다'
            : 'journal-ingest: ✅ 저장 완료 — 미니앱에서 볼 수 있고, 다음 /jedi-start 에서 이어받습니다');
        } else {
          console.log(deduped
            ? 'journal-ingest: ✅ 이미 동일 내용 (재임베딩 skip)'
            : 'journal-ingest: ✅ 인덱싱 완료 — 이제 검색·회상에서 찾을 수 있습니다');
        }
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

module.exports = { buildRequest, hoistPrioritySection, CONTENT_CAP };
if (require.main === module) main();
