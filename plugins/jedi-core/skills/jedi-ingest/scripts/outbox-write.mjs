#!/usr/bin/env node
// 고른 파일의 글자를 뽑아 조각내고 «보낼 곳 폴더»에 쌓는다 — 판단 0 (결정론). 서버로는 PC 연결 프로그램이 보낸다.
// 쓰는 법:
//   node outbox-write.mjs --todo <todo.json> --root <자료 폴더> --dry-run             ← 양만 재기(아무것도 안 쌓음)
//   node outbox-write.mjs --todo <todo.json> --root <자료 폴더> --limit 10             ← 본문 쌓기
//   node outbox-write.mjs --todo <todo.json> --root <자료 폴더> --ledger-only                             ← 본문 없이 원장 줄만
//   node outbox-write.mjs --status                                                     ← 보낼 곳·막힘 숫자
// 다른 옵션: --max-chars <합계 글자 상한> · --include-large(30MB 넘는 문서도) · --report <파일별 결과 json>
// 나오는 것: 숫자 한 줄(JSON) — 파일 이름·본문은 화면에 찍지 않는다. 파일별 내역은 --report 파일(이 PC 안)에만 적는다.
// @AI:INTENT 본문을 클로드가 도구 호출에 다시 적으면 구독을 쓰고 글자가 달라진다 → 이 스크립트가 파일에서 바로 쓴다.
// @AI:CONSTRAINT 🔴 열쇠·토큰·네트워크를 쓰지 않는다. 파일만 쓰고, 보내기는 러너(cc-runner/lib/file-push.js)가 기기 토큰으로 한다.
// @AI:CONSTRAINT 🔴 쓰는 쪽 약속 = `<이름>.jsonl.tmp` 로 끝까지 쓴 뒤 `<이름>.jsonl` 로 rename(러너 file-push.js 머리말). 있는 파일에 덧붙이지 않는다.
// @AI:CONSTRAINT 🔴 file_path 는 NFC 로 보낸다 — 맥은 낱자 분리(NFD)로 주는데 서버 원장 줄은 NFC 다(2026-11-07 교수님 맥 380줄 NFD 0건). 그대로 보내면 같은 파일이 다른 줄로 갈라진다.
// @AI:CONSTRAINT 🔴 «도구가 없어서·잠시 못 읽어서» 못 읽은 파일은 줄을 쓰지 않는다 — skipped 줄은 보낸 기록에 남아 다음 스캔에서 빠지므로, 도구가 생겨도 영영 다시 안 읽는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chunkText } from './chunk-text.mjs';
import { loadRules, isExcluded } from './exclude-rule.mjs';

const nfc = (x) => String(x).normalize('NFC');
const MAX_ROWS_PER_FILE = 100;              // 서버 한 요청 상한과 같다
const MAX_FILE_BYTES = 7 * 1024 * 1024;     // 러너 요청 상한(7.5MB)보다 조금 낮게
const MAX_ROW_BYTES = 7 * 1024 * 1024;      // 한 줄이 이보다 크면 러너가 row_too_large 로 막는다 → 여기서 먼저 뺀다
const MAX_CHUNKS_PER_ROW = 1000;            // 서버 기기 시간당 상한 기본값 — 넘으면 서버가 chunks_over_cap 으로 막는다
const MAX_PLAIN_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;  // 압축 폭탄 막기
const PDF_TIMEOUT_MS = 180 * 1000;
const MIN_PDF_CHARS = 20;                   // 🟡 provisional — 이보다 적으면 스캔본으로 본다(쪽마다·전체 둘 다 이 기준)
// 🔑 다시 읽으면 달라질 수 있는 건너뜀 — 러너가 skipped 줄을 보낸 기록에 적어 영영 안 읽으므로, 원장에는 pending 으로 남긴다(읽는 도구가 생기면 다시 나온다).
const RETRY_LATER = new Set(['hwp_not_supported', 'unknown_type']);

/** 다시 시도하면 결과가 달라질 수 있는 실패 — 줄을 쓰지 않는다. */
export class Transient extends Error { constructor(reason) { super(reason); this.reason = reason; } }
/** 다시 읽어도 같은 결과 — skipped 줄로 남긴다. */
export class Definite extends Error { constructor(reason) { super(reason); this.reason = reason; } }

