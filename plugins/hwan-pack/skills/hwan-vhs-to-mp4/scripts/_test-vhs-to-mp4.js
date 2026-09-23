#!/usr/bin/env node
'use strict';
// _test-vhs-to-mp4.js — ffmpeg 없이 순수 함수로 프리셋을 잠근다 (합성 ffprobe 입력)
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const m = require('./vhs-to-mp4.js');
let pass = 0; const cases = [];
const t = (n, f) => cases.push([n, f]);

const vhs = { streams: [{ codec_type: 'video', codec_name: 'mpeg2video', width: 720, height: 480, pix_fmt: 'yuv420p', field_order: 'tt' }, { codec_type: 'audio', codec_name: 'pcm_s16le' }], format: { duration: '7200.04' } };
const prog = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 480, pix_fmt: 'yuv420p', field_order: 'progressive' }], format: { duration: '10' } };

t('A1 인터레이스 판정 tt/bb/tb/bt 만 true', () => {
  assert.strictEqual(m.probeSummary(vhs).interlaced, true);
  assert.strictEqual(m.probeSummary(prog).interlaced, false);
  assert.strictEqual(m.probeSummary({ streams: [{ codec_type: 'video' }] }).interlaced, false);
});
t('A2 오디오 없으면 has_audio=false', () => assert.strictEqual(m.probeSummary(prog).has_audio, false));
t('B1 VHS 기본: yadif + 화질 3필터 + h264/aac/yuv420p/faststart', () => {
  const a = m.buildArgs('in.avi', 'out.mp4', m.probeSummary(vhs));
  const vf = a[a.indexOf('-vf') + 1];
  assert.strictEqual(vf, 'yadif=1,hqdn3d=3:2:6:4,unsharp=5:5:0.6,eq=contrast=1.05:saturation=1.1');
  for (const k of ['libx264', 'yuv420p', 'high', 'aac', '160k', '+faststart']) assert.ok(a.includes(k), k);
  assert.strictEqual(a[a.length - 1], 'out.mp4');
});
t('B2 progressive + --no-enhance → -vf 없음 · 해상도 확대 0', () => {
  const a = m.buildArgs('in.mp4', 'out.mp4', m.probeSummary(prog), { enhance: false });
  assert.ok(!a.includes('-vf')); assert.ok(!a.some((x) => /scale=/.test(x)));
});
t('B3 무음 입력 → -an', () => assert.ok(m.buildArgs('i', 'o', m.probeSummary(prog)).includes('-an')));
t('B4 crf 는 문자열로 전달', () => { const a = m.buildArgs('i', 'o', m.probeSummary(vhs), { crf: 18 }); assert.strictEqual(a[a.indexOf('-crf') + 1], '18'); });
t('C1 출력 경로 = 같은 폴더 <이름>_mp4.mp4 (원본 보존)', () => {
  assert.strictEqual(m.outputPathFor(path.join('d', 'tape 01.AVI')), path.join('d', 'tape 01_mp4.mp4'));
});
t('D1 검증: h264/yuv420p/오디오/길이 ±1s', () => {
  const i = m.probeSummary(vhs);
  assert.deepStrictEqual(m.verifyOutput(i, { codec: 'h264', pix_fmt: 'yuv420p', has_audio: true, duration: 7200.5 }), []);
  assert.strictEqual(m.verifyOutput(i, { codec: 'hevc', pix_fmt: 'yuv420p', has_audio: true, duration: 7200 }).length, 1);
  assert.strictEqual(m.verifyOutput(i, { codec: 'h264', pix_fmt: 'yuv420p', has_audio: false, duration: 7100 }).length, 2);
});
t('E1 OS 경로 하드코딩 0 (Tier F-1)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'vhs-to-mp4.js'), 'utf8');
  // 셔뱅 줄(#!/usr/bin/env)은 경로 하드코딩이 아니다 — 첫 줄을 빼고 본다
  const body = src.split('\n').slice(1).join('\n');
  assert.ok(!/C:[\\/]Users|\/usr\/|\/opt\//.test(body));
});
for (const [n, f] of cases) { try { f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + ' — ' + e.message); } }
console.log(pass + '/' + cases.length); process.exit(pass === cases.length ? 0 : 1);
