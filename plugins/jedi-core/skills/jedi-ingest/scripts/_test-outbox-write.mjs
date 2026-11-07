#!/usr/bin/env node
// outbox-write.mjs 시험 — 실행 모양 그대로(scan-folder → sent-check filter → outbox-write → 보낸 기록 → 다시 filter) + 미래 상태 합성.
// 쓰는 법: node _test-outbox-write.mjs   (임시 폴더만 쓴다 · 네트워크 없음)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildBody, buildLedger, writeOutbox, readStatus, extractPdf, extractOffice, pickOrder, resolveInside,
  decodePlain, stripLoneSurrogates, Definite, Transient,
} from './outbox-write.mjs';
import { chunkText } from './chunk-text.mjs';
import { normalizeRules, isExcluded } from './exclude-rule.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-write-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.JEDI_INGEST_DIR;
const ingestDir = path.join(home, '.jedi-ingest');
const node = (script, args) => spawnSync(process.execPath, [path.join(here, script), ...args], { env, encoding: 'utf8' });

let pass = 0; let failed = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

// 작은 zip 만들기(시험 전용) — 진짜 오피스 파일과 같은 틀
function makeZip(entries) {
  const locals = []; const central = []; let off = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8'); const comp = zlib.deflateRawSync(raw); const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(Object.keys(entries).length, 8); eo.writeUInt16LE(Object.keys(entries).length, 10); eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eo]);
}
const DOCX = makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>첫 문단 A&amp;B</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">탭 뒤</w:t></w:r></w:p><w:p><w:r><w:instrText>숨은 필드</w:instrText></w:r><w:r><w:t>둘째 문단</w:t></w:r></w:p></w:body></w:document>' });
const XLSX = makeZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="매출&amp;비용" sheetId="1" r:id="rId1"/><sheet name="빈 시트" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>품목</t></si><si><r><t>가</t></r><r><t>격</t></r><rPh><t>읽는법</t></rPh></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><cols><col min="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>직접 글</t></is></c><c r="B2"/><c r="C2"><f>1+1</f><v>2</v></c></row><row r="3"/></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
});
const PPTX = makeZip({
  'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>열째 장</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>둘째 장</a:t></a:r><a:r><a:t> 이어서</a:t></a:r></a:p><a:p><a:r><a:t>다음 줄</a:t></a:r></a:p></p:sld>',
  'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:r><a:t>발표 노트</a:t></a:r></a:p></p:notes>',
});

const root = path.join(tmp, '자료');
const NFD_DIR = '가온 자료'.normalize('NFD');
const write = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
write(`${NFD_DIR}/메모.txt`.normalize('NFD'), '맥 낱자 이름 파일의 본문입니다.\n\n둘째 문단입니다.');
write('문서/계획.docx', DOCX);
write('문서/표.xlsx', XLSX);
write('문서/발표.pptx', PPTX);
write('문서/빈글.txt', '   ');
write('문서/비밀_고유이름.csv', 'a,b\n1,2');
write('문서/깨진.docx', Buffer.from('이건 압축 파일이 아닙니다'));
write('문서/스캔본.pdf', Buffer.from('%PDF-1.4 가짜'));
write('사진/a.png', Buffer.from([1, 2, 3]));
write('계약서/비밀계약.txt', '넣지 않을 본문 절대 나가면 안 됨');
fs.writeFileSync(path.join(root, '.jedi-ingest.json'), JSON.stringify({ connector_id: 'pc-test-drive', exclude: ['계약서'] }));

const f = (n) => path.join(tmp, n);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const outboxRows = () => {
  const d = path.join(ingestDir, 'outbox');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
};
const clearOutbox = () => fs.rmSync(path.join(ingestDir, 'outbox'), { recursive: true, force: true });

