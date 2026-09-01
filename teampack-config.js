#!/usr/bin/env node
// @AI:INTENT 팀팩 회사 카드(신원·노션 ID) 단일 조회 진입점 — 하드코딩/파일 명단 대체.
//   서버 SSOT: GET /mcp/ext/teampack-config (unified-agent/shared/teampack-config.js).
//   토큰 tenant로 서버가 카드를 고르므로, 팀팩 파일에 회사별 리터럴을 둘 필요가 없다.
//   spec: ~/.claude/specs/2026-07-29-teampack-identity-ssot-and-journal-backfill.md PR-3
//
// 사용법:
//   node teampack-config.js name          -> 내 이름 (저장 스킬 '작성자')
//   node teampack-config.js hub           -> 허브 페이지 ID (staff_hub_id || master_hub_id)
//   node teampack-config.js notion.<key>  -> 노션 ID 임의 키 (team_journal_ds 등)
//   node teampack-config.js company       -> 회사명
//
// 출력 규약: 해당 값만 stdout(모르면 빈 문자열). 경고·진단은 stderr → 파이프 오염 0.
//   종료코드는 항상 0 — 이 스크립트 실패가 스킬 진행을 막지 않는다(신원은 부수 정보).
//
// @AI:CONSTRAINT 🔴 파일 폴백(staff-map.json)을 두지 않는다.
//   백엔드가 평소 답해버리면 파일이 썩은 사실 자체가 은폐되고, 두 소스 불일치를 감지할 게이트가 0개다.
//   가용성 폴백은 "다른 장부"가 아니라 **직전 서버 응답의 캐시**여야 한다(아래 CACHE).
// @AI:FRAGILE stale 7일 초과 캐시는 조용히 쓰지 않고 stderr로 크게 경고한다.
//   옛 이름이 조용히 살아나는 것이 이 설계에서 가장 위험한 실패 모드다.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const TIMEOUT_MS = 4000;
const STALE_DAYS = 7;
const CACHE_DIR = path.join(os.homedir(), '.claude', 'zulgap');
const CACHE_FILE = path.join(CACHE_DIR, 'teampack-config.cache.json');

function out(v) { process.stdout.write(v == null ? '' : String(v)); process.exit(0); }
function warn(m) { try { process.stderr.write(`[teampack-config] ${m}\n`); } catch (_) {} }

// ── 토큰·URL — 개인 제디 토큰에서만 (resolve-staff.js와 동일 탐색 순서) ─────────
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
    } catch (_) { /* 파일 없음·파싱 실패 → 다음 후보 */ }
  }
  return null;
}

// ── 캐시 ────────────────────────────────────────────────────────────────────
function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!c || !c.data || !c.fetched_at) return null;
    const ageDays = (Date.now() - new Date(c.fetched_at).getTime()) / 86400000;
    return { data: c.data, ageDays };
  } catch (_) { return null; }
}
function writeCache(data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetched_at: new Date().toISOString(), data }, null, 2));
  } catch (_) { /* 캐시 실패는 무해 — 다음 호출이 다시 서버로 */ }
}

// ── 서버 조회 ───────────────────────────────────────────────────────────────
function fetchConfig({ token, url }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/mcp/ext/teampack-config', url); } catch (_) { return resolve(null); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 404) { warn('이 회사(tenant)의 팀팩 카드가 서버에 없습니다 — 사장님께 온보딩 요청'); return resolve(null); }
        if (res.statusCode !== 200) { warn(`서버 응답 ${res.statusCode}`); return resolve(null); }
        try {
          const j = JSON.parse(body);
          resolve(j && (j.data || j) || null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { warn(`${TIMEOUT_MS}ms 초과 — 캐시로 폴백`); req.destroy(); resolve(null); });
    req.on('error', (e) => { warn(`요청 실패(${e.code || e.message}) — 캐시로 폴백`); resolve(null); });
    req.end();
  });
}

// ── 키 추출 ─────────────────────────────────────────────────────────────────
// @AI:INTENT hub = staff_hub_id 우선, 없으면 master_hub_id.
//   키가 없는 tenant는 기존 동작(마스터 허브) 그대로 — 전환이 회사별로 점진 적용된다.
function pick(data, key) {
  if (!data) return '';
  if (key === 'name') return data.actor_name || '';
  if (key === 'company') return data.company_name || '';
  if (key === 'hub') return (data.notion && (data.notion.staff_hub_id || data.notion.master_hub_id)) || '';
  if (key.startsWith('notion.')) return (data.notion && data.notion[key.slice(7)]) || '';
  return '';
}

(async () => {
  const key = (process.argv[2] || 'name').trim();
  const creds = readCreds();
  if (!creds) { warn('제디 토큰 없음 — 사장님께 발급 요청'); out(''); }

  const fresh = await fetchConfig(creds);
  if (fresh) { writeCache(fresh); out(pick(fresh, key)); }

  // 서버 실패 → 직전 응답 캐시로 폴백 (다른 장부가 아니라 같은 소스의 사본)
  const cached = readCache();
  if (!cached) { warn('캐시도 없음 — 값 없이 진행'); out(''); }
  if (cached.ageDays > STALE_DAYS) {
    // @AI:FRAGILE fail-loud — 조용히 옛 값을 쓰면 개명·퇴사가 반영 안 된 채 기록이 쌓인다
    warn(`🔴 캐시가 ${Math.floor(cached.ageDays)}일 지났습니다(허용 ${STALE_DAYS}일). 값을 쓰지 않습니다 — 네트워크/토큰을 확인하세요.`);
    out('');
  }
  warn(`캐시 사용(${Math.floor(cached.ageDays)}일 전 응답)`);
  out(pick(cached.data, key));
})().catch(() => out(''));
