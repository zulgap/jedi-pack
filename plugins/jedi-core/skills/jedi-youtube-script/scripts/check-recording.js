#!/usr/bin/env node
// check-recording.js — 녹화 «설정» 과 «결과» 를 재서 판정한다. 눈으로 보지 않는다.
//
// 쓰는 법
//   node check-recording.js --obs                     촬영 전: OBS 설정을 잰다
//   node check-recording.js <녹화본>                   촬영 후: 결과 파일을 잰다
//   node check-recording.js --obs <10초테스트.mkv>     둘 다 (권장)
//
// 옵션 (전부 기본값이 있다)
//   --res 1920x1080   기대 해상도        --fps 30       최소 프레임
//   --kbps 8000       최소 비트레이트     --lufs -14     목표 라우드니스(유튜브)
//   --lufs-tol 2      허용 오차          --peak -1      최대 트루피크(dBTP)
//   --no-audio        음량 검사 건너뜀 (음성 없이 화면만 녹화할 때)
//   --profile <이름>  OBS 프로필 지정 (기본: 현재 선택된 프로필)
//
// @AI:INTENT 2026-08-16 첫 실촬영에서 15분을 통째로 잃었다. 슬라이드는 게이트가 6장을 잡았는데
//   «녹화 자체» 는 아무도 재지 않아서, 캔버스는 1920×1080인데 출력이 1280×720 으로 줄어 저장됐고
//   음량은 -27.1 LUFS (유튜브 기준 -14 대비 13dB 부족) 로 녹음됐다. 둘 다 찍기 «전에» 읽으면
//   잡히는 것이었다. 그래서 이 스크립트는 사람의 「고쳤겠지」 를 대체한다.
// @AI:CONSTRAINT LLM 0 — 전부 ini 원본값과 ffmpeg 측정값 판정이다. 「대체로 괜찮음」 류의 유연한
//   해석을 넣지 말 것. 이 스크립트의 값어치는 그것을 안 하는 데 있다.
// @AI:DEPENDS ffmpeg 경로는 설치 방식마다 다르다. 하드코딩하면 팀원 PC 에서 즉사하므로 후보를
//   순서대로 찾는다. 하나도 없으면 «조용히 통과시키지 않고» 못 쟀다고 밝힌다 — 안 잰 것을
//   통과로 적는 순간 이 게이트는 거짓말이 된다.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ─────────────────────────────────────────── 인자

const argv = process.argv.slice(2);
const WANT_OBS = argv.includes('--obs');
const NO_AUDIO = argv.includes('--no-audio');

// @AI:FRAGILE 값을 받는 옵션과 «받지 않는 플래그» 를 구분해야 한다. 구분하지 않으면
//   `--obs <파일>` 에서 파일명이 --obs 의 값으로 먹혀 파일 검사가 «조용히» 통째로 빠진다
//   (실제로 첫 실행에서 그랬다 — 통과처럼 보이는데 아무것도 안 잰 상태였다).
const VALUE_OPTS = new Set(['res', 'fps', 'kbps', 'lufs', 'lufs-tol', 'peak', 'profile']);

let FILE = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_OPTS.has(a.slice(2))) i++; // 다음 토큰은 이 옵션의 값이다
    continue;
  }
  if (!FILE) FILE = a;
}

function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}

const WANT_RES = opt('res', '1920x1080');
const [WANT_W, WANT_H] = WANT_RES.split('x').map(Number);
const MIN_FPS = Number(opt('fps', 30));
const MIN_KBPS = Number(opt('kbps', 8000));
const WANT_LUFS = Number(opt('lufs', -14));
const LUFS_TOL = Number(opt('lufs-tol', 2));
const MAX_PEAK = Number(opt('peak', -1));

if (!WANT_OBS && !FILE) {
  console.error('쓰는 법: node check-recording.js --obs [녹화본] | node check-recording.js <녹화본>');
  console.error('  --obs 는 촬영 «전» 설정 검사, 파일 인자는 촬영 «후» 결과 검사다. 둘 다 주는 것이 가장 안전하다.');
  process.exit(2);
}

const fails = [];
const warns = [];
const notes = [];
const rows = [];

// @AI:INTENT 「고품질」(CQP) 로 녹화하면 비트레이트가 «내용에 따라» 변한다. 슬라이드처럼 정지한
//   화면은 데이터가 거의 안 생겨 244kbps 도 나오는데 화질은 멀쩡하다(2026-08-17 실측: 그 파일의
//   글자가 또렷했다). 그래서 품질 모드를 알고 있을 때는 하한 판정을 «참고» 로 낮춘다.
//   비트레이트를 못 채운 것과 안 채워도 되는 것을 같은 실패로 적으면 사람이 게이트를 안 믿게 된다.
let recQualityMode = null;

