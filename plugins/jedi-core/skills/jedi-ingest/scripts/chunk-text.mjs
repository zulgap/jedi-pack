#!/usr/bin/env node
// 뽑아낸 본문 글(텍스트 파일)을 검색용 조각으로 나눈다 — 판단 0 (결정론).
// 쓰는 법: node chunk-text.mjs <본문.txt> [--size 1500]
// 나오는 것(JSON): { chunks: [...], extracted_chars, expected_chunk_count }
// @AI:INTENT 조각 크기를 매번 AI가 정하면 같은 파일이 돌 때마다 다르게 잘린다 → 스크립트로 고정한다.
//   문단(빈 줄) 경계를 먼저 지키고, 한 문단이 너무 길 때만 문장 끝에서 자른다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SIZE = 1500;

/** 글 → 조각 배열. 🔑 대화 경로(이 명령)와 전송 경로(outbox-write.mjs)가 이 함수 한 벌을 쓴다 — 갈리면 같은 파일이 경로마다 다르게 잘린다. */
export function chunkText(raw, size = DEFAULT_SIZE) {
  const text = String(raw).replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  const paras = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const splitLong = (p) => {
    if (p.length <= size) return [p];
    const parts = []; let cur = '';
    for (const sent of p.split(/(?<=[.!?。다요]\s)|(?<=\n)/)) {
      if ((cur + sent).length > size && cur) { parts.push(cur.trim()); cur = ''; }
      cur += sent;
      while (cur.length > size) { parts.push(cur.slice(0, size)); cur = cur.slice(size); }
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  };
  const chunks = []; let cur = '';
  for (const p of paras.flatMap(splitLong)) {
    if (cur && (cur.length + p.length + 2) > size) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args[0];
  const sIdx = args.indexOf('--size');
  const SIZE = sIdx > -1 ? Number(args[sIdx + 1]) : DEFAULT_SIZE;
  if (!file || !fs.existsSync(file)) { console.error('본문 텍스트 파일을 주세요'); process.exit(2); }
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  const chunks = chunkText(text, SIZE);
  console.log(JSON.stringify({ chunks, extracted_chars: text.length, expected_chunk_count: chunks.length }));
}
