#!/usr/bin/env node
'use strict';
/**
 * handoff-done-check — 핸드오프의 `> 완료조건:` 을 실제로 검사한다 (팀팩판)
 *
 * 왜: 「진행 중」 표시는 쌓이는데 **무엇이 끝났는지 세는 자리가 없다.**
 *   「끝났다」라는 낱말로 찾으면 안 된다 — 실측(2026-08-19, 사장님 PC 18건)에서 **16건이 오탐**이었다.
 *   전부 `X는 끝났다, 남은 것은 Y` 형태라 낱말로는 원리적으로 못 가른다.
 *   그래서 **쓸 때 기계가 읽을 수 있게 적어 두고**, 그것만 검사한다.
 *
 * @AI:INTENT 자동으로 «닫지» 않는다 — 후보까지만 낸다. 닫는 것은 사람이다.
 * @AI:CONSTRAINT 「모름」을 「미충족」으로 뭉개지 않는다. gh 미설치·네트워크 실패는 unknown 으로 남기고
 *   그 사실을 시끄럽게 보고한다 — 조용히 미충족으로 처리하면 끝난 작업이 영원히 열린 채로 남는다.
 *
 * 문법:  > 완료조건: pr:239 · commit:ac93d27@origin/main · file:plugins/x/y.md · human:대표님-확인
 *   구분자 = `·` 또는 `|`. human: 은 **검사하지 않는다**(사람만 아는 것).
 *
 * 🔑 `human:` 이 대부분인 것이 정상이다. 이 도구의 값어치는 「자동으로 닫는 것」이 아니라
 *   **「내가 할 일 / 남의 답 대기 / 진짜 끝남」이 매번 자동으로 갈리는 것**이다.
 *
 * @AI:DEPENDS 사장님 PC 의 `~/.claude/tools/handoff-done-check.js` 와 **같은 문법**이되
 *   ① 레포가 팀팩 ② `tool:` 축 없음 — 아래 주석 참조. 문법을 갈라지게 고치지 말 것.
 *
 * 사용:  node handoff-done-check.js            # 사람용 요약
 *        node handoff-done-check.js --json     # 기계용(/jedi-start 가 읽는다)
 *        node handoff-done-check.js --file <경로>   # 한 건만
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE;
const SPECS = path.join(HOME, '.claude', 'specs');

// @AI:CONSTRAINT 직원 PC 에 있는 레포는 팀팩뿐이다. 두 자리를 다 보는 이유는
//   설치 형태에 따라 clone 위치가 갈리기 때문(문서 경로를 손으로 적게 하지 않는다).
const REPOS = [
  path.join(HOME, 'claude-team-pack'),
  path.join(HOME, 'Documents', 'claude-team-pack'),
];
const PR_REPO = 'zulgap/claude-team-pack';

const COND_RE = /^>\s*완료조건:\s*(.+)$/m;
/**
 * 진행 중 표식 — 🔵 하나가 아니다.
 *
 * @AI:CONSTRAINT 🔴 2026-09-14 실측(사장님 PC 판): 🔵 만 보면 **25건이 통째로 안 보인다**
 *   (🟢 12 · 🟡 4 · 🔴 2 · ⬜ 2 · ⏸ ⬛ 🔀 ⛔ 📋 각 1). 사람이 「부분 종결」·「보류」를 다른 색으로 적기 때문이다.
 *   실사고: 🟢 로 적힌 트랙이 스캔 밖이라 **이미 고쳐진 일을 「1순위」로 올렸다.**
 * @AI:INTENT ✅(종결)만 빼고 나머지 색은 전부 본다. 레거시 글자 라벨(`**진행중**`·`IN_PROGRESS` 등)은
 *   여전히 제외 — 완료조건 규약 이전 문서라 넣으면 노이즈만 는다.
 */
const OPEN_RE = /^>\s*상태:\s*(?!✅)[\u{1F300}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{23F0}-\u{23FF}\u{25A0}-\u{27BF}]/mu;
const DONE_RE = /^>\s*상태:\s*✅/m;
const MARK_RE = /^>\s*상태:\s*(\S+)/m;

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 20000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

