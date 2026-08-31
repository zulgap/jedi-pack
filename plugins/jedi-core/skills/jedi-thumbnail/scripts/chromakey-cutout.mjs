#!/usr/bin/env node
// chromakey-cutout.mjs — 순수 녹색 배경 사진 → 인물만 남은 투명 PNG (팀원용, 의존성 0)
//
// 왜 이 스크립트인가:
//   썸네일에 진행자를 «누끼»로 얹으려면 배경이 지워진 투명 PNG 가 필요하다. 그런데 팀원 PC 에는
//   rembg·onnxruntime 같은 배경제거 라이브러리가 없고(2026-08-27 실측), 설치를 요구할 수도 없다.
//   그래서 ext_generate_image 로 **배경을 순수 녹색으로 바꾼 사진**을 받아 여기서 키잉한다.
//   PNG 코덱은 Node 내장 zlib 으로 직접 구현했다 — npm 의존성을 하나도 늘리지 않기 위해서다.
//
// 앞단(이미지 생성) 프롬프트에 반드시 넣을 것:
//   "배경은 완전히 균일한 순수 형광 녹색(#00FF00) 단색으로 채운다. 그라데이션·그림자·질감 없이
//    완벽하게 평평한 한 가지 색" + "인물 위에 녹색 빛이 번지지 않게 한다"
//
// 사용:
//   node chromakey-cutout.mjs <입력.png> <출력.png> [--top 0] [--bottom 1] [--threshold 40]
//     --top/--bottom  인물 바운딩박스 높이의 비율 구간만 남긴다 (전신 → 상반신 크롭용)
//     --threshold     녹색 판정 임계값. 기본 40
//   출력: 마지막 줄 = 저장 경로와 크기
//
// @AI:CONSTRAINT 8비트 RGB/RGBA · 비인터레이스 PNG 만 다룬다. 이미지 백엔드가 내보내는 형식이다.
//   그 밖의 형식은 조용히 깨지지 않도록 즉시 에러를 낸다.

import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }

// ── CRC32 (PNG 청크용) ───────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG 디코드 → {width, height, rgba} ───────────────────────────────────────
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('PNG 파일이 아닙니다');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // len(4) + type(4) + data + crc(4)
  }
  if (!ihdr) throw new Error('IHDR 청크가 없습니다');
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (bitDepth !== 8) throw new Error(`8비트 PNG만 지원합니다 (받은 bitDepth=${bitDepth})`);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`RGB(2)/RGBA(6)만 지원합니다 (받은 colorType=${colorType})`);
  }
  if (interlace !== 0) throw new Error('인터레이스 PNG는 지원하지 않습니다');

  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) throw new Error('IDAT 데이터가 잘려 있습니다');

  // 필터 해제 — 앞 픽셀(a)·윗줄(b)·윗줄 앞 픽셀(c) 기준
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
      let v = src[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      else if (ft !== 0) throw new Error(`알 수 없는 필터 타입 ${ft}`);
      cur[i] = v & 0xff;
    }
  }

  // RGB → RGBA 로 통일 (알파 255)
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = out[p * ch];
    rgba[p * 4 + 1] = out[p * ch + 1];
    rgba[p * 4 + 2] = out[p * ch + 2];
    rgba[p * 4 + 3] = ch === 4 ? out[p * ch + 3] : 255;
  }
  return { width, height, rgba };
}

