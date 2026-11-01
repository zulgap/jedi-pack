// cdp-tab-fence.mjs — 작업용 크롬(127.0.0.1:9333)에 붙는 플레이라이트에게 «자기가 연 탭만» 보여 주는 울타리.
//
// @AI:INTENT 2026-11-01 사장님 확정 — AI 브라우저는 사람이 켜 둔 작업용 크롬에 붙어 쓰고, 여러 대화가 같은 크롬을 쓸 때
//   각 대화는 자기가 연 탭만 만진다. 그런데 @playwright/mcp@0.0.83 을 --cdp-endpoint 로 그냥 붙이면(11/01 실측)
//   ① 이미 열려 있는 남의 탭을 「현재 탭」으로 잡아 browser_navigate 가 그 탭을 다른 주소로 옮겨 버린다
//   ② browser_tabs 에 남의 탭이 다 보여 select·close 로 남의 탭을 닫을 수 있다
//   ③ browser_resize 가 Browser.setWindowBounds 로 «크롬 창 전체» 크기를 바꾼다(남의 탭·폰 화면까지)
//   @playwright/mcp 에 「새 탭만 쓰기」 옵션은 없다(--help 전수 확인). 그래서 래퍼와 크롬 사이에 이 중계를 끼운다.
// @AI:CONSTRAINT 남의 탭은 «안 보이게»만 한다 — 닫거나 옮기지 않는다. 숨길 때 크롬이 그 탭을 디버거 대기로 멈춰 두었으면
//   반드시 풀어 준다(Runtime.runIfWaitingForDebugger) — 안 풀면 다른 대화가 막 연 탭이 하얀 화면으로 멈춘다.
// @AI:CONSTRAINT 이 파일은 stdout 에 쓰지 않는다(래퍼의 stdout 은 MCP 통신 채널이다). 진단은 stderr 로만.
//
// 구조: 플레이라이트 ─ws→ [이 중계 127.0.0.1:임의포트] ─ws→ 작업용 크롬
//   · «내 탭» = 이 연결이 Target.createTarget 으로 만든 탭 + 그 탭이 연 팝업(openerId)
//   · 판정은 TabFence(순수 상태기계) — 소켓 없이 시험한다(scripts/_test-pw-vault.js B5)

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

const PAGE_LIKE = new Set(['page', 'tab']);
const INTERNAL_ID_BASE = 1_900_000_000;
// 창·브라우저 전체에 닿는 명령 — 남의 탭과 사람에게까지 닿으므로 막는다.
const BLOCKED = new Map([
  ['Browser.close', '작업용 크롬은 사람이 켜 둔 공용 크롬이라 닫지 않습니다'],
  ['Browser.crash', '작업용 크롬은 공용이라 막았습니다'],
  ['Browser.crashGpuProcess', '작업용 크롬은 공용이라 막았습니다'],
  ['Browser.setWindowBounds', '작업용 크롬은 다른 대화·폰 화면이 같이 보는 창이라 창 크기를 바꾸지 않습니다'],
]);

/**
 * 순수 상태기계. 메시지(이미 JSON 으로 푼 것)를 넣으면 어디로 무엇을 보낼지 돌려준다.
 *   fromChrome(msg) / fromClient(msg) → { toClient: [msg...], toChrome: [msg...] }
 */
export class TabFence {
  constructor() {
    this.mine = new Set();          // 내 탭 targetId
    this.hiddenSessions = new Set(); // 숨긴 남의 탭 세션
    this.pendingCreate = new Set();  // 응답을 기다리는 Target.createTarget 의 id
    this.getTargetsIds = new Set();
    this.holding = false;
    this.queue = [];
    this.nextInternal = INTERNAL_ID_BASE;
  }

  _isMine(ti) {
    if (!ti) return false;
    if (this.mine.has(ti.targetId)) return true;
    if (ti.openerId && this.mine.has(ti.openerId)) { this.mine.add(ti.targetId); return true; }
    return false;
  }