/**
 * 한 줄을 축 목록으로. 알 수 없는 접두사는 버리지 않고 unknown_axis 로 남긴다(조용한 누락 금지).
 *
 * @AI:CONSTRAINT 🔴 `tool:` 축은 **일부러 없다.** 사장님 PC 판에는 있는데(`~/.claude/tools/` 안의
 *   스크립트를 돌려 JSON 을 비교한다) 직원 PC 에는 그 자리에 대응물이 없다. 근거 없이 열어 두면
 *   ① 쓰는 사람이 0인 축이 생기고 ② 완료조건 줄은 손으로 쓰는 자유 텍스트라 **임의 명령 실행 통로**가 된다.
 *   `tool:` 이 적혀 있으면 여기서 `unknown_axis` 로 잡혀 「검사 못 함」에 뜬다 — 조용히 통과시키지 않는다.
 */

/**
 * 「이 조각이 취소선 안인가」를 조각 순서대로 훑는다.
 *
 * @AI:INTENT 취소선이 «구분자를 넘어» 걸쳐 있을 수 있다 — 설명을 길게 쓰면
 *   `~~pr:357,361(정정 · 머지)~~` 가 `·` 로 쪼개져 열림/닫힘이 다른 조각에 떨어진다.
 * @AI:CONSTRAINT 🔴 이걸 안 보면 **끝난 항목이 「남은 것」으로 보인다** — 오탐 방향이 나쁘다.
 */
function scanStruck(cores) {
  let open = false;
  return cores.map((core) => {
    const startsHere = /^~~/.test(core);
    const closedHere = /^~~[\s\S]*~~/.test(core);
    const struck = startsHere || open;
    if (startsHere && !closedHere) open = true;          // 열고 안 닫음 → 뒤 조각도 취소선 안
    else if (open && /~~\s*$/.test(core)) open = false;  // 꼬리에서 닫힘
    return struck;
  });
}

/**
 * @AI:CONSTRAINT 🔴 「모름」을 부풀리지 않는다 — 2026-09-14 실측(사장님 PC 판): 진행 중 301건 중
 *   unknown 51건의 실체가 gh 조회 실패가 아니라 **이 파서의 문법 누락**이었다. 끝난 항목의 취소선 42축 ·
 *   사람이 적어둔 자유 문장 76축 · 인자 뒤 괄호가 경로를 오염시킨 것이 섞여 있었고, 그 때문에
 *   「끝났는데 안 끝난 것」이 화면에서 「검사 못 함」으로 보였다. 수리 후 51 → 14.
 *
 * 세 갈래로 가른다 — 「이미 끝났다고 사람이 표시한 것(struck)」 · 「기계가 볼 축」 · 「사람이 적어둔 메모(note)」.
 * note 는 unknown 이 **아니다**(모르는 게 아니라 기계가 볼 것이 아니다). 다만 남아 있으면 ready 로 올리지 않는다.
 */