// ── 글자 뽑기 ───────────────────────────────────────────────────────────────
export function decodePlain(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch (_) { /* 옛 한글 파일 */ }
  try { return new TextDecoder('euc-kr', { fatal: true }).decode(body); } catch (_) { throw new Definite('unknown_encoding'); }
}

export function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, e) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
    if (e === 'quot') return '"'; if (e === 'apos') return "'";
    const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}

/** 압축 파일을 통째로 읽지 않고 필요한 것만 꺼낸다(200MB 파워포인트도 메모리에 다 안 올린다). */
export function openZip(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); };
  try {
    const tailLen = Math.min(size, 66 * 1024);
    const tail = read(size - tailLen, tailLen);
    const eo = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eo < 0) {
      // 🔑 암호 걸린 오피스 파일은 옛 복합 문서 모양(D0CF11E0)이다 → 다시 읽어도 같다.
      // 그 밖의 «압축 끝 표시 없음»은 받다 만 파일일 수 있다(실측: 앞이 전부 0 인 xlsx 4건) → 잠그지 않고 다음 회차에 다시 본다.
      if (read(0, 4).toString('hex') === 'd0cf11e0') throw new Definite('not_zip_or_encrypted');
      throw new Transient('incomplete_or_not_zip');
    }
    const count = tail.readUInt16LE(eo + 10);
    const cdSize = tail.readUInt32LE(eo + 12);
    const cdPos = tail.readUInt32LE(eo + 16);
    if (count === 0xffff || cdPos === 0xffffffff || cdSize === 0xffffffff) throw new Transient('zip64_unsupported');
    const cd = read(cdPos, cdSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Definite('bad_zip');
      const flags = cd.readUInt16LE(p + 8); const method = cd.readUInt16LE(p + 10);
      const comp = cd.readUInt32LE(p + 20); const raw = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28); const xl = cd.readUInt16LE(p + 30); const cl = cd.readUInt16LE(p + 32);
      const off = cd.readUInt32LE(p + 42);
      entries.set(cd.subarray(p + 46, p + 46 + nl).toString('utf8'), { flags, method, comp, raw, off });
      p += 46 + nl + xl + cl;
    }
    const text = (name) => {
      const e = entries.get(name);
      if (!e) return null;
      if (e.flags & 1) throw new Definite('not_zip_or_encrypted');
      if (e.raw > MAX_ENTRY_BYTES) throw new Transient('entry_too_large');
      const lh = read(e.off, 30);
      const start = e.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = read(start, e.comp);
      if (e.method === 0) return data.toString('utf8');
      if (e.method !== 8) throw new Transient('zip_method_unsupported');
      return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
    };
    return { names: () => [...entries.keys()], text, close: () => fs.closeSync(fd) };
  } catch (e) { fs.closeSync(fd); throw e; }
}

/** `<x:row>` 같은 접두어를 뗀다 — 서버·프로그램이 만든 오피스 파일은 다른 접두어를 쓴다(실측: 접두어 엑셀을 0자로 읽었다). 속성(r:id)은 그대로. */
export const dropPrefix = (xml) => (xml == null ? xml : xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1'));

export function docxText(raw) {
  const xml = dropPrefix(raw);
  const out = []; let cur = '';
  const re = /<t(?:\s[^>]*)?>([^<]*)<\/t>|<tab\/>|<br\/>|<\/p>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) cur += unescapeXml(m[1]);
    else if (m[0] === '<tab/>') cur += '\t';
    else if (m[0] === '<br/>') cur += '\n';
    else { if (cur.trim()) out.push(cur); cur = ''; }
  }
  if (cur.trim()) out.push(cur);
  return out.join('\n\n');
}

function slideText(raw) {
  const xml = dropPrefix(raw);
  const out = []; let cur = '';
  const re = /<t(?:\s[^>]*)?>([^<]*)<\/t>|<\/p>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) cur += unescapeXml(m[1]);
    else { if (cur.trim()) out.push(cur); cur = ''; }
  }
  if (cur.trim()) out.push(cur);
  return out.join('\n');
}