assert.equal(node('scan-folder.mjs', [root, '--out', f('scan.json')]).status, 0);
const filter = (out) => {
  const r = node('sent-check.mjs', ['filter', '--scan', f('scan.json'), '--connector', 'pc-test-drive', '--out', f(out)]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
filter('todo.json');
const todo = readJson(f('todo.json'));
const ok = (over = {}) => ({ root, ...over });

await t('N1 --dry-run 은 아무것도 쌓지 않고 숫자만 준다', () => {
  const r = node('outbox-write.mjs', ['--todo', f('todo.json'), '--root', root, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.dry_run, true); assert.equal(s.outbox_files, 0);
  assert.equal(fs.existsSync(path.join(ingestDir, 'outbox')), false);
  assert.ok(s.to_send >= 4, JSON.stringify(s));
});

await t('N2 화면에는 파일 이름·본문이 찍히지 않는다', () => {
  const r = node('outbox-write.mjs', ['--todo', f('todo.json'), '--root', root, '--dry-run']);
  for (const s of ['비밀_고유이름', '둘째 문단', '비밀계약']) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), s);
});

await t('N3 넣지 않기로 한 파일은 줄·경로·본문 어디에도 없다', () => {
  const r = node('outbox-write.mjs', ['--todo', f('todo.json'), '--root', root, '--report', f('report.json')]);
  assert.equal(r.status, 0, r.stderr);
  const raw = fs.readdirSync(path.join(ingestDir, 'outbox')).map((n) => fs.readFileSync(path.join(ingestDir, 'outbox', n), 'utf8')).join('');
  for (const s of ['비밀계약', '계약서', '절대 나가면']) { assert.ok(!raw.includes(s), s); assert.ok(!fs.readFileSync(f('report.json'), 'utf8').includes(s), s); }
});

await t('N4 🔴 scan.json 을 그대로 주면 쌓지 않고 멈춘다(제외 파일 유출 막기)', () => {
  clearOutbox();
  const r = node('outbox-write.mjs', ['--todo', f('scan.json'), '--root', root]);
  assert.equal(r.status, 2); assert.equal(outboxRows().length, 0);
  const r2 = node('outbox-write.mjs', ['--todo', f('scan.json'), '--ledger-only']);
  assert.equal(r2.status, 2); assert.equal(outboxRows().length, 0);
});

await t('N5 쓰는 쪽 약속: .tmp 없이 *.jsonl 만 남고 줄마다 서버 문 모양', () => {
  clearOutbox();
  assert.equal(node('outbox-write.mjs', ['--todo', f('todo.json'), '--root', root]).status, 0);
  const names = fs.readdirSync(path.join(ingestDir, 'outbox'));
  assert.ok(names.length && names.every((n) => /\.jsonl$/.test(n)), names.join());
  const rows = outboxRows();
  assert.ok(rows.length);
  for (const r of rows) {
    assert.equal(r.connector_id, 'pc-test-drive');
    assert.match(r.scan_batch, /^[0-9a-f-]{36}$/);
    assert.match(r.file_hash, /^[0-9a-f]{32}$/);
    assert.ok(!path.isAbsolute(r.file_path) && !r.file_path.includes('..'));
    if (r.chunks) { assert.equal(r.expected_chunk_count, r.chunks.length); assert.ok(r.extracted_chars > 0); assert.ok(r.extractor); }
    else { assert.equal(r.index_status, 'skipped'); assert.ok(r.skip_reason); }
  }
});

await t('N6 🔴 낱자 분리(NFD) 이름도 NFC 경로로 보낸다 + 파일은 원래 이름으로 읽는다', () => {
  const rows = outboxRows();
  const hit = rows.find((r) => r.file_path.endsWith('메모.txt'.normalize('NFC')));
  assert.ok(hit, rows.map((r) => r.file_path).join());
  assert.equal(hit.file_path, hit.file_path.normalize('NFC'));
  assert.ok(hit.chunks[0].includes('맥 낱자 이름 파일의 본문'));
});

await t('N7 보낸 기록을 러너 규칙대로 적으면 다음 filter 에서 본문 줄이 다시 안 나온다', () => {
  // 러너 file-push.js _record: cur[r.file_path] = { hash, size, mtime } · 본문 줄·skipped 줄만
  const rec = {};
  for (const r of outboxRows()) rec[r.file_path] = { hash: r.file_hash, size: r.size_bytes, mtime: r.mtime };
  fs.writeFileSync(path.join(ingestDir, 'sent-pc-test-drive.json'), JSON.stringify(rec));
  filter('todo2.json');
  const t2 = readJson(f('todo2.json'));
  const back = t2.files.filter((x) => x.suggest?.action === 'read' && rec[x.file_path.normalize('NFC')]);
  assert.equal(back.length, 0);
  assert.ok(!t2.files.some((x) => x.file_path.normalize('NFC').endsWith('메모.txt')));
  fs.rmSync(path.join(ingestDir, 'sent-pc-test-drive.json'));
});

await t('N8 PC 에 PDF 읽는 도구가 없으면 줄을 쓰지 않는다(skipped 로 잠그지 않기)', async () => {
  const { rows, summary } = await buildBody(todo, ok({ deps: { extractPdf: () => Promise.reject(new Transient('no_pdf_reader')) } }));
  assert.ok(!rows.some((r) => r.ext === '.pdf'));
  assert.equal(summary.left_reasons.no_pdf_reader, 1);
});

await t('N9 스캔본 PDF 는 skipped + 사유로 한 번 적는다', async () => {
  const { rows, summary } = await buildBody(todo, ok({ deps: { extractPdf: () => Promise.reject(new Definite('scanned_no_text')) } }));
  const pdf = rows.find((r) => r.ext === '.pdf');
  assert.equal(pdf.index_status, 'skipped'); assert.equal(pdf.skip_reason, 'scanned_no_text'); assert.ok(!pdf.chunks);
  assert.equal(summary.skip_reasons.scanned_no_text, 1);
});

await t('N10 extractPdf — 맥 판정(열쇠 잠김·스캔본·정상·시간초과)과 맥 밖', async () => {
  const fake = (err, stdout) => (c, a, o, cb) => cb(err, stdout);
  await assert.rejects(extractPdf('x', { platform: 'win32' }), (e) => e instanceof Transient && e.reason === 'no_pdf_reader');
  await assert.rejects(extractPdf('x', { platform: 'darwin', exec: fake(null, '{"ok":false,"reason":"locked"}') }), (e) => e instanceof Definite && e.reason === 'pdf_locked');
  await assert.rejects(extractPdf('x', { platform: 'darwin', exec: fake(null, '{"ok":false,"reason":"open_failed"}') }), (e) => e instanceof Transient && e.reason === 'pdf_open_failed');
  await assert.rejects(extractPdf('x', { platform: 'darwin', exec: fake(null, '{"ok":true,"pages":3,"text":" \\n "}') }), (e) => e instanceof Definite && e.reason === 'scanned_no_text');
  await assert.rejects(extractPdf('x', { platform: 'darwin', exec: fake(new Error('timeout'), '') }), (e) => e instanceof Transient);
  const good = await extractPdf('x', { platform: 'darwin', exec: fake(null, JSON.stringify({ ok: true, pages: 2, text: '충분히 긴 본문 글자입니다 충분히 긴 본문 글자입니다' })) });
  assert.equal(good.pages, 2);
});

await t('N11 오피스 글자 — 워드 탭·기호·숨은 필드 제외 / 엑셀 공유 글자·윗주 제외·직접 글·빈 시트 / 파워포인트 장 순서(2<10)·노트', () => {
  const d = extractOffice(path.join(root, '문서/계획.docx'), 'docx').text;
  assert.ok(d.includes('첫 문단 A&B\t탭 뒤')); assert.ok(d.includes('둘째 문단')); assert.ok(!d.includes('숨은 필드'));
  const x = extractOffice(path.join(root, '문서/표.xlsx'), 'xlsx').text;
  assert.ok(x.includes('# 매출&비용')); assert.ok(x.includes('품목\t가격')); assert.ok(x.includes('직접 글\t\t2'));
  assert.ok(!x.includes('읽는법')); assert.ok(!x.includes('빈 시트'));
  const p = extractOffice(path.join(root, '문서/발표.pptx'), 'pptx');
  assert.equal(p.pages, 2);
  assert.ok(p.text.indexOf('둘째 장 이어서') < p.text.indexOf('열째 장')); assert.ok(p.text.includes('다음 줄')); assert.ok(p.text.includes('발표 노트'));
});

await t('N12 🔴 받다 만 파일(압축 끝 없음)은 잠그지 않고 남긴다 · 암호 파일·빈 글만 skipped', async () => {
  const { rows, summary } = await buildBody(todo, ok({ deps: { extractPdf: () => Promise.reject(new Transient('no_pdf_reader')) } }));
  const by = (n) => rows.find((r) => r.file_path.endsWith(n));
  assert.equal(by('깨진.docx'), undefined);
  assert.equal(summary.left_reasons.incomplete_or_not_zip, 1);
  assert.equal(by('빈글.txt').skip_reason, 'empty_text');
  const ole = write('문서/암호.xlsx', Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600)]));
  assert.throws(() => extractOffice(ole, 'xlsx'), (e) => e instanceof Definite && e.reason === 'not_zip_or_encrypted');
  const zeros = write('문서/앞이0.xlsx', Buffer.alloc(600));
  assert.throws(() => extractOffice(zeros, 'xlsx'), (e) => e instanceof Transient);
  fs.unlinkSync(ole); fs.unlinkSync(zeros);
});

