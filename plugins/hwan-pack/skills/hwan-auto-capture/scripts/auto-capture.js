#!/usr/bin/env node
'use strict';
// auto-capture.js — 테이프 넣고 재생만 누르면: 신호 감지 → 녹화 → 신호 끊기면 종료 → mp4 변환 (결정론 100% · LLM 0)
//
// @AI:INTENT 두 단계로 나눈다. ① 대기: 화면이 검정/무음이 아닌 순간을 기다린다(파일 안 만듦)
//   ② 녹화: 무손실로 받으면서 「검정+무음이 N초 이상」이면 스스로 멈춘다 → PR #357 vhs-to-mp4.js 로 넘긴다.
//   판정은 ffmpeg 의 blackdetect/silencedetect 출력 줄을 parse* 순수 함수가 읽는다 — 검사가 합성 줄로 잠근다.
// @AI:CONSTRAINT 사람 손 = 「테이프 넣기 · 재생 누르기」뿐 (사장님 확정 2026-09-23 「재생버튼까진 사람이 합니다」).
//   VCR 을 제어하는 코드를 넣지 말 것.
// @AI:CONSTRAINT 장치 이름은 설정 파일(~/.claude/zulgap/hwan-capture.json)에서만 읽는다 — 코드에 박지 않는다(Tier K·F).
//   없으면 --list 로 찾아 적으라고 안내하고 멈춘다.
// @AI:HUMAN_ONLY 「테이프가 처음인가」는 사람이 확인한다 (사장님 확정 2026-09-23 — 넣자마자 녹화하면 중간부터 찍힌다).
//   ① 되감기 확인 = --rewound 없으면 시작 거부 ② 녹화 시작 N초 뒤 첫 장면 사진을 남겨 사람이 본다
//   → 아니면 <출력>.stop 파일을 만들어 멈춘다(변환 안 함). 녹화는 신호 순간부터라 앞부분은 잘리지 않는다.
//
// 쓰기:
//   node auto-capture.js --list                                  장치 목록 (ffmpeg dshow)
//   node auto-capture.js --out <폴더> [--name 고객명] --rewound  대기 → 녹화(+첫 장면 사진) → 변환 · 볼 화면 창이 함께 뜬다
//   (--no-view 면 창 없이)
//   node auto-capture.js --out <폴더> --dry                      설정·장치·명령만 보여주고 안 돈다
//   멈추기: <출력>.stop 파일을 만든다(백그라운드 실행에서도 ffmpeg 가 깨끗이 닫힌다) · Ctrl+C 도 된다

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'zulgap', 'hwan-capture.json');
// 사장님 확정 프리셋 — 「검정 30초 + 무음 30초」 = 테이프 끝. VHS 끝의 파란 화면(blue screen)도 pic_th 로 잡힌다
// first_frame_sec = 녹화 시작 뒤 첫 장면 사진을 찍는 시각(초). 재생 직후의 잡음·검정을 넘기려고 10초
const DEFAULTS = { black_sec: 30, silence_sec: 30, black_pic_th: 0.98, silence_db: -50, start_grace_sec: 5, first_frame_sec: 10 };

// ── 순수 함수 ────────────────────────────────────────────────────────────────
// `ffmpeg -list_devices true -f dshow -i dummy` 의 stderr → { video:[], audio:[] }
function parseDshowDevices(stderr) {
  const out = { video: [], audio: [] };
  for (const line of String(stderr || '').split('\n')) {
    const m = line.match(/"([^"]+)"\s+\((video|audio)\)/);
    if (m) out[m[2]].push(m[1]);
  }
  return out;
}

