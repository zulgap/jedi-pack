#!/usr/bin/env node
// 스킬 넘겨받기 공통 셋업 실행기 — 서버(판단OS)가 준 «셋업 계획»을 이 PC 에서 그대로 처리하고 결과를 보고한다.
//
//   node skill-setup.js <스킬 폴더 이름>            준비(복사·설치·창 열기) + 보고
//   node skill-setup.js <스킬> --check              바꾸지 않고 지금 상태만 + 보고
//   node skill-setup.js <스킬> --json               로컬 클로드가 읽는 모양으로 출력
//   node skill-setup.js --selftest
//
// @AI:INTENT 스킬마다 「○○-setup.js」 를 따로 짜지 않게 한다(2026-10-22 안경투 블로그 이전 사례 · 팀팩 #621).
//   무엇을 갖출지는 서버 계획(get_setup_plan)이 정하고, 이 파일은 «단계 종류별 처리기» 7개만 갖는다(10/23 self_test 추가 — 셋업 끝 자체 시험).
//   회사 값(NAS 주소 등)은 서버 회사 칸에만 있다 — 이 레포는 공개라 여기 적지 않는다.
// @AI:CONSTRAINT 🔴 판단 없음 — 다음에 뭘 할지(❌ 원인·대안·사람에게 부탁)는 이 실행기가 정하지 않는다. 로컬 클로드가 --json 을 보고 대화한다.
// @AI:CONSTRAINT 🔴 울타리 — ① 쓰는 곳은 ~/.claude/zulgap/ 아래만(실제 경로로 재확인 · junction 거부) ② 복사 출발지는 회사 값 폴더 아래만
//   ③ 이미 있는 파일은 절대 안 덮는다 ④ npm 은 형제 스킬 «자기» package.json 만 --ignore-scripts 로 · 셸 문자열 0(argv 만)
// @AI:DEPENDS 단계 종류·응답 모양 = 판단OS unified-agent/shared/skill-setup.js (STEP_KINDS · viewSetupPlan · sanitizeSetupReport).
//   종류를 늘리려면 서버와 «함께». 모르는 종류는 «failed · unknown_kind» 로 보고한다(조용히 넘기지 않는다).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ENGINE_VERSION = 3;   // 2 = self_test 단계 · pip 판 조건(10/23) · 3 = self_test 가 부품 위키로 실제 부품까지 본다(10/27)
const DEFAULT_URL = 'https://judgmentos-unified-agent-production.up.railway.app';
const MAX_COPY_BYTES = 1024 * 1024;
const TEST_TIMEOUT_MS = 180000;   // 자체 시험 하나당(합성 영상 굽는 시험이 1분 안쪽)
const COPY_EXT = new Set(['.md', '.json', '.txt']);
const BOM_RE = /^\uFEFF/;

// ── 순수 부품 (시험 = --selftest) ────────────────────────────────────────────

/** NAS 주소 앞 «\\» 가 Git Bash 를 지나며 «\» 하나로 줄어든다(10/22 실측) — 윈도에서 «\이름\…» 꼴이면 되살린다 */
function fixUnc(p, platform = process.platform) {
  const s = String(p || '');
  return platform === 'win32' && /^\\[^\\]/.test(s) ? `\\${s}` : s;
}

/**
 * NAS 이름 바꿔 끼우기 — `\\이름\공유\…`(또는 `//이름/…`)의 «이름»이 별칭표에 있으면 그 주소로 바꾼 경로, 없으면 null.
 * @AI:INTENT 서버 회사 값은 사무실 안 NAS 이름(예 \\nas\…)으로 적혀 있는데, 사무실 밖 PC 는 회사 망(Tailscale)으로
 *   들어와도 그 이름이 안 풀리고 숫자 주소로만 닿는다(10/23 원격 직원 실측). 그 PC 에만 «이름 → 주소» 표를 둔다.
 * @AI:CONSTRAINT 별칭표는 그 PC 의 ~/.claude/zulgap/nas-alias.json 에만 — 이 레포(공개 사본으로 나감)·서버 회사 값에 주소를 넣지 않는다.
 */
function swapUncHost(p, alias) {
  const m = /^(\\\\|\/\/)([^\\/]+)([\\/].*)?$/.exec(String(p || ''));
  if (!m || !alias) return null;
  const to = alias[m[2].toLowerCase()];
  return to ? `${m[1]}${to}${m[3] || ''}` : null;
}

/** 별칭표 읽기 — 키·값 모두 «이름 글자»만(경로 구분자·공백 거부). 깨졌으면 빈 표 */
function readNasAlias(home = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'zulgap', 'nas-alias.json'), 'utf8').replace(BOM_RE, ''));
    const ok = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,253}$/.test(s);
    return Object.fromEntries(Object.entries(raw || {}).filter(([k, v]) => ok(k) && ok(v)).map(([k, v]) => [k.toLowerCase(), v]));
  } catch { return {}; }
}

/** 원래 경로가 열리면 그대로, 안 열리고 별칭 경로가 열리면 별칭 경로, 둘 다 안 열리면 원래 경로(오류는 원래 이름으로 보인다) */
function reachable(p, alias, exists = fs.existsSync) {
  if (!p || exists(p)) return p;
  const alt = swapUncHost(p, alias);
  return alt && exists(alt) ? alt : p;
}

/** 상대경로 울타리 — 절대경로·..·드라이브·ADS(:)·빈 값 거부 */
function isSafeRel(rel) {
  const s = String(rel || '');
  if (!s || path.isAbsolute(s) || /^[\\/]/.test(s) || s.includes(':') || s.includes('\0')) return false;
  return !s.split(/[\\/]+/).some((seg) => seg === '..');
}

/** base 아래인가(문자열 기준 — 실제 경로 확인은 realInside) */
function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 표 한 칸 값 — `| 이름 | `값` |` 꼴(팀팩 채널 파일 공통 · ahn-fill readChannel 과 같은 규칙) */
function readCell(md, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(md).match(new RegExp(`^\\|\\s*${esc}\\s*\\|([^|]*)\\|`, 'm'));
  return m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : null;
}

/** «키: 값» 줄 읽기·바꾸기(뒤 주석 보존) */
function readLine(md, key, home = os.homedir()) {
  const m = String(md).match(new RegExp(`^${key}:\\s*([^#\\n]+?)\\s*(#.*)?$`, 'm'));
  return m ? m[1].replace(/^~(?=[\\/])/, home) : null;
}
function rewriteLine(md, key, value) {
  return String(md).replace(new RegExp(`^(${key}:\\s*)(\\S[^#\\n]*?)(\\s*#.*)?$`, 'm'), (_, k, _v, c) => `${k}${value}${c || ''}`);
}
// @AI:INTENT 줄이 «아예 없으면» 머리말(--- … ---) 끝에 넣는다 — 머리말이 없으면 맨 위 (10/24 경훈 PC WR-ZG-2026-1024-03)
//   계획에 새 줄 점검(edit_root_line)이 생겨도 이미 받은 채널 정본은 copy_file 이 «안 덮어서» 그 줄이 영영 안 생겼다.
//   처음 받는 PC 는 편집 재료 받기(pull)가 NAS 판으로 덮으므로(주고받은 기록 없음) 넣은 줄이 정본과 갈라지지 않는다.
function insertLine(md, key, value) {
  const s = String(md), nl = s.includes('\r\n') ? '\r\n' : '\n', row = `${key}: ${value}   # 셋업이 넣음(회사 값)`;
  const m = s.match(/^---\r?\n[\s\S]*?\r?\n(---)\s*(\r?\n|$)/);
  if (!m) return row + nl + s;
  const at = m.index + m[0].lastIndexOf('---');
  return s.slice(0, at) + row + nl + s.slice(at);
}

