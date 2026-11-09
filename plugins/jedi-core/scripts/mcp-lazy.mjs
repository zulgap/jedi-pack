#!/usr/bin/env node
// mcp-lazy.mjs — 무거운 연결 프로그램(파워포인트·한글·작업용 브라우저)을 «처음 쓸 때» 띄우는 대기 문지기.
//
// .mcp.json 에서 이렇게 부른다 (진짜 명령은 `--` 뒤에 그대로 — 버전 고정 문자열도 인자에 남는다):
//   "command": "node",
//   "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-lazy.mjs", "pptx", "--", "uvx", "--with", "mcp<2", ...]
//
// @AI:INTENT 2026-11-08 사장님 확정 「매번 켜지 말고 필요할 때만 켜는 게 맞다」. 실측 7일 2,729턴 중
//   작업용 브라우저 658 · 파워포인트 637 · 한글 491 턴이 «안 붙은 연결»이었다 — 대화마다 셋을 동시에 띄우면
//   한 개 20~37초라 30초 시작 한도를 넘긴다. 그래서 대화 시작 때는 저장해 둔 도구 목록으로 바로 답하고,
//   도구를 실제로 부를 때(tools/call 등) 진짜 프로그램을 띄워 이어 붙인다. 안 쓰는 대화는 아예 안 띄운다.
// @AI:CONSTRAINT stdout 은 MCP 통신 채널이다 — 줄 단위 JSON 외에는 한 글자도 쓰지 않는다. 진단은 stderr 로만.
// @AI:DEPENDS 끄는 길: 환경변수 ZULGAP_MCP_LAZY=0 이면 예전처럼 진짜 프로그램을 바로 띄워 그대로 잇는다.
//   저장 목록 위치: ZULGAP_MCP_LAZY_DIR > ~/.zulgap/mcp-lazy (🔴 git 저장소 밖 · 플러그인 갱신에도 남는다).
//   저장 목록은 «이름 + 명령 + 인자(버전 포함)» 열쇠로 묶인다 — 버전이 바뀌면 한 번 진짜로 띄워 다시 저장한다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CACHE_SCHEMA = 1;
const DEFAULT_PROTOCOL = '2025-11-25';
const CHILD_INIT_TIMEOUT_MS = Number(process.env.ZULGAP_MCP_LAZY_INIT_MS) || 180_000;
// @AI:INTENT 저장 목록이 없을 때(이 PC 첫 실행·버전 바뀜) 예전처럼 바로 띄우되, 이 시간 안에 목록을 못 받으면
//   따로 떨어진 «예열» 프로세스를 하나 띄운다 — 클로드가 30초에 이 창을 끊어도 예열은 끝까지 가서 목록을 저장한다.
const WARM_AFTER_MS = Number(process.env.ZULGAP_MCP_LAZY_WARM_AFTER_MS) || 15_000;

export const LIST_KEYS = {
  'tools/list': 'tools',
  'prompts/list': 'prompts',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
};

const log = (s) => { try { process.stderr.write(`mcp-lazy: ${s}\n`); } catch { /* 닫힘 */ } };

export function cacheDir() {
  return process.env.ZULGAP_MCP_LAZY_DIR || path.join(os.homedir(), '.zulgap', 'mcp-lazy');
}

// @AI:FRAGILE 인자 안의 절대 경로(플러그인 폴더)는 플러그인이 갱신될 때마다 바뀐다 — 파일 이름만 열쇠에 넣는다.
//   그러지 않으면 갱신마다 저장 목록이 무효가 되어 다시 느린 시작으로 돌아간다.
export function cacheKey(name, cmd, args) {
  // 윈도·맥 경로를 어느 운영체제에서 재도 같게(C:\… 는 맥·리눅스 path.isAbsolute 로는 절대 경로가 아니다)
  const abs = (s) => path.win32.isAbsolute(s) || path.posix.isAbsolute(s);
  const norm = [cmd, ...args].map(String).map((s) => (abs(s) ? s.split(/[\\/]/).pop() : s));
  return crypto.createHash('sha1').update(JSON.stringify([CACHE_SCHEMA, name, ...norm])).digest('hex').slice(0, 16);
}

const safe = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '_');
export const cacheFile = (name) => path.join(cacheDir(), `${safe(name)}.json`);