  _foreignPage(ti) { return !!ti && PAGE_LIKE.has(ti.type) && !this._isMine(ti); }

  fromClient(msg) {
    const out = { toClient: [], toChrome: [] };
    if (!msg || typeof msg.method !== 'string') { out.toChrome.push(msg); return out; }
    const reason = BLOCKED.get(msg.method);
    if (reason) {
      const r = { id: msg.id, error: { code: -32000, message: reason } };
      if (msg.sessionId) r.sessionId = msg.sessionId;
      out.toClient.push(r);
      return out;
    }
    if (msg.method === 'Target.closeTarget' && !this.mine.has(msg.params && msg.params.targetId)) {
      out.toClient.push({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), error: { code: -32000, message: '이 대화가 연 탭이 아니라서 닫지 않습니다' } });
      return out;
    }
    if (msg.method === 'Target.createTarget' && !msg.sessionId) this.pendingCreate.add(msg.id);
    if (msg.method === 'Target.getTargets') this.getTargetsIds.add(`${msg.sessionId || ''}:${msg.id}`);
    // @AI:INTENT 다운로드 위치를 플레이라이트 임시 폴더로 돌리면 «남의 탭·사람»의 다운로드까지 그리로 간다 — 크롬 기본 위치 그대로 두고 알림만 받는다.
    if (msg.method === 'Browser.setDownloadBehavior') {
      out.toChrome.push({ ...msg, params: { behavior: 'default', eventsEnabled: true, ...(msg.params && msg.params.browserContextId ? { browserContextId: msg.params.browserContextId } : {}) } });
      return out;
    }
    out.toChrome.push(msg);
    return out;
  }

  fromChrome(msg) {
    const out = { toClient: [], toChrome: [] };
    if (msg && typeof msg.id === 'number' && msg.id >= INTERNAL_ID_BASE) return out; // 내가 보낸 명령의 답
    if (msg && msg.id != null && !msg.sessionId && this.pendingCreate.has(msg.id)) {
      this.pendingCreate.delete(msg.id);
      if (msg.result && msg.result.targetId) this.mine.add(msg.result.targetId);
    }
    if (this.holding) {
      this.queue.push(msg);
      if (this.pendingCreate.size === 0) this._flush(out);
      return out;
    }
    this._process(msg, out);
    return out;
  }

  _flush(out) {
    this.holding = false;
    const q = this.queue; this.queue = [];
    for (const m of q) {
      if (this.holding) this.queue.push(m); else this._process(m, out);
    }
  }

  _internal(method, params, sessionId) {
    const m = { id: this.nextInternal++, method, params };
    if (sessionId) m.sessionId = sessionId;
    return m;
  }

  _process(msg, out) {
    if (!msg) return;
    if (msg.sessionId && this.hiddenSessions.has(msg.sessionId)) return;
    const p = msg.params || {};
    const rootLevel = !msg.sessionId;
    if (rootLevel && (msg.method === 'Target.attachedToTarget' || msg.method === 'Target.targetCreated') && PAGE_LIKE.has(p.targetInfo && p.targetInfo.type) && !this._isMine(p.targetInfo)) {
      // @AI:FRAGILE 내가 막 만든 탭의 attach 가 createTarget 응답보다 먼저 올 수 있다 — 응답이 올 때까지 순서째 붙잡아 둔다.
      if (this.pendingCreate.size > 0) { this.holding = true; this.queue.push(msg); return; }
      if (msg.method === 'Target.attachedToTarget') {
        this.hiddenSessions.add(p.sessionId);
        if (p.waitingForDebugger) out.toChrome.push(this._internal('Runtime.runIfWaitingForDebugger', {}, p.sessionId));
        out.toChrome.push(this._internal('Target.detachFromTarget', { sessionId: p.sessionId }));
      }
      return;
    }
    if (rootLevel && msg.method === 'Target.detachedFromTarget' && this.hiddenSessions.has(p.sessionId)) { this.hiddenSessions.delete(p.sessionId); return; }
    if (rootLevel && (msg.method === 'Target.targetInfoChanged' || msg.method === 'Target.targetDestroyed')) {
      const id = p.targetInfo ? p.targetInfo.targetId : p.targetId;
      if (p.targetInfo && this._foreignPage(p.targetInfo)) return;
      if (msg.method === 'Target.targetDestroyed' && !this.mine.has(id)) return;
      if (msg.method === 'Target.targetDestroyed') this.mine.delete(id);
    }
    const gk = `${msg.sessionId || ''}:${msg.id}`;
    if (msg.id != null && this.getTargetsIds.has(gk)) {
      this.getTargetsIds.delete(gk);
      if (msg.result && Array.isArray(msg.result.targetInfos)) {
        msg = { ...msg, result: { ...msg.result, targetInfos: msg.result.targetInfos.filter((t) => !this._foreignPage(t)) } };
      }
    }
    out.toClient.push(msg);
  }
}