/**
 * pip 설치 이름 + 판 조건 — `pillow` · `pillow<13` · `pillow>=12,<13` · `faster-whisper==1.1.0` (10/23 · 판 고정)
 * @AI:CONSTRAINT 두 번째 울타리 — 안내 문구로만 쓰고 셸에 넘기지 않지만, 이름·조건 모양 밖은 bad_args 로 거부한다
 */
const PIP_SPEC_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,59})((?:==|!=|<=|>=|~=|<|>)[0-9][0-9A-Za-z.*]{0,19}(?:,(?:==|!=|<=|>=|~=|<|>)[0-9][0-9A-Za-z.*]{0,19}){0,3})?$/;

/** 판 비교 — 숫자 마디만(1.2.3 · 13.0.0.dev0 의 dev 이하는 버림). 조건을 모두 만족하면 true */
function versionOk(ver, cond) {
  if (!cond) return true;
  const num = (v) => String(v).split('.').map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x));
  const cmp = (a, b) => { const A = num(a), B = num(b); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d < 0 ? -1 : 1; } return 0; };
  return cond.split(',').every((c) => {
    const m = /^(==|!=|<=|>=|~=|<|>)(.+)$/.exec(c.trim());
    if (!m) return false;
    const [, op, v] = m;
    if (v.includes('*')) { const pre = v.split('*')[0].replace(/\.$/, ''); const hit = String(ver) === pre || String(ver).startsWith(pre + '.'); return op === '!=' ? !hit : hit; }
    const d = cmp(ver, v);
    if (op === '~=') { const p = num(v), w = num(ver); return d >= 0 && p.slice(0, -1).every((x, i) => w[i] === x); }   // ~=12.1 = 12.1 이상 12.x
    return { '==': d === 0, '!=': d !== 0, '<': d < 0, '<=': d <= 0, '>': d > 0, '>=': d >= 0 }[op];
  });
}

/**
 * 셋업 끝 자체 시험 고르기 — 그 스킬 scripts/ 의 `_test…` 파일(.js·.py)만. match 는 `*` 하나짜리 무늬(기본 `_test*`)
 * @AI:CONSTRAINT 울타리 — 무늬는 `_test` 로 시작하는 이름 글자와 `*` 만(경로 구분자·.. 불가) · 그 스킬 폴더 밖 파일은 못 고른다
 */
function testPattern(match) {
  const m = match === undefined || match === null || match === '' ? '_test*' : String(match);
  if (!/^_test[A-Za-z0-9._*-]{0,60}$/.test(m)) return null;
  const body = m.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\-]/g, '\\$&')).join('[A-Za-z0-9._-]*');
  return new RegExp(`^${body}$`);
}
function pickTests(names, match) {
  const re = testPattern(match);
  if (!re) return null;
  return names.filter((n) => /^_test[-_A-Za-z0-9.]*\.(js|py)$/.test(n) && re.test(n)).sort();
}

/**
 * 셋업 결과 업무요청 끝의 «기계가 읽는 꼬리표» 한 줄 — `setup_feedback: {"skill","plan_hash","pc","items":[{kind,target,fix}]}` (10/23)
 * @AI:INTENT 사람이 읽는 본문과 따로, 서버가 «같은 고칠 곳이 여러 PC 에서 반복» · «계획이 바뀐 뒤에도 또 나옴(고쳤는데 안 고쳐짐)»을 세는 재료.
 *   본문은 클로드가 쓰지만 꼬리표 모양은 여기 한 곳에서만 만든다(손으로 쓰면 키 이름이 PC 마다 갈린다).
 * @AI:DEPENDS 모양 = 판단OS 서버 쪽 파서와 같아야 한다 — 키·kind 이름을 바꾸려면 서버와 함께.
 */
const FEEDBACK_KINDS = ['plan_gap', 'manual_step', 'ai_workaround', 'not_working'];
/** 부품 확인(check_parts.py) 출력 → 실패한 부품 이름 한 줄. 서버가 남기는 글자(한글·영문·괄호·쉼표)만 — 판 번호·이유는 PC 화면에 */
function partsFailNote(stdout) {
  const names = String(stdout || '').split(/\r?\n/).filter((l) => l.startsWith('❌ ') && !l.startsWith('❌ 부품 ') && l.includes(' — '))   // 끝 요약 줄(「❌ 부품 N개 — …」)은 이름이 아니다
    .map((l) => l.slice(2).split(' — ')[0].replace(/\s[\d][\w.]*$/, '').replace(/[^A-Za-z0-9가-힣._() -]/g, '').trim()).filter(Boolean);
  return `부품 ${names.slice(0, 4).join(', ') || '확인 실패'}`.slice(0, 120);
}

function feedbackTag(input) {
  const i = input || {};
  const s = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '');
  const items = (Array.isArray(i.items) ? i.items : []).filter((x) => x && FEEDBACK_KINDS.includes(x.kind)).slice(0, 12)
    // scope: company = 그 회사가 고칠 것(회사 계획·회사 스킬) · common = 우리 공통(셋업 엔진·팀팩에서 내려온 스킬 자체) — 고객사 PC 면 common 은 줄갭에도 알린다
    .map((x) => ({ kind: x.kind, scope: x.scope === 'common' ? 'common' : 'company', target: s(x.target, 120), fix: s(x.fix, 160) })).filter((x) => x.target);
  const tag = { skill: s(i.skill, 60), plan_hash: /^[0-9a-f]{12}$/.test(String(i.plan_hash || '')) ? i.plan_hash : null, pc: s(i.pc, 63) || null, items };
  return `setup_feedback: ${JSON.stringify(tag)}`;
}

/** 결과 → 사람 줄 표시 */
const MARK = { ok: '✅', skipped: '⏭', human: '👤', missing: '❌', failed: '❌' };

/** 끝 코드 — 0 준비 끝 / 2 사람 몫만 / 1 남음 */
function exitCode(items) {
  if (items.some((i) => i.state === 'missing' || i.state === 'failed')) return 1;
  return items.some((i) => i.state === 'human') ? 2 : 0;
}

// ── 서버 ─────────────────────────────────────────────────────────────────────