// ── RGBA → PNG 인코드 (필터 0 고정) ──────────────────────────────────────────
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bitDepth
  ihdr[9] = 6;   // colorType RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const rawBuf = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawBuf[y * (stride + 1)] = 0; // filter: None
    rgba.copy(rawBuf, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawBuf, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 크로마키 ────────────────────────────────────────────────────────────────
/**
 * 녹색 배경을 알파로 바꾸고, 인물 바운딩박스로 잘라 낸다.
 *
 * @AI:INTENT 판정은 `G - max(R,B)` 하나로 한다. 무채색 체크 옷·검은 머리·피부는 이 값이 작고
 *   형광 녹색만 크게 나온다 — 색상환 변환 없이도 충분히 갈린다(실측 배경 RGB 약 (5,245,15)).
 * @AI:CONSTRAINT 알파만 0으로 만들고 끝내면 안 된다. 투명 픽셀의 **RGB 에 초록이 그대로 남아**
 *   브라우저가 축소할 때 그 색까지 보간해 초록 테두리가 번진다(2026-08-27 실측).
 *   불투명 색을 바깥으로 번지게(edge bleed) 한 뒤, 그 바깥은 중립 회색으로 눌러야 한다.
 */
export function chromaKey({ width, height, rgba }, { threshold = 40, top = 0, bottom = 1 } = {}) {
  const n = width * height;
  const alpha = new Uint8Array(n);
  const rgb = new Float32Array(n * 3);
  const soft = Math.max(1, threshold - 12); // 경계 반투명 구간 폭

  for (let p = 0; p < n; p++) {
    const r = rgba[p * 4], g = rgba[p * 4 + 1], b = rgba[p * 4 + 2];
    const excess = g - Math.max(r, b);
    if (excess > threshold) alpha[p] = 0;
    else if (excess > threshold - soft) {
      alpha[p] = Math.round(Math.max(0, Math.min(1, (threshold - excess) / soft)) * 255);
    } else alpha[p] = 255;
    // 스필 제거 — 남은 픽셀의 G 를 max(R,B) 수준으로 눌러 초록 테두리를 없앤다
    rgb[p * 3] = r;
    rgb[p * 3 + 1] = alpha[p] > 0 && g > Math.max(r, b) ? Math.max(r, b) : g;
    rgb[p * 3 + 2] = b;
  }

  // edge bleed — 불투명 색을 8픽셀 바깥으로 밀어낸다
  const known = new Uint8Array(n);
  for (let p = 0; p < n; p++) known[p] = alpha[p] > 8 ? 1 : 0;
  const acc = new Float32Array(3);
  for (let pass = 0; pass < 8; pass++) {
    const fill = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (known[p]) continue;
        acc[0] = acc[1] = acc[2] = 0;
        let cnt = 0;
        for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (!known[q]) continue;
          acc[0] += rgb[q * 3]; acc[1] += rgb[q * 3 + 1]; acc[2] += rgb[q * 3 + 2];
          cnt++;
        }
        if (cnt) fill.push([p, acc[0] / cnt, acc[1] / cnt, acc[2] / cnt]);
      }
    }
    if (!fill.length) break;
    for (const [p, r, g, b] of fill) {
      rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = b; known[p] = 1;
    }
  }
  // 번짐 밴드 바깥은 알파를 무시하는 뷰어에서 초록판으로 보인다 — 중립 회색으로 눌러 둔다
  for (let p = 0; p < n; p++) {
    if (!known[p]) { rgb[p * 3] = 128; rgb[p * 3 + 1] = 128; rgb[p * 3 + 2] = 128; }
  }

  // 인물 바운딩박스
  let y0 = height, y1 = -1, x0 = width, x1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 8) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  if (y1 < 0) throw new Error('인물을 찾지 못했습니다 — --threshold 를 낮춰 보세요');

  const h = y1 + 1 - y0;
  const cy0 = y0 + Math.floor(h * top);
  const cy1 = y0 + Math.floor(h * bottom);
  const cw = x1 + 1 - x0;
  const chh = Math.max(1, cy1 - cy0);

  const out = Buffer.alloc(cw * chh * 4);
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      const src = (cy0 + y) * width + (x0 + x);
      const dst = (y * cw + x) * 4;
      out[dst] = Math.round(rgb[src * 3]);
      out[dst + 1] = Math.round(rgb[src * 3 + 1]);
      out[dst + 2] = Math.round(rgb[src * 3 + 2]);
      out[dst + 3] = alpha[src];
    }
  }
  return { width: cw, height: chh, rgba: out };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const [src, dst] = argv.filter((a) => !a.startsWith('--'));
  if (!src || !dst) fail('사용법: node chromakey-cutout.mjs <입력.png> <출력.png> [--top 0] [--bottom 1] [--threshold 40]');

  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1];
  }
  const num = (v, d) => (v !== undefined && Number.isFinite(+v) ? +v : d);

  let img;
  try { img = decodePng(fs.readFileSync(src)); } catch (e) { fail(`읽기 실패: ${e.message}`); }

  let cut;
  try {
    cut = chromaKey(img, {
      threshold: num(opt.threshold, 40),
      top: num(opt.top, 0),
      bottom: num(opt.bottom, 1),
    });
  } catch (e) { fail(e.message); }

  fs.writeFileSync(dst, encodePng(cut.width, cut.height, cut.rgba));
  console.error(`✅ 누끼 완료 — 원본 ${img.width}×${img.height} → ${cut.width}×${cut.height}`);
  console.log(dst);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('chromakey-cutout.mjs')) {
  main();
}