await t('N23 🔴 접두어 엑셀(<x:row>) · 🔴 날짜 칸은 날짜 글자로 · 숫자·글 칸은 그대로', () => {
  const p = write('문서/접두어.xlsx', makeZip({
    'xl/workbook.xml': '<x:workbook><x:sheets><x:sheet name="보고" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<x:styleSheet><x:numFmts><x:numFmt numFmtId="170" formatCode="yyyy&quot;년&quot; m&quot;월&quot;"/><x:numFmt numFmtId="171" formatCode="#,##0&quot;원&quot;"/></x:numFmts><x:cellXfs><x:xf numFmtId="0"/><x:xf numFmtId="14"/><x:xf numFmtId="170"/><x:xf numFmtId="171"/></x:cellXfs></x:styleSheet>',
    'xl/worksheets/sheet1.xml': '<x:worksheet><x:sheetData><x:row r="1"><x:c r="A1" t="str"><x:v>글칸</x:v></x:c><x:c r="B1" s="1"><x:v>45000</x:v></x:c><x:c r="C1" s="2"><x:v>45000.5</x:v></x:c><x:c r="D1" s="3"><x:v>45000</x:v></x:c><x:c r="E1" s="0"><x:v>12</x:v></x:c></x:row></x:sheetData></x:worksheet>',
  }));
  assert.equal(extractOffice(p, 'xlsx').text, '# 보고\n글칸\t2023-03-15\t2023-03-15 12:00\t45000\t12');
  fs.unlinkSync(p);
});

