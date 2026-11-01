#!/usr/bin/env node
// playwright-mcp.mjs — 브라우저 MCP 를 «창마다 새 브라우저 + 로그인 금고 복사본» 으로 띄운다.
//
// .mcp.json 에서 이렇게 부른다 (버전 고정 문자열은 인자에 그대로 둔다 — mcp-version-check 가 읽는다):
//   "command": "node",
//   "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/playwright-mcp.mjs", "@playwright/mcp@0.0.80"]
//
// @AI:INTENT 예전에는 모든 창이 작업 폴더별 브라우저 프로필 하나를 같이 써서, 한 창이 열어 두면 다른 창이
//   「Browser is already in use」로 막혔다(2026-08-16~09-15 실측: 85세션·24일). 그래서 창마다 --isolated 로
//   새 브라우저를 띄우고, 로그인 쿠키만 금고 파일(pw-vault.mjs)에서 --storage-state 로 복사해 넣는다.
// @AI:CONSTRAINT 금고 파일이 없으면 --storage-state 가 실패해 브라우저가 아예 안 뜬다 — 반드시 먼저 만든다.
//   이 스크립트는 stdout 에 아무것도 쓰지 않는다(MCP 통신 채널이다). 진단은 stderr 로만.
// @AI:DEPENDS 되돌리는 길: 환경변수 ZULGAP_PW_SHARED_PROFILE=1 이면 옛 방식(공유 프로필)으로 띄운다.
//
// @AI:INTENT 2026-11-01 사장님 확정 — 작업용 크롬(127.0.0.1:9333 · 사람이 켜 둔 크롬)이 떠 있으면 거기에 붙는다.
//   새로 띄운 브라우저는 navigator.webdriver=true · UA HeadlessChrome 이고 로그인이 따로지만, 붙으면 일반 크롬 · 사람 로그인 그대로다.
//   붙을 때는 cdp-tab-fence.mjs 중계를 거쳐 «이 대화가 연 탭만» 보이게 한다(남의 탭을 옮기거나 닫지 않게).
//   작업용 크롬이 없으면(1.5초 안에 /json/version 답 없음) 위 금고 방식 그대로 — 작업용 크롬 없는 PC 하위호환.
// @AI:DEPENDS 끄는 길: ZULGAP_PW_WORK_CHROME=0 이면 작업용 크롬이 떠 있어도 금고 방식으로 띄운다.
//   🔴 작업용 크롬에 붙을 때는 --isolated 를 넘기지 않는다 — 넘기면 크롬 안에 빈 새 컨텍스트를 만들어 사람 로그인이 안 보인다.

import { spawn } from 'node:child_process';
import { ensureVault, WORK_CHROME_PORT } from './pw-vault.mjs';
import { startTabFence, workChromeUp } from './cdp-tab-fence.mjs';

const [pkg, ...rest] = process.argv.slice(2);
if (!pkg) {
  process.stderr.write('playwright-mcp: 패키지(@playwright/mcp@버전) 인자가 필요합니다\n');
  process.exit(2);
}

const legacy = process.env.ZULGAP_PW_SHARED_PROFILE === '1';
const workChromeOff = process.env.ZULGAP_PW_WORK_CHROME === '0';
const args = ['-y', pkg];
let fence = null;
if (!legacy && !workChromeOff && await workChromeUp(WORK_CHROME_PORT, 1500)) {
  try {
    fence = await startTabFence({ chromePort: WORK_CHROME_PORT });
    process.stderr.write(`playwright-mcp: 작업용 크롬(127.0.0.1:${WORK_CHROME_PORT})에 붙습니다 — 이 대화가 연 탭만 씁니다\n`);
  } catch (e) {
    process.stderr.write(`playwright-mcp: 작업용 크롬 울타리를 못 띄워 금고 방식으로 띄웁니다 — ${e.message}\n`);
  }
}
if (fence) {
  args.push('--cdp-endpoint', fence.endpoint);
} else if (!legacy) {
  let vault;
  try {
    vault = ensureVault();
  } catch (e) {
    process.stderr.write(`playwright-mcp: 금고를 만들지 못해 금고 없이 새 브라우저로 띄웁니다 — ${e.message}\n`);
  }
  args.push('--isolated');
  if (vault) args.push('--storage-state', vault);
}
args.push(...rest);

const isWin = process.platform === 'win32';
// @AI:FRAGILE Windows 는 npx 가 .cmd 라 shell 없이 spawn 하면 EINVAL(Node 24) — shell 을 켜고 공백 있는 인자는 따옴표로 감싼다.
const quoted = isWin ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
const child = spawn(isWin ? 'npx.cmd' : 'npx', quoted, { stdio: 'inherit', shell: isWin, windowsHide: true });

const forward = (sig) => { try { child.kill(sig); } catch { /* 이미 끝남 */ } };
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
child.on('exit', (code, signal) => { fence?.close(); process.exit(code ?? (signal ? 1 : 0)); });
child.on('error', (e) => {
  process.stderr.write(`playwright-mcp: 실행 실패 — ${e.message}\n`);
  process.exit(1);
});