export function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const si = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = si.exec(xml))) {
    const body = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''); // 윗주(읽는 법)는 본문이 아니다
    let s = '';
    const t = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
    let tm;
    while ((tm = t.exec(body))) s += unescapeXml(tm[1]);
    out.push(s);
  }
  return out;
}

/** 스타일 번호 → 날짜 칸인가. 날짜는 파일 안에 일련번호(45000)로 있어 그대로 두면 검색에서 못 찾는다. */
export function dateStyles(xml) {
  const out = new Set();
  if (!xml) return out;
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = (/\bnumFmtId="(\d+)"/.exec(m[0]) || [])[1]; const code = (/\bformatCode="([^"]*)"/.exec(m[0]) || [])[1];
    if (id && code !== undefined) custom.set(Number(id), unescapeXml(code));
  }
  const isDateFmt = (id) => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = custom.get(id);
    if (!code) return false;
    return /[ymdh]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
  };
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!block) return out;
  let i = 0;
  for (const m of block[1].matchAll(/<xf\b[^>]*>/g)) {
    const id = Number((/\bnumFmtId="(\d+)"/.exec(m[0]) || [])[1] || 0);
    if (isDateFmt(id)) out.add(i);
    i++;
  }
  return out;
}

/** 엑셀 일련번호 → 날짜 글자(1900 체계). 말이 안 되는 값은 그대로 둔다. */
export function serialToDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return v;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  const iso = d.toISOString();
  return n % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function sheetText(xml, strings, dates = new Set()) {
  const rows = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let r;
  while ((r = rowRe.exec(xml))) {
    if (!r[1]) continue;
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cRe.exec(r[1]))) {
      const type = (/\bt="([^"]+)"/.exec(c[1]) || [])[1];
      const body = c[2] || '';
      let v = '';
      if (type === 'inlineStr') { for (const t of body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) v += unescapeXml(t[1]); }
      else {
        const vm = /<v>([^<]*)<\/v>/.exec(body);
        if (vm) {
          const style = Number((/\bs="(\d+)"/.exec(c[1]) || [])[1] ?? -1);
          if (type === 's') v = strings[Number(vm[1])] ?? '';
          else if ((!type || type === 'n') && dates.has(style)) v = serialToDate(vm[1]);
          else v = unescapeXml(vm[1]);
        }
      }
      cells.push(v);
    }
    if (cells.some((x) => x.trim())) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

const byNumber = (a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]);

export function extractOffice(file, kind) {
  const z = openZip(file);
  try {
    if (kind === 'docx') {
      const xml = z.text('word/document.xml');
      if (xml === null) throw new Definite('bad_office_file');
      return { text: docxText(xml), pages: null };
    }
    if (kind === 'pptx') {
      const slides = z.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
      if (!slides.length) throw new Definite('bad_office_file');
      // 발표 노트도 뽑는다 — 서버 추출기와 같은 범위(본문보다 노트에 맥락이 많은 자료가 있었다).
      const notes = z.names().filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).sort(byNumber);
      const part = (list) => list.map((n) => slideText(z.text(n))).filter((s) => s.trim()).join('\n\n');
      return { text: [part(slides), part(notes)].filter(Boolean).join('\n\n'), pages: slides.length };
    }
    if (kind === 'xlsx') {
      const wb = dropPrefix(z.text('xl/workbook.xml'));
      const rels = dropPrefix(z.text('xl/_rels/workbook.xml.rels'));
      if (wb === null || rels === null) throw new Definite('bad_office_file');
      const strings = sharedStrings(dropPrefix(z.text('xl/sharedStrings.xml')));
      const dates = dateStyles(dropPrefix(z.text('xl/styles.xml')));
      const target = new Map();
      for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        const id = (/\bId="([^"]+)"/.exec(m[0]) || [])[1]; const t = (/\bTarget="([^"]+)"/.exec(m[0]) || [])[1];
        if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t}`);
      }
      const parts = [];
      for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
        const name = unescapeXml((/\bname="([^"]*)"/.exec(m[0]) || [])[1] || '');
        const id = (/\s[\w.-]+:id="([^"]+)"/.exec(m[0]) || [])[1];
        const xml = target.has(id) ? z.text(target.get(id)) : null;
        const body = xml ? sheetText(dropPrefix(xml), strings, dates) : '';
        if (body) parts.push(`# ${name}\n${body}`);
      }
      return { text: parts.join('\n\n'), pages: null };
    }
    throw new Transient('unknown_office_kind');
  } finally { z.close(); }
}

