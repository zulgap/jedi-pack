// «넣지 않을 것» 규칙 한 벌 — 훑기(scan-folder)와 쌓기(outbox-write)가 같은 판정을 쓴다. 판단 0 (결정론).
// 규칙 파일: 자료 폴더 맨 위 .jedi-ingest.json 의 exclude
//   · 이름만 적으면(`인사`) 어느 깊이의 폴더·파일이든 그 이름이면 뺀다
//   · 사이에 / 가 있으면(`2024/인사`) 맨 위 기준 경로로 뺀다
// @AI:CONSTRAINT 🔴 비교는 양쪽을 맞춘 뒤에만 한다 — 맥 낱자 분리(NFD) · 윈도 역슬래시 · 앞의 ./ / · 대소문자(맥·윈도 기본 디스크는 구분 안 함).
//   맞추지 않으면 규칙이 조용히 안 먹어 넣지 않기로 한 자료가 나간다. 어긋날 때는 빼는 쪽으로 간다.
import fs from 'node:fs';
import path from 'node:path';

const clean = (x) => String(x).normalize('NFC').replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '').replace(/\/+$/, '').toLowerCase();

export function normalizeRules(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('exclude 는 목록이어야 합니다');
  return list.map(clean).filter(Boolean);
}

export function hitsRule(rel, rule) {
  const r = clean(rel);
  if (rule.includes('/')) return r === rule || r.startsWith(`${rule}/`);
  return r.split('/').includes(rule);
}

export const isExcluded = (rel, rules) => rules.some((rule) => hitsRule(rel, rule));

/** 규칙 파일 읽기. 🔴 «없음»일 때만 규칙 0 — 깨진 것을 없음으로 치면 제외가 통째로 꺼진다(그때는 던진다 · 부르는 쪽이 멈춘다). BOM 은 뗀다. */
export function loadRules(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.jedi-ingest.json'), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const rule = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return normalizeRules(rule.exclude);
}
