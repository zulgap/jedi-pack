#!/usr/bin/env node
// 뽑아낸 본문 글(텍스트 파일)을 검색용 조각으로 나눈다 — 판단 0 (결정론).
// 쓰는 법: node chunk-text.mjs <본문.txt> [--size 1500]
// 나오는 것(JSON): { chunks: [...], extracted_chars, expected_chunk_count }
// @AI:INTENT 조각 크기를 매번 AI가 정하면 같은 파일이 돌 때마다 다르게 잘린다 → 스크립트로 고정한다.
//   문단(빈 줄) 경계를 먼저 지키고, 한 문단이 너무 길 때만 문장 끝에서 자른다.
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
const sIdx = args.indexOf('--size');
const SIZE = sIdx > -1 ? Number(args[sIdx + 1]) : 1500;
if (!file || !fs.existsSync(file)) { console.error('본문 텍스트 파일을 주세요'); process.exit(2); }

const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
const paras = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

function splitLong(p) {
  if (p.length <= SIZE) return [p];
  const parts = []; let cur = '';
  for (const sent of p.split(/(?<=[.!?。다요]\s)|(?<=\n)/)) {
    if ((cur + sent).length > SIZE && cur) { parts.push(cur.trim()); cur = ''; }
    cur += sent;
    while (cur.length > SIZE) { parts.push(cur.slice(0, SIZE)); cur = cur.slice(SIZE); }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const chunks = []; let cur = '';
for (const p of paras.flatMap(splitLong)) {
  if (cur && (cur.length + p.length + 2) > SIZE) { chunks.push(cur); cur = ''; }
  cur = cur ? `${cur}\n\n${p}` : p;
}
if (cur) chunks.push(cur);

console.log(JSON.stringify({ chunks, extracted_chars: text.length, expected_chunk_count: chunks.length }));