/** 제디 열쇠 — 환경변수 → ~/.claude.json mcpServers.jedi.env (export-company 와 같은 순서) */
function readCreds(env = process.env, home = os.homedir()) {
  if (env.JUDGMENTOS_TOKEN && env.JUDGMENTOS_TOKEN.trim()) return { token: env.JUDGMENTOS_TOKEN.trim(), url: env.JUDGMENTOS_URL || DEFAULT_URL };
  for (const f of [path.join(home, '.claude.json'), path.join(env.APPDATA || '', 'Claude', 'claude_desktop_config.json')]) {
    try {
      const e = JSON.parse(fs.readFileSync(f, 'utf8').replace(BOM_RE, ''))?.mcpServers?.jedi?.env;
      if (e && e.JUDGMENTOS_TOKEN) return { token: e.JUDGMENTOS_TOKEN, url: e.JUDGMENTOS_URL || DEFAULT_URL };
    } catch { /* 다음 후보 */ }
  }
  return null;
}

async function callTool(creds, name, args, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(new URL('/mcp/ext/call', creds.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` }, body: JSON.stringify({ name, args }) });
  } catch (e) { return { ok: false, error: 'network', message: String((e && e.message) || e).slice(0, 120) }; }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth', message: '제디 열쇠가 거부됐습니다 — 팀팩 설치를 다시 하거나 열쇠를 받으세요' };
  if (!res.ok) return { ok: false, error: 'http_' + res.status };
  let inner;
  try { inner = (await res.json())?.content?.[0]?.text; } catch { return { ok: false, error: 'bad_response' }; }
  if (typeof inner !== 'string') return { ok: false, error: 'bad_response' };
  if (inner.startsWith('Error:')) return { ok: false, error: 'tool_error', message: inner.slice(0, 200) };
  try { return JSON.parse(inner); } catch { return { ok: false, error: 'bad_response' }; }
}

/** 이 PC 러너 기기 «번호»들(토큰은 읽지 않는다 — cc-runner/lib/runner-api.js deviceFilePath 와 같은 자리) */
function readDeviceIds(env = process.env) {
  const p = env.CC_DEVICE_FILE || path.join(env.APPDATA || path.join(os.homedir(), '.config'), 'judgmentos', 'device.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(BOM_RE, ''));
    const list = Array.isArray(j.devices) ? j.devices : [j];
    return list.map((d) => d && (d.device_id || String(d.device_token || '').split('.')[0])).filter((x) => /^[0-9a-f-]{36}$/i.test(String(x || ''))).slice(0, 8);
  } catch { return []; }
}

function readPackVersion(home = os.homedir()) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8').replace(BOM_RE, ''));
    for (const k of Object.keys((j && j.plugins) || {})) {
      const v = /^jedi-core@/.test(k) && j.plugins[k] && j.plugins[k][0] && j.plugins[k][0].version;
      if (typeof v === 'string' && /^(?:[0-9a-f]{7,40}|[0-9][0-9.]{0,19})$/.test(v)) return v;
    }
  } catch { /* 없으면 빈 값 */ }
  return null;
}

// ── 형제 스킬 찾기 (설치 형태가 둘 — 캐시: <마켓>/<팩>/<판>/skills · 레포: plugins/<팩>/skills) ─────

/** 클로드코드가 «지금 쓰는» 팩 판 — installed_plugins.json 의 installPath. 🔴 폴더 바뀐 시각 순서와 다르다(10/23 실측: 쓰는 판 55a0c78 · 최근 바뀐 판 1c68af5) */
function activeSkillRoots(home = os.homedir()) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8').replace(BOM_RE, ''));
    return Object.keys((j && j.plugins) || {}).filter((k) => /@zulgap-team-pack$/.test(k))
      .map((k) => j.plugins[k] && j.plugins[k][0] && j.plugins[k][0].installPath).filter(Boolean)
      .map((p) => path.join(p, 'skills')).filter((s) => fs.existsSync(s));
  } catch { return []; }
}

function skillRoots(here = __dirname, home = os.homedir()) {
  const mySkills = path.resolve(here, '..', '..');                 // …/skills
  const roots = [...activeSkillRoots(home), mySkills];
  const up = (n) => path.resolve(mySkills, ...Array(n).fill('..'));
  const tryDirs = (base, depth) => {
    // depth 2 = <팩>/<판>/skills (캐시) · depth 1 = <팩>/skills (레포)
    let packs = [];
    try { packs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name)); } catch { return; }
    for (const p of packs) {
      if (depth === 1) { const s = path.join(p, 'skills'); if (fs.existsSync(s)) roots.push(s); continue; }
      let vers = [];
      try { vers = fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name)); } catch { continue; }
      vers.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);   // 새 판 먼저
      for (const v of vers) { const s = path.join(v, 'skills'); if (fs.existsSync(s)) roots.push(s); }
    }
  };
  tryDirs(up(3), 2);   // 캐시
  tryDirs(up(2), 1);   // 레포
  return [...new Set(roots)];
}

function findSkillHaving(rel, roots = skillRoots()) {
  if (!isSafeRel(rel)) return null;
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names) { const d = path.join(r, n); if (fs.existsSync(path.join(d, rel))) return d; }
  }
  return null;
}

// ── 처리기 7종 ───────────────────────────────────────────────────────────────

function makeCtx(plan, opts = {}) {
  const home = opts.home || os.homedir();
  const zroot = path.join(home, '.claude', 'zulgap');
  const alias = opts.alias || readNasAlias(home);
  const exists = opts.exists || fs.existsSync;
  const slots = Object.fromEntries((plan.slots || []).map((s) => [s.key, s.value ? reachable(fixUnc(s.value), alias, exists) : null]));
  /** 목적지 — ~/.claude/zulgap/ 아래, 있는 부모까지 실제 경로로 재확인(junction 이 밖을 가리키면 거부) */
  const dest = (rel) => {
    if (!isSafeRel(rel)) return null;
    const p = path.join(zroot, rel);
    if (!isInside(zroot, p)) return null;
    let probe = path.dirname(p);
    while (!fs.existsSync(probe) && isInside(zroot, probe) && probe !== zroot) probe = path.dirname(probe);
    try {
      if (fs.existsSync(zroot) && fs.existsSync(probe) && !isInside(fs.realpathSync(zroot), fs.realpathSync(probe))) return null;
    } catch { return null; }
    return p;
  };
  return { home, zroot, slots, dest, check: !!opts.check, run: opts.run || spawnSync, roots: opts.roots || skillRoots(), opts };
}

const HANDLERS = {
  copy_file(a, c) {
    const to = c.dest(a.to);
    if (!to) return { state: 'failed', code: 'bad_dest' };
    if (fs.existsSync(to)) return { state: 'ok', code: 'exists' };   // 🔴 안 덮는다
    const root = c.slots[a.from_slot];
    if (!root) return { state: 'missing', code: 'company_value_empty' };
    if (!isSafeRel(a.rel) || !COPY_EXT.has(path.extname(a.rel).toLowerCase())) return { state: 'failed', code: 'bad_source' };
    const src = path.join(root, a.rel);
    if (!isInside(root, src)) return { state: 'failed', code: 'bad_source' };
    if (c.check) return { state: 'missing', code: 'not_copied' };
    let body;
    try {
      const st = fs.statSync(src);
      if (st.size > MAX_COPY_BYTES) return { state: 'failed', code: 'source_too_big' };
      body = fs.readFileSync(src);
    } catch (e) { return { state: 'failed', code: e && e.code === 'ENOENT' ? 'source_not_found' : 'source_unreadable', note: src }; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const tmp = `${to}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body);
    if (!fs.readFileSync(tmp).equals(body) || !body.length) { fs.rmSync(tmp, { force: true }); return { state: 'failed', code: 'copy_mismatch' }; }
    if (fs.existsSync(to)) { fs.rmSync(tmp, { force: true }); return { state: 'ok', code: 'exists' }; }
    fs.renameSync(tmp, to);
    return { state: 'ok', code: 'copied' };
  },

  path_open(a, c) {
    const f = c.dest(a.file);
    if (!f || !fs.existsSync(f)) return { state: 'missing', code: 'file_missing' };
    const md = fs.readFileSync(f, 'utf8');
    const cur = readLine(md, a.line_key, c.home);
    if (cur && fs.existsSync(fixUnc(cur))) return { state: 'ok', code: 'opens' };
    const fix = a.fix_from_slot && c.slots[a.fix_from_slot];
    if (!fix) return { state: 'missing', code: cur ? 'path_not_open' : 'line_missing', note: cur || null };
    if (c.check) return { state: 'missing', code: cur ? 'path_not_open' : 'line_missing', note: cur || null };
    fs.writeFileSync(f, cur ? rewriteLine(md, a.line_key, fix) : insertLine(md, a.line_key, fix), 'utf8');
    const done = cur ? 'rewritten' : 'inserted';
    return fs.existsSync(fix) ? { state: 'ok', code: done } : { state: 'failed', code: `${done}_not_open`, note: fix };
  },

  table_cells(a, c) {
    const f = c.dest(a.file);
    if (!f || !fs.existsSync(f)) return { state: 'missing', code: 'file_missing' };
    const md = fs.readFileSync(f, 'utf8');
    const empty = (a.cells || []).filter((n) => { const v = readCell(md, n); return !v || !v.length; });
    return empty.length ? { state: 'missing', code: 'cells_empty', note: empty.join(', ') } : { state: 'ok' };
  },

  node_deps(a, c) {
    const dir = findSkillHaving(a.skill_has, c.roots);
    if (!dir) return { state: 'missing', code: 'sibling_skill_missing', note: a.skill_has };
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(BOM_RE, '')); } catch { return { state: 'failed', code: 'no_package_json' }; }
    const deps = Object.keys(pkg.dependencies || {});
    const lacking = deps.filter((d) => !fs.existsSync(path.join(dir, 'node_modules', d, 'package.json')));
    if (!lacking.length) return { state: 'ok', code: 'installed' };
    if (c.check) return { state: 'missing', code: 'not_installed', note: lacking.join(', ') };
    // 🔴 셸 없이 — 윈도 npm.cmd 는 shell 없이 못 띄우니 node 로 npm-cli.js 를 직접 부른다(argv 만 · 폴더 공백 안전)
    const cli = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p));
    if (!cli) return { state: 'failed', code: 'npm_not_found' };
    const r = c.run(process.execPath, [cli, 'install', '--prefix', dir, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], { encoding: 'utf8', timeout: 300000 });
    const still = deps.filter((d) => !fs.existsSync(path.join(dir, 'node_modules', d, 'package.json')));
    return r.status === 0 && !still.length ? { state: 'ok', code: 'installed_now' } : { state: 'failed', code: 'npm_failed', note: String(r.stderr || '').slice(-160) };
  },

  tool(a, c) {
    // 🔴 shell 을 쓰지 않는다 — 윈도에서 shell 로 넘기면 `-c "import PIL"` 따옴표가 사라져 늘 «없음»이 된다(10/22 실측)
    if (a.binary) {
      // 🔴 두 번째 울타리(서버 lintPlan 이 첫째) — 회사가 등록한 계획(save_setup_plan)도 여기로 온다. 실행 파일은 «이름»만, 확인 인자는 정해진 넷만
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(String(a.binary)) || (a.version_arg !== undefined && !['-version', '--version', '-v', '-V'].includes(a.version_arg))) return { state: 'failed', code: 'bad_args' };
      const r = c.run(a.binary, [a.version_arg || '-version'], { encoding: 'utf8', timeout: 20000 });
      return r.status === 0 ? { state: 'ok' } : { state: 'missing', code: 'binary_missing', note: a.binary };
    }
    if (a.python_import) {
      // pip 은 이름 또는 «이름+판 조건»(`pillow<13`) — 조건이 있으면 깔린 판까지 본다(10/23 · Pillow 13 에서 그림 단계가 멈춘 사고 뒤 판 고정 길)
      const spec = a.pip === undefined ? null : PIP_SPEC_RE.exec(String(a.pip));
      if (a.pip !== undefined && !spec) return { state: 'failed', code: 'bad_args' };
      const hint = spec ? (spec[2] ? `pip install "${a.pip}"` : `pip install ${a.pip}`) : a.python_import;
      for (const py of ['python', 'python3', 'py']) {
        const r = c.run(py, ['-c', `import ${String(a.python_import).replace(/[^A-Za-z0-9_.]/g, '')}`], { encoding: 'utf8', timeout: 20000 });
        if (r.status !== 0) continue;
        if (!spec || !spec[2]) return { state: 'ok' };
        // 판 읽기 — 배포 이름(pip 이름)으로. 이름은 위 모양 검사를 지난 글자만이라 코드 조각에 그대로 넣어도 된다
        const v = c.run(py, ['-c', `import importlib.metadata as m; print(m.version('${spec[1]}'))`], { encoding: 'utf8', timeout: 20000 });
        const ver = String(v.stdout || '').trim();
        if (v.status !== 0 || !ver) return { state: 'missing', code: 'python_version_unknown', note: hint };
        return versionOk(ver, spec[2]) ? { state: 'ok', code: 'version_ok', note: ver } : { state: 'missing', code: 'python_version_mismatch', note: `${ver} 깔림 → ${hint}` };
      }
      return { state: 'missing', code: 'python_module_missing', note: hint };
    }
    return { state: 'failed', code: 'bad_args' };
  },

  /**
   * 셋업 끝 자체 시험 — 그 스킬 scripts/ 의 `_test…`(.js·.py)를 돌려 하나라도 실패하면 not ready + 실패한 시험 이름
   * @AI:INTENT 10/23 원격 직원 PC — 셋업이 «준비 끝»이라 했는데 설명 그림 단계가 Pillow 13 에서 멈췄다. 준비물이 «있나»만 보고 «도나»를 안 봤다.
   *   그 스킬이 이미 가진 시험을 그 PC 에서 돌리면 판 차이·글꼴·인코딩 같은 «그 PC 에서만» 깨지는 것을 셋업 때 잡는다.
   * @AI:CONSTRAINT 고르는 것은 그 스킬 폴더 scripts/ 안 `_test` 파일뿐(testPattern) · 셸 없이(argv) · 파이썬은 utf-8 모드로(한국어 윈도 cp949 가짜 실패 막기)
   */
  self_test(a, c) {
    const dir = findSkillHaving(a.skill_has, c.roots);
    if (!dir) return { state: 'missing', code: 'sibling_skill_missing', note: a.skill_has };
    const sd = path.join(dir, 'scripts');
    let names = [];
    try { names = fs.readdirSync(sd); } catch { /* 폴더 없음 = 시험 없음 */ }
    const tests = pickTests(names, a.match);
    if (!tests) return { state: 'failed', code: 'bad_args' };
    if (!tests.length) return { state: 'missing', code: 'no_tests', note: a.match || '_test*' };
    let py;   // 파이썬은 처음 필요할 때 한 번만 찾는다
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const failed = [];
    for (const n of tests) {
      let cmd = process.execPath;
      if (n.endsWith('.py')) {
        if (py === undefined) py = ['python', 'python3', 'py'].find((p) => c.run(p, ['-c', 'import sys'], { encoding: 'utf8', timeout: 20000 }).status === 0) || null;
        if (!py) { failed.push(`${n}(파이썬 없음)`); continue; }
        cmd = py;
      }
      const r = c.run(cmd, [path.join(sd, n)], { cwd: sd, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, env });
      if (r.status !== 0) failed.push(n);
    }
    // 🔴 부품 위키(10/27) — 그 스킬 scripts/ 가 쓰는 바깥 부품(코드의 import 에서 읽는다)을 판 상한 + 짧은 실제 확인으로 본다.
    //   10/26 경훈 PC 는 위 시험이 다 통과했는데 OpenCV 5 · PyAV 19 · 그래픽카드 방식에서 멈췄다 — 계산 시험은 진짜 부품을 안 부른다
    const parts = path.join(__dirname, '..', 'parts', 'check_parts.py');
    if (fs.existsSync(parts)) {
      if (py === undefined) py = ['python', 'python3', 'py'].find((p) => c.run(p, ['-c', 'import sys'], { encoding: 'utf8', timeout: 20000 }).status === 0) || null;
      if (!py) failed.push('부품(파이썬 없음)');
      else {
        const r = c.run(py, [parts, dir], { cwd: dir, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, env });
        if (r.status !== 0) failed.push(partsFailNote(r.stdout));
      }
    }
    return failed.length ? { state: 'failed', code: 'tests_failed', note: failed.join(', ').slice(0, 200) } : { state: 'ok', code: 'tests_passed', note: `${tests.length}개 통과` };
  },

  chrome_login(a, c) {
    const pf = a.profile_from || {};
    const f = c.dest(pf.file);
    const prof = f && fs.existsSync(f) ? (readCell(fs.readFileSync(f, 'utf8'), pf.cell) || [])[0] : null;
    if (!prof) return { state: 'missing', code: 'profile_unknown' };
    const dir = findSkillHaving('scripts/chrome-session.js', c.roots);
    if (!dir) return { state: 'missing', code: 'sibling_skill_missing' };
    if (!fs.existsSync(path.join(dir, 'node_modules', 'playwright-core'))) return { state: 'missing', code: 'browser_parts_missing' };
    const cs = path.join(dir, 'scripts', 'chrome-session.js');
    const run = (args) => { const r = c.run(process.execPath, [cs, ...args], { encoding: 'utf8', timeout: 90000 }); try { return JSON.parse(r.stdout); } catch { return { error: String(r.stderr || r.stdout || '').trim().slice(0, 160) }; } };
    let st = run(['status', prof]);
    const url = a.url && /^https:\/\/[^\s]{3,300}$/.test(String(a.url)) ? a.url : null;   // 두 번째 울타리 — https 만
    if (!st.error && !st.open && !c.check) { run(['open', prof, ...(url ? [url] : [])]); st = run(['status', prof]); }
    if (st.error) return { state: 'failed', code: 'chrome_error', note: st.error };
    if (!st.open) return { state: c.check ? 'missing' : 'failed', code: 'chrome_not_open' };
    return st.logged_in ? { state: 'ok', code: 'logged_in' } : { state: 'human', code: 'login_needed' };
  },
};