// @AI:INTENT 맥에는 설치 없이 PDF 글자를 읽는 내장 부품(PDFKit)이 있다(2026-11-07 맥북 실측 — 한글 그대로 · 0.18초). 윈도는 내장이 없어 지금은 못 읽는다.
const JXA_PDF = `ObjC.import('PDFKit');ObjC.import('Foundation');
function run(argv){var d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
if(!d||d.isNil())return JSON.stringify({ok:false,reason:'open_failed'});
if(d.isLocked)return JSON.stringify({ok:false,reason:'locked'});
var n=Number(d.pageCount),thin=0;for(var i=0;i<n;i++){var p=d.pageAtIndex(i).string;if(!p||p.isNil()||Number(p.length)<${MIN_PDF_CHARS})thin++;}
var s=d.string;return JSON.stringify({ok:true,pages:n,thin:thin,text:(s&&!s.isNil())?s.js:''});}`;

export function extractPdf(file, { platform = process.platform, exec = execFile } = {}) {
  if (platform !== 'darwin') return Promise.reject(new Transient('no_pdf_reader'));
  return new Promise((resolve, reject) => {
    exec('osascript', ['-l', 'JavaScript', '-e', JXA_PDF, file], { timeout: PDF_TIMEOUT_MS, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(new Transient('pdf_read_failed'));
      let j;
      try { j = JSON.parse(stdout); } catch (_) { return reject(new Transient('pdf_read_failed')); }
      // 🔑 못 여는 PDF 는 덜 받은 파일일 수 있어 잠그지 않는다(압축 파일의 incomplete_or_not_zip 과 같은 이유). 암호만 다시 읽어도 같다.
      if (!j.ok) return reject(j.reason === 'locked' ? new Definite('pdf_locked') : new Transient('pdf_open_failed'));
      if (String(j.text || '').trim().length < MIN_PDF_CHARS) return reject(new Definite('scanned_no_text'));
      resolve({ text: j.text, pages: j.pages, thin: j.thin || 0 });
    });
  });
}

async function extract(file, extractor, deps) {
  if (extractor === 'plain') {
    const st = fs.statSync(file);
    if (st.size > MAX_PLAIN_BYTES) throw new Transient('plain_too_large');
    return { text: decodePlain(fs.readFileSync(file)), pages: null };
  }
  if (extractor === 'pdf') return (deps.extractPdf || extractPdf)(file);
  if (['docx', 'xlsx', 'pptx'].includes(extractor)) return extractOffice(file, extractor);
  throw new Transient('unknown_extractor');
}