// blackdetect / silencedetect 줄 → 이벤트. 다른 줄은 null
function parseDetectLine(line) {
  const s = String(line || '');
  let m;
  if ((m = s.match(/black_start:\s*([\d.]+)/))) return { kind: 'black_start', t: Number(m[1]) };
  if ((m = s.match(/black_end:\s*([\d.]+)/))) return { kind: 'black_end', t: Number(m[1]) };
  if ((m = s.match(/silence_start:\s*([\d.]+)/))) return { kind: 'silence_start', t: Number(m[1]) };
  if ((m = s.match(/silence_end:\s*([\d.]+)/))) return { kind: 'silence_end', t: Number(m[1]) };
  if ((m = s.match(/time=(\d+):(\d+):([\d.]+)/))) return { kind: 'progress', t: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
  return null;
}

// 상태기계 — 이벤트를 먹여 「지금 신호가 있나 / 끝났나」를 낸다. 시간은 ffmpeg 가 준 스트림 시각(초)
function createSignalTracker(cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const st = { black_since: 0, silent_since: 0, seen_content: false, now: 0 };
  return {
    state: st,
    feed(ev) {
      if (!ev) return this.verdict();
      if (ev.kind === 'progress') st.now = ev.t;
      else if (ev.kind === 'black_start') st.black_since = ev.t;
      else if (ev.kind === 'black_end') { st.black_since = null; st.seen_content = true; st.now = Math.max(st.now, ev.t); }
      else if (ev.kind === 'silence_start') st.silent_since = ev.t;
      else if (ev.kind === 'silence_end') { st.silent_since = null; st.now = Math.max(st.now, ev.t); }
      return this.verdict();
    },
    // 검정·무음은 ffmpeg 가 「시작」만 먼저 알리고 「끝」은 끝나야 알리므로, since 가 있으면 now 와의 차로 잰다
    verdict() {
      const blackFor = st.black_since == null ? 0 : Math.max(0, st.now - st.black_since);
      const silentFor = st.silent_since == null ? 0 : Math.max(0, st.now - st.silent_since);
      const hasSignal = st.black_since == null && st.silent_since == null;
      const ended = st.seen_content && blackFor >= c.black_sec && silentFor >= c.silence_sec;
      return { hasSignal, ended, blackFor, silentFor, seen_content: st.seen_content };
    },
  };
}

function detectFilters(cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  return {
    vf: 'blackdetect=d=1:pic_th=' + c.black_pic_th,
    af: 'silencedetect=n=' + c.silence_db + 'dB:d=1',
  };
}

// 🔴 -nostdin 을 넣지 말 것 — 멈춤은 stdin 'q' 로 보내는데 -nostdin 이면 ffmpeg 가 그것을 무시한다
//   (2026-09-23 실측: q 를 보내도 안 멈춰 8초 뒤 강제 종료 · 넣은 채 배포돼 있었다 → 대기가 영원히 안 끝났을 것)
// 볼 화면 출력 — 같은 입력을 작게 줄여 stdout(pipe:1) 으로 흘린다. node 가 받아 ffplay 창에 넘긴다
function viewOutputArgs() {
  return ['-map', '0:v', '-map', '0:a', '-vf', 'scale=640:-2', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-f', 'nut', 'pipe:1'];
}

function buildWaitArgs(video, audio, cfg, opts) {
  const f = detectFilters(cfg);
  return ['-hide_banner', '-f', 'dshow', '-i', 'video=' + video + ':audio=' + audio,
    '-vf', f.vf, '-af', f.af, '-f', 'null', '-'].concat(opts && opts.view ? viewOutputArgs() : []);
}

// 첫 장면 사진 경로 — 녹화 파일 옆 <이름>_first.jpg
function firstFramePath(output) { return output.replace(/\.mkv$/i, '') + '_first.jpg'; }
function stopFilePath(output) { return output + '.stop'; }

// 녹화 = 무손실(ffv1 + pcm) mkv. 같은 입력을 감지 필터로도 흘려 stderr 로 이벤트를 받는다
function buildRecordArgs(video, audio, output, cfg, opts) {
  const f = detectFilters(cfg);
  return ['-hide_banner', '-y', '-f', 'dshow', '-rtbufsize', '512M', '-i', 'video=' + video + ':audio=' + audio,
    '-map', '0:v', '-map', '0:a',
    '-c:v', 'ffv1', '-level', '3', '-c:a', 'pcm_s16le', output,
    '-map', '0:v', '-map', '0:a', '-vf', f.vf, '-af', f.af, '-f', 'null', '-']
    .concat(opts && opts.view ? viewOutputArgs() : []);
}

// 첫 장면 사진 = 녹화 «중인» mkv 에서 first_frame_sec 지점 1장을 따로 뽑는다.
// @AI:FRAGILE 녹화 명령에 사진 출력(-ss)을 붙이지 말 것 — 그 출력이 10초 동안 초기화를 붙잡아
//   볼 화면이 처음 10초 멈춘다(2026-09-23 실측: 5초에 2MB = 4프레임). 정작 「시작이 맞나」를 볼 구간이다.
function buildFirstFrameArgs(output, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(c.first_frame_sec), '-i', output,
    '-frames:v', '1', '-q:v', '3', firstFramePath(output)];
}

// 시작 관문 — 되감기 확인(--rewound) 없이는 녹화하지 않는다. --dry·--list 는 관문 밖
function startGate(argv) {
  if (argv.includes('--list') || argv.includes('--dry')) return { ok: true };
  if (argv.includes('--rewound')) return { ok: true };
  return { ok: false, reason: '테이프를 처음까지 되감았는지 사람에게 먼저 확인하세요. 확인했으면 --rewound 를 붙여 다시 실행' };
}

function outputName(dir, name) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  return path.join(dir, (name ? name.replace(/[\\/:*?"<>|]/g, '_') + '_' : 'tape_') + stamp + '.mkv');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return null; }
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
function listDevices() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' });
  if (r.error) { console.error('ffmpeg 가 없습니다. 윈도우: winget install Gyan.FFmpeg → 터미널 새로 열기'); return 2; }
  const d = parseDshowDevices(r.stderr);
  console.log('영상 장치:', d.video.length ? d.video.join(' | ') : '(없음)');
  console.log('음성 장치:', d.audio.length ? d.audio.join(' | ') : '(없음)');
  console.log('\n설정 파일에 적을 것 → ' + CONFIG_PATH);
  console.log(JSON.stringify({ video: d.video[0] || '<영상 장치 이름>', audio: d.audio[0] || '<음성 장치 이름>' }, null, 2));
  return d.video.length && d.audio.length ? 0 : 1;
}

// stopFile 이 생기면 ffmpeg 에 'q' 를 보내 깨끗이 닫는다 — 백그라운드 실행에서 node 만 죽이면
// 윈도우에선 ffmpeg 자식이 살아남아 녹화를 계속하므로, 멈춤은 반드시 이 파일로 한다
// 볼 화면 창 — ffmpeg stdout → node → ffplay stdin 으로 «중계»한다.
// @AI:FRAGILE ffplay 를 ffmpeg 에 직접 잇지 말 것: 사람이 창을 닫으면 파이프가 끊겨 ffmpeg(=녹화)까지 죽는다.
//   node 가 사이에서 받아 버리므로 창을 닫아도 녹화는 계속된다. 창이 느리면 64MB 넘는 몫은 버린다(녹화 무관).
function attachViewer(p, title) {
  let alive = true;
  let v;
  try {
    v = spawn('ffplay', ['-hide_banner', '-loglevel', 'error', '-window_title', title, '-i', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  } catch (_) { alive = false; }
  if (v) {
    v.on('error', () => { alive = false; console.log('  (볼 화면을 못 띄웠습니다 — ffplay 없음. 녹화는 그대로 됩니다)'); });
    v.on('close', () => { alive = false; });
    v.stdin.on('error', () => { alive = false; });
  }
  p.stdout.on('data', (chunk) => {
    if (alive && v && v.stdin.writableLength < 64 * 1024 * 1024) { try { v.stdin.write(chunk); } catch (_) { alive = false; } }
  });
  return () => { if (v) { try { v.stdin.end(); } catch (_) { /* 닫힘 */ } try { v.kill(); } catch (_) { /* 닫힘 */ } } };
}

function runFfmpeg(args, onLine, stopFile, viewTitle) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['pipe', viewTitle ? 'pipe' : 'ignore', 'pipe'] });
    const closeViewer = viewTitle ? attachViewer(p, viewTitle) : () => {};
    let buf = ''; let humanStop = false;
    const quit = () => { try { p.stdin.write('q'); } catch (_) { /* 이미 닫힘 */ } };
    const timer = stopFile ? setInterval(() => { if (!humanStop && fs.existsSync(stopFile)) { humanStop = true; quit(); } }, 2000) : null;
    p.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop();
      for (const line of parts) { if (onLine(line, p)) quit(); }
    });
    p.on('close', (code) => { if (timer) clearInterval(timer); closeViewer(); resolve({ code, humanStop }); });
  });
}