await t('N13 --limit: 종류를 번갈아 고른다 · 같은 입력 같은 순서 · 나머지는 left', async () => {
  const deps = { extractPdf: () => Promise.resolve({ text: 'PDF 본문 '.repeat(5), pages: 1 }) };
  const a = await buildBody(todo, ok({ limit: 4, deps }));
  const b = await buildBody(todo, ok({ limit: 4, deps }));
  assert.deepEqual(a.rows.map((r) => r.file_path), b.rows.map((r) => r.file_path));
  assert.equal(a.rows.length, 4);
  assert.deepEqual(a.rows.map((r) => r.ext), ['.csv', '.docx', '.pdf', '.pptx']); // 확장자 차례대로 하나씩 — 파일 순서에 기대지 않는다
  assert.ok(a.summary.left_reasons.over_limit > 0);
  assert.equal(pickOrder([{ file_path: 'b', ext: '.a' }, { file_path: 'a', ext: '.a' }, { file_path: 'c', ext: '.b' }]).map((x) => x.file_path).join(), 'a,c,b');
});

await t('N14 --max-chars: 넘는 파일에서 멈추고 뒤를 끼워 넣지 않는다', async () => {
  const deps = { extractPdf: () => Promise.reject(new Transient('no_pdf_reader')) };
  const { rows, summary } = await buildBody(todo, ok({ maxChars: 5, deps }));
  assert.equal(rows.filter((r) => r.chunks).length, 0);
  assert.ok(summary.left_reasons.over_max_chars >= 1);
});

