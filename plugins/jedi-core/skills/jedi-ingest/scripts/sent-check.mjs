#!/usr/bin/env node
// 이미 넣은 파일을 해시로 거르고, 보낸 파일을 이 PC 에 기록한다 — 판단 0 (결정론).
// 쓰는 법:
//   node sent-check.mjs filter --scan <scan.json> --connector <등록된 통로 이름> --out <todo.json>
//   node sent-check.mjs record --todo <todo.json> --connector <등록된 통로 이름> --done <done.json>
// 기록 파일: ~/.jedi-ingest/sent-<통로 이름>.json = { 경로: { hash, size, mtime } }
// @AI:INTENT 대조를 클로드가 눈으로 하면 파일이 많을수록 틀린다 → 코드로 고정한다. 서버 원장을 읽는 문이 없어 이 PC 기록이 유일한 기준이다.
// @AI:CONSTRAINT 🔴 넣지 않기로 한 파일(excluded_by_rule)의 경로·규칙은 todo.json 에 절대 싣지 않는다 — 그 파일이 서버로 나가는 재료이기 때문이다.
// @AI:CONSTRAINT 이 스크립트는 scan·todo·done·기록 파일만 읽고 쓴다. 네트워크·열쇠·토큰·환경변수를 쓰지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED_REASON = 'excluded_by_rule';

/** 기록과 같은 파일인가 — 해시가 있으면 해시로, 없으면(30MB 초과) 크기·수정시각으로. */
export function isUnchanged(file, sent) {
  const prev = sent && sent[file.file_path];
  if (!prev) return false;
  if (file.file_hash) return prev.hash === file.file_hash;
  return prev.size === file.size_bytes && prev.mtime === file.mtime;
}

/** scan 결과 + 기록 → 보낼 목록과 숫자. 제외 규칙·덩어리 요약·폴더 위치는 결과에 싣지 않는다. */
export function filterScan(scan, sent, connector) {
  const kept = scan.files.filter((f) => f.suggest?.reason !== EXCLUDED_REASON);
  const todo = kept.filter((f) => !isUnchanged(f, sent));
  const read = todo.filter((f) => f.suggest?.action === 'read');
  return {
    todo: { connector_id: connector, scan_batch: scan.scan_batch, files: todo },
    summary: {
      record: !!sent,
      total: scan.files.length,
      excluded: scan.files.length - kept.length,
      unchanged: kept.length - todo.length,
      todo: todo.length,
      read: read.length,
      read_bytes: read.reduce((n, f) => n + (f.size_bytes || 0), 0),
      ask: todo.filter((f) => f.suggest?.action === 'ask').length,
    },
  };
}

/** 응답에서 실패가 아닌 경로들을 기록에 더한다. 맥 한글 이름은 낱자 분리(NFD)일 수 있어 NFC 로 맞춰 대조한다. */
export function applyDone(todo, sent, donePaths) {
  const nfc = (x) => String(x).normalize('NFC');
  const left = new Set(donePaths.map(nfc));
  const next = { ...sent };
  let saved = 0;
  for (const f of todo.files) {
    if (left.delete(nfc(f.file_path))) {
      next[f.file_path] = { hash: f.file_hash ?? null, size: f.size_bytes ?? null, mtime: f.mtime ?? null };
      saved++;
    }
  }
  return { sent: next, saved, unmatched: left.size };
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`${label} 을 읽지 못했습니다: ${file} (${e.message})`);
  }
}

function recordFile(connector) {
  // 통로 이름이 파일 이름이 되므로 경로 조각이 못 들어오게 막는다.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(connector || '')) fail(`통로 이름이 올바르지 않습니다: ${connector}`);
  return path.join(os.homedir(), '.jedi-ingest', `sent-${connector}.json`);
}

// @AI:CONSTRAINT 🔴 기록이 «없음»과 «깨짐»을 가른다. 깨진 것을 없음으로 치면 전부 다시 보내고, 그대로 덮으면 기록을 잃는다 → 멈춘다.
function loadRecord(file) {
  if (!fs.existsSync(file)) return null;
  const sent = readJson(file, '보낸 파일 기록');
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) fail(`보낸 파일 기록의 모양이 틀렸습니다: ${file}`);
  return sent;
}

function writeRecord(file, sent) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sent, null, 1));
  fs.renameSync(tmp, file);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i > -1 ? rest[i + 1] : undefined;
  };
  const connector = opt('connector');
  if (cmd === 'filter') {
    if (!opt('scan') || !opt('out')) fail('쓰는 법: sent-check.mjs filter --scan <scan.json> --connector <이름> --out <todo.json>');
    const sentPath = recordFile(connector);
    const scan = readJson(opt('scan'), 'scan 결과');
    if (!Array.isArray(scan.files)) fail('scan 결과에 files 목록이 없습니다');
    const { todo, summary } = filterScan(scan, loadRecord(sentPath), connector);
    fs.writeFileSync(opt('out'), JSON.stringify(todo, null, 2));
    console.log(JSON.stringify(summary));
    return;
  }
  if (cmd === 'record') {
    if (!opt('todo') || !opt('done')) fail('쓰는 법: sent-check.mjs record --todo <todo.json> --connector <이름> --done <done.json>');
    const sentPath = recordFile(connector);
    const todo = readJson(opt('todo'), 'todo 목록');
    const done = readJson(opt('done'), 'done 목록');
    if (!Array.isArray(todo.files)) fail('todo 목록에 files 가 없습니다');
    if (!Array.isArray(done)) fail('done 은 경로 배열이어야 합니다');
    const { sent, saved, unmatched } = applyDone(todo, loadRecord(sentPath) || {}, done);
    writeRecord(sentPath, sent);
    console.log(JSON.stringify({ saved, unmatched }));
    return;
  }
  fail('쓰는 법: sent-check.mjs filter|record …');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