// ── 웹소켓 틀(RFC 6455) — 압축 확장은 요청에서 빼므로 다루지 않는다 ─────────────────────────
export function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  const head = [0x80 | opcode];
  let ext;
  if (len < 126) { head.push((mask ? 0x80 : 0) | len); ext = Buffer.alloc(0); }
  else if (len < 65536) { head.push((mask ? 0x80 : 0) | 126); ext = Buffer.alloc(2); ext.writeUInt16BE(len); }
  else { head.push((mask ? 0x80 : 0) | 127); ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(len)); }
  if (!mask) return Buffer.concat([Buffer.from(head), ext, payload]);
  const key = crypto.randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), ext, key, body]);
}

/** 들어온 바이트에서 완성된 틀을 꺼낸다 → { frames:[{fin,opcode,payload}], rest } */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = (b1 & 0x80) !== 0;
    let key;
    if (masked) { if (buf.length - p < 4) break; key = buf.subarray(p, p + 4); p += 4; }
    if (buf.length - p < len) break;
    let payload = buf.subarray(p, p + len);
    if (masked) { const u = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ key[i & 3]; payload = u; }
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload: Buffer.from(payload) });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** 한 방향 흐름: 틀을 모아 «완성된 글 메시지»마다 onText, 제어 틀은 onControl */
function framePump(onText, onControl) {
  let buf = Buffer.alloc(0);
  let parts = null;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const { frames, rest } = decodeFrames(buf);
    buf = Buffer.from(rest);
    for (const f of frames) {
      if (f.opcode >= 8) { onControl(f); continue; }
      if (f.opcode === 1 || f.opcode === 2) parts = [f.payload];
      else if (f.opcode === 0 && parts) parts.push(f.payload);
      if (f.fin && parts) { const whole = Buffer.concat(parts); parts = null; onText(whole); }
    }
  };
}

const log = (s) => { try { process.stderr.write(`cdp-tab-fence: ${s}\n`); } catch { /* 무시 */ } };

/**
 * 울타리 중계를 띄운다. 연결마다 TabFence 하나(= 플레이라이트 연결 하나 = 대화 하나).
 * @returns {Promise<{ port:number, endpoint:string, close:()=>void }>}
 */