await t('N15 스캔 뒤 내용이 바뀐 파일은 쌓지 않는다(해시가 다른 본문을 보내면 판이 섞인다)', async () => {
  const p = write('문서/바뀜.txt', '처음 글');
  const hash = 'a'.repeat(32);
  const mini = { connector_id: 'c', scan_batch: 'b', files: [{ file_path: '문서/바뀜.txt', ext: '.txt', size_bytes: 1, mtime: 'm', file_hash: hash, suggest: { action: 'read', extractor: 'plain' } }] };
  const { rows, summary } = await buildBody(mini, ok());
  assert.equal(rows.length, 0); assert.equal(summary.left_reasons.changed_since_scan, 1);
  fs.unlinkSync(p);
});

await t('N16 🔴 목록이 자료 폴더 밖을 가리키면 읽지 않는다', async () => {
  fs.writeFileSync(path.join(tmp, '밖.txt'), '밖의 비밀');
  assert.equal(resolveInside(root, '../밖.txt'), null);
  assert.equal(resolveInside(root, path.join(tmp, '밖.txt')), null);
  const mini = { connector_id: 'c', scan_batch: 'b', files: [{ file_path: '../밖.txt', ext: '.txt', suggest: { action: 'read', extractor: 'plain' } }] };
  const { rows, summary } = await buildBody(mini, ok());
  assert.equal(rows.length, 0); assert.equal(summary.left_reasons.outside_root, 1);
});

await t('N17 이모지가 조각 경계에 걸려도 혼자 남은 반쪽이 안 나간다', async () => {
  write('문서/이모지.txt', 'a'.repeat(1499) + '😀' + 'b'.repeat(50));
  const hash = await (await import('./outbox-write.mjs')).md5File(path.join(root, '문서/이모지.txt'));
  const mini = { connector_id: 'c', scan_batch: 'b', files: [{ file_path: '문서/이모지.txt', ext: '.txt', size_bytes: 1, mtime: 'm', file_hash: hash, suggest: { action: 'read', extractor: 'plain' } }] };
  const raw = chunkText('a'.repeat(1499) + '😀' + 'b'.repeat(50));
  assert.ok(raw.some((c) => /[\uD800-\uDBFF]$/.test(c)), '자르기가 쌍을 가른다는 전제가 깨졌다');
  const { rows } = await buildBody(mini, ok());
  for (const c of rows[0].chunks) assert.equal(c, stripLoneSurrogates(c));
  fs.unlinkSync(path.join(root, '문서/이모지.txt'));
});

await t('N18 옛 한글(EUC-KR)·UTF-16·BOM 글', () => {
  assert.equal(decodePlain(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])), '한글');
  assert.equal(decodePlain(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('글', 'utf16le')])), '글');
  assert.equal(decodePlain(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('글')])), '글');
});

await t('N19 --ledger-only: 본문 없음 · 건너뜀 사유 · 해시 없는 파일은 뺀다(서버 문이 거절)', () => {
  const big = { connector_id: 'c', scan_batch: 'b', files: [
    { file_path: 'a.mp4', ext: '.mp4', size_bytes: 9, mtime: 'm', file_hash: null, suggest: { action: 'skip', reason: 'media' } },
    { file_path: 'b.png', ext: '.png', size_bytes: 9, mtime: 'm', file_hash: 'f'.repeat(32), suggest: { action: 'skip', reason: 'image_no_text' } },
    { file_path: 'c.txt', ext: '.txt', size_bytes: 9, mtime: 'm', file_hash: 'e'.repeat(32), suggest: { action: 'read', extractor: 'plain' } },
  ] };
  const { rows, summary } = buildLedger(big);
  assert.equal(summary.no_hash, 1); assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !r.chunks));
  assert.equal(rows[0].index_status, 'skipped'); assert.equal(rows[0].skip_reason, 'image_no_text');
  assert.equal(rows[1].index_status, 'pending');
});