// ── 줄 만들기 ───────────────────────────────────────────────────────────────
/** 조각 자르기가 이모지 쌍 가운데를 자르면 서버 저장·변환이 실패한다(2026-08 서버 추출기 14건 실패와 같은 원인) → 혼자 남은 반쪽을 뗀다. */
export function stripLoneSurrogates(s) {
  return String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

function baseRow(todo, f, hash) {
  return {
    connector_id: todo.connector_id, file_path: nfc(f.file_path), scan_batch: todo.scan_batch,
    ext: f.ext, size_bytes: f.size_bytes, mtime: f.mtime, file_hash: hash,
  };
}

/** 고르는 순서 — 확장자를 번갈아 고른다. --limit 10 이면 한 종류로 쏠리지 않고 PDF·워드·엑셀·파워포인트·글이 섞인다(글자 대조용). 같은 입력이면 늘 같은 순서. */
export function pickOrder(files) {
  const groups = new Map();
  for (const f of [...files].sort((a, b) => (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0))) {
    if (!groups.has(f.ext)) groups.set(f.ext, []);
    groups.get(f.ext).push(f);
  }
  const keys = [...groups.keys()].sort();
  const out = [];
  for (let i = 0; out.length < files.length; i++) for (const k of keys) if (groups.get(k)[i]) out.push(groups.get(k)[i]);
  return out;
}

/** 안전한 상대경로만 — 목록이 자료 폴더 밖을 가리키면 읽지 않는다. */
export function resolveInside(root, rel) {
  const abs = path.resolve(root, rel);
  const r = path.relative(path.resolve(root), abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return abs;
}

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

/** 본문 묶음 — 반환 { rows, summary, report }. 파일을 쓰지 않는다. */
export async function buildBody(todo, { root, limit = Infinity, maxChars = Infinity, includeLarge = false, deps = {} }) {
  const wanted = todo.files.filter((f) => f.suggest?.action === 'read' || (includeLarge && f.suggest?.action === 'ask'));
  const sum = {
    target: wanted.length, to_send: 0, chars: 0, chunks: 0, skipped: 0, left: 0, partial_pdf: 0, by_ext: {}, skip_reasons: {}, left_reasons: {},
    not_target: todo.files.length - wanted.length,
  };
  const rows = []; const report = [];
  const leave = (f, reason) => { sum.left++; bump(sum.left_reasons, reason); report.push({ file_path: nfc(f.file_path), result: 'left', reason }); };
  let picked = 0; let stopped = null;
  for (const f of pickOrder(wanted)) {
    if (stopped) { leave(f, stopped); continue; }
    if (picked >= limit) { stopped = 'over_limit'; leave(f, stopped); continue; }
    const file = resolveInside(root, f.file_path);
    if (!file) { leave(f, 'outside_root'); continue; }
    let hash;
    try { hash = await md5File(file); } catch (_) { leave(f, 'read_failed'); continue; }
    if (f.file_hash && f.file_hash !== hash) { leave(f, 'changed_since_scan'); continue; }
    const extractor = f.suggest?.extractor || { '.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' }[f.ext] || 'plain';
    let out;
    try {
      out = await extract(file, extractor, deps);
    } catch (e) {
      if (e instanceof Definite) {
        picked++;
        sum.skipped++; bump(sum.skip_reasons, e.reason);
        rows.push({ ...baseRow(todo, f, hash), extractor, index_status: 'skipped', skip_reason: e.reason });
        report.push({ file_path: nfc(f.file_path), result: 'skipped', reason: e.reason });
        continue;
      }
      leave(f, e instanceof Transient ? e.reason : 'extract_failed');
      continue;
    }
    const text = String(out.text || '').replace(/\u0000/g, '');
    const chunks = chunkText(text).map(stripLoneSurrogates).filter((c) => c.trim());
    if (!chunks.length) {
      picked++;
      sum.skipped++; bump(sum.skip_reasons, 'empty_text');
      rows.push({ ...baseRow(todo, f, hash), extractor, index_status: 'skipped', skip_reason: 'empty_text' });
      report.push({ file_path: nfc(f.file_path), result: 'skipped', reason: 'empty_text' });
      continue;
    }
    if (chunks.length > MAX_CHUNKS_PER_ROW) { leave(f, 'too_many_chunks'); continue; }
    const chars = text.replace(/\s/g, '').length; // 서버 추출기(doc-extractor)와 같은 뜻 — 공백 뺀 글자 수
    if (sum.chars + chars > maxChars) {
      // 🔑 합계 상한은 순서를 지킨다 — 작은 파일을 골라 끼워 넣으면 같은 입력의 다음 회차와 순서가 어긋난다.
      stopped = 'over_max_chars'; leave(f, stopped); continue;
    }
    const row = {
      ...baseRow(todo, f, hash), extractor, ...(out.pages != null ? { page_count: out.pages } : {}),
      extracted_chars: chars, expected_chunk_count: chunks.length, chunks,
    };
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') > MAX_ROW_BYTES) { leave(f, 'row_too_large'); continue; }
    picked++;
    rows.push(row);
    // 🔑 표지만 글자인 스캔본 — 읽은 만큼 보내되 숨기지 않는다. 절반 넘는 쪽이 비면 목록표에 따로 센다.
    const partial = out.pages > 0 && (out.thin || 0) / out.pages > 0.5;
    if (partial) sum.partial_pdf++;
    sum.to_send++; sum.chars += chars; sum.chunks += chunks.length; bump(sum.by_ext, f.ext || '(없음)');
    report.push({ file_path: nfc(f.file_path), result: 'to_send', extractor, chars, chunks: chunks.length, ...(partial ? { partial_pdf: true } : {}), chunk_sha1: chunks.map((c) => crypto.createHash('sha1').update(c).digest('hex').slice(0, 12)) });
  }
  return { rows, summary: sum, report };
}

/** 원장 줄만 — 본문 없음. 해시 없는 파일(30MB 넘는 영상 등)은 서버 문이 거절하므로 뺀다. */
export function buildLedger(todo) {
  const rows = []; let noHash = 0;
  for (const f of todo.files) {
    if (!f.file_hash) { noHash++; continue; }
    const skip = f.suggest?.action === 'skip' && !RETRY_LATER.has(f.suggest?.reason);
    rows.push({ ...baseRow(todo, f, f.file_hash), index_status: skip ? 'skipped' : 'pending', ...(skip ? { skip_reason: f.suggest.reason || 'unknown_type' } : {}) });
  }
  return { rows, summary: { rows: rows.length, no_hash: noHash } };
}

// ── 쌓기 ────────────────────────────────────────────────────────────────────
// @AI:DEPENDS 러너 cc-runner/lib/file-push.js baseDir() · sent-check.mjs recordDir() 와 같은 규칙.
export function baseDir(env = process.env) {
  return env.JEDI_INGEST_DIR || path.join(os.homedir(), '.jedi-ingest');
}

export function writeOutbox(rows, { dir = baseDir(), batch = crypto.randomUUID() } = {}) {
  const outDir = path.join(dir, 'outbox');
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  let cur = []; let bytes = 0; let seq = 0;
  const flush = () => {
    if (!cur.length) return;
    const name = `${batch}-${String(++seq).padStart(4, '0')}.jsonl`;
    const tmp = path.join(outDir, `${name}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, cur.join('\n') + '\n', null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, path.join(outDir, name));
    written.push(name);
    cur = []; bytes = 0;
  };
  for (const r of rows) {
    const line = JSON.stringify(r);
    const n = Buffer.byteLength(line, 'utf8') + 1;
    if (cur.length && (cur.length >= MAX_ROWS_PER_FILE || bytes + n > MAX_FILE_BYTES)) flush();
    cur.push(line); bytes += n;
  }
  flush();
  return written;
}

/** 보낼 곳·막힘 숫자 — 이름·본문 없음. 막힘 줄의 사유만 센다. */
export function readStatus({ dir = baseDir() } = {}) {
  const names = (d) => { try { return fs.readdirSync(path.join(dir, d)); } catch (_) { return []; } };
  const out = names('outbox');
  const res = {
    waiting_files: out.filter((n) => /\.jsonl$/i.test(n)).length,
    working_files: out.filter((n) => /\.jsonl\.processing-/i.test(n)).length,
    receipts: names('sent').length,
    blocked_rows: 0, blocked_reasons: {}, retrying_rows: 0, retrying_reasons: {},
  };
  // 처리 전용 파일 안의 «다시 보내는 중» 사유 — 사람이 손대야 하는 것(sensitive_without_project 등)은 막힘 칸에 안 간다.
  for (const n of out.filter((x) => /\.jsonl\.processing-/i.test(x))) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, 'outbox', n), 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let last = null;
      try { last = JSON.parse(line)?._push?.last || null; } catch (_) { /* 쓰다 만 줄 */ }
      if (last) { res.retrying_rows++; bump(res.retrying_reasons, last); }
    }
  }
  for (const n of names('blocked')) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, 'blocked', n), 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      res.blocked_rows++;
      let reason = 'unknown';
      try { reason = JSON.parse(line)?._blocked?.reason || 'unknown'; } catch (_) { /* 깨진 줄 */ }
      bump(res.blocked_reasons, reason);
    }
  }
  return res;
}

// ── 명령 ────────────────────────────────────────────────────────────────────
function fail(msg) { console.error(msg); process.exit(2); }
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const VALUE_OPTS = new Set(['--todo', '--root', '--limit', '--max-chars', '--report']);
const FLAG_OPTS = new Set(['--dry-run', '--ledger-only', '--status', '--include-large']);

async function main(argv) {
  // 🔴 모르는 옵션은 멈춘다 — 「--dryrun」 오타가 실제 쌓기로 돌면 안 된다.
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_OPTS.has(argv[i])) { i++; continue; }
    if (!FLAG_OPTS.has(argv[i])) fail('모르는 옵션입니다 — 쓰는 법은 스크립트 머리말을 보세요');
  }
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i > -1 ? argv[i + 1] : undefined; };
  const has = (name) => argv.includes(`--${name}`);
  if (has('status')) { console.log(JSON.stringify(readStatus())); return; }
  if (!opt('todo')) fail('쓰는 법: outbox-write.mjs --todo <todo.json> --root <자료 폴더> [--dry-run] [--limit N] | --ledger-only | --status');
  let todo;
  try { todo = JSON.parse(stripBom(fs.readFileSync(opt('todo'), 'utf8'))); } catch (e) { fail(`todo 목록을 읽지 못했습니다: ${e.message}`); }
  if (!Array.isArray(todo.files) || !todo.connector_id || !todo.scan_batch) fail('todo 목록 모양이 틀렸습니다 — sent-check.mjs filter 결과만 받습니다');
  // @AI:CONSTRAINT 🔴 scan.json 을 그대로 넘기면 넣지 않기로 한 파일의 경로·본문이 나간다 → 그런 줄이 하나라도 있으면 쌓지 않고 멈춘다.
  if (todo.rules !== undefined || todo.files.some((f) => f.suggest?.reason === 'excluded_by_rule')) fail('넣지 않기로 한 파일이 목록에 있습니다 — scan.json 이 아니라 sent-check.mjs filter 결과(todo.json)를 주세요');
  const root = opt('root');
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('--root 에 자료 폴더를 주세요');
  // @AI:CONSTRAINT 🔴 쌓기 직전에 규칙을 다시 본다 — 목록을 만든 뒤 ④ 에서 넣지 않기로 정한 폴더가 옛 todo.json 으로 나가는 길을 막는다.
  let rules;
  try { rules = loadRules(root); } catch (e) { fail('넣지 않을 폴더 규칙(.jedi-ingest.json)을 읽지 못해 멈춥니다'); }
  const hit = todo.files.filter((f) => isExcluded(f.file_path, rules)).length;
  if (hit) fail(`넣지 않기로 한 파일 ${hit}개가 목록에 남아 있습니다 — 훑기·거르기를 다시 돌려 새 todo.json 을 만드세요`);
  if (has('ledger-only')) {
    const { rows, summary } = buildLedger(todo);
    const files = has('dry-run') ? [] : writeOutbox(rows, { batch: todo.scan_batch });
    console.log(JSON.stringify({ mode: 'ledger', dry_run: has('dry-run'), ...summary, outbox_files: files.length }));
    return;
  }
  const num = (v, name) => { if (v === undefined) return Infinity; const n = Number(v); if (!Number.isInteger(n) || n < 0) fail(`--${name} 는 0 이상 정수`); return n; };
  const { rows, summary, report } = await buildBody(todo, {
    root, limit: num(opt('limit'), 'limit'), maxChars: num(opt('max-chars'), 'max-chars'), includeLarge: has('include-large'),
  });
  if (opt('report')) fs.writeFileSync(opt('report'), JSON.stringify(report, null, 1));
  const files = has('dry-run') ? [] : writeOutbox(rows, { batch: `${todo.scan_batch}-${Date.now().toString(36)}` });
  console.log(JSON.stringify({ mode: 'body', dry_run: has('dry-run'), ...summary, outbox_files: files.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`멈췄습니다: ${e && e.message}`); process.exit(2); });
}