async function runPlan(plan, opts = {}) {
  const c = makeCtx(plan, opts);
  const items = [];
  // @AI:INTENT 자체 시험(self_test)은 계획 어디에 적혀 있든 «맨 끝»에 돈다 — 복사·설치가 끝난 뒤의 모습을 시험해야 «준비 끝»의 뜻이 맞다
  const all = plan.steps || [];
  const ordered = [...all.filter((s) => s.kind !== 'self_test'), ...all.filter((s) => s.kind === 'self_test')];
  for (const st of ordered) {
    const h = HANDLERS[st.kind];
    let r;
    try { r = h ? h(st.args || {}, c) : { state: 'failed', code: 'unknown_kind' }; } catch (e) { r = { state: 'failed', code: 'handler_error', note: String((e && e.message) || e).slice(0, 120) }; }
    // 사람 몫 단계(who=human)는 코드가 끝낼 수 없다 — ok 가 아니면 human 으로 남긴다
    if (st.who === 'human' && r.state === 'missing') r = { ...r, state: 'human' };
    items.push({ id: st.id, kind: st.kind, label: st.label || st.id, who: st.who, state: r.state, code: r.code || null, note: r.note || null, step_note: st.note || null });
  }
  return items;
}

// ── 본체 ─────────────────────────────────────────────────────────────────────

