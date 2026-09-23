#!/usr/bin/env node
'use strict';
// vhs-to-mp4.js — VHS 캡처 파일 → 어디서나 재생되는 mp4 (결정론 100% · LLM 0)
//
// @AI:INTENT 판정(입력이 인터레이스인가·오디오가 있나)은 ffprobe JSON 에서 읽고, 변환 인자는 buildArgs()
//   순수 함수가 만든다. 그래서 검사(_test-vhs-to-mp4.js)가 ffmpeg 없이 합성 입력으로 인자를 잠근다.
// @AI:CONSTRAINT 원본을 절대 덮어쓰지 않는다 — 출력은 항상 새 파일(<이름>_mp4.mp4). 이미 있으면 건너뛴다.
// @AI:CONSTRAINT ffmpeg/ffprobe 는 PATH 에서만 찾는다(OS 경로 하드코딩 0 — Tier F-1). 없으면 설치 안내 후 exit 2.
//
// 쓰기:
//   node vhs-to-mp4.js <파일 또는 폴더> [--dry] [--no-enhance] [--crf 20]
//   --dry        무엇을 할지만 찍고 아무것도 안 만든다
//   --no-enhance 화질 필터(노이즈 제거·선명화·색보정) 없이 디인터레이스만

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VIDEO_EXT = new Set(['.avi', '.mpg', '.mpeg', '.mov', '.mkv', '.mp4', '.m2v', '.vob', '.dv', '.wmv', '.ts', '.m2ts', '.mts']);

// ── 순수 함수 ────────────────────────────────────────────────────────────────
function probeSummary(probeJson) {
  const v = (probeJson.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (probeJson.streams || []).find((s) => s.codec_type === 'audio') || null;
  const fo = String(v.field_order || 'unknown');
  return {
    codec: v.codec_name || null,
    width: v.width || null,
    height: v.height || null,
    pix_fmt: v.pix_fmt || null,
    interlaced: fo === 'tt' || fo === 'bb' || fo === 'tb' || fo === 'bt',
    field_order: fo,
    duration: Number((probeJson.format && probeJson.format.duration) || v.duration || 0),
    has_audio: !!a,
  };
}

// VHS 표준 프리셋 한 벌 — 사장님 확정 2026-09-23 (spec 2026-09-23-hwanjeonso-vhs-to-mp4-skill.md)
//   해상도 원본 유지(4:3) · 디인터레이스 · 노이즈 제거 · 약한 선명화 · 색보정 · H.264 High + AAC + faststart
function buildArgs(input, output, summary, opts) {
  const o = opts || {};
  const enhance = o.enhance !== false;
  const crf = String(o.crf || 20);
  const vf = [];
  if (summary.interlaced) vf.push('yadif=1');
  if (enhance) vf.push('hqdn3d=3:2:6:4', 'unsharp=5:5:0.6', 'eq=contrast=1.05:saturation=1.1');
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input];
  if (vf.length) args.push('-vf', vf.join(','));
  args.push(
    '-c:v', 'libx264', '-preset', 'slow', '-crf', crf,
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
  );
  if (summary.has_audio) args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  else args.push('-an');
  args.push('-movflags', '+faststart', output);
  return args;
}

function outputPathFor(input) {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  return path.join(dir, base + '_mp4.mp4');
}

// 출력 검증 — 「만들어졌다」가 아니라 「규격에 맞고 길이가 같다」
function verifyOutput(inSummary, outSummary) {
  const problems = [];
  if (outSummary.codec !== 'h264') problems.push('video codec ' + outSummary.codec + ' (h264 여야 함)');
  if (outSummary.pix_fmt !== 'yuv420p') problems.push('pix_fmt ' + outSummary.pix_fmt + ' (yuv420p 여야 함)');
  if (inSummary.has_audio && !outSummary.has_audio) problems.push('오디오가 사라짐');
  if (inSummary.duration > 0 && Math.abs(inSummary.duration - outSummary.duration) > 1) {
    problems.push('길이 차이 ' + Math.abs(inSummary.duration - outSummary.duration).toFixed(1) + 's (±1s 초과)');
  }
  return problems;
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
function has(bin) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  return probeSummary(JSON.parse(out));
}

function listInputs(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  return fs.readdirSync(target)
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()) && !/_mp4\.mp4$/i.test(f))
    .map((f) => path.join(target, f));
}

function main(argv) {
  const dry = argv.includes('--dry');
  const enhance = !argv.includes('--no-enhance');
  const crfIdx = argv.indexOf('--crf');
  const crf = crfIdx !== -1 ? argv[crfIdx + 1] : undefined;
  const target = argv.filter((a) => !a.startsWith('--') && a !== crf)[0];
  if (!target || !fs.existsSync(target)) {
    console.error('쓰기: node vhs-to-mp4.js <파일 또는 폴더> [--dry] [--no-enhance] [--crf 20]');
    return 2;
  }
  if (!has('ffmpeg') || !has('ffprobe')) {
    console.error('ffmpeg 가 없습니다. 윈도우: winget install Gyan.FFmpeg  · 맥: brew install ffmpeg  → 터미널을 새로 열고 다시 실행');
    return 2;
  }
  const inputs = listInputs(target);
  if (!inputs.length) { console.error('변환할 영상 파일이 없습니다: ' + target); return 2; }

  let fail = 0;
  for (const input of inputs) {
    const output = outputPathFor(input);
    if (fs.existsSync(output)) { console.log('skip  ' + path.basename(input) + ' — 이미 ' + path.basename(output) + ' 있음'); continue; }
    // @AI:INTENT 깨진 캡처 파일은 «한 건 실패»지 «전체 중단»이 아니다 — 스택 대신 FAIL 한 줄로 적고 다음 파일로
    let s;
    try { s = probe(input); } catch (e) {
      fail++;
      console.error('FAIL  ' + path.basename(input) + ' — 읽을 수 없는 파일 (캡처가 깨졌거나 영상이 아님): ' + String(e.stderr || e.message).trim().split('\n').pop());
      continue;
    }
    const args = buildArgs(input, output, s, { enhance: enhance, crf: crf });
    console.log((dry ? 'plan  ' : 'conv  ') + path.basename(input) + '  ' + s.width + 'x' + s.height + ' ' + s.codec + ' '
      + (s.interlaced ? '인터레이스→디인터레이스' : 'progressive') + ' ' + Math.round(s.duration) + 's' + (s.has_audio ? '' : ' (무음)'));
    if (dry) { console.log('       ffmpeg ' + args.join(' ')); continue; }
    const t0 = Date.now();
    const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
      fail++;
      console.error('FAIL  ' + path.basename(input) + ' — ffmpeg exit ' + r.status + '\n' + String(r.stderr || '').split('\n').slice(-5).join('\n'));
      try { fs.unlinkSync(output); } catch (_) { /* 없으면 그만 */ }
      continue;
    }
    const problems = verifyOutput(s, probe(output));
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    if (problems.length) { fail++; console.error('FAIL  ' + path.basename(output) + ' — 규격 미달: ' + problems.join(' / ')); continue; }
    const mb = (fs.statSync(output).size / 1048576).toFixed(0);
    console.log('ok    ' + path.basename(output) + '  ' + mb + 'MB  ' + mins + '분');
  }
  return fail ? 1 : 0;
}

module.exports = { probeSummary, buildArgs, outputPathFor, verifyOutput, VIDEO_EXT };
if (require.main === module) process.exit(main(process.argv.slice(2)));
