#!/usr/bin/env node
// @AI:INTENT 팀 세션 저널 1행을 제디 백엔드에 벡터 인덱싱 → 나중에 검색·회상으로 찾을 수 있게 한다.
//   노션에만 쌓으면 검색 0이다. 이 호출이 있어야 `recall_prompts(source='journal')`와
//   컨텍스트 로더가 그 기록을 찾는다.
//   spec: ~/.claude/specs/2026-07-29-teampack-identity-ssot-and-journal-backfill.md PR-4
//
// 사용: node journal-ingest.js "<notion_page_id 대시 UUID>" "<세션 제목>" "<한줄 요약>"
//
// @AI:TENANT 🔐 tenant는 **토큰에서만** 파생된다(서버 `req._mcpAuth.actor`). 클라이언트가 지정할 수 없다.
//   → 팀원 토큰으로 부르면 그 회사 tenant에 적재되고, 그 회사 사람만 검색된다.
//   사장님(master)은 크로스테넌트 읽기 권한으로 필요할 때 본다.
//
// @AI:INTENT 작성자 귀속은 **서버가 결정론으로** 한다 — 토큰 actor → `person_actor` 링크 → `person_id`.
//   이름 문자열 매칭은 하지 않는다(Migration 441 @AI:CONSTRAINT). 링크 없는 actor는 태깅 skip
//   (오태깅보다 무태깅). 즉 이 스크립트는 "누구"를 보내지 않는다 — 토큰이 곧 신원이다.
//
// @AI:CONSTRAINT 실패해도 종료코드 0 — 저널 적재(노션)는 이미 끝난 뒤이고, 인덱싱 실패가
//   스킬 진행을 막아선 안 된다. 다만 **조용히 넘기지 않고** 무슨 일인지 stdout에 남긴다.
// @AI:CONSTRAINT 멱등 — 같은 page_id + 같은 내용이면 서버가 재임베딩을 skip한다(`deduped: true`).
//   저널을 고쳐서 다시 부르면 그때만 재임베딩된다.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

const [sourceId, title, text] = process.argv.slice(2);
if (!sourceId || !title) {
  console.error('usage: node journal-ingest.js "<notion_page_id>" "<title>" "<summary>"');
  process.exit(0); // 사용법 오류도 스킬을 막지 않는다
}

// @AI:CONSTRAINT 홈 경로는 os.homedir() — USERPROFILE은 맥/리눅스에서 undefined.
//   팀원 PC가 윈도우/맥 혼재이므로 양쪽에서 동작해야 한다.
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

const creds = readCreds();
if (!creds) {
  console.log('journal-ingest: 제디 토큰 없음 — 인덱싱 skip (노션 기록은 정상). 관리자에게 토큰 발급 요청');
  process.exit(0);
}

const body = JSON.stringify({ source_id: sourceId, title, text: text || '' });
let u;
try { u = new URL('/mcp/ext/journal-ingest', creds.url); } catch (_) {
  console.log('journal-ingest: URL 해석 실패 — skip');
  process.exit(0);
}

const lib = u.protocol === 'http:' ? http : https;
const req = lib.request(u, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${creds.token}`,
    'Content-Length': Buffer.byteLength(body),
  },
  timeout: 15000, // 임베딩 생성이 있어 teampack-config(4s)보다 넉넉히
}, (res) => {
  let s = '';
  res.on('data', (c) => { s += c; });
  res.on('end', () => {
    if (res.statusCode === 200) {
      let deduped = false;
      try { deduped = !!JSON.parse(s).deduped; } catch (_) {}
      console.log(deduped
        ? 'journal-ingest: ✅ 이미 동일 내용 (재임베딩 skip)'
        : 'journal-ingest: ✅ 인덱싱 완료 — 이제 검색·회상에서 찾을 수 있습니다');
    } else {
      console.log(`journal-ingest: ⚠️ 실패 ${res.statusCode} ${s.slice(0, 200)} (노션 기록은 정상)`);
    }
  });
});
req.on('timeout', () => { console.log('journal-ingest: ⚠️ 15s 초과 — skip (노션 기록은 정상)'); req.destroy(); });
req.on('error', (e) => { console.log(`journal-ingest: ⚠️ ${e.code || e.message} — skip (노션 기록은 정상)`); });
req.write(body);
req.end();
