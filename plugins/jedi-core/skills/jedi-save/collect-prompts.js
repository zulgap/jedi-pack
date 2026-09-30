#!/usr/bin/env node
// collect-prompts.js — /jedi-save 스킬이 부르는 결정론 프롬프트 수집기.
//   현재 세션의 유저 프롬프트를 transcript에서 추출해 judgmentos prompt_log로 bulk 전송(데이터 해자).
//   @AI:INTENT 팀원 주력 표면=Claude Code 데스크탑 Code탭은 #27527로 UserPromptSubmit 훅이 죽음.
//     스킬(AI 실행)은 그 탭에서도 도니, 캡처를 훅→스킬로 옮겨 우회한다.
//   @AI:CONSTRAINT 토큰 없음/네트워크 실패/파싱 실패 모두 조용히 종료(스킬 흐름 절대 안 막음).
//     서버가 actor/tenant를 토큰 클레임에서 파생(위변조 불가) + is_owner=tenant===MASTER + secret/PII 마스킹.
//   멱등: turn_uuid = sha256(session_id + ':' + prompt) → ON CONFLICT DO NOTHING (재실행/훅 중복 안전).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function turnUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// 토큰/URL — ~/.claude.json mcpServers.jedi.env (prompt-capture.js와 동일 경로)
function loadToken() {
  const candidates = [
    path.join(os.homedir(), '.claude.json'),
    path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'),
  ];
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const env = j && j.mcpServers && j.mcpServers.jedi && j.mcpServers.jedi.env;
      if (env && env.JUDGMENTOS_TOKEN && env.JUDGMENTOS_URL) {
        return { token: env.JUDGMENTOS_TOKEN, url: env.JUDGMENTOS_URL };
      }
    } catch (_) { /* 다음 후보 */ }
  }
  return null;
}

// 세션ID로 transcript jsonl 찾기 (projects/*/<sid>.jsonl — cwd 슬러그 무관하게 탐색)
function findTranscript(sid) {
  if (!sid) return null;
  const base = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(base, d, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 유저 프롬프트 추출 (string content = 타이핑, array = tool_result 제외 + 커맨드/시스템 노이즈 skip)
function extractPrompts(transcriptPath) {
  const out = [];
  const seen = new Set();
  let lines = [];
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return out; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'user' || !ev.message || typeof ev.message.content !== 'string') continue;
    const t = ev.message.content.trim();
    if (!t || t.length < 2) continue;
    if (t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')
      || t.startsWith('This session is being continued')) continue;
    if (seen.has(t)) continue; // 같은 발화 중복 제거
    seen.add(t);
    out.push({ text: t, ts: ev.timestamp || null, cwd: ev.cwd || null });
  }
  return out;
}

function post(url, token, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url.replace(/\/$/, '') + '/mcp/ext/prompt-log'); } catch { return resolve(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
      },
    }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        let deduped = false;
        try { deduped = JSON.parse(s).deduped === true; } catch { /* noop */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, deduped });
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

// ── 「왜」 고르기 (2026-09-30 · 저널 「왜」 v3.1) ──────────────────────────────────────────────
// @AI:INTENT /jedi-save 때 사람이 «이유를 댄 말»을 판단 기록으로 남긴다. 원문은 AI 가 옮겨 적지 않는다 —
//   --why-list 가 번호를 붙여 보여 주고, AI 는 번호와 «그 말 속 이유 구절»만 고른다. --why-pick 이 번호를
//   turn_uuid 로 바꾸고 구절이 원문 안에 글자 그대로 있는지 먼저 대조한다(서버도 자기 사본으로 한 번 더).
// @AI:DEPENDS 번호 = 위 extractPrompts 순서(1부터). 두 모드가 같은 함수로 같은 대화기록을 읽으므로 번호가 흔들리지 않는다.
// @AI:DEPENDS turn_uuid 규칙 = sha256(`${sid}:${trim 한 원문}`) — hooks/prompt-capture.js·response-capture.js 와 같아야
//   서버가 원장 행을 찾는다(scripts/_test-turn-uuid-parity.js).
const WHY_MIN_CHARS = 10;   // 「네」「ㅇㅇ」 같은 말엔 이유가 없다 — 목록에서만 뺀다(번호는 그대로)
const WHY_SHOW_CHARS = 600;
const WHY_MAX = 3;          // 사장님 확정 「가」 — 세션당 3개
const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function buildWhyList(prompts) {
  return prompts
    .map((p, i) => ({ n: i + 1, text: p.text }))
    .filter((x) => x.text.length >= WHY_MIN_CHARS)
    .map((x) => ({ n: x.n, text: x.text.length > WHY_SHOW_CHARS ? `${x.text.slice(0, WHY_SHOW_CHARS)}…(이하 생략)` : x.text }));
}

