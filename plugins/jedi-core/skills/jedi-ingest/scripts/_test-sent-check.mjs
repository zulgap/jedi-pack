#!/usr/bin/env node
// sent-check.mjs 시험 — 실행 모양 그대로(scan-folder → filter → record → 다시 filter) + 미래 상태 합성.
// 쓰는 법: node _test-sent-check.mjs   (임시 폴더만 쓴다 · 네트워크 없음)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterScan, applyDone, isUnchanged } from './sent-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SENT = path.join(here, 'sent-check.mjs');
const SCAN = path.join(here, 'scan-folder.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-check-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
// 기록 파일이 진짜 홈으로 가지 않게 시험 안에서만 홈을 돌린다(윈도 USERPROFILE · 맥/리눅스 HOME).
const env = { ...process.env, HOME: home, USERPROFILE: home };
const run = (script, args) => execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
const runRaw = (args) => spawnSync(process.execPath, [SENT, ...args], { env, encoding: 'utf8' });
const f = (name) => path.join(tmp, name);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let pass = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const row = (file_path, over = {}) => ({
  file_path, file_hash: `h-${file_path}`, size_bytes: 10, mtime: '2026-11-06T00:00:00.000Z', suggest: { action: 'read' }, ...over,
});

// ── 순수 함수 ──
t('P1 해시가 같으면 그대로 · 다르면 다시', () => {
  const sent = { 'a.txt': { hash: 'h-a.txt', size: 1, mtime: 'x' } };
  assert.equal(isUnchanged(row('a.txt'), sent), true);
  assert.equal(isUnchanged(row('a.txt', { file_hash: 'new' }), sent), false);
  assert.equal(isUnchanged(row('b.txt'), sent), false);
});
t('P2 해시 없는 큰 파일은 크기·수정시각으로', () => {
  const big = row('big.pdf', { file_hash: null, size_bytes: 99, mtime: 'm1' });
  assert.equal(isUnchanged(big, { 'big.pdf': { hash: null, size: 99, mtime: 'm1' } }), true);
  assert.equal(isUnchanged(big, { 'big.pdf': { hash: null, size: 99, mtime: 'm2' } }), false);
  assert.equal(isUnchanged(big, { 'big.pdf': { hash: null, size: 98, mtime: 'm1' } }), false);
});
t('P3 기록 없음 = 전부 보낼 목록 · record:false', () => {
  const { todo, summary } = filterScan({ scan_batch: 'b', files: [row('a.txt')] }, null, 'conn');
  assert.equal(summary.record, false);
  assert.equal(todo.files.length, 1);
});
t('P4 빈 목록 · 합계가 맞는다', () => {
  const { summary } = filterScan({ scan_batch: 'b', files: [] }, {}, 'conn');
  assert.deepEqual([summary.total, summary.excluded, summary.unchanged, summary.todo, summary.read], [0, 0, 0, 0, 0]);
});
t('P5 등록된 이름이 PC 이름 후보를 대신한다', () => {
  const { todo } = filterScan({ connector_id: 'pc-guess', scan_batch: 'b', files: [] }, null, 'registered');
  assert.equal(todo.connector_id, 'registered');
});
t('P6 NFD 경로도 done 과 맞는다 · 못 찾은 수를 센다', () => {
  const nfd = '자료.txt'.normalize('NFD');
  const out = applyDone({ files: [row(nfd)] }, {}, ['자료.txt'.normalize('NFC'), '없는파일.txt']);
  assert.equal(out.saved, 1);
  assert.equal(out.unmatched, 1);
  assert.ok(out.sent[nfd]);
});
t('P7 done 에 없는 파일은 기록하지 않는다 · 옛 기록은 남는다', () => {
  const out = applyDone({ files: [row('a.txt'), row('b.txt')] }, { 'old.txt': { hash: 'o' } }, ['a.txt']);
  assert.ok(out.sent['a.txt']);
  assert.equal(out.sent['b.txt'], undefined);
  assert.ok(out.sent['old.txt']);
});

// ── 실행 모양 그대로 ──
const root = f('자료');
fs.mkdirSync(path.join(root, '넣는폴더'), { recursive: true });
fs.mkdirSync(path.join(root, '비밀폴더'), { recursive: true });
fs.writeFileSync(path.join(root, '넣는폴더', 'a.txt'), '가나다');
fs.writeFileSync(path.join(root, '넣는폴더', 'b.md'), '라마바');
fs.writeFileSync(path.join(root, '넣는폴더', 'c.mp4'), 'x');
fs.writeFileSync(path.join(root, '비밀폴더', '제외파일이름.txt'), '안 나가야 한다');
fs.writeFileSync(path.join(root, '.jedi-ingest.json'), JSON.stringify({ connector_id: 'test-conn', exclude: ['비밀폴더'] }));
const rescan = () => run(SCAN, [root, '--out', f('scan.json')]);
const filter = () => JSON.parse(run(SENT, ['filter', '--scan', f('scan.json'), '--connector', 'test-conn', '--out', f('todo.json')]));

t('E1 첫 실행 — 제외가 빠지고 기록은 없다', () => {
  rescan();
  const s = filter();
  assert.deepEqual([s.record, s.total, s.excluded, s.unchanged, s.todo, s.read], [false, 4, 1, 0, 3, 2]);
});
t('E2 🔴 제외 파일·폴더 이름이 todo.json 어디에도 없다', () => {
  const text = fs.readFileSync(f('todo.json'), 'utf8');
  assert.equal(text.includes('제외파일이름'), false);
  assert.equal(text.includes('비밀폴더'), false);
  assert.equal(readJson(f('todo.json')).connector_id, 'test-conn');
});
t('E3 record — 보낸 파일만 기록 · 제외 파일은 기록에도 없다', () => {
  fs.writeFileSync(f('done.json'), JSON.stringify(['넣는폴더/a.txt', '넣는폴더/b.md', '넣는폴더/c.mp4']));
  const out = JSON.parse(run(SENT, ['record', '--todo', f('todo.json'), '--connector', 'test-conn', '--done', f('done.json')]));
  assert.deepEqual(out, { saved: 3, unmatched: 0 });
  const rec = readJson(path.join(home, '.jedi-ingest', 'sent-test-conn.json'));
  assert.equal(Object.keys(rec).length, 3);
  assert.equal(JSON.stringify(rec).includes('제외파일이름'), false);
  assert.equal(fs.existsSync(path.join(home, '.jedi-ingest', 'sent-test-conn.json.tmp')), false);
});
t('E4 다시 돌리면 보낼 것 0', () => {
  rescan();
  const s = filter();
  assert.deepEqual([s.record, s.excluded, s.unchanged, s.todo, s.read], [true, 1, 3, 0, 0]);
});
t('E5 파일이 바뀌면 그 파일만 다시 나온다', () => {
  fs.writeFileSync(path.join(root, '넣는폴더', 'a.txt'), '바뀐 내용');
  rescan();
  const s = filter();
  assert.deepEqual([s.unchanged, s.todo], [2, 1]);
  assert.equal(readJson(f('todo.json')).files[0].file_path, '넣는폴더/a.txt');
});
t('E6 통로가 다르면 기록이 갈린다', () => {
  const out = JSON.parse(run(SENT, ['filter', '--scan', f('scan.json'), '--connector', 'other-conn', '--out', f('todo2.json')]));
  assert.equal(out.record, false);
  assert.equal(out.todo, 3);
});
t('E7 🔴 깨진 기록은 없음으로 치지 않고 멈춘다 · 덮어쓰지 않는다', () => {
  const p = path.join(home, '.jedi-ingest', 'sent-broken.json');
  fs.writeFileSync(p, '{깨짐');
  const a = runRaw(['filter', '--scan', f('scan.json'), '--connector', 'broken', '--out', f('todo3.json')]);
  assert.equal(a.status, 2);
  assert.equal(fs.existsSync(f('todo3.json')), false);
  const b = runRaw(['record', '--todo', f('todo.json'), '--connector', 'broken', '--done', f('done.json')]);
  assert.equal(b.status, 2);
  assert.equal(fs.readFileSync(p, 'utf8'), '{깨짐');
});
t('E8 경로 조각이 든 통로 이름은 거절', () => {
  for (const bad of ['../up', 'a/b', '']) {
    assert.equal(runRaw(['filter', '--scan', f('scan.json'), '--connector', bad, '--out', f('todo4.json')]).status, 2);
  }
});
t('E9 없는 scan · 모양 틀린 done 은 실패로 끝난다', () => {
  assert.equal(runRaw(['filter', '--scan', f('없음.json'), '--connector', 'test-conn', '--out', f('todo5.json')]).status, 2);
  fs.writeFileSync(f('bad-done.json'), '{"a":1}');
  assert.equal(runRaw(['record', '--todo', f('todo.json'), '--connector', 'test-conn', '--done', f('bad-done.json')]).status, 2);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} PASS · ${failed} FAIL`);
process.exit(failed ? 1 : 0);
