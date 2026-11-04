// node plugins/jedi-core/skills/jedi-start/_test-start-brief.js — 얇은 시작 재료 판정 + 실행 모양 그대로
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const B = require('./start-brief.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const cuts = { recentCut: '2026-11-03', foldCut: '2026-11-01' };
const doc = (hdr, one = '**끝내려면 이것을 한다**') => `# 핸드오프\n\n${hdr}\n\n## 한 줄\n${one}\n\n## 잔여\n`;

const live = doc('> 작성: x\n> 상태: 🔵 진행\n> 작성자: 나래\n> 소속: 줄갭 › 판단OS 개발');
ok(B.judgeHandoff('2026-11-04-handoff-a.md', live, cuts).marked, '🔵 = 후보');
ok(B.judgeHandoff('2026-11-04-handoff-a.md', live, cuts).author === '나래', '작성자 줄을 읽는다');
ok(B.judgeHandoff('2026-11-04-handoff-a.md', live, cuts).belongs === '줄갭 › 판단OS 개발', '소속 줄을 읽는다');
ok(!B.judgeHandoff('2026-11-04-handoff-a.md', live, cuts).old, '최근은 안 접음');
ok(B.judgeHandoff('2026-10-01-handoff-a.md', live, cuts).old, '오래된 🔵 는 접되 남는다(오래됨≠끝남)');
ok(B.judgeHandoff('2026-11-04-autohandoff-a.md', live, cuts) === null, 'autohandoff 제외');
ok(B.judgeHandoff('2026-11-04-handoff-a.md', doc('> 상태: ✅ 종결 (2026-11-04)'), cuts) === null, '종결 제외');
ok(B.judgeHandoff('2026-11-04-handoff-a.md', doc('> 상태: 🔵 진행\n> · ✅ 종결 — 다른 세션이 덧붙임'), cuts) === null, '머리 블록 아래 덧붙인 종결도 읽는다(9/8)');
ok(B.judgeHandoff('2026-11-04-handoff-a.md', doc('> 상태: 🔵 진행\n> 선행: x (✅ 종결 — 이 파일이 승계)'), cuts).marked, '인라인 언급은 닫힌 게 아니다');
ok(B.judgeHandoff('2026-11-04-handoff-a.md', doc('> 작성: x'), cuts).marked === false, '상태 없는 최근 파일 = 미표기 후보');
ok(B.judgeHandoff('2026-10-01-handoff-a.md', doc('> 작성: x'), cuts) === null, '상태 없는 옛 파일은 후보 아님');
ok(!B.judgeHandoff('handoff-무날짜.md', live, cuts).old, '날짜를 못 읽으면 접지 않는다');
ok(B.judgeHandoff('2026-11-04-spec.md', live, cuts) === null, '핸드오프 아닌 파일 제외');

ok(B.oneLine(doc('> x', '⟳ 갱신 — 이미 해결된 것을 가리켰다\n**지금 남은 것은 여섯 건**')) === '지금 남은 것은 여섯 건', '⟳ 메타 줄에 속지 않는다');
ok(B.oneLine('제목만') === '', '한 줄 절 없음');
ok(B.hintScore({ file: '2026-11-04-handoff-card-ledger.md', one: '카드 명세서' }, '카드 어디까지') === 1, '말씀 낱말 일치');

// 실행 모양 그대로 — HOME 을 임시로
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'start-brief-'));
const env = { ...process.env, USERPROFILE: home, HOME: home };
const tool = path.join(__dirname, 'start-brief.js');
const run = (...a) => execFileSync('node', [tool, ...a], { env, encoding: 'utf8', cwd: home });
let j = JSON.parse(run('--json')); // specs 폴더가 없는 새 PC
ok(j.candidates.length === 0 && j.autohandoffs.length === 0, '새 PC — 폴더 없어도 죽지 않는다');
ok(j.dirty_files === null, '저장소가 아니면 null(0 이 아니다)');
const spec = path.join(home, '.claude', 'specs');
fs.mkdirSync(spec, { recursive: true });
const pad = (x) => String(x).padStart(2, '0');
const d = (ago) => { const t = new Date(Date.now() - ago * 864e5); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
fs.writeFileSync(path.join(spec, `${d(0)}-handoff-new.md`), live);
fs.writeFileSync(path.join(spec, `${d(9)}-handoff-card.md`), doc('> 상태: 🔵 진행', '**카드 정리**'));
fs.writeFileSync(path.join(spec, `${d(9)}-handoff-other.md`), live);
fs.writeFileSync(path.join(spec, `${d(0)}-handoff-done.md`), doc('> 상태: ✅ 종결 (오늘)'));
fs.writeFileSync(path.join(spec, `${d(0)}-autohandoff-x.md`), '> x');
j = JSON.parse(run('--json'));
ok(j.candidates.length === 1 && j.old_count === 2, '최근 1 · 접음 2 · 종결 제외');
ok(j.autohandoffs.length === 1, '끊긴 흔적');
j = JSON.parse(run('--json', '--hint', '카드 어디까지'));
ok(j.candidates.length === 2 && j.candidates[0].file.includes('card'), '말씀에 맞으면 옛 트랙도 펼쳐 맨 앞에');
ok(run().includes('작성자: 나래'), '말로도 작성자를 알린다');
fs.rmSync(home, { recursive: true, force: true });

console.log(`_test-start-brief: ${n}개 항목 통과`);
