#!/usr/bin/env node
// start-brief.js — 얇은 /jedi-start 의 «이어서 할 일» 재료를 결정론으로 한 번에 낸다
// 사용: node start-brief.js [--hint "<말씀·인자>"] [--json]
//
// @AI:INTENT 옛 문서의 bash 조회(로케일 함정·맥 date·머리 블록 판정)를 도구 한 벌로 옮겨 지시문을 줄인다.
// @AI:CONSTRAINT 읽기 전용 — 트랙을 닫거나 고르지 않는다. 닫기는 /jedi-save · 고르기는 사람.
// @AI:CONSTRAINT 「오래됨 ≠ 끝남」 — 3일 넘은 트랙은 접을 뿐 빼지 않는다. 날짜를 못 읽으면 안 접는다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 핸드오프 글 → 머리 블록(첫 `>` 묶음). 순수. */
function headerBlock(text) {
  const out = [];
  let started = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('>')) { started = true; out.push(line); } else if (started) break;
  }
  return out;
}

/** 줄 머리가 상태급인 종결만 — 「선행: …(✅ 종결)」 인라인 언급은 닫힌 게 아니다(9/8 전수 39건 오탐). */
function isClosed(header) {
  return header.some((l) => /^> *(·|-|상태:)? *✅ *\**종결/.test(l));
}

function field(header, name) {
  const re = new RegExp(`^> *${name}: *`);
  const l = header.find((x) => re.test(x));
  return l ? l.replace(re, '').trim() : null;
}

/** `## 한 줄` 의 실질 문장 — 메타(⟳·취소선·인용)를 건너뛰고 강조 줄을 먼저 고른다(8/15 정반대 오독). */
function oneLine(text) {
  const lines = String(text).split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('## 한 줄'));
  if (i < 0) return '';
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.startsWith('## ')) break;
    if (!l.trim() || l.startsWith('--') || l.startsWith('> ') || l.startsWith('~~') || l.includes('⟳')) continue;
    body.push(l.trim());
  }
  return (body.find((l) => l.startsWith('**')) || body[0] || '').replace(/\*\*/g, '');
}

/** 파일 하나 → 후보(또는 null). 순수. recentCut·foldCut 은 YYYY-MM-DD. */
function judgeHandoff(name, text, { recentCut, foldCut }) {
  if (!/handoff/.test(name) || /autohandoff/.test(name)) return null;
  const header = headerBlock(text);
  if (isClosed(header)) return null;
  const status = field(header, '상태');
  const live = !!status && /^🔵/.test(status);
  const date = (name.match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
  if (!live && !(date && date >= recentCut)) return null; // 상태 없는 옛 파일은 최근 2일치만
  const old = !!date && date < foldCut; // 날짜 못 읽으면 접지 않는다
  return { file: name, date, marked: live, status, one: oneLine(text), old, author: field(header, '작성자'), belongs: field(header, '소속') };
}

/** 말씀 낱말이 파일명·한 줄에 몇 개 맞나. 순수. */
function hintScore(c, hint) {
  const words = String(hint || '').split(/[\s,·/「」]+/).filter((w) => w.length >= 2);
  const hay = `${c.file} ${c.one}`.toLowerCase();
  return words.filter((w) => hay.includes(w.toLowerCase())).length;
}

function listHandoffs(specDir, now, hint) {
  const recentCut = localDate(now - 864e5);
  const foldCut = localDate(now - 3 * 864e5);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(specDir); } catch { return out; } // 폴더가 없으면 후보 0(처음 쓰는 PC)
  for (const name of names) {
    if (!name.endsWith('.md') || !name.includes('handoff')) continue;
    let text;
    try { text = fs.readFileSync(path.join(specDir, name), 'utf8'); } catch { continue; }
    const c = judgeHandoff(name, text, { recentCut, foldCut });
    if (c) out.push({ ...c, score: hintScore(c, hint) });
  }
  out.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

function gitDirty() {
  try {
    const s = execFileSync('git', ['status', '--short'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return s.split('\n').filter((l) => l && !l.startsWith('??')).length;
  } catch { return null; } // 저장소가 아니거나 못 읽음 — 0 이 아니다
}

function main(argv) {
  const i = argv.indexOf('--hint');
  const hint = i >= 0 ? argv[i + 1] || '' : '';
  const now = Date.now();
  const specDir = path.join(os.homedir(), '.claude', 'specs');
  const all = listHandoffs(specDir, now, hint);
  const recent = all.filter((c) => !c.old || c.score > 0);
  const today = localDate(now);
  let autos = [];
  try { autos = fs.readdirSync(specDir).filter((n) => n.startsWith(today) && n.includes('autohandoff')).sort().reverse().slice(0, 3); } catch { /* 폴더 없음 */ }
  const result = { candidates: recent, old_count: all.length - recent.length, autohandoffs: autos, dirty_files: gitDirty() };
  if (argv.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`이어서 할 일 후보 ${recent.length}건 (3일 넘은 것 ${result.old_count}건은 접음 — 끝난 건 아님)`);
  for (const c of recent.slice(0, 8)) {
    const tail = [c.belongs && `소속: ${c.belongs}`, c.author && `작성자: ${c.author}`].filter(Boolean).join(' · ');
    console.log(`${c.score ? '★ ' : ''}${c.date || '날짜없음'} ${c.marked ? '' : '⚠️ 상태 미표기 '}${c.file}\n   ${c.one || '(한 줄 없음)'}${tail ? `\n   ${tail}` : ''}`);
  }
  if (recent.length > 8) console.log(`…외 ${recent.length - 8}건`);
  if (autos.length) console.log(`오늘 끊긴 흔적: ${autos.join(', ')}`);
  if (result.dirty_files) console.log(`이 폴더에 저장 안 된 변경 ${result.dirty_files}개 — 다른 창이 잡고 있을 수 있음`);
}

module.exports = { headerBlock, isClosed, field, oneLine, judgeHandoff, hintScore };
if (require.main === module) main(process.argv.slice(2));
