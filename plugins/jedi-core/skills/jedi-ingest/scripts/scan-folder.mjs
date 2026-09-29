#!/usr/bin/env node
// 폴더를 훑어 «파일 원장에 올릴 목록»을 만든다 — 판단 0 (결정론).
// 쓰는 법: node scan-folder.mjs <폴더> [--out <json 경로>]
// 나오는 것(JSON): connector_id 후보 · scan_batch · 파일마다 {file_path, ext, size_bytes, mtime, file_hash, bundle, suggest}
//   · file_path = 폴더 기준 상대경로('/' 구분) — 서버 원장 키(회사·커넥터·경로)가 된다
//   · bundle    = 맨 위 폴더 이름(덩어리 단위로 사람에게 묻는다) — 폴더 바로 아래 파일은 '(맨 위)'
//   · suggest   = 확장자로 정한 «처리 안»(read | skip) + 사유. 최종 결정은 사람
// @AI:INTENT 여기는 기계가 확실히 셀 수 있는 것만 한다. «어느 일의 자료인가»는 이 스크립트가 정하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const root = args[0];
const outIdx = args.indexOf('--out');
const out = outIdx > -1 ? args[outIdx + 1] : null;
if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('폴더 경로를 주세요: node scan-folder.mjs <폴더>');
  process.exit(2);
}

// 확장자 → 처리 안. 서버 추출기 이름(extractor)과 같은 말을 쓴다.
const READ = { '.txt': 'plain', '.md': 'plain', '.csv': 'plain', '.json': 'plain',
  '.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' };
const SKIP = {
  '.hwp': 'hwp_not_supported', '.hwpx': 'hwp_not_supported',
  '.exe': 'installer', '.msi': 'installer', '.dmg': 'installer', '.pkg': 'installer',
  '.zip': 'archive', '.7z': 'archive', '.rar': 'archive',
  '.jpg': 'image_no_text', '.jpeg': 'image_no_text', '.png': 'image_no_text', '.heic': 'image_no_text', '.gif': 'image_no_text',
  '.mp4': 'media', '.mov': 'media', '.mp3': 'media', '.m4a': 'media', '.wav': 'media',
};
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.claude']);
const MAX_READ_BYTES = 30 * 1024 * 1024; // 30MB 넘는 문서는 사람에게 먼저 묻는다

// 🔑 사람이 정한 «넣지 않을 폴더» 규칙 — 자료 폴더 맨 위의 .jedi-ingest.json (폴더와 함께 다닌다)
//   { "exclude": ["계약서", "인사/급여"] } — 맨 위 기준 상대경로 접두. 서버에는 «넣지 않기» 칸이 없어 여기 둔다.
const RULE_FILE = path.join(root, '.jedi-ingest.json');
let exclude = [];
try { exclude = (JSON.parse(fs.readFileSync(RULE_FILE, 'utf8')).exclude || []).map(x => String(x).replace(/\\/g, '/').replace(/\/+$/, '')); } catch { /* 규칙 없음 = 첫 실행 */ }
const excluded = rel => exclude.some(x => rel === x || rel.startsWith(x + '/'));

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('~$') || e.name === '.DS_Store' || e.name === 'Thumbs.db' || e.name === '.jedi-ingest.json') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
    if (!e.isFile()) continue;
    const st = fs.statSync(full);
    const rel = path.relative(root, full).split(path.sep).join('/');
    const ext = path.extname(e.name).toLowerCase();
    const top = rel.includes('/') ? rel.split('/')[0] : '(맨 위)';
    let suggest;
    if (excluded(rel)) suggest = { action: 'skip', reason: 'excluded_by_rule' };
    else if (READ[ext] && st.size <= MAX_READ_BYTES) suggest = { action: 'read', extractor: READ[ext] };
    else if (READ[ext]) suggest = { action: 'ask', reason: 'too_large' };
    else suggest = { action: 'skip', reason: SKIP[ext] || 'unknown_type' };
    files.push({ file_path: rel, ext, size_bytes: st.size, mtime: st.mtime.toISOString(),
      file_hash: st.size <= MAX_READ_BYTES ? md5(full) : null, bundle: top, suggest });
  }
})(root);

// 커넥터 이름 = PC 이름. 같은 PC·같은 폴더는 다음번에도 같은 이름 → 서버 원장이 중복 없이 갱신된다.
const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'pc';
const summary = {};
for (const f of files) {
  const b = (summary[f.bundle] ||= { files: 0, read: 0, skip: 0, ask: 0, bytes: 0 });
  b.files++; b[f.suggest.action]++; b.bytes += f.size_bytes;
}
const result = {
  root: path.resolve(root),
  rules: { exclude },
  connector_id: `pc-${host}`,
  scan_batch: crypto.randomUUID(),
  total: files.length,
  bundles: summary,
  files,
};
const json = JSON.stringify(result, null, 2);
if (out) { fs.writeFileSync(out, json); console.log(`목록 ${files.length}개 → ${out}`); }
else console.log(json);