await t('N20 파일 나누기: 100줄·7MB 를 안 넘는다', () => {
  const dir = path.join(tmp, 'split');
  const rows = Array.from({ length: 250 }, (_, i) => ({ i }));
  assert.equal(writeOutbox(rows, { dir, batch: 'x' }).length, 3);
  const big = Array.from({ length: 3 }, () => ({ s: 'x'.repeat(4 * 1024 * 1024) }));
  assert.equal(writeOutbox(big, { dir: path.join(tmp, 'split2'), batch: 'y' }).length, 3);
});

await t('N21 --status: 숫자·사유만 · 이름 없음', () => {
  const dir = path.join(tmp, 'st');
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true }); fs.mkdirSync(path.join(dir, 'blocked')); fs.mkdirSync(path.join(dir, 'sent'));
  fs.writeFileSync(path.join(dir, 'outbox', 'a.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'outbox', 'b.jsonl.processing-1-a-1'), '{}\n');
  fs.writeFileSync(path.join(dir, 'blocked', 'c.jsonl'), `${JSON.stringify({ file_path: '비밀이름.pdf', _blocked: { reason: 'bad_file_path' } })}\n깨진 줄\n`);
  const s = readStatus({ dir });
  assert.deepEqual(s, { waiting_files: 1, working_files: 1, receipts: 0, blocked_rows: 2, blocked_reasons: { bad_file_path: 1, unknown: 1 }, retrying_rows: 0, retrying_reasons: {} });
  assert.ok(!JSON.stringify(s).includes('비밀이름'));
});

await t('N22 조각 나누기는 대화 경로와 같은 한 벌이다', () => {
  fs.writeFileSync(f('body.txt'), '문단 하나\n\n문단 둘\n\n' + '길다 '.repeat(800));
  const cli = JSON.parse(node('chunk-text.mjs', [f('body.txt')]).stdout);
  assert.deepEqual(cli.chunks, chunkText(fs.readFileSync(f('body.txt'), 'utf8')));
  assert.equal(cli.expected_chunk_count, cli.chunks.length);
});

await t('R1 🔴 목록을 만든 뒤 넣지 않기로 정한 폴더는 옛 todo.json 으로 나가지 않는다', () => {
  clearOutbox();
  const rulePath = path.join(root, '.jedi-ingest.json');
  const before = fs.readFileSync(rulePath, 'utf8');
  fs.writeFileSync(rulePath, JSON.stringify({ connector_id: 'pc-test-drive', exclude: ['계약서', '문서'] }));
  for (const extra of [['--limit', '10'], ['--ledger-only']]) {
    const r = node('outbox-write.mjs', ['--todo', f('todo.json'), '--root', root, ...extra]);
    assert.equal(r.status, 2, extra.join()); assert.equal(outboxRows().length, 0);
  }
  fs.writeFileSync(rulePath, '{ 깨진');
  assert.equal(node('outbox-write.mjs', ['--todo', f('todo.json'), '--root', root]).status, 2);
  fs.writeFileSync(rulePath, before);
});

await t('R1b 🔴 규칙 파일이 사라져도 «제외» 표시가 든 목록은 쌓지 않는다', () => {
  clearOutbox();
  const r0 = path.join(tmp, 'r0'); fs.mkdirSync(r0);
  fs.writeFileSync(f('mark.json'), JSON.stringify({ connector_id: 'c', scan_batch: 'b', files: [{ file_path: 'x.txt', ext: '.txt', suggest: { action: 'skip', reason: 'excluded_by_rule' } }] }));
  assert.equal(node('outbox-write.mjs', ['--todo', f('mark.json'), '--root', r0, '--ledger-only']).status, 2);
  assert.equal(outboxRows().length, 0);
});