function judge(label, value, ok, want) {
  rows.push({ label, value, ok, want });
  if (ok === false) fails.push(`${label}: ${value} (기대 ${want})`);
  if (ok === null) warns.push(`${label}: ${value}`);
}

// ─────────────────────────────────────────── OBS 설정 읽기

function obsProfileDir() {
  const roots = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'obs-studio'),
    path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio'),
    path.join(os.homedir(), '.config', 'obs-studio'),
  ].filter(Boolean);
  const root = roots.find((r) => fs.existsSync(path.join(r, 'basic', 'profiles')));
  if (!root) return null;

  const base = path.join(root, 'basic', 'profiles');
  const named = opt('profile', null);
  if (named) {
    const p = path.join(base, named);
    return fs.existsSync(p) ? p : null;
  }
  // global.ini 의 ProfileDir 이 «지금 선택된» 프로필이다. 프로필이 여럿일 때 아무거나 읽으면
  // 안 쓰는 프로필을 재고 통과시켜 버린다.
  const g = path.join(root, 'global.ini');
  if (fs.existsSync(g)) {
    const m = fs.readFileSync(g, 'utf8').match(/^ProfileDir=(.+)$/m);
    if (m) {
      const p = path.join(base, m[1].trim());
      if (fs.existsSync(p)) return p;
    }
  }
  const dirs = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory());
  if (dirs.length === 1) return path.join(base, dirs[0]);
  return null;
}