export async function startTabFence({ chromePort, host = '127.0.0.1' }) {
  const chromeBase = `http://${host}:${chromePort}`;
  const server = http.createServer(async (req, res) => {
    // 플레이라이트 connectOverCDP 가 묻는 것은 /json/version 하나 — 연결 주소만 이 중계로 바꿔 준다. 탭 목록(/json/list)은 내주지 않는다.
    if (process.env.ZULGAP_CDP_FENCE_DEBUG === '1') log(`http ${req.method} ${req.url}`);
    if (/^\/json\/version\/?$/.test(req.url || '')) {
      try {
        const v = await (await fetch(`${chromeBase}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
        const port = server.address().port;
        if (v.webSocketDebuggerUrl) v.webSocketDebuggerUrl = v.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${host}:${port}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      } catch (e) {
        res.writeHead(502); res.end('작업용 크롬 응답 없음');
      }
      return;
    }
    res.writeHead(404); res.end();
  });

  server.on('upgrade', (req, client, head) => {
    const fence = new TabFence();
    const upstream = net.connect(chromePort, host);
    let handshaken = false;
    let hsBuf = Buffer.alloc(0);
    const sendClient = (m) => { if (!client.destroyed) client.write(encodeFrame(1, Buffer.from(JSON.stringify(m)), false)); };
    const sendChrome = (m) => { if (!upstream.destroyed) upstream.write(encodeFrame(1, Buffer.from(JSON.stringify(m)), true)); };
    const dbg = process.env.ZULGAP_CDP_FENCE_DEBUG === '1'
      ? (dir, m) => log(`${dir} ${String(m.method || '')}${m.id != null ? '#' + m.id : ''}${m.sessionId ? ' s=' + m.sessionId.slice(0, 6) : ''}${m.params && m.params.targetInfo ? ' ' + m.params.targetInfo.type + ':' + m.params.targetInfo.targetId.slice(0, 6) + ' opener=' + String(m.params.targetInfo.openerId || '').slice(0, 6) : ''}`)
      : null;
    const route = (r) => {
      if (dbg) { r.toChrome.forEach((m) => dbg('→크롬', m)); r.toClient.forEach((m) => dbg('→PW', m)); }
      r.toChrome.forEach(sendChrome); r.toClient.forEach(sendClient);
    };
    const closeBoth = () => { try { client.destroy(); } catch {} try { upstream.destroy(); } catch {} };

    const fromClient = framePump((data) => {
      let m; try { m = JSON.parse(data.toString('utf8')); } catch { upstream.write(encodeFrame(1, data, true)); return; }
      route(fence.fromClient(m));
    }, (f) => { upstream.write(encodeFrame(f.opcode, f.payload, true)); if (f.opcode === 8) closeBoth(); });
    const fromChrome = framePump((data) => {
      let m; try { m = JSON.parse(data.toString('utf8')); } catch { client.write(encodeFrame(1, data, false)); return; }
      route(fence.fromChrome(m));
    }, (f) => { client.write(encodeFrame(f.opcode, f.payload, false)); if (f.opcode === 8) closeBoth(); });

    upstream.on('connect', () => {
      const lines = [`GET ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^(host|sec-websocket-extensions)$/i.test(k)) continue;
        lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Host: ${host}:${chromePort}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
    });
    upstream.on('data', (chunk) => {
      if (handshaken) { fromChrome(chunk); return; }
      hsBuf = Buffer.concat([hsBuf, chunk]);
      const end = hsBuf.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.write(hsBuf.subarray(0, end + 4));
      handshaken = true;
      if (head && head.length) fromClient(head);
      const rest = hsBuf.subarray(end + 4);
      if (rest.length) fromChrome(Buffer.from(rest));
    });
    client.on('data', (chunk) => { if (handshaken) fromClient(chunk); else head = Buffer.concat([head || Buffer.alloc(0), chunk]); });
    upstream.on('error', (e) => { log(`크롬 연결 오류 — ${e.message}`); closeBoth(); });
    client.on('error', () => closeBoth());
    upstream.on('close', () => closeBoth());
    client.on('close', () => closeBoth());
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const port = server.address().port;
  return { port, endpoint: `http://${host}:${port}`, close: () => server.close() };
}

/** 작업용 크롬이 떠 있나 — /json/version 이 timeoutMs 안에 답하면 true */
export async function workChromeUp(port, timeoutMs = 1500, host = '127.0.0.1') {
  try {
    const r = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const v = await r.json();
    return typeof v.webSocketDebuggerUrl === 'string';
  } catch { return false; }
}