await t('R2 🔴 규칙 — 이름은 어느 깊이든 · 경로는 맨 위 기준 · ./ / \\ NFD 대소문자를 맞춘다', () => {
  const rules = normalizeRules(['인사', './계약서', '/기밀/', 'a\\b', 'Contracts', '보고서/2024']);
  for (const rel of ['2024/인사/급여.xlsx', '인사/x', '계약서/y', '기밀/z', 'a/b/c', 'contracts/1', 'CONTRACTS/2', '보고서/2024/x', '2024/인사.txt'.replace('.txt', '')]) assert.ok(isExcluded(rel, rules), rel);
  assert.ok(isExcluded('2024/인사/급여.xlsx'.normalize('NFD'), normalizeRules(['인사'.normalize('NFC')])));
  for (const rel of ['인사팀/x', '다른/보고서/2024/x', 'a/c', '기밀문서/z']) assert.ok(!isExcluded(rel, rules), rel);
  assert.throws(() => normalizeRules('인사'));
});

await t('R3 🔴 깊은 폴더 제외가 먹고 제외 파일은 읽지 않으며, 안 걸린 규칙은 숫자로 보인다', () => {
  const r3 = path.join(tmp, 'r3');
  fs.mkdirSync(path.join(r3, '2024', '인사'), { recursive: true });
  fs.writeFileSync(path.join(r3, '2024', '인사', '급여.txt'), '본문');
  fs.writeFileSync(path.join(r3, '겉.txt'), '겉');
  fs.writeFileSync(path.join(r3, '.jedi-ingest.json'), JSON.stringify({ exclude: ['인사', '오타폴더'] }));
  assert.equal(node('scan-folder.mjs', [r3, '--out', f('r3.json')]).status, 0);
  const s = readJson(f('r3.json'));
  const hit = s.files.find((x) => x.file_path.endsWith('급여.txt'));
  assert.equal(hit.suggest.reason, 'excluded_by_rule'); assert.equal(hit.file_hash, null);
  assert.equal(s.rules_no_hit, 1); assert.equal(s.unreadable, 0);
  const out = node('sent-check.mjs', ['filter', '--scan', f('r3.json'), '--connector', 'c-x', '--out', f('r3t.json')]);
  assert.equal(JSON.parse(out.stdout).rules_no_hit, 1);
});

await t('R4 못 읽는 폴더가 있어도 스캔이 안 죽고 이름을 안 찍는다(윈도는 건너뜀)', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const r4 = path.join(tmp, 'r4'); const secret = path.join(r4, '비밀폴더이름');
  fs.mkdirSync(secret, { recursive: true }); fs.writeFileSync(path.join(r4, '겉.txt'), '겉');
  fs.chmodSync(secret, 0o000);
  try {
    const r = node('scan-folder.mjs', [r4, '--out', f('r4.json')]);
    assert.equal(r.status, 0); assert.ok(!(r.stdout + r.stderr).includes('비밀폴더이름'));
    assert.equal(readJson(f('r4.json')).unreadable, 1);
  } finally { fs.chmodSync(secret, 0o755); }
});

await t('R5 🔴 원장 줄 — 읽는 도구가 없는 종류는 pending 으로(건너뜀으로 잠그지 않기)', () => {
  const mini = { connector_id: 'c', scan_batch: 'b', files: [
    { file_path: 'a.hwp', ext: '.hwp', file_hash: 'a'.repeat(32), suggest: { action: 'skip', reason: 'hwp_not_supported' } },
    { file_path: 'b.doc', ext: '.doc', file_hash: 'b'.repeat(32), suggest: { action: 'skip', reason: 'unknown_type' } },
    { file_path: 'c.exe', ext: '.exe', file_hash: 'c'.repeat(32), suggest: { action: 'skip', reason: 'installer' } },
  ] };
  assert.deepEqual(buildLedger(mini).rows.map((r) => r.index_status), ['pending', 'pending', 'skipped']);
});