function parseIni(text) {
  const out = {};
  let sec = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const s = line.match(/^\[(.+)\]$/);
    if (s) { sec = s[1]; out[sec] = out[sec] || {}; continue; }
    const i = line.indexOf('=');
    if (i > 0 && sec) out[sec][line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function obsRunning() {
  try {
    if (process.platform === 'win32') {
      const o = execFileSync('tasklist', ['/FI', 'IMAGENAME eq obs64.exe'], { encoding: 'latin1' });
      return /obs64\.exe/i.test(o);
    }
    execFileSync('pgrep', ['-x', 'obs'], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function checkObs() {
  const dir = obsProfileDir();
  if (!dir) {
    warns.push('OBS 프로필을 못 찾았다 — 설정 검사를 건너뛴다 (--profile 로 지정할 수 있다)');
    return;
  }
  const ini = path.join(dir, 'basic.ini');
  if (!fs.existsSync(ini)) { warns.push('basic.ini 없음: ' + ini); return; }
  const cfg = parseIni(fs.readFileSync(ini, 'utf8'));
  notes.push('OBS 프로필: ' + path.basename(dir));

  // @AI:FRAGILE OBS 는 «종료할 때» 메모리 값으로 basic.ini 를 덮어쓴다. 실행 중에 읽은 값은
  //   화면에 보이는 설정과 다를 수 있다. 조용히 통과시키면 안 되므로 반드시 알린다.
  if (obsRunning()) {
    warns.push('OBS 가 실행 중이다 — 이 파일 값은 낡았을 수 있다. 설정을 바꿨다면 OBS 를 «끄고» 다시 재라');
  }

  const V = cfg.Video || {};
  const outW = Number(V.OutputCX), outH = Number(V.OutputCY);
  const baseW = Number(V.BaseCX), baseH = Number(V.BaseCY);

  // 오늘 당한 바로 그것 — 캔버스는 제대로인데 «출력» 에서 줄여 저장한다.
  judge('출력 해상도', `${outW}x${outH}`, outW === WANT_W && outH === WANT_H, WANT_RES);
  if (baseW && (baseW !== outW || baseH !== outH)) {
    warns.push(`캔버스(${baseW}x${baseH}) 와 출력(${outW}x${outH}) 이 다르다 — 저장할 때 축소된다`);
  }

  const fps = Number(V.FPSCommon || V.FPSInt || (V.FPSNum && V.FPSDen ? Number(V.FPSNum) / Number(V.FPSDen) : 0));
  judge('프레임', fps ? fps + 'fps' : '미검출', fps ? fps >= MIN_FPS : null, `${MIN_FPS}fps 이상`);

  const mode = (cfg.Output || {}).Mode || 'Simple';
  notes.push('출력 모드: ' + mode);

  if (mode === 'Simple') {
    const S = cfg.SimpleOutput || {};
    const q = S.RecQuality || 'Stream';
    recQualityMode = q;
    // "Stream" = 녹화에 «스트리밍용» 비트레이트를 쓴다. 스트리밍은 회선에 맞춰 낮게 잡으므로
    // 녹화 품질이 거기에 묶인다. 오늘 2.5Mbps 가 나온 이유가 이것이다.
    const qOk = q !== 'Stream';
    judge('녹화 품질', q === 'Stream' ? 'Stream(스트리밍과 동일)' : q, qOk, 'Small / HQ / Lossless');
    if (!qOk) {
      const vb = Number(S.VBitrate || 0);
      judge('└ 그때 쓰이는 비트레이트', vb ? vb + 'kbps' : '미검출', vb ? vb >= MIN_KBPS : null, `${MIN_KBPS}kbps 이상`);
    }
    if (S.RecEncoder) notes.push('녹화 인코더: ' + S.RecEncoder);
  } else {
    const A = cfg.AdvOut || {};
    notes.push('고급 모드 — 녹화 인코더: ' + (A.RecEncoder || '미설정'));
    if (A.RecEncoder === 'none') {
      warns.push('고급 모드인데 녹화 인코더가 none 이다 — 스트리밍 인코더를 그대로 쓴다');
    }
  }
}

// ─────────────────────────────────────────── ffmpeg 찾기

function findFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  // 1) PATH
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const hit = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)[0].trim();
    if (hit && fs.existsSync(hit)) return hit;
  } catch { /* PATH 에 없다 — 다음 후보로 */ }

  // 2) 흔한 편집기가 번들로 갖고 있다. 설치돼 있으면 그것을 쓴다(추가 설치 0).
  const bundles = [
    path.join(os.homedir(), 'AppData', 'Local', 'CapCut', 'Apps'),
    path.join(os.homedir(), 'Applications', 'CapCut.app', 'Contents', 'Resources'),
  ];
  for (const b of bundles) {
    if (!fs.existsSync(b)) continue;
    let cands = [];
    try {
      cands = fs.readdirSync(b)
        .map((d) => path.join(b, d, exe))
        .filter((p) => fs.existsSync(p))
        .sort(); // 버전 문자열 오름차순 → 마지막이 최신
    } catch { continue; }
    if (cands.length) return cands[cands.length - 1];
    const direct = path.join(b, exe);
    if (fs.existsSync(direct)) return direct;
  }
  return null;
}

// @AI:FRAGILE ffmpeg 는 측정값을 «stderr» 로 낸다. execFileSync 는 stdout 만 돌려주므로
//   종료코드 0 인 명령(-f null -)에서는 요약이 통째로 사라진다 — 실패가 아니라 «측정값 없음» 으로
//   조용히 지나간다(실제로 첫 판에서 음량이 「못 쟀음」 으로 나왔다). spawnSync 로 둘 다 받는다.
function ffRun(ff, args) {
  const r = spawnSync(ff, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return (r.stdout || '') + (r.stderr || '');
}

// ─────────────────────────────────────────── 녹화본 재기

function probeWithFfmpeg(ff, file) {
  const out = ffRun(ff, ['-hide_banner', '-i', file]);
  const v = out.match(/Stream #\d+:\d+.*: Video: (\w+).*?, (\d+)x(\d+).*?, ([\d.]+) fps/s);
  const dur = out.match(/Duration: (\d+):(\d+):([\d.]+), .*?bitrate: (\d+) kb\/s/);
  const a = out.match(/Stream #\d+:\d+.*: Audio: (\w+).*?, (\d+) Hz, (\w+)/);
  return {
    codec: v && v[1], w: v && Number(v[2]), h: v && Number(v[3]), fps: v && Number(v[4]),
    seconds: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    kbps: dur && Number(dur[4]),
    audio: a ? { codec: a[1], hz: Number(a[2]), layout: a[3] } : null,
  };
}

function measureLoudness(ff, file) {
  const out = ffRun(ff, ['-hide_banner', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-vn', '-f', 'null', '-']);
  const i = out.match(/I:\s*(-?[\d.]+)\s*LUFS/);
  const peaks = [...out.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)].map((m) => Number(m[1]));
  if (!i) {
    // ebur128 이 없거나 실패했으면 volumedetect 로 최소한 최대치라도 잡는다.
    const vd = ffRun(ff, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
    const mx = vd.match(/max_volume:\s*(-?[\d.]+) dB/);
    return { lufs: null, peak: mx ? Number(mx[1]) : null };
  }
  return { lufs: Number(i[1]), peak: peaks.length ? Math.max(...peaks) : null };
}

// ffmpeg 가 없을 때의 최소 폴백 — MKV(EBML) 헤더에서 해상도·길이만 읽는다. 음량은 못 잰다.
function probeMkvHeader(file) {
  const fd = fs.openSync(file, 'r');
  const st = fs.fstatSync(fd);
  const n = Math.min(8 << 20, st.size);
  const b = Buffer.alloc(n);
  fs.readSync(fd, b, 0, n, 0);
  fs.closeSync(fd);

  const vint = (off, strip) => {
    const f = b[off];
    if (f === undefined) return null;
    let len = 0;
    for (let i = 0; i < 8; i++) if (f & (0x80 >> i)) { len = i + 1; break; }
    if (!len) return null;
    let v = strip ? f & ((0x80 >> (len - 1)) - 1) : f;
    for (let i = 1; i < len; i++) v = v * 256 + b[off + i];
    return { v, len };
  };
  const MASTERS = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0]);
  const f = {};
  (function walk(start, end, depth) {
    let off = start;
    while (off < end) {
      const id = vint(off, false); if (!id) return;
      const sz = vint(off + id.len, true); if (!sz) return;
      const d0 = off + id.len + sz.len;
      const d1 = d0 + Math.min(sz.v, end - d0);
      if (MASTERS.has(id.v) && depth < 6) walk(d0, d1, depth + 1);
      else {
        const u = () => { let v = 0; for (let i = d0; i < d1; i++) v = v * 256 + b[i]; return v; };
        if (id.v === 0x2ad7b1) f.scale = u();
        else if (id.v === 0x4489) f.dur = d1 - d0 === 4 ? b.readFloatBE(d0) : d1 - d0 === 8 ? b.readDoubleBE(d0) : null;
        else if (id.v === 0xb0) f.w = u();
        else if (id.v === 0xba) f.h = u();
        else if (id.v === 0x23e383) f.frameNs = u();
      }
      off = d1;
      if (off <= start) return;
    }
  })(0, n, 0);

  const sec = f.dur ? (f.dur * (f.scale || 1e6)) / 1e9 : null;
  return {
    codec: null, w: f.w, h: f.h,
    fps: f.frameNs ? 1e9 / f.frameNs : null,
    seconds: sec, kbps: sec ? Math.round((st.size * 8) / sec / 1000) : null,
    audio: null,
  };
}

function checkFile(file) {
  if (!fs.existsSync(file)) { fails.push('파일 없음: ' + file); return; }
  const ff = findFfmpeg();
  let p, measured;

  if (ff) {
    notes.push('ffmpeg: ' + ff);
    p = probeWithFfmpeg(ff, file);
  } else if (/\.mkv$/i.test(file)) {
    warns.push('ffmpeg 를 못 찾아 MKV 헤더만 읽었다 — 해상도·비트레이트는 재지만 «음량은 못 쟀다»');
    p = probeMkvHeader(file);
  } else {
    fails.push('ffmpeg 가 없고 MKV 도 아니라 이 파일은 «전혀 재지 못했다». ffmpeg 를 설치하거나 MKV 로 녹화할 것');
    return;
  }

  judge('파일 해상도', p.w && p.h ? `${p.w}x${p.h}` : '미검출',
    p.w && p.h ? p.w === WANT_W && p.h === WANT_H : null, WANT_RES);
  judge('파일 프레임', p.fps ? p.fps.toFixed(0) + 'fps' : '미검출',
    p.fps ? p.fps >= MIN_FPS - 0.5 : null, `${MIN_FPS}fps 이상`);
  // 품질 기준(CQP) 녹화면 비트레이트 하한은 잣대가 아니다 — 위 @AI:INTENT 참조
  const cqp = recQualityMode && recQualityMode !== 'Stream';
  if (cqp) {
    rows.push({ label: '파일 비트레이트', value: (p.kbps || '?') + 'kbps', ok: 'info', want: '' });
    notes.push(`품질 기준(${recQualityMode}) 녹화라 비트레이트는 내용에 따라 변한다 — 정지 화면이면 낮게 나오고 그게 정상이다`);
  } else {
    judge('파일 비트레이트', p.kbps ? p.kbps + 'kbps' : '미검출',
      p.kbps ? p.kbps >= MIN_KBPS : null, `${MIN_KBPS}kbps 이상`);
  }
  if (p.seconds) notes.push('길이: ' + Math.floor(p.seconds / 60) + '분 ' + (p.seconds % 60).toFixed(1) + '초');
  if (p.audio) notes.push(`음성 규격: ${p.audio.codec} ${p.audio.hz}Hz ${p.audio.layout}`);

  // @AI:INTENT 코드가 못 잡는 것이 있다 — 작업표시줄·다른 창·알림 팝업이 화면에 들어왔는지는
  //   픽셀을 봐야 알고, 그 판정을 결정론으로 만들기 어렵다(슬라이드 배경이 검정이라 여백 검출도
  //   빗나간다). 실사고(2026-08-17): 리허설 프레임 하단에 작업표시줄이 시계까지 통째로 찍혔는데
  //   위의 수치는 «전부 정상» 이었다. 그래서 재는 대신 «보게 만든다» — 프레임을 뽑아 경로를 들이민다.
  if (ff) {
    const shot = file.replace(/\.[^.]+$/, '') + '-frame.png';
    const at = p.seconds && p.seconds > 4 ? Math.min(p.seconds / 2, 30) : 1;
    ffRun(ff, ['-hide_banner', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', shot]);
    if (fs.existsSync(shot)) {
      notes.push('프레임 뽑음: ' + shot);
      notes.push('🔴 이 그림을 «열어» 볼 것 — 작업표시줄·다른 창·알림이 찍혔는지는 코드가 못 잡는다');
    }
  }

  if (NO_AUDIO) { notes.push('음량 검사 건너뜀 (--no-audio)'); return; }
  if (!ff) { judge('음량', '못 쟀음 (ffmpeg 없음)', null, `${WANT_LUFS} LUFS`); return; }
  if (p.audio === null && p.codec !== null) { warns.push('음성 트랙이 없다 — 마이크가 안 잡혔을 수 있다'); return; }

  measured = measureLoudness(ff, file);
  if (measured.lufs === null) {
    judge('음량(LUFS)', '못 쟀음', null, `${WANT_LUFS} LUFS`);
  } else {
    const diff = measured.lufs - WANT_LUFS;
    judge('음량(라우드니스)', `${measured.lufs} LUFS`, Math.abs(diff) <= LUFS_TOL, `${WANT_LUFS}±${LUFS_TOL} LUFS`);
    if (Math.abs(diff) > LUFS_TOL) {
      notes.push(diff < 0
        ? `→ ${Math.abs(diff).toFixed(1)}dB 작다. 유튜브는 작은 소리를 «키워주지 않는다». 마이크 필터에 컴프레서+게인을 걸 것`
        : `→ ${diff.toFixed(1)}dB 크다. 유튜브가 자동으로 줄이지만 여유가 없어 답답하게 들린다`);
    }
  }
  if (measured.peak !== null) {
    judge('최대 피크', `${measured.peak} dB`, measured.peak <= MAX_PEAK, `${MAX_PEAK} dB 이하`);
    if (measured.peak > MAX_PEAK) notes.push('→ 소리가 깨질 수 있다. 입력 게인을 낮출 것');
  }
}

// ─────────────────────────────────────────── 실행

if (WANT_OBS) checkObs();
if (FILE) checkFile(FILE);

console.log('');
console.log('  녹화 게이트 — 재서 판정한다');
console.log('  ' + '─'.repeat(58));
for (const r of rows) {
  const mark = r.ok === true ? '통과' : r.ok === false ? '실패' : r.ok === 'info' ? '참고' : ' ?  ';
  const want = (r.ok === true || r.ok === 'info') ? '' : `   (기대 ${r.want})`;
  console.log(`  [${mark}] ${r.label.padEnd(18)} ${String(r.value).padEnd(22)}${want}`);
}
if (notes.length) { console.log(''); for (const n of notes) console.log('   · ' + n); }
if (warns.length) { console.log(''); for (const w of warns) console.log('   ⚠ ' + w); }
console.log('');

if (fails.length) {
  console.log('  판정: 실패 ' + fails.length + '건 — 이대로 찍으면 그대로 저장된다');
  for (const f of fails) console.log('    · ' + f);
  console.log('');
  process.exit(1);
}
if (warns.length) {
  console.log('  판정: 통과 (확인할 것 ' + warns.length + '건)');
  console.log('');
  process.exit(0);
}
console.log('  판정: 통과');
console.log('');
process.exit(0);