/** picks=[{n, reason_quote}] → {ok:[{n, turn_uuid, reason_quote}], rejected:[{n, why}]} — 순수 함수 */
function resolveWhyPicks(prompts, sid, picks) {
  const ok = []; const rejected = [];
  const seen = new Set();
  for (const pk of Array.isArray(picks) ? picks : []) {
    const n = Number(pk && pk.n);
    const quote = collapse(pk && pk.reason_quote);
    const p = Number.isInteger(n) ? prompts[n - 1] : null;
    if (!p) { rejected.push({ n: pk && pk.n, why: '그런 번호가 없습니다' }); continue; }
    if (quote.length < 4) { rejected.push({ n, why: '이유 구절이 너무 짧습니다' }); continue; }
    if (!collapse(p.text).includes(quote)) { rejected.push({ n, why: '구절이 그 말 안에 글자 그대로 없습니다(바꿔 쓰지 말고 그대로 떼어 오세요)' }); continue; }
    if (seen.has(n)) { rejected.push({ n, why: '같은 번호를 두 번 골랐습니다' }); continue; }
    if (ok.length >= WHY_MAX) { rejected.push({ n, why: `세션당 ${WHY_MAX}개까지입니다` }); continue; }
    seen.add(n);
    ok.push({ n, turn_uuid: turnUuid(`${sid}:${p.text}`), reason_quote: quote });
  }
  return { ok, rejected };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 「왜」 모드 — 토큰·네트워크 없이 로컬 대화기록만 읽는다. 끝나면 종료(수집 전송 안 함).
function runWhyMode(sid) {
  const tp = findTranscript(sid);
  if (!tp) { console.log(`collect-prompts: 대화기록을 못 찾았습니다 (sid=${sid.slice(0, 8)}…) — 「왜」 단계는 건너뜁니다`); return; }
  const prompts = extractPrompts(tp);
  if (process.argv.includes('--why-list')) {
    const list = buildWhyList(prompts);
    console.log(`collect-prompts [왜 후보]: 이번 세션 사람 말 ${prompts.length}건 중 ${list.length}건 (짧은 말 제외 · 번호는 --why-pick 에 그대로)`);
    list.forEach((x) => console.log(`\n#${x.n}\n${x.text}`));
    return;
  }
  let picks;
  try { picks = JSON.parse(argValue('--why-pick') || '[]'); }
  catch (e) { console.log(`collect-prompts: --why-pick 형식 오류(JSON 배열 [{"n":3,"reason_quote":"…"}]) — ${e.message}`); process.exitCode = 1; return; }
  const { ok, rejected } = resolveWhyPicks(prompts, sid, picks);
  const out = argValue('--out') || path.join(os.tmpdir(), `jedi-why-${(sid || 'nosid').slice(0, 8)}.json`);
  fs.writeFileSync(out, JSON.stringify(ok.map(({ turn_uuid, reason_quote }) => ({ turn_uuid, reason_quote })), null, 2));
  rejected.forEach((r) => console.log(`  ✗ #${r.n} — ${r.why}`));
  ok.forEach((r) => console.log(`  ✓ #${r.n} — ${r.reason_quote.slice(0, 60)}`));
  console.log(`collect-prompts: 「왜」 확인 ${ok.length}건 · 버림 ${rejected.length}건 → ${out}`);
}

if (require.main === module) (async () => {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
  if (process.argv.includes('--why-list') || process.argv.includes('--why-pick')) { runWhyMode(sid); return; }
  const auth = loadToken();
  if (!auth) { console.log('collect-prompts: 토큰 없음 → skip (수집 안 함, 저널은 정상)'); return; }
  const tp = findTranscript(sid);
  if (!tp) { console.log(`collect-prompts: transcript 못 찾음 (sid=${sid.slice(0, 8)}…) → skip`); return; }

  const prompts = extractPrompts(tp);
  if (!prompts.length) { console.log('collect-prompts: 이 세션 유저 프롬프트 0건'); return; }

  // --dry: 전송 없이 추출 결과만 (검증용)
  if (process.argv.includes('--dry')) {
    console.log(`collect-prompts [DRY]: sid=${sid.slice(0, 8)}… transcript=${path.basename(tp)} url=${auth.url.replace(/\/\/.*@/, '//')} 프롬프트 ${prompts.length}건:`);
    prompts.forEach((p, i) => console.log(`  ${i + 1}. ${p.text.replace(/\n+/g, ' ').slice(0, 80)}`));
    return;
  }

  let sent = 0, deduped = 0, failed = 0;
  for (const p of prompts) {
    const body = {
      prompt_text: p.text,
      session_uuid: UUID_RE.test(sid) ? sid : undefined,
      turn_uuid: turnUuid(`${sid}:${p.text}`),
      ts: p.ts || undefined,
      project_hint: p.cwd || undefined,
      source: 'claude_code',
    };
    const r = await post(auth.url, auth.token, body);
    if (r && r.ok) { r.deduped ? deduped++ : sent++; } else { failed++; }
  }
  console.log(`collect-prompts: 프롬프트 ${prompts.length}건 중 신규 ${sent} / 기존(멱등) ${deduped} / 실패 ${failed} → prompt_log`);
})().catch((e) => { console.log('collect-prompts: 예외(무시)', e.message); });

module.exports = { extractPrompts, turnUuid, buildWhyList, resolveWhyPicks, WHY_MAX };