await t('R6 접두어가 다른 워드·파워포인트 · 여러 조각 직접 글 · 다른 접두어 r:id 도 읽는다', () => {
  const d = write('문서/접두어.docx', makeZip({ 'word/document.xml': '<ns0:document><ns0:p><ns0:r><ns0:t>다른 접두어 워드</ns0:t></ns0:r></ns0:p></ns0:document>' }));
  assert.ok(extractOffice(d, 'docx').text.includes('다른 접두어 워드'));
  const p = write('문서/접두어.pptx', makeZip({ 'ppt/slides/slide1.xml': '<q:sld><b:p><b:r><b:t lang="ko">다른 접두어 장표</b:t></b:r></b:p></q:sld>' }));
  assert.ok(extractOffice(p, 'pptx').text.includes('다른 접두어 장표'));
  const x = write('문서/조각.xlsx', makeZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="가" sheetId="1" d2p1:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>앞</t></r><r><t>뒤</t></r></is></c></row></sheetData></worksheet>',
  }));
  assert.equal(extractOffice(x, 'xlsx').text, '# 가\n앞뒤');
  for (const q of [d, p, x]) fs.unlinkSync(q);
});

await t('R7 절반 넘는 쪽이 빈 PDF 는 보내되 목록표 숫자로 드러난다 · 글자 수는 공백 뺀 값', async () => {
  const txt = '표지 글자입니다 충분히 깁니다 충분히 깁니다';
  const { rows, summary, report } = await buildBody(todo, ok({ deps: { extractPdf: () => Promise.resolve({ text: txt, pages: 200, thin: 199 }) } }));
  const pdf = rows.find((r) => r.ext === '.pdf');
  assert.ok(pdf.chunks); assert.equal(summary.partial_pdf, 1);
  assert.equal(pdf.extracted_chars, txt.replace(/\s/g, '').length);
  assert.ok(report.some((r) => r.partial_pdf));
  const ok2 = await buildBody(todo, ok({ deps: { extractPdf: () => Promise.resolve({ text: txt, pages: 2, thin: 1 }) } }));
  assert.equal(ok2.summary.partial_pdf, 0);
});

await t('R8 🔴 모르는 옵션은 멈춘다(--dryrun 오타가 실제 쌓기로 돌지 않게)', () => {
  clearOutbox();
  const r = node('outbox-write.mjs', ['--todo', f('todo.json'), '--root', root, '--dryrun']);
  assert.equal(r.status, 2); assert.equal(outboxRows().length, 0);
  assert.equal(node('outbox-write.mjs', ['--todo', f('todo.json'), '--ledger-only']).status, 2); // --root 없음
});

await t('R9 --status: 처리 중인 줄의 다시 보내기 사유가 보인다(사람 손이 필요한 신호)', () => {
  const dir = path.join(tmp, 'st2');
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'outbox', 'a.jsonl.processing-1-a-1'), `${JSON.stringify({ file_path: '비밀.pdf', _push: { last: 'sensitive_without_project' } })}\n${JSON.stringify({ file_path: 'b' })}\n쓰다 만`);
  const s = readStatus({ dir });
  assert.equal(s.retrying_rows, 1); assert.deepEqual(s.retrying_reasons, { sensitive_without_project: 1 });
  assert.ok(!JSON.stringify(s).includes('비밀'));
});

await t('D2 🔴 스킬 문서 — 전송 길과 사람 확인이 있고 «길이 없다»는 옛 문장이 없다', () => {
  const doc = fs.readFileSync(path.join(here, '..', 'SKILL.md'), 'utf8');
  for (const s of ['⑤-B 전송 길', '첫 전체 전송 전 사람 확인', '--dry-run', '--status', '쌓았다 ≠ 넣었다', '④ 뒤에 ①·①-4 를 다시 돌려', 'sensitive_without_project` 가 있으면 **더 쌓지 않고 멈춘다', 'rules_no_hit']) assert.ok(doc.includes(s), s);
  for (const s of ['대화를 거치지 않고 보내는 전송 문은 아직 없다', '대량을 보낼 길은 아직 없다', '그 길은 아직 이 스킬에서 열려 있지 않다']) assert.ok(!doc.includes(s), s);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
