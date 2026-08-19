#!/usr/bin/env node
// upload-image.mjs — 로컬 이미지를 줄갭 백엔드 storage에 올리고 공개 URL을 받는다 (팀원용, 의존성 0)
// 사용: node upload-image.mjs <이미지파일경로> [--name 표시이름]
// 출력: 마지막 줄 = image_url (스크립트/에이전트가 그대로 캡처 가능)
//
// 왜 이 스크립트인가: ext_generate_image의 input_images는 웹 URL만 받는다.
// 로컬 PC 사진(인물 고정·합성 원본)은 이 스크립트로 먼저 URL을 만들어야 한다.
// 파일 바이트는 HTTP로 직접 전송 — AI 대화 컨텍스트를 통과하지 않는다(토큰 폭주 방지).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.env.JEDI_BASE_URL || 'https://judgmentos-unified-agent-production.up.railway.app';
const MAX_BYTES = 6 * 1024 * 1024; // 서버 base64 8MB cap ≈ 바이너리 6MB

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
if (!filePath) fail('사용법: node upload-image.mjs <이미지파일경로> [--name 표시이름]');
const nameIdx = args.indexOf('--name');
const displayName = nameIdx >= 0 ? args[nameIdx + 1] : path.basename(filePath);

// 1) 토큰 — Claude Code 제디 MCP 설정에서 읽기 (resolve-staff.js와 동일 위치)
let token = process.env.JUDGMENTOS_TOKEN || null;
if (!token) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    token = cfg?.mcpServers?.jedi?.env?.JUDGMENTOS_TOKEN || null;
  } catch (_) { /* 아래 공통 안내 */ }
}
if (!token) fail('JEDI_TOKEN 없음 — ~/.claude.json의 jedi MCP 설정(JUDGMENTOS_TOKEN)이 필요합니다. install 재실행 또는 사장님께 토큰 요청.');

// 2) 파일 읽기 + 크기/형식 사전 검사 (서버가 magic byte로 최종 판정 — png/jpeg/gif/webp만)
if (!fs.existsSync(filePath)) fail(`파일 없음: ${filePath}`);
const buf = fs.readFileSync(filePath);
if (buf.length > MAX_BYTES) fail(`파일이 너무 큼 (${(buf.length / 1024 / 1024).toFixed(1)}MB > 6MB) — 해상도를 줄여서 다시 시도`);
if (buf.length < 12) fail('이미지 파일이 아님 (너무 작음)');

// 3) 업로드 (Node 18+ 내장 fetch)
const res = await fetch(`${BASE}/mcp/ext/upload-image`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ file_base64: buf.toString('base64'), filename: displayName }),
}).catch((e) => fail(`네트워크 오류: ${e.message}`));

const body = await res.json().catch(() => null);
if (res.status === 401 || res.status === 403) fail('토큰 인증 실패 — 토큰 만료/교체 여부를 사장님께 확인');
if (res.status === 415) fail('지원하지 않는 이미지 형식 — png/jpeg/gif/webp만 가능 (실제 파일 내용 기준)');
if (res.status === 413) fail('파일이 너무 큼 — 6MB 이하로 줄여서 재시도');
if (!res.ok || !body?.success || !body?.data?.image_url) fail(`업로드 실패 (HTTP ${res.status}): ${body?.error || '알 수 없음'}`);

console.error(`✅ 업로드 완료${body.data.dedupe_hit ? ' (기존 동일 파일 재사용)' : ''} — ${displayName}`);
console.log(body.data.image_url);