export function readCache(name, key) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(name), 'utf8'));
    if (c && c.schema === CACHE_SCHEMA && c.key === key && c.init && c.lists && Array.isArray(c.lists['tools/list']?.tools)) return c;
  } catch { /* 없음·깨짐 = 무효 */ }
  return null;
}

export function writeCache(name, obj) {
  const file = cacheFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, savedAt: new Date().toISOString(), ...obj }));
  fs.renameSync(tmp, file); // 여러 창이 동시에 써도 반쯤 쓴 파일을 읽지 않게
}

function lastProtocol() {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir(), 'client.json'), 'utf8')).protocolVersion || DEFAULT_PROTOCOL; } catch { return DEFAULT_PROTOCOL; }
}
function rememberProtocol(v) {
  if (!v) return;
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(path.join(cacheDir(), 'client.json'), JSON.stringify({ protocolVersion: v })); } catch { /* 못 적어도 동작엔 지장 없음 */ }
}

// ── 진짜 프로그램 띄우기 ────────────────────────────────────────────────
// @AI:FRAGILE Windows 에서 .cmd(npx 등)는 shell 없이 띄우면 EINVAL(Node 24) — PATH 에서 찾아 .exe 면 shell 없이,
//   .cmd/.bat 면 shell 을 켜고 특수문자 인자를 따옴표로 감싼다(「mcp<2」의 < 는 따옴표가 없으면 넘겨주기 기호가 된다).
function resolveWin(cmd) {
  if (path.extname(cmd)) return cmd;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext.toLowerCase());
      try { if (fs.statSync(p).isFile()) return p; } catch { /* 없음 */ }
    }
  }
  return cmd;
}

export function spawnReal(cmd, args, stdio = ['pipe', 'pipe', 'inherit']) {
  if (cmd === 'node') return spawn(process.execPath, args, { stdio, windowsHide: true });
  if (process.platform !== 'win32') return spawn(cmd, args, { stdio });
  const exe = resolveWin(cmd);
  if (/\.(cmd|bat)$/i.test(exe)) {
    const q = (a) => (/[\s"<>|&^()%]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
    return spawn(q(exe), args.map(q), { stdio, shell: true, windowsHide: true });
  }
  return spawn(exe, args, { stdio, windowsHide: true });
}

// 줄 단위 JSON 읽기 (\r\n 허용 · JSON 아닌 줄은 stderr 로)
function onLines(stream, cb) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log(`JSON 아닌 줄 무시: ${line.slice(0, 120)}`); continue; }
      cb(msg);
    }
  });
}

const send = (stream, msg) => { try { stream.write(JSON.stringify(msg) + '\n'); } catch { /* 닫힘 */ } };
const isReq = (m) => m && m.method && m.id !== undefined && m.id !== null;
const LAZY = '__mcp_lazy__';

