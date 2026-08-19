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

(async () => {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
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