function parseCondition(line) {
  const cores = line.split(/[·|]/).map((s) => s.trim()).filter(Boolean);
  const flags = scanStruck(cores);
  return cores.map((raw, i) => {
    // ① 취소선 = 사람이 「이 항목은 끝났다」고 그어 둔 것
    const struck = flags[i];
    const st = raw.match(/^~~([\s\S]*?)~~/);
    let core = (struck && st ? st[1] : struck ? raw.replace(/^~~/, '').replace(/~~\s*$/, '') : raw).trim();
    // ② 백틱·볼드 장식 제거 (`pr:239` / **human:…**)
    core = core.replace(/^[`*_]+/, '').replace(/[`*_]+$/, '').trim();
    const m = core.match(/^(pr|commit|file|human):\s*([\s\S]+)$/);
    if (!m) {
      // 🔴 접두사가 «있는데» 지원 목록 밖이면 unknown_axis 로 남긴다 — 특히 `tool:`.
      //   위 @AI:CONSTRAINT 의 계약이다(조용히 통과시키지 않는다). note 로 접으면
      //   「검사 못 함」에서 사라지고 「사람 답 하나면 닫힘」으로 둔갑한다.
      if (/^[A-Za-z_][\w-]*:/.test(core)) return { kind: 'unknown_axis', raw, struck };
      return { kind: 'note', raw, struck };
    }
    // ③ 인자 뒤 괄호 주석 절단 — `file:경로 (설명)` 에서 설명이 경로에 붙던 것
    const arg = m[2].split(/\s+[(（]/)[0].replace(/[`*_]+$/, '').trim();
    return { kind: m[1], arg, raw, struck };
  });
}

function checkPr(arg) {
  const nums = arg.split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of nums) {
    if (!/^\d+$/.test(n)) return { ok: false, why: `PR 번호가 숫자가 아님: ${n}` };
    let state;
    try {
      state = sh('gh', ['pr', 'view', n, '--repo', PR_REPO, '--json', 'state', '-q', '.state'], { timeout: 25000 });
    } catch (e) {
      return { unknown: true, why: `조회 실패(gh): ${String(e.message || e).split('\n')[0].slice(0, 80)}` };
    }
    if (state !== 'MERGED') return { ok: false, why: `PR #${n} = ${state}` };
  }
  return { ok: true, why: `PR ${nums.join(',')} 전부 MERGED` };
}

/** commit:<sha>[@<ref>] — 팀팩 기본 브랜치는 main 이다(judgmentos 의 master 와 다르다). */
function checkCommit(arg) {
  const [sha, ref = 'origin/main'] = arg.split('@').map((s) => s.trim());
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { ok: false, why: `커밋 sha 형식 아님: ${sha}` };
  let sawRepo = false;
  for (const repo of REPOS) {
    if (!fs.existsSync(path.join(repo, '.git'))) continue;
    sawRepo = true;
    try {
      const out = sh('git', ['-C', repo, 'branch', '-r', '--contains', sha], { timeout: 15000 });
      if (out.split('\n').some((l) => l.trim().replace(/^\*?\s*/, '') === ref)) {
        return { ok: true, why: `${sha.slice(0, 8)} ∈ ${ref}` };
      }
    } catch { /* 그 레포에 없는 sha — 다음 자리로 */ }
  }
  if (!sawRepo) return { unknown: true, why: '팀팩 레포를 못 찾음(clone 위치 확인)' };
  return { ok: false, why: `${sha.slice(0, 8)} 이 ${ref} 에 없음` };
}

/** file:<경로> — `~`=홈, 절대경로, 그 외는 팀팩 레포 상대. */
function checkFile(arg) {
  const cands = arg.startsWith('~')
    ? [path.join(HOME, arg.slice(1).replace(/^[/\\]/, ''))]
    : (path.isAbsolute(arg) ? [arg] : REPOS.map((r) => path.join(r, arg)));
  const hit = cands.find((p) => fs.existsSync(p));
  return hit ? { ok: true, why: `실재: ${hit.replace(HOME, '~')}` } : { ok: false, why: `없음: ${arg}` };
}

function checkAxis(ax) {
  // 🔴 취소선은 「사람이 끝났다고 표시한 것」이다 — 다시 검사하지 않는다(그 표시가 곧 사람의 판정).
  if (ax.struck) return { done_marked: true, why: `끝남 표시: ${(ax.arg || ax.raw).slice(0, 60)}` };
  if (ax.kind === 'note') return { note: true, why: ax.raw.slice(0, 90) };
  if (ax.kind === 'human') return { human: true, why: ax.arg };
  if (ax.kind === 'unknown_axis') return { unknown: true, why: `모르는 축: ${ax.raw}` };
  try {
    if (ax.kind === 'pr') return checkPr(ax.arg);
    if (ax.kind === 'commit') return checkCommit(ax.arg);
    if (ax.kind === 'file') return checkFile(ax.arg);
  } catch (e) {
    return { unknown: true, why: `검사 중 예외: ${String(e.message || e).slice(0, 80)}` };
  }
  return { unknown: true, why: `미구현 축: ${ax.kind}` };
}

function evaluate(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (DONE_RE.test(src)) return null;              // 이미 닫힌 것은 대상 아님
  const name = path.basename(file);
  const one = ((src.match(/^## 한 줄\s*\n+([\s\S]{0,400}?)(?=\n## |\n$)/m) || [])[1] || '')
    .split('\n').map((s) => s.trim()).filter((s) => s && !/^[>~-]/.test(s))[0] || '';
  const mark = (src.match(MARK_RE) || [])[1] || '';
  const m = src.match(COND_RE);
  if (!m) return { file: name, one, mark, state: 'no_condition', axes: [] };

  const axes = parseCondition(m[1]).map((ax) => ({ ...ax, result: checkAxis(ax) }));
  const live = axes.filter((a) => !a.result.done_marked);          // 끝남 표시가 없는 것만 판정 대상
  const machine = live.filter((a) => !a.result.human && !a.result.note);
  const humans = live.filter((a) => a.result.human);
  const notes = live.filter((a) => a.result.note);
  const unknowns = machine.filter((a) => a.result.unknown);
  const unmet = machine.filter((a) => !a.result.unknown && !a.result.ok);
  const doneMarked = axes.length - live.length;

  // 🔴 unknown 이 하나라도 있으면 ready 로 올리지 않는다 — 「모름」은 「충족」이 아니다.
  // 🔴 note(사람이 적어둔 자유 문장)가 남아 있어도 ready 로 올리지 않는다 — 기계가 못 읽을 뿐
  //    「남은 것 = 내일 확인」 같은 실제 잔여가 거기 적혀 있다.
  const state = unknowns.length ? 'unknown'
    : unmet.length ? 'in_progress'
      : (humans.length || notes.length) ? 'waiting_human' : 'ready';
  return {
    file: name, one, mark, state, done_marked: doneMarked, notes: notes.length,
    axes: axes.map((a) => ({ kind: a.kind, raw: a.raw, struck: !!a.struck, ...a.result })),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const fi = argv.indexOf('--file');
  let files;
  if (!fs.existsSync(SPECS)) {
    const empty = { ran_at: new Date().toISOString(), total: 0, ready: 0, waiting_human: 0, in_progress: 0, unknown: 0, no_condition: 0, rows: [] };
    if (asJson) console.log(JSON.stringify(empty, null, 1));
    else console.log('[완료조건] 아직 핸드오프가 없습니다 (~/.claude/specs 없음)');
    return;
  }
  if (fi >= 0 && argv[fi + 1]) {
    files = [path.isAbsolute(argv[fi + 1]) ? argv[fi + 1] : path.join(SPECS, argv[fi + 1])];
  } else {
    // @AI:CONSTRAINT 파일명으로 거르지 않는다 — 판정축은 `> 상태: 🔵` 한 줄뿐이다.
    //   🔴 실측(2026-08-19): 이름에 'handoff' 를 요구했더니 상태 줄을 가진 161건 중 **48건(30%)** 을
    //   원리적으로 못 봤다. 전수 스캔이 2,040개에 0.44초라 필터가 애초에 필요 없었다.
    files = fs.readdirSync(SPECS)
      .filter((f) => f.endsWith('.md') && !f.includes('autohandoff'))
      .map((f) => path.join(SPECS, f))
      .filter((p) => { try { return OPEN_RE.test(fs.readFileSync(p, 'utf8')); } catch { return false; } });
  }
  const rows = files.map((f) => { try { return evaluate(f); } catch (e) { return { file: path.basename(f), state: 'unknown', error: String(e.message || e).slice(0, 100), axes: [] }; } }).filter(Boolean);
  const by = (s) => rows.filter((r) => r.state === s);
  const out = {
    ran_at: new Date().toISOString(),
    total: rows.length,
    ready: by('ready').length,
    waiting_human: by('waiting_human').length,
    in_progress: by('in_progress').length,
    unknown: by('unknown').length,
    no_condition: by('no_condition').length,
    // 🔑 「사람이 끝났다고 그어 둔 축」과 「기계가 못 읽는 메모」를 «숫자로» 낸다 —
    //    안 세면 이 둘이 unknown 에 섞여 「모름」을 부풀린다.
    done_marked_axes: rows.reduce((n, r) => n + (r.done_marked || 0), 0),
    note_axes: rows.reduce((n, r) => n + (r.notes || 0), 0),
    rows,
  };
  if (asJson) { console.log(JSON.stringify(out, null, 1)); return; }

  const show = (label, s, withWhy) => {
    const list = by(s);
    if (!list.length) return;
    console.log(`\n${label} ${list.length}건`);
    for (const r of list.slice(0, 12)) {
      console.log(`  · ${r.file.replace(/^\d{4}-/, '').replace(/\.md$/, '')}`);
      if (r.one) console.log(`      ${r.one.replace(/\*\*/g, '').slice(0, 90)}`);
      if (withWhy) for (const a of r.axes.filter(withWhy)) console.log(`      ${a.kind}: ${a.why}`);
    }
    if (list.length > 12) console.log(`  … 외 ${list.length - 12}건`);
  };
  console.log(`[완료조건] 진행 중 ${out.total}건 — 조건 적힌 것 ${out.total - out.no_condition}건`
    + ` (끝남 표시 ${out.done_marked_axes}축 · 사람 메모 ${out.note_axes}축)`);
  show('✅ 닫을 수 있는 것', 'ready', null);
  show('⏳ 사람 답 하나면 닫힘', 'waiting_human', (a) => a.human || a.note);
  show('🔵 진행 중', 'in_progress', (a) => !a.human && !a.ok && !a.unknown);
  show('⚠️ 검사 못 함 (「미충족」이 아니다)', 'unknown', (a) => a.unknown);
  if (out.no_condition) console.log(`\n📄 완료조건 미표기 ${out.no_condition}건 — /jedi-save 가 다음 회차에 채웁니다`);
}

if (require.main === module) main();
module.exports = { parseCondition, checkAxis, evaluate, scanStruck };
