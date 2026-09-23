#!/usr/bin/env node
'use strict';
// _test-auto-capture.js — ffmpeg·장치 없이 순수 함수로 감지·종료 판정을 잠근다 (합성 stderr 줄)
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const m = require('./auto-capture.js');
let pass = 0; const cases = [];
const t = (n, f) => cases.push([n, f]);

t('A1 dshow 목록 파싱 — 영상/음성 분리', () => {
  const d = m.parseDshowDevices('[dshow @ 0] "USB Video" (video)\n[dshow @ 0]   Alternative name "@device_pnp"\n[dshow @ 0] "USB Audio" (audio)\n');
  assert.deepStrictEqual(d, { video: ['USB Video'], audio: ['USB Audio'] });
});
t('A2 감지 줄 파싱 — black/silence/progress · 그 외 null', () => {
  assert.deepStrictEqual(m.parseDetectLine('[blackdetect @ 0] black_start:12.5 black_end:40 black_duration:27.5'), { kind: 'black_start', t: 12.5 });
  assert.deepStrictEqual(m.parseDetectLine('[silencedetect @ 0] silence_end: 3.2 | silence_duration: 3.2'), { kind: 'silence_end', t: 3.2 });
  assert.deepStrictEqual(m.parseDetectLine('frame=  100 fps=30 time=00:01:30.50 bitrate=N/A'), { kind: 'progress', t: 90.5 });
  assert.strictEqual(m.parseDetectLine('Stream mapping:'), null);
});
t('B1 대기: 검정·무음이 풀리면 hasSignal', () => {
  const tr = m.createSignalTracker();
  tr.feed({ kind: 'black_start', t: 0 }); tr.feed({ kind: 'silence_start', t: 0 });
  assert.strictEqual(tr.feed({ kind: 'progress', t: 10 }).hasSignal, false);
  tr.feed({ kind: 'black_end', t: 12 });
  assert.strictEqual(tr.verdict().hasSignal, false, '소리는 아직 무음');
  assert.strictEqual(tr.feed({ kind: 'silence_end', t: 12.5 }).hasSignal, true);
});
t('B2 종료: 내용을 본 뒤 검정 30s AND 무음 30s 여야 ended', () => {
  const tr = m.createSignalTracker({ black_sec: 30, silence_sec: 30 });
  tr.feed({ kind: 'black_end', t: 1 }); tr.feed({ kind: 'silence_end', t: 1 });
  tr.feed({ kind: 'black_start', t: 100 });
  assert.strictEqual(tr.feed({ kind: 'progress', t: 140 }).ended, false, '검정만 40s — 소리가 있으면 안 끝남');
  tr.feed({ kind: 'silence_start', t: 120 });
  assert.strictEqual(tr.feed({ kind: 'progress', t: 145 }).ended, false, '무음 25s');
  assert.strictEqual(tr.feed({ kind: 'progress', t: 151 }).ended, true);
});
t('B3 내용을 본 적 없으면(테이프 없음) 아무리 검정·무음이어도 ended 아님', () => {
  const tr = m.createSignalTracker();
  tr.feed({ kind: 'black_start', t: 0 }); tr.feed({ kind: 'silence_start', t: 0 });
  assert.strictEqual(tr.feed({ kind: 'progress', t: 3600 }).ended, false);
});
t('B4 중간 무음(조용한 장면)은 화면이 있으면 안 끝남', () => {
  const tr = m.createSignalTracker();
  tr.feed({ kind: 'black_end', t: 1 }); tr.feed({ kind: 'silence_end', t: 1 });
  tr.feed({ kind: 'silence_start', t: 50 });
  assert.strictEqual(tr.feed({ kind: 'progress', t: 200 }).ended, false);
});
t('C1 녹화 인자: 무손실 ffv1+pcm · 감지 필터 동시 출력 · 출력 경로', () => {
  const a = m.buildRecordArgs('V', 'A', 'o.mkv', {});
  for (const k of ['ffv1', 'pcm_s16le', 'o.mkv', 'dshow']) assert.ok(a.includes(k), k);
  assert.ok(a.some((x) => /blackdetect/.test(x)) && a.some((x) => /silencedetect/.test(x)));
  assert.ok(a.includes('video=V:audio=A'));
});
t('C2 대기 인자: 파일을 만들지 않는다(-f null)', () => {
  const a = m.buildWaitArgs('V', 'A', {});
  assert.ok(a.includes('null') && !a.some((x) => /\.mkv|\.mp4/.test(x)));
});
t('C3 임계값은 설정으로 바뀐다', () => {
  const a = m.buildRecordArgs('V', 'A', 'o', { black_pic_th: 0.9, silence_db: -40 });
  assert.ok(a.includes('blackdetect=d=1:pic_th=0.9') && a.includes('silencedetect=n=-40dB:d=1'));
});
t('D1 출력 이름: 고객명 위험문자 제거 · mkv · 폴더 안', () => {
  const p = m.outputName('out', '김:철/수');
  assert.ok(p.startsWith(path.join('out', '김_철_수_')) && p.endsWith('.mkv'));
});
t('F1 시작 관문: --rewound 없으면 거부 · 있으면 통과 · --dry/--list 는 관문 밖', () => {
  assert.strictEqual(m.startGate(['--out', 'x']).ok, false);
  assert.ok(/되감/.test(m.startGate(['--out', 'x']).reason));
  assert.strictEqual(m.startGate(['--out', 'x', '--rewound']).ok, true);
  assert.strictEqual(m.startGate(['--out', 'x', '--dry']).ok, true);
  assert.strictEqual(m.startGate(['--list']).ok, true);
});
t('F2 첫 장면 사진: 녹화 명령엔 없고(볼 화면 10초 멈춤) 녹화 중 파일에서 따로 뽑는다 · 시각은 설정', () => {
  const out = path.join('out', 't.mkv');
  const shot = path.join('out', 't_first.jpg');
  assert.strictEqual(m.firstFramePath(out), shot);
  const rec = m.buildRecordArgs('V', 'A', out, {}, { view: true });
  assert.ok(!rec.includes(shot) && !rec.includes('-ss'), '녹화 명령에 사진 출력이 붙으면 볼 화면이 처음 10초 멈춘다');
  const a = m.buildFirstFrameArgs(out, {});
  assert.strictEqual(a[a.indexOf('-ss') + 1], '10');
  assert.ok(a.indexOf('-ss') < a.indexOf('-i'), '-ss 는 입력 앞(빠른 탐색)');
  assert.strictEqual(a[a.indexOf('-i') + 1], out);
  assert.strictEqual(a[a.length - 1], shot);
  const b = m.buildFirstFrameArgs(out, { first_frame_sec: 20 });
  assert.strictEqual(b[b.indexOf('-ss') + 1], '20');
});
t('F3 멈춤 파일: 녹화 파일 옆 .stop', () => {
  assert.strictEqual(m.stopFilePath(path.join('out', 't.mkv')), path.join('out', 't.mkv') + '.stop');
});
t('G1 -nostdin 금지 — 멈춤 신호(stdin q)를 ffmpeg 가 무시한다 (2026-09-23 실측 결함)', () => {
  for (const a of [m.buildWaitArgs('V', 'A', {}), m.buildRecordArgs('V', 'A', 'o.mkv', {}),
    m.buildWaitArgs('V', 'A', {}, { view: true }), m.buildRecordArgs('V', 'A', 'o.mkv', {}, { view: true })]) {
    assert.ok(!a.includes('-nostdin'), a.join(' '));
  }
});
t('G2 볼 화면: view 면 대기·녹화 둘 다 pipe:1 출력 · 아니면 없음', () => {
  assert.ok(m.buildWaitArgs('V', 'A', {}, { view: true }).includes('pipe:1'));
  const r = m.buildRecordArgs('V', 'A', 'o.mkv', {}, { view: true });
  assert.ok(r.includes('pipe:1'));
  assert.ok(!m.buildWaitArgs('V', 'A', {}).includes('pipe:1'));
  assert.ok(!m.buildRecordArgs('V', 'A', 'o.mkv', {}).includes('pipe:1'));
});
t('E1 장치 이름·OS 경로 하드코딩 0 · VCR 제어 코드 0', () => {
  const src = fs.readFileSync(path.join(__dirname, 'auto-capture.js'), 'utf8').split('\n').slice(1).join('\n');
  assert.ok(!/C:[\\/]Users|\/usr\/|\/opt\//.test(src));
  assert.ok(!/NM-RB93|SV-65D|"USB Video"/.test(src), '장치 이름은 설정 파일에만');
  assert.ok(!/\b(ir|lirc|remote)\b/i.test(src), '재생 버튼은 사람');
});
for (const [n, f] of cases) { try { f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + ' — ' + e.message); } }
console.log(pass + '/' + cases.length); process.exit(pass === cases.length ? 0 : 1);