// ── 예열: 진짜 프로그램을 한 번 띄워 도구 목록을 저장하고 끝낸다 ─────────────
async function warm(name, cmd, args, key) {
  const lock = path.join(cacheDir(), `${safe(name)}.warm.lock`);
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 5 * 60_000) return 0; } catch { /* 잠금 없음 */ }
    fs.writeFileSync(lock, String(process.pid));
    const protocolVersion = lastProtocol();
    const child = spawnReal(cmd, args, ['pipe', 'pipe', 'ignore']);
    const pending = new Map();
    let n = 0;
    const call = (method, params) => new Promise((res, rej) => {
      const id = `${LAZY}warm:${++n}`;
      pending.set(id, { res, rej });
      send(child.stdin, { jsonrpc: '2.0', id, method, params });
    });
    onLines(child.stdout, (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    });
    const dead = new Promise((_, rej) => { child.on('error', rej); child.on('exit', (c) => rej(new Error(`끝남 ${c}`))); });
    const timer = setTimeout(() => child.kill(), CHILD_INIT_TIMEOUT_MS);
    try {
      const init = await Promise.race([call('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'mcp-lazy-warm', version: '1' } }), dead]);
      send(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
      const lists = {};
      for (const [method, field] of Object.entries(LIST_KEYS)) {
        const capName = method.startsWith('tools') ? 'tools' : method.startsWith('prompts') ? 'prompts' : 'resources';
        if (!init?.capabilities?.[capName]) continue;
        try { const r = await Promise.race([call(method, {}), dead]); if (r && !r.nextCursor) lists[method] = { [field]: r[field] || [] }; } catch { /* 그 목록만 건너뜀 */ }
      }
      if (lists['tools/list']) writeCache(name, { key, clientProtocolVersion: protocolVersion, init, lists });
    } finally {
      clearTimeout(timer);
      try { child.kill(); } catch { /* 이미 끝남 */ }
    }
    return 0;
  } catch (e) {
    log(`${name} 예열 실패 — ${e.message}`);
    return 1;
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch { /* 무시 */ }
  }
}

// ── 문지기 본체 ────────────────────────────────────────────────────────
function gate(name, cmd, args, key) {
  const out = process.stdout;
  let cache = readCache(name, key);
  let mode = 'idle';          // idle(저장 목록으로 응대 중) · starting · live · eager(저장 목록 없음 → 바로 이음)
  let child = null;
  let clientInit = null;
  let gotInitialized = false;
  let queue = [];
  const track = new Map();    // eager 모드: 저장할 응답 id → method
  const eagerSave = { init: null, lists: {}, protocol: null };
  let warmTimer = null;

  const fail = (why) => {
    log(`${name} 연결 프로그램을 켜지 못했습니다 — ${why}`);
    for (const m of queue) if (isReq(m)) send(out, { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `${name} 연결 프로그램을 켜지 못했습니다: ${why} — 다시 부르면 한 번 더 켭니다` } });
    queue = [];
    if (mode === 'eager') for (const id of track.keys()) send(out, { jsonrpc: '2.0', id, error: { code: -32603, message: `${name} 연결 프로그램을 켜지 못했습니다: ${why}` } });
    track.clear();
    try { child?.kill(); } catch { /* 무시 */ }
    child = null;
    mode = cache ? 'idle' : 'eager-dead';
  };

  const saveEager = () => {
    if (!eagerSave.init || !eagerSave.lists['tools/list']) return;
    try {
      writeCache(name, { key, clientProtocolVersion: eagerSave.protocol, init: eagerSave.init, lists: eagerSave.lists });
      if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
    } catch (e) { log(`저장 실패 — ${e.message}`); }
  };

  const fromChild = (m) => {
    if (typeof m.id === 'string' && m.id.startsWith(LAZY)) {
      if (m.id === `${LAZY}init`) {
        if (m.error) return fail(m.error.message || '초기화 거절');
        if (gotInitialized) send(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
        mode = 'live';
        const q = queue; queue = [];
        for (const x of q) send(child.stdin, x);
        send(child.stdin, { jsonrpc: '2.0', id: `${LAZY}tools`, method: 'tools/list', params: {} });
      } else if (m.id === `${LAZY}tools` && m.result && !m.result.nextCursor && cache) {
        // 진짜 목록이 저장 목록과 다르면 고쳐 저장하고 클라이언트에 「목록 바뀜」을 알린다
        const fresh = m.result.tools || [];
        if (JSON.stringify(fresh) !== JSON.stringify(cache.lists['tools/list'].tools)) {
          cache.lists['tools/list'] = { tools: fresh };
          try { writeCache(name, cache); } catch { /* 무시 */ }
          send(out, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        }
      }
      return;
    }
    if (mode === 'eager' && m.id !== undefined && track.has(m.id) && m.result) {
      const method = track.get(m.id); track.delete(m.id);
      if (method === 'initialize') eagerSave.init = m.result;
      else if (!m.result.nextCursor) eagerSave.lists[method] = { [LIST_KEYS[method]]: m.result[LIST_KEYS[method]] || [] };
      saveEager();
    }
    send(out, m);
  };

  const startChild = (eager) => {
    mode = eager ? 'eager' : 'starting';
    try { child = spawnReal(cmd, args); } catch (e) { return fail(e.message); }
    const me = child;
    me.on('error', (e) => { if (child === me) fail(e.message); });
    me.on('exit', (code) => {
      if (child !== me) return;
      if (mode === 'live' || mode === 'eager') process.exit(code ?? 1);
      fail(`시작 중 끝남(${code})`);
    });
    me.stdin.on('error', () => { /* 끊김은 exit 에서 처리 */ });
    onLines(me.stdout, fromChild);
    if (!eager) {
      send(me.stdin, { jsonrpc: '2.0', id: `${LAZY}init`, method: 'initialize', params: clientInit });
      const t = setTimeout(() => { if (child === me && mode === 'starting') fail('시작 시간 초과'); }, CHILD_INIT_TIMEOUT_MS);
      t.unref?.();
    }
  };

  const answer = (m, result) => send(out, { jsonrpc: '2.0', id: m.id, result });

  const fromClient = (m) => {
    if (mode === 'eager') {
      if (isReq(m) && (m.method === 'initialize' || (LIST_KEYS[m.method] && !m.params?.cursor))) track.set(m.id, m.method);
      return send(child.stdin, m);
    }
    if (mode === 'live') return send(child.stdin, m);
    if (mode === 'eager-dead') {
      if (isReq(m)) send(out, { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `${name} 연결 프로그램을 켜지 못했습니다` } });
      return;
    }

    // idle · starting — 저장 목록으로 바로 답할 수 있는 것은 직접 답한다
    if (m.method === 'initialize' && isReq(m)) {
      clientInit = m.params || {};
      rememberProtocol(clientInit.protocolVersion);
      if (cache && cache.clientProtocolVersion === clientInit.protocolVersion) return answer(m, cache.init);
      // 저장 목록 없음·다른 판 → 예전처럼 바로 띄워 잇고, 그 응답으로 목록을 저장한다
      cache = null;
      eagerSave.protocol = clientInit.protocolVersion;
      track.set(m.id, 'initialize');
      startChild(true);
      if (mode !== 'eager') return; // 띄우기 실패
      warmTimer = setTimeout(() => {
        if (readCache(name, key)) return;
        try {
          const self = fileURLToPath(import.meta.url);
          const w = spawn(process.execPath, [self, '--warm', name, '--', cmd, ...args], { detached: true, stdio: 'ignore', windowsHide: true });
          w.unref();
        } catch (e) { log(`예열 못 띄움 — ${e.message}`); }
      }, WARM_AFTER_MS);
      warmTimer.unref?.();
      return send(child.stdin, m);
    }
    if (m.method === 'notifications/initialized') { gotInitialized = true; return; }
    if (m.method === 'ping' && isReq(m)) return answer(m, {});
    if (LIST_KEYS[m.method] && isReq(m)) return answer(m, cache?.lists?.[m.method] || { [LIST_KEYS[m.method]]: [] });
    if (!isReq(m)) { if (mode === 'starting') queue.push(m); return; } // 띄우기 전 알림(취소 등)은 버린다
    if (!clientInit) return send(out, { jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'initialize 전입니다' } });
    queue.push(m);
    if (mode === 'idle') { log(`${name} — 처음 부름(${m.method}) · 진짜 프로그램을 띄웁니다`); startChild(false); }
  };

  onLines(process.stdin, fromClient);
  process.stdin.on('end', () => {
    if (!child) process.exit(0);
    try { child.stdin.end(); } catch { /* 무시 */ }
    setTimeout(() => { try { child?.kill(); } catch { /* 무시 */ } process.exit(0); }, 3000).unref?.();
  });
  const forward = (sig) => { try { child?.kill(sig); } catch { /* 이미 끝남 */ } process.exit(0); };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
}

// ── 입구 ──────────────────────────────────────────────────────────────
export function parseArgv(argv) {
  const a = [...argv];
  const isWarm = a[0] === '--warm';
  if (isWarm) a.shift();
  const sep = a.indexOf('--');
  if (sep < 1 || !a[sep + 1]) return null;
  return { warm: isWarm, name: a[0], cmd: a[sep + 1], args: a.slice(sep + 2) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const p = parseArgv(process.argv.slice(2));
  if (!p) {
    log('사용법: mcp-lazy.mjs <이름> -- <명령> [인자…]');
    process.exit(2);
  }
  const key = cacheKey(p.name, p.cmd, p.args);
  if (p.warm) {
    process.exit(await warm(p.name, p.cmd, p.args, key));
  } else if (process.env.ZULGAP_MCP_LAZY === '0') {
    const child = spawnReal(p.cmd, p.args, 'inherit');
    child.on('exit', (code) => process.exit(code ?? 1));
    child.on('error', (e) => { log(`실행 실패 — ${e.message}`); process.exit(1); });
  } else {
    gate(p.name, p.cmd, p.args, key);
  }
}
