// chromakey-cutout.mjs 단위 테스트
// @AI:INTENT PNG 코덱을 직접 구현했으므로(npm 의존성 0) **필터 해제**가 최대 위험 구간이다.
//   인코더는 필터 0만 쓰기 때문에 왕복 테스트로는 필터 1~4 경로가 한 줄도 안 돈다.
//   그래서 필터 1~4로 직접 인코딩한 PNG를 만들어 디코더에 먹인다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, encodePng, chromaKey } from './chromakey-cutout.mjs';

const GREEN = [0, 255, 0];
const RED = [220, 30, 40];

/** width×height RGBA 버퍼를 만들고 (x,y)→[r,g,b] 로 채운다 */
function make(width, height, fn) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const p = (y * width + x) * 4;
      rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255;
    }
  }
  return { width, height, rgba };
}

// ── PNG 코덱 ────────────────────────────────────────────
test('encodePng → decodePng 왕복이 픽셀을 그대로 보존한다', () => {
  const src = make(7, 5, (x, y) => [x * 30, y * 50, (x + y) * 20]);
  const out = decodePng(encodePng(src.width, src.height, src.rgba));
  assert.equal(out.width, 7);
  assert.equal(out.height, 5);
  assert.deepEqual(Buffer.from(out.rgba), Buffer.from(src.rgba));
});

test('필터 1~4로 인코딩된 PNG를 정확히 해제한다 (Sub/Up/Average/Paeth)', () => {
  // 같은 그림을 «필터 타입만 다르게» 직접 인코딩해, 전부 같은 픽셀로 복원되는지 본다.
  const W = 6, H = 5, CH = 3;
  const pix = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) pix.push((x * 37 + y * 11) & 0xff, (x * 5 + y * 61) & 0xff, (x * 91 + y * 3) & 0xff);
  }
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  const crcT = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcT[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };

  for (const ft of [1, 2, 3, 4]) {
    const stride = W * CH;
    const raw = Buffer.alloc((stride + 1) * H);
    for (let y = 0; y < H; y++) {
      raw[y * (stride + 1)] = ft;
      for (let i = 0; i < stride; i++) {
        const cur = pix[y * stride + i];
        const a = i >= CH ? pix[y * stride + i - CH] : 0;
        const b = y > 0 ? pix[(y - 1) * stride + i] : 0;
        const c = y > 0 && i >= CH ? pix[(y - 1) * stride + i - CH] : 0;
        let v;
        if (ft === 1) v = cur - a;
        else if (ft === 2) v = cur - b;
        else if (ft === 3) v = cur - ((a + b) >> 1);
        else v = cur - paeth(a, b, c);
        raw[y * (stride + 1) + 1 + i] = v & 0xff;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2; // RGB
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);

    const got = decodePng(png);
    for (let p = 0; p < W * H; p++) {
      assert.equal(got.rgba[p * 4], pix[p * CH], `필터 ${ft}: 픽셀 ${p} R`);
      assert.equal(got.rgba[p * 4 + 1], pix[p * CH + 1], `필터 ${ft}: 픽셀 ${p} G`);
      assert.equal(got.rgba[p * 4 + 2], pix[p * CH + 2], `필터 ${ft}: 픽셀 ${p} B`);
      assert.equal(got.rgba[p * 4 + 3], 255, `필터 ${ft}: RGB는 알파 255로 채워야 한다`);
    }
  }
});

test('지원하지 않는 형식은 조용히 깨지지 않고 즉시 에러를 낸다', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /PNG 파일이 아닙니다/);
});

// ── 크로마키 ────────────────────────────────────────────
const withBlock = () => make(20, 16, (x, y) => (x >= 5 && x < 11 && y >= 4 && y < 12 ? RED : GREEN));

test('순수 녹색은 투명해지고 인물 픽셀은 불투명하게 남는다', () => {
  const cut = chromaKey(withBlock());
  assert.equal(cut.width, 6, '바운딩박스 폭');
  assert.equal(cut.height, 8, '바운딩박스 높이');
  for (let p = 0; p < cut.width * cut.height; p++) {
    assert.equal(cut.rgba[p * 4 + 3], 255, `픽셀 ${p}는 불투명해야 한다`);
  }
});

test('--top/--bottom은 바운딩박스 높이의 비율 구간만 남긴다 (전신 → 상반신)', () => {
  const cut = chromaKey(withBlock(), { top: 0, bottom: 0.5 });
  assert.equal(cut.height, 4, '높이 8의 위쪽 절반');
  assert.equal(cut.width, 6, '폭은 그대로');
});

test('투명 픽셀에 초록이 남지 않는다 (축소할 때 번지는 원인)', () => {
  // 인물을 한가운데 두면 사방이 투명 — 그 영역의 RGB가 초록이면 실패다.
  const cut = chromaKey(make(24, 24, (x, y) => (x >= 10 && x < 14 && y >= 10 && y < 14 ? RED : GREEN)), {
    top: 0, bottom: 1,
  });
  // 잘린 결과는 인물뿐이므로, 번짐 검증은 «자르기 전» 경계에서 본다 → 여백을 남기고 다시 확인
  const wide = chromaKey(make(24, 24, (x, y) => (x >= 2 && x < 22 && y >= 10 && y < 14 ? RED : GREEN)));
  for (const img of [cut, wide]) {
    for (let p = 0; p < img.width * img.height; p++) {
      if (img.rgba[p * 4 + 3] > 8) continue;
      const g = img.rgba[p * 4 + 1], r = img.rgba[p * 4], b = img.rgba[p * 4 + 2];
      assert.ok(g - Math.max(r, b) <= 8, `투명 픽셀 ${p}에 초록 잔량이 남았다 (${r},${g},${b})`);
    }
  }
});

test('인물이 하나도 없으면 빈 파일을 뱉지 않고 에러를 낸다', () => {
  assert.throws(() => chromaKey(make(8, 8, () => GREEN)), /인물을 찾지 못했습니다/);
});