async function main(argv) {
  if (argv.includes('--list')) return listDevices();
  const gate = startGate(argv);
  if (!gate.ok) { console.error(gate.reason); return 2; }
  const dry = argv.includes('--dry');
  const outIdx = argv.indexOf('--out'); const dir = outIdx !== -1 ? argv[outIdx + 1] : null;
  const nameIdx = argv.indexOf('--name'); const name = nameIdx !== -1 ? argv[nameIdx + 1] : '';
  if (!dir) { console.error('쓰기: node auto-capture.js --list | --out <폴더> [--name 고객명] [--dry]'); return 2; }
  const cfg = readConfig();
  if (!cfg || !cfg.video || !cfg.audio) {
    console.error('장치 설정이 없습니다 → node auto-capture.js --list 로 이름을 확인해 ' + CONFIG_PATH + ' 에 적으세요');
    return 2;
  }
  fs.mkdirSync(dir, { recursive: true });
  const output = outputName(dir, name);
  const view = !argv.includes('--no-view');
  const waitArgs = buildWaitArgs(cfg.video, cfg.audio, cfg, { view });
  const recArgs = buildRecordArgs(cfg.video, cfg.audio, output, cfg, { view });
  console.log('장치: ' + cfg.video + ' / ' + cfg.audio);
  const stopFile = stopFilePath(output);
  const shot = firstFramePath(output);
  const c = Object.assign({}, DEFAULTS, cfg);
  console.log('출력: ' + output);
  console.log('멈추기: ' + stopFile + ' 파일을 만들면 멈춥니다');
  if (dry) { console.log('대기: ffmpeg ' + waitArgs.join(' ')); console.log('녹화: ffmpeg ' + recArgs.join(' ')); return 0; }

  // ① 대기 — 화면·소리가 들어올 때까지 (파일 안 만듦)
  console.log('테이프를 넣고 재생을 누르세요. 신호를 기다립니다…');
  const waitTracker = createSignalTracker(cfg);
  let gotSignal = false;
  const w = await runFfmpeg(waitArgs, (line) => {
    const v = waitTracker.feed(parseDetectLine(line));
    if (v.hasSignal && waitTracker.state.now >= c.start_grace_sec) { gotSignal = true; return true; }
    return false;
  }, stopFile, view ? '대기 중 — 되감기·재생 확인용 (닫아도 됩니다)' : null);
  if (w.humanStop) { console.error('사람이 멈춤 (대기 중). 파일 없음'); return 1; }
  if (!gotSignal) { console.error('신호를 받지 못한 채 끝났습니다 (장치 분리·Ctrl+C). 파일 없음'); return 1; }

  // ② 녹화 — 끝(검정+무음 N초)이면 스스로 멈춤. first_frame_sec 뒤 첫 장면 사진을 알린다
  console.log('신호 감지 → 녹화 시작 ' + new Date().toLocaleTimeString());
  const recTracker = createSignalTracker(cfg);
  let lastLog = 0; let announced = false;
  const r = await runFfmpeg(recArgs, (line) => {
    const ev = parseDetectLine(line);
    const v = recTracker.feed(ev);
    if (ev && ev.kind === 'progress') {
      if (!announced && ev.t >= c.first_frame_sec + 2) {
        announced = true;
        const s = spawn('ffmpeg', buildFirstFrameArgs(output, cfg), { stdio: 'ignore' });
        s.on('close', (code) => {
          if (code === 0 && fs.existsSync(shot)) console.log('첫 장면: ' + shot + ' — 테이프 시작이 맞는지 사람이 확인. 아니면 ' + stopFile + ' 를 만들어 멈춘다');
          else console.log('첫 장면 사진을 못 뽑았습니다(녹화는 계속) — 볼 화면 창으로 확인하세요');
        });
      }
      if (ev.t - lastLog >= 300) { lastLog = ev.t; console.log('  녹화 중 ' + Math.round(ev.t / 60) + '분'); }
    }
    return v.ended;
  }, stopFile, view ? '녹화 중 — 창을 닫아도 녹화는 계속됩니다' : null);
  if (r.humanStop) {
    console.error('사람이 멈춤 → 변환 안 함. 녹화 파일은 남아 있습니다(시작이 아니었으면 사람이 지운다): ' + output);
    return 1;
  }
  const v = recTracker.verdict();
  const st = fs.existsSync(output) ? fs.statSync(output) : null;
  if (!st || st.size < 1024 * 1024) { console.error('녹화 파일이 비었습니다 (exit ' + r.code + ')'); return 1; }
  console.log((v.ended ? '테이프 끝 감지 → ' : '수동 종료 → ') + '녹화 종료 ' + (st.size / 1073741824).toFixed(2) + 'GB  (' + Math.round(recTracker.state.now / 60) + '분)');

  // ③ 변환 — PR #357 스킬. 형제 폴더 이름은 설치 형태마다 달라 찾아서 부른다
  const conv = findSibling('vhs-to-mp4.js');
  if (!conv) { console.error('변환 스크립트를 못 찾았습니다 — hwan-vhs-to-mp4 스킬로 직접 변환하세요: ' + output); return 1; }
  console.log('mp4 변환 시작…');
  const cv = spawnSync('node', [conv, output], { stdio: 'inherit' });
  return cv.status === 0 ? 0 : 1;
}

function findSibling(file) {
  // 이 스킬 폴더의 형제 스킬들 안에서 찾는다 (폴더명을 박지 않는다 — Tier E)
  const skillsDir = path.resolve(__dirname, '..', '..');
  try {
    for (const d of fs.readdirSync(skillsDir)) {
      const p = path.join(skillsDir, d, 'scripts', file);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* 없으면 null */ }
  return null;
}

module.exports = { runFfmpeg, viewOutputArgs, buildFirstFrameArgs, parseDshowDevices, parseDetectLine, createSignalTracker, buildWaitArgs, buildRecordArgs, outputName, firstFramePath, stopFilePath, startGate, DEFAULTS, CONFIG_PATH };
if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