async function main(argv) {
  // --feedback-tag '<json>' (또는 - 로 표준입력) → 업무요청 끝에 붙일 꼬리표 한 줄만 출력(서버·네트워크 없음)
  const fi = argv.indexOf('--feedback-tag');
  if (fi >= 0) {
    const raw = argv[fi + 1] && argv[fi + 1] !== '-' ? argv[fi + 1] : fs.readFileSync(0, 'utf8');
    try { console.log(feedbackTag(JSON.parse(raw))); return 0; } catch (e) { console.error('꼬리표 JSON 을 못 읽었습니다: ' + e.message); return 1; }
  }
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--tenant') a.tenant = argv[++i];
    else if (x.startsWith('--')) a[x.slice(2)] = true;
    else a._.push(x);
  }
  // --tenant <회사 칸 번호> — 여러 회사를 보는 열쇠(사장님)가 «어느 회사 셋업인가»를 고를 때만. 직원·고객 열쇠는 자기 회사라 필요 없다(서버가 거부)
  const tsel = a.tenant && /^[0-9a-f-]{36}$/i.test(a.tenant) ? a.tenant : null;
  if (a.selftest) return selftest();
  const skill = a._[0];
  const out = (o) => { if (a.json) console.log(JSON.stringify(o, null, 2)); };
  if (!skill) { console.error('사용: node skill-setup.js <스킬 폴더 이름> [--check] [--json]'); return 1; }
  const creds = readCreds();
  if (!creds) { const o = { skill, ready: false, error: 'no_token', message: '제디 열쇠(JUDGMENTOS_TOKEN)가 없습니다 — 팀팩 설치를 다시 하거나 열쇠를 받으세요' }; out(o); if (!a.json) console.log('❌ ' + o.message); return 1; }
  const plan = await callTool(creds, 'get_setup_plan', { skill, ...(tsel ? { read_tenant_id: tsel } : {}) });
  if (!plan.ok) {
    const o = { skill, ready: false, error: plan.error, message: plan.message || '셋업 계획을 못 받았습니다', known: plan.known || null };
    out(o); if (!a.json) console.log(`❌ ${o.message}${o.known ? ` (계획 있는 스킬: ${o.known.join(', ')})` : ''}`);
    return 1;
  }
  const items = await runPlan(plan, { check: !!a.check });
  const report = {
    skill, report_id: crypto.randomUUID(), plan_hash: plan.plan_hash, engine_version: ENGINE_VERSION, pack_version: readPackVersion(),
    device_ids: readDeviceIds(), hostname: /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(os.hostname()) ? os.hostname() : null,
    // 자체 시험만 note(실패한 시험 이름 · 200자)를 함께 보낸다 — 다른 단계 note 엔 이 PC 경로가 들어갈 수 있어 보내지 않는다
    items: items.map((i) => ({ id: i.id, state: i.state, ...(i.code ? { code: i.code } : {}), ...(i.kind === 'self_test' && i.note ? { note: String(i.note).slice(0, 200) } : {}) })),
    ...(tsel ? { write_tenant_id: tsel } : {}),
  };
  const rep = await callTool(creds, 'report_setup', report);
  const code = exitCode(items);
  // plan_hash · pc 는 셋업 끝 «결과 업무요청»(SKILL.md 7번)의 재료 — 같은 PC·스킬·계획 건을 찾아 덧붙이는 열쇠다
  const o = { skill, label: plan.label, plan_hash: plan.plan_hash || null, pc: report.hostname, check: !!a.check, missing_company_values: plan.missing, ask_claude: plan.ask_claude, items,
    server: { recorded: !!rep.recorded, level: rep.level || null, duplicate: rep.duplicate || null, error: rep.ok === false ? (rep.error || 'report_failed') : null },
    ready: code === 0, exit: code };
  if (a.json) { out(o); return code; }
  console.log(`\n${plan.label || skill} 셋업${a.check ? ' 점검' : ''}`);
  if (plan.missing && plan.missing.length) console.log(`❌ 회사 값이 비었습니다: ${plan.missing.join(', ')} — 관리자에게 여쭐 일`);
  for (const i of items) console.log(`${MARK[i.state] || '•'} ${i.label}${i.code ? ` — ${i.code}` : ''}${i.note ? ` (${i.note})` : ''}${i.state === 'human' && i.step_note ? `\n   ${i.step_note}` : ''}`);
  for (const q of plan.ask_claude || []) console.log(`🤖 클로드가 확인: ${q}`);
  console.log(`\n${code === 0 ? '✅ 준비 끝' : code === 2 ? '👤 사람이 할 것만 남음 — 끝나면 이 명령을 다시' : `❌ ${items.filter((i) => i.state === 'missing' || i.state === 'failed').length}건 남음`}`
    + ` · 서버 보고 ${rep.recorded ? '적힘' : rep.duplicate ? '같은 결과(한 번만)' : `안 됨(${o.server.error || '?'})`}`
    + ` · PC ${o.pc || '?'} · 계획 ${o.plan_hash || '?'}`);
  return code;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-setup-'));
  const home = path.join(tmp, 'home'); const nas = path.join(tmp, 'nas');
  fs.mkdirSync(path.join(nas, 'naver'), { recursive: true });
  fs.writeFileSync(path.join(nas, 'a.md'), `x\nraw_root: ${path.join(tmp, 'nope')}   # 편 폴더\n`);
  fs.writeFileSync(path.join(nas, 'fm.md'), '---\nchannel: x\nraw_root: /nope   # 편 폴더\n---\n본문 --- 줄\n');
  fs.writeFileSync(path.join(nas, 'naver', 'b.md'), '| 카테고리번호 | `12` |\n| 프로필키 | `ahn` |\n| 예약 시각 | |\n');
  fs.mkdirSync(path.join(tmp, 'raw'));
  const calls = [], ran = [];
  const fakeRun = (cmd, args) => { calls.push([cmd, ...args]); return { status: cmd === 'ffmpeg' ? 0 : 1, stdout: '', stderr: '' }; };
  const plan = {
    slots: [{ key: 'root', value: nas }, { key: 'raw', value: path.join(tmp, 'raw') }],
    steps: [
      { id: 'c1', kind: 'copy_file', who: 'code', args: { from_slot: 'root', rel: 'a.md', to: 'channels/a.md' } },
      { id: 'c2', kind: 'copy_file', who: 'code', args: { from_slot: 'root', rel: 'naver/b.md', to: 'channels/naver/b.md' } },
      { id: 'p1', kind: 'path_open', who: 'code', args: { file: 'channels/a.md', line_key: 'raw_root', fix_from_slot: 'raw' } },
      { id: 'c3', kind: 'copy_file', who: 'code', args: { from_slot: 'root', rel: 'fm.md', to: 'channels/fm.md' } },
      { id: 'p2', kind: 'path_open', who: 'code', args: { file: 'channels/fm.md', line_key: 'edit_root', fix_from_slot: 'raw' } },
      { id: 't1', kind: 'table_cells', who: 'code', args: { file: 'channels/naver/b.md', cells: ['카테고리번호', '예약 시각'] } },
      { id: 'f1', kind: 'tool', who: 'code', args: { binary: 'ffmpeg' } },
      { id: 'y1', kind: 'tool', who: 'code', args: { python_import: 'PIL', pip: 'pillow' } },
      { id: 'x1', kind: 'rm_rf', who: 'code', args: {} },
      { id: 'b1', kind: 'tool', who: 'code', args: { binary: 'C:\\Windows\\System32\\cmd.exe' } },
      { id: 'b2', kind: 'tool', who: 'code', args: { binary: 'ffmpeg', version_arg: '/c del' } },
      { id: 'evil', kind: 'copy_file', who: 'code', args: { from_slot: 'root', rel: 'a.md', to: '../../.ssh/a.md' } },
    ],
  };
  return runPlan(plan, { home, run: fakeRun, roots: [] }).then((it) => {
    const by = Object.fromEntries(it.map((i) => [i.id, i]));
    const chA = path.join(home, '.claude', 'zulgap', 'channels', 'a.md');
    const cases = [
      ['복사 — 회사 값 폴더에서 ~/.claude/zulgap/ 아래로', by.c1.state === 'ok' && by.c1.code === 'copied' && fs.existsSync(chA)],
      ['🔴 원본 PC 경로가 안 열리면 그 줄만 회사 값으로(주석 보존)', by.p1.code === 'rewritten' && fs.readFileSync(chA, 'utf8').includes(`raw_root: ${path.join(tmp, 'raw')}   # 편 폴더`)],
      ['🔴 줄이 아예 없으면 머리말 끝에 회사 값으로 넣는다(본문·다른 줄 그대로 · 10/24 경훈 PC)', by.p2.code === 'inserted' && fs.readFileSync(path.join(home, '.claude', 'zulgap', 'channels', 'fm.md'), 'utf8') === `---\nchannel: x\nraw_root: /nope   # 편 폴더\nedit_root: ${path.join(tmp, 'raw')}   # 셋업이 넣음(회사 값)\n---\n본문 --- 줄\n`],
      ['머리말 없는 파일은 맨 위에 · CRLF 는 CRLF 로', insertLine('a\r\nb\r\n', 'k', 'v') === 'k: v   # 셋업이 넣음(회사 값)\r\na\r\nb\r\n'],
      ['표 칸 빈 것 이름으로', by.t1.state === 'missing' && by.t1.note === '예약 시각'],
      ['실행 파일 있음 · 파이썬 모듈 없음 = 설치 안내 · 셸 없이(argv)', by.f1.state === 'ok' && by.y1.code === 'python_module_missing' && by.y1.note === 'pip install pillow' && calls.some((x) => x[0] === 'python' && x[1] === '-c' && x[2] === 'import PIL')],
      ['모르는 단계 종류 = failed(조용히 안 넘김)', by.x1.state === 'failed' && by.x1.code === 'unknown_kind'],
      ['🔴 실행 파일 경로·이상한 확인 인자 = 띄우지 않고 failed', by.b1.code === 'bad_args' && by.b2.code === 'bad_args' && !calls.some((x) => /cmd\.exe/i.test(x[0]) || x.includes('/c del'))],
      ['🔴 목적지가 밖이면 거부', by.evil.state === 'failed' && by.evil.code === 'bad_dest' && !fs.existsSync(path.join(home, '.ssh'))],
      ['상대경로 울타리', !isSafeRel('C:/x') && !isSafeRel('a/../b') && !isSafeRel('a:b') && !isSafeRel('/etc') && isSafeRel('channels/naver/b.md')],
      ['Git Bash 가 줄인 «\\이름» 되살리기', fixUnc('\\nas\\s', 'win32') === '\\\\nas\\s' && fixUnc('//nas/s', 'win32') === '//nas/s' && fixUnc('\\x', 'darwin') === '\\x'],
      ['사무실 밖 PC — NAS 이름 바꿔 끼우기(대소문자 무시 · 표에 없으면 null · 경로 아니면 null)', swapUncHost('\\\\NAS\\공유\\a', { nas: '10.0.0.5' }) === '\\\\10.0.0.5\\공유\\a' && swapUncHost('//nas/s', { nas: 'h' }) === '//h/s' && swapUncHost('\\\\other\\s', { nas: 'h' }) === null && swapUncHost('C:\\nas\\s', { nas: 'h' }) === null],
      ['🔴 원래 이름이 열리면 별칭을 안 쓴다 · 안 열리고 별칭이 열리면 별칭 · 둘 다 안 열리면 원래 이름', (() => {
        const al = { nas: '10.0.0.5' };
        return reachable('\\\\nas\\s', al, () => true) === '\\\\nas\\s'
          && reachable('\\\\nas\\s', al, (p) => p.startsWith('\\\\10.')) === '\\\\10.0.0.5\\s'
          && reachable('\\\\nas\\s', al, () => false) === '\\\\nas\\s';
      })()],
      ['별칭표 — 경로 구분자·공백 든 값은 버린다 · 파일 없으면 빈 표', (() => {
        const h = path.join(tmp, 'home-alias'); fs.mkdirSync(path.join(h, '.claude', 'zulgap'), { recursive: true });
        fs.writeFileSync(path.join(h, '.claude', 'zulgap', 'nas-alias.json'), '\uFEFF' + JSON.stringify({ NAS: '10.0.0.5', bad: '..\\x', 'a b': '1.1.1.1' }));
        const r = readNasAlias(h); return r.nas === '10.0.0.5' && Object.keys(r).length === 1 && Object.keys(readNasAlias(path.join(tmp, 'none'))).length === 0;
      })()],
      ['끝 코드 — 남음 1 · 사람만 2 · 끝 0', exitCode([{ state: 'ok' }, { state: 'missing' }]) === 1 && exitCode([{ state: 'ok' }, { state: 'human' }]) === 2 && exitCode([{ state: 'ok' }, { state: 'skipped' }]) === 0],
    ];
    // 🔴 다시 돌려도 안 덮는다 — 사람이 고친 파일 보존
    fs.writeFileSync(chA, 'HAND-EDITED');
    return runPlan(plan, { home, run: fakeRun, roots: [] }).then((it2) => {
      cases.push(['🔴 두 번째 실행 — 있는 파일은 안 덮는다', it2[0].code === 'exists' && fs.readFileSync(chA, 'utf8').endsWith('HAND-EDITED')]);
      return runPlan(plan, { home: path.join(tmp, 'home2'), run: fakeRun, roots: [], check: true });
    }).then((it3) => {
      cases.push(['--check = 바꾸지 않는다', it3[0].state === 'missing' && it3[0].code === 'not_copied' && !fs.existsSync(path.join(tmp, 'home2'))]);
      // 셋업 끝 자체 시험(self_test · 10/23) — 가짜 스킬 폴더에 시험 셋(통과 js · 실패 js · 통과 py) + 시험 아닌 파일
      const sk = path.join(tmp, 'skills', 'fake-skill', 'scripts'); fs.mkdirSync(sk, { recursive: true });
      for (const n of ['_test-ok.js', '_test-bad.js', '_test-ok.py', 'tool.js', '_test-notes.md']) fs.writeFileSync(path.join(sk, n), '');
      const tRun = (cmd, args, o) => { ran.push([cmd, ...args, o && o.env && o.env.PYTHONUTF8]); return { status: /_test-bad/.test(args[0] || '') ? 1 : 0, stdout: '', stderr: '' }; };
      const tPlan = { steps: [
        { id: 'st', kind: 'self_test', who: 'code', args: { skill_has: 'scripts/tool.js' } },
        { id: 'f0', kind: 'tool', who: 'code', args: { binary: 'ffmpeg' } },
        { id: 'st2', kind: 'self_test', who: 'code', args: { skill_has: 'scripts/tool.js', match: '_test-ok*' } },
        { id: 'st3', kind: 'self_test', who: 'code', args: { skill_has: 'scripts/tool.js', match: '../x' } },
        { id: 'st4', kind: 'self_test', who: 'code', args: { skill_has: 'scripts/tool.js', match: '_test-none*' } },
      ] };
      return runPlan(tPlan, { home: path.join(tmp, 'home3'), run: tRun, roots: [path.join(tmp, 'skills')] });
    }).then((it4) => {
      const by4 = Object.fromEntries(it4.map((i) => [i.id, i]));
      cases.push(['🔴 자체 시험 — 하나라도 실패하면 failed + 실패한 시험 이름 · 시험 아닌 파일은 안 돌린다', by4.st.state === 'failed' && by4.st.code === 'tests_failed' && by4.st.note === '_test-bad.js' && exitCode(it4) === 1]);
      cases.push(['자체 시험 — 무늬로 고르면 그것만 · 전부 통과 = ok', by4.st2.state === 'ok' && by4.st2.code === 'tests_passed' && by4.st2.note === '2개 통과']);
      cases.push(['🔴 자체 시험 무늬 울타리(경로 불가) · 고른 시험 0개 = missing', by4.st3.code === 'bad_args' && by4.st4.state === 'missing' && by4.st4.code === 'no_tests']);
      cases.push(['자체 시험은 계획 순서와 무관하게 맨 끝 · 파이썬은 utf-8 모드', it4[0].id === 'f0' && ran.some((x) => /_test-ok\.py$/.test(x[1]) && x[2] === '1')]);
      cases.push(['🔴 자체 시험이 부품 위키 확인도 돌린다(10/27) — 그 스킬 폴더를 넘긴다', ran.some((x) => /check_parts\.py$/.test(x[1] || '') && /fake-skill$/.test(x[2] || '') && x[3] === '1')]);
      cases.push(['부품 실패 줄 → 이름만(판 번호·이유는 버림)', partsFailNote('✅ 그림 부품(Pillow) 12.1\n❌ 얼굴 찾기(OpenCV) 5.0.0.93 — 이 판은 확인 안 됨 → pip install "opencv-python<5"\n❌ 소리 파일 열기(PyAV) — 안 깔려 있습니다\n\n❌ 부품 2개 — 위 ❌ 줄의 할 일을 하고 다시\n') === '부품 얼굴 찾기(OpenCV), 소리 파일 열기(PyAV)' && partsFailNote('') === '부품 확인 실패']);
      cases.push(['pip 판 조건 모양 — 이름·조건만', PIP_SPEC_RE.test('pillow') && PIP_SPEC_RE.test('pillow<13') && PIP_SPEC_RE.test('pillow>=12,<13') && PIP_SPEC_RE.test('faster-whisper==1.1.0') && !PIP_SPEC_RE.test('pillow; rm -rf /') && !PIP_SPEC_RE.test('pillow <13') && !PIP_SPEC_RE.test('"pillow"')]);
      cases.push(['판 비교', versionOk('12.1.1', '<13') && !versionOk('13.0.0', '<13') && versionOk('12.3.0', '>=12,<13') && versionOk('12.1.1', '==12.*') && !versionOk('13.0', '==12.*') && versionOk('12.2', '~=12.1') && !versionOk('13.0', '~=12.1') && versionOk('x', '')]);
      // pip 판 조건 — 깔린 판이 조건 밖이면 missing + 설치 안내(따옴표) · 안이면 ok
      const vRun = (ver) => (cmd, args) => ({ status: cmd === 'python' ? 0 : 1, stdout: /metadata/.test(args[1] || '') ? ver + '\n' : '', stderr: '' });
      const pPlan = { steps: [{ id: 'p', kind: 'tool', who: 'code', args: { python_import: 'PIL', pip: 'pillow<13' } }, { id: 'q', kind: 'tool', who: 'code', args: { python_import: 'PIL', pip: 'pillow && del' } }] };
      return Promise.all([runPlan(pPlan, { home: path.join(tmp, 'home4'), run: vRun('13.0.0'), roots: [] }), runPlan(pPlan, { home: path.join(tmp, 'home4'), run: vRun('12.1.1'), roots: [] })]);
    }).then(([bad13, ok12]) => {
      cases.push(['🔴 pip 판 조건 — 13 깔림 + 「<13」 = missing · 안내에 따옴표', bad13[0].state === 'missing' && bad13[0].code === 'python_version_mismatch' && bad13[0].note === '13.0.0 깔림 → pip install "pillow<13"' && bad13[1].code === 'bad_args']);
      cases.push(['pip 판 조건 — 12 깔림 = ok', ok12[0].state === 'ok' && ok12[0].code === 'version_ok']);
      const tg = feedbackTag({ skill: 'zulgap-ahn-youtube-edit', plan_hash: 'abcdef012345', pc: 'PC-1', items: [
        { kind: 'manual_step', target: 'SKILL.md 「NAS 연결」', fix: 'hosts 한 줄\n안내', scope: 'common' }, { kind: 'bogus', target: 'x' }, { kind: 'not_working', target: '' }, { kind: 'plan_gap', target: '계획 raw_root_line' }] });
      const tj = JSON.parse(tg.replace(/^setup_feedback: /, ''));
      cases.push(['결과 꼬리표 — 한 줄 · 모르는 kind·빈 고칠 곳 버림 · scope 기본 company', tg.startsWith('setup_feedback: {') && !tg.includes('\n') && tj.items.length === 2 && tj.items[0].scope === 'common' && tj.items[1].scope === 'company' && tj.plan_hash === 'abcdef012345'
        && feedbackTag({ plan_hash: 'nope' }).includes('"plan_hash":null')]);
      let bad = 0;
      for (const [name, okv] of cases) { bad += !okv; console.log(`${okv ? 'ok' : 'NOT OK'}  ${name}`); }
      console.log(`${cases.length - bad}/${cases.length}`);
      fs.rmSync(tmp, { recursive: true, force: true });
      return bad ? 1 : 0;
    });
  });
}

if (require.main === module) {
  // 🔴 process.exit() 를 부르지 않는다 — 윈도에서 fetch 연결이 닫히는 중에 끊으면 Node 가 libuv 단언으로 죽어 끝 코드가 127 이 된다(10/23 실측).
  //   끝 코드만 정해 두고 열린 연결이 정리되며 스스로 끝나게 한다.
  Promise.resolve(main(process.argv.slice(2))).then((c) => { process.exitCode = c; }).catch((e) => { console.error('실패:', e.message); process.exitCode = 1; });
}

module.exports = { fixUnc, swapUncHost, readNasAlias, reachable, isSafeRel, isInside, readCell, readLine, rewriteLine, exitCode, readCreds, readDeviceIds, skillRoots, findSkillHaving, runPlan, HANDLERS, ENGINE_VERSION, PIP_SPEC_RE, versionOk, testPattern, pickTests, feedbackTag, FEEDBACK_KINDS };
