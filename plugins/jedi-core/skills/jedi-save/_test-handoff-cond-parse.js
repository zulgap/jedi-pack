#!/usr/bin/env node
'use strict';
/**
 * _test-handoff-cond-parse — 완료조건 줄의 «장식 세 가지»를 잠근다.
 *
 * 왜: 사장님 PC 판 실측(2026-09-14) — 진행 중 301건 중 unknown 51건의 실체가
 *   gh 조회 실패가 아니라 **파서 문법 누락**이었다. 끝난 항목의 취소선 42축 ·
 *   사람이 적어둔 자유 문장 76축 · 인자 뒤 괄호 오염이 전부 `unknown_axis` 로 뭉개져
 *   트랙을 통째로 「검사 못 함」으로 떨어뜨렸다. 같은 코드가 여기에도 그대로 있었다.
 *
 * @AI:CONSTRAINT 🔴 done_marked(끝남 표시) / note(사람 메모) / unknown(진짜 모름)은 서로 다른 사실이다.
 *   셋을 한 칸에 섞으면 끝난 트랙이 영원히 열린 채로 남는다.
 * @AI:CONSTRAINT 🔴 `tool:` 은 여기서 **unknown 이어야 한다** — 직원 PC 에 대응물이 없어 일부러 뺀 축이라,
 *   note 로 접으면 「검사 못 함」에서 사라지고 「사람 답 하나면 닫힘」으로 둔갑한다.
 */
const assert = require('assert');
const { parseCondition, checkAxis } = require('./handoff-done-check.js');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); process.exitCode = 1; }
};
const one = (line) => parseCondition(line)[0];

console.log('[완료조건 파서]');

t('평범한 축은 그대로 (회귀)', () => {
  const a = one('pr:239');
  assert.strictEqual(a.kind, 'pr');
  assert.strictEqual(a.arg, '239');
  assert.ok(!a.struck);
});

t('취소선 = 끝남 표시 (kind 도 살아 있다)', () => {
  const a = one('~~pr:239,241~~');
  assert.strictEqual(a.struck, true);
  assert.strictEqual(a.kind, 'pr');
  assert.strictEqual(a.arg, '239,241');
});

t('취소선 뒤 괄호 설명이 붙어도 끝남 표시', () => {
  const a = one('~~human:대표님-확인~~(2026-09-13 확정)');
  assert.strictEqual(a.struck, true);
  assert.strictEqual(a.kind, 'human');
});

t('백틱·볼드 장식 제거', () => {
  assert.strictEqual(one('`pr:239`').kind, 'pr');
  assert.strictEqual(one('**pr:239**').arg, '239');
});

t('인자 뒤 괄호 주석 절단 — 경로를 오염시키지 않는다', () => {
  const a = one('file:plugins/x/y.md   (설명이 여기 붙으면 안 된다');
  assert.strictEqual(a.kind, 'file');
  assert.strictEqual(a.arg, 'plugins/x/y.md');
});

t('전각 괄호도 절단', () => {
  assert.strictEqual(one('file:docs/x.md （설명）').arg, 'docs/x.md');
});

t('접두사 없는 자유 문장 = note (unknown 아님)', () => {
  const a = one('**남은 것 = 내일 확인**');
  assert.strictEqual(a.kind, 'note');
});

t('🔴 tool: 은 note 가 아니라 unknown — 직원 PC 에 대응물이 없다', () => {
  const a = one('tool:handoff-done-check.js --json .ready>0');
  assert.strictEqual(a.kind, 'unknown_axis',
    'note 로 접으면 「검사 못 함」에서 사라져 조용히 통과한다');
});

t('모르는 접두사도 unknown 으로 남는다', () => {
  assert.strictEqual(one('deploy:staging').kind, 'unknown_axis');
});

t('취소선이 구분자를 넘어가도 끝남으로 본다', () => {
  const ax = parseCondition('~~pr:357,361(차단 · 문구 정정 — 머지)~~ · human:남은-일');
  assert.deepStrictEqual(ax.map((a) => !!a.struck), [true, true, false]);
  assert.strictEqual(ax[2].kind, 'human');
});

t('취소선이 닫힌 뒤 조각은 다시 살아난다', () => {
  const ax = parseCondition('~~pr:1 · pr:2~~ · human:살아있음 · pr:3');
  assert.deepStrictEqual(ax.map((a) => !!a.struck), [true, true, false, false]);
});

t('구분자로 갈린 여러 축을 각각 판정', () => {
  const ax = parseCondition('~~pr:239~~ · `pr:241`(머지) · 남은 것 = 확인 · human:대표님-결정');
  assert.deepStrictEqual(ax.map((a) => a.kind), ['pr', 'pr', 'note', 'human']);
  assert.deepStrictEqual(ax.map((a) => !!a.struck), [true, false, false, false]);
});

console.log('[checkAxis 분류]');

t('취소선은 검사하지 않고 done_marked', () => {
  const r = checkAxis({ kind: 'pr', arg: '239', raw: '~~pr:239~~', struck: true });
  assert.strictEqual(r.done_marked, true);
  assert.ok(!r.ok && !r.unknown && !r.human);
});

t('note 는 unknown 이 아니다', () => {
  const r = checkAxis({ kind: 'note', raw: '남은 것 = 확인', struck: false });
  assert.strictEqual(r.note, true);
  assert.notStrictEqual(r.unknown, true);
});

t('human 은 여전히 사람 몫', () => {
  assert.strictEqual(checkAxis({ kind: 'human', arg: 'x', raw: 'human:x', struck: false }).human, true);
});

t('진짜 모르는 축은 unknown 으로 남는다', () => {
  assert.strictEqual(checkAxis({ kind: 'unknown_axis', raw: 'tool:x', struck: false }).unknown, true);
});

console.log('[진행 중 표식 스캔]');

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, 'handoff-done-check.js'), 'utf8');
const openLine = (src.match(/^const OPEN_RE = .+$/m) || [])[0];
assert.ok(openLine, 'OPEN_RE 선언을 못 찾음 — 마커 변경됨');
const OPEN_RE = vm.runInNewContext(openLine + '; OPEN_RE');
const line = (mk) => '> 상태: ' + mk + ' 진행';

t('🔵 는 진행 중', () => assert.ok(OPEN_RE.test(line('🔵'))));

t('✅ 종결은 진행 중이 아니다', () => assert.ok(!OPEN_RE.test(line('✅'))));

t('🟢·🟡·🔴 등 다른 색도 진행 중으로 본다', () => {
  // 🔴 사장님 PC 판 실측: 🔵 만 보면 25건이 통째로 안 보였다(그중 🟢 가 12건)
  for (const mk of ['🟢', '🟡', '🔴', '⬜', '⏸', '⬛', '🔀', '⛔', '📋']) {
    assert.ok(OPEN_RE.test(line(mk)), mk + ' 를 놓치면 그 트랙이 통째로 안 보인다');
  }
});

t('레거시 글자 라벨은 여전히 제외 (노이즈 방지)', () => {
  for (const mk of ['**진행중**', 'IN_PROGRESS', '설계', 'DRAFT']) {
    assert.ok(!OPEN_RE.test(line(mk)), mk + ' 까지 넣으면 옛 문서가 쏟아진다');
  }
});

console.log(pass + '개 통과');
