/**
 * V13 阶段 3 测试 (修订) — 飞书应用模块 (token + 发消息 + WS 收)
 *
 * 覆盖:
 *   1. 构造 FeishuApp 不崩
 *   2. 缺凭证时 start() 报错但不抛
 *   3. token 缓存 (同 token 复用)
 *   4. sendText 调 axios 走 POST
 *   5. sendCard 走 POST + card 字段
 *   6. WS 收到 event message → onMessage 触发
 *   7. onMessage 返回 string → sendText
 *   8. onMessage 返回 {card} → sendCard
 *   9. 非 p2p (group chat) 不回消息
 *  10. WS 断线自动重连
 *  11. stop() 后不再重连
 *  12. 凭证刷新机制 (过期前 10 分钟主动刷)
 *  13. WS 收到的 interactive (卡片回调) 解析 action.value
 *  14. onError 钩子触发
 *  15. isConnected() 反映状态
 *  16. (新) HTTP endpoint discovery 成功 → 拿到 wss URL
 *  17. (新) endpoint discovery 失败 → onError + 重连
 *  18. (改) WS connect 后不发 auth frame (鉴权在 URL 升级握手阶段完成)
 *  19. (新) CONTROL PING → 忽略不崩
 *  20. (新) CONTROL PONG → 更新 ClientConfig
 *  21. (新) DATA event sum=1 → 直接走 onMessage
 *  22. (新) DATA event sum=3 → 等 3 片齐了再触发
 *  23. (新) DATA card → 走 onAction
 *  24. (新) Ping 周期触发
 *  25. (新) WS close → 调度重连
 *  26. (新) 重连时重新走 endpoint discovery
 */
'use strict';

// mock axios + ws + protobufjs 避免真实网络
const path = require('path');
const Module = require('module');
const origResolve = Module._resolveFilename;

// ============== fakeAxios ==============
const _axiosMock = { posts: [], gets: [], responses: new Map(), failNext: null };

const fakeAxios = {
  post(url, data, opts) {
    _axiosMock.posts.push({ url, data, opts });
    const failKey = url + '|' + JSON.stringify(data);
    if (_axiosMock.failNext && failKey.includes(_axiosMock.failNext)) {
      const err = new Error('mock fail');
      err.response = { data: { msg: 'mocked error' } };
      _axiosMock.failNext = null;
      return Promise.reject(err);
    }
    // endpoint discovery
    if (url.includes('/callback/ws/endpoint')) {
      const forcedFail = _axiosMock.responses.get('endpoint');
      if (forcedFail) {
        if (forcedFail === 'network_error') return Promise.reject(new Error('mock network'));
        return Promise.resolve({ data: forcedFail });
      }
      return Promise.resolve({
        data: {
          code: 0,
          msg: 'ok',
          data: {
            URL: 'wss://open-mock.feishu.cn/ws?service_id=1&device_id=mock-dev',
            ClientConfig: { PingInterval: 120, ReconnectCount: 5, ReconnectInterval: 60, ReconnectNonce: 30 }
          }
        }
      });
    }
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return Promise.resolve({ data: { code: 0, tenant_access_token: 'mock-token-123', expire: 7200 } });
    }
    if (url.includes('/im/v1/messages') && (data?.msg_type === 'text' || data?.card)) {
      return Promise.resolve({ data: { code: 0, data: { message_id: 'mock-msg-' + _axiosMock.posts.length } } });
    }
    return Promise.resolve({ data: { code: 0 } });
  },
  get(url, opts) {
    _axiosMock.gets.push({ url, opts });
    return Promise.resolve({ data: { code: 0 } });
  }
};

// ============== fakeWs ==============
const _wsMock = { instances: [], lastInstance: null };

const fakeWs = function (url, opts) {
  this.url = url;
  this.opts = opts;
  this.readyState = 0;
  this.OPEN = 1;
  this.CLOSED = 3;
  const handlers = {};
  this._sentFrames = [];   // 记录所有 ws.send(...) 数据
  _wsMock.instances.push(this);
  _wsMock.lastInstance = this;
  this.on = (evt, fn) => { handlers[evt] = fn; this['_' + evt] = fn; };
  this.send = (data) => { this._sentFrames.push(data); this._lastSent = data; };
  this.close = () => { this.readyState = 3; if (handlers.close) handlers.close(); };
  this._handlers = handlers;
  this._triggerOpen = () => { this.readyState = 1; if (handlers.open) handlers.open(); };
  this._triggerMessage = (raw) => {
    // Debug: 看 raw 是什么
    if (raw && raw.length) {
      // 反解 fake frame 看 payloadLen
      const d = decodeFrame(raw);
      if (process.env.FEISHU_TEST_DEBUG) console.log('  [debug] frame seq=', d.headers.find(h=>h.key==='seq')?.value, 'payloadLen=', d.payload?.length, 'payloadBuf is Buffer:', Buffer.isBuffer(d.payload));
    }
    if (handlers.message) handlers.message(raw);
  };
  this._triggerClose = () => { this.readyState = 3; if (handlers.close) handlers.close(); };
  this._triggerError = (e) => { if (handlers.error) handlers.error(e); };
};

// ============== fakeFrameType (JS 对象 ↔ Buffer 简化编解码) ==============
// 编码格式: 4 bytes header (SeqID LE uint32) + headers.length (1 byte) + headers + 4 bytes payload.length + payload
// 这是测试用简易协议, 真实 wire format 由真实 protobufjs 保证 (生产代码用真实库)

function _encodeHeaders(headers) {
  const parts = [];
  for (const h of headers) {
    const k = Buffer.from(h.key, 'utf8');
    const v = Buffer.from(h.value, 'utf8');
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt8(k.length, 0); lenBuf.writeUInt8(v.length, 1);
    parts.push(lenBuf, k, v);
  }
  return Buffer.concat(parts);
}

function _decodeHeaders(buf, offset, count) {
  const headers = [];
  for (let i = 0; i < count; i++) {
    const kLen = buf.readUInt8(offset); offset += 1;
    const vLen = buf.readUInt8(offset); offset += 1;
    const k = buf.slice(offset, offset + kLen).toString('utf8'); offset += kLen;
    const v = buf.slice(offset, offset + vLen).toString('utf8'); offset += vLen;
    headers.push({ key: k, value: v });
  }
  return { headers, nextOffset: offset };
}

function encodeFrame(obj) {
  // obj = {SeqID, LogID, service, method, headers, payload}
  const headersBuf = _encodeHeaders(obj.headers || []);
  const payloadBuf = obj.payload ? Buffer.from(obj.payload) : Buffer.alloc(0);
  const buf = Buffer.alloc(4 + 4 + 4 + 4 + 1 + headersBuf.length + 4 + payloadBuf.length);
  let off = 0;
  buf.writeUInt32LE(obj.SeqID >>> 0, off); off += 4;
  buf.writeUInt32LE((obj.LogID || 0) >>> 0, off); off += 4;
  buf.writeInt32LE(obj.service === undefined ? 1 : obj.service, off); off += 4;
  buf.writeInt32LE(obj.method === undefined ? 1 : obj.method, off); off += 4;
  buf.writeUInt8(obj.headers?.length || 0, off); off += 1;
  headersBuf.copy(buf, off); off += headersBuf.length;
  buf.writeUInt32LE(payloadBuf.length, off); off += 4;
  payloadBuf.copy(buf, off);
  return buf;
}

function decodeFrame(buf) {
  let off = 0;
  const SeqID = buf.readUInt32LE(off); off += 4;
  const LogID = buf.readUInt32LE(off); off += 4;
  const service = buf.readInt32LE(off); off += 4;
  const method = buf.readInt32LE(off); off += 4;
  const headerCount = buf.readUInt8(off); off += 1;
  const { headers, nextOffset } = _decodeHeaders(buf, off, headerCount);
  off = nextOffset;
  const payloadLen = buf.readUInt32LE(off); off += 4;
  const payload = buf.slice(off, off + payloadLen);
  return { SeqID, LogID, service, method, headers, payload };
}

const fakeFrameType = {
  create(obj) { return obj; },
  encode(obj) { return { finish: () => encodeFrame(obj) }; },
  decode(buf) { return decodeFrame(buf); }
};

const fakeProtobuf = {
  loadSync() {
    return { lookupType: () => fakeFrameType };
  }
};

// ============== 拦截 require ==============
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'axios') return fakeAxios;
  if (req === 'ws') return fakeWs;
  if (req === 'protobufjs') return fakeProtobuf;
  return origLoad.apply(this, arguments);
};

// ============== 测 FeishuApp ==============
const { FeishuApp } = require('../../electron/feishu-app');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

async function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// helper: 构造 fake DATA event frame
function makeEventFrame({ type = 'event', sum = 1, seq = 0, msgId = 'm-' + Date.now(), messageType = 'text', text = 'hi', sender = 'ou_user1' }) {
  const evt = {
    sender: { sender_id: { open_id: sender } },
    message_id: msgId,
    chat_id: 'c-001',
    chat_type: 'p2p',
    message_type: messageType,
    content: JSON.stringify({ text })
  };
  if (messageType === 'interactive') {
    evt.content = JSON.stringify({ action: { value: { askId: 'a1', decision: 'confirm' } } });
  }
  return encodeFrame({
    SeqID: 1, LogID: 0, service: 1, method: 1,
    headers: [
      { key: 'type', value: type },
      { key: 'message_id', value: msgId },
      { key: 'sum', value: String(sum) },
      { key: 'seq', value: String(seq) }
    ],
    payload: Buffer.from(JSON.stringify(evt), 'utf8')
  });
}

(async () => {
  // ===== 情形 1: 构造不崩 =====
  console.log('\n情形 1: 构造 FeishuApp');
  {
    const app = new FeishuApp({ appId: 'cli_test', appSecret: 'secret' });
    assert(typeof app.start === 'function', '有 start 方法');
    assert(typeof app.sendText === 'function', '有 sendText 方法');
    assert(typeof app.stop === 'function', '有 stop 方法');
    assert(typeof app.sendCard === 'function', '有 sendCard 方法');
    assert(typeof app.isConnected === 'function', '有 isConnected 方法');
    assert(app.isConnected() === false, '初始未连接');
  }

  // ===== 情形 2: 缺凭证 start 报错 =====
  console.log('\n情形 2: 缺凭证 start');
  {
    let errCaught = null;
    const app = new FeishuApp({ appId: '', appSecret: '', onError: (e) => { errCaught = e; } });
    const ok = await app.start();
    assert(ok === false, 'start 返回 false');
    assert(errCaught !== null, 'onError 触发');
    assert(/appId\/appSecret/.test(errCaught.message), `错误含凭证提示: ${errCaught.message}`);
  }

  // ===== 情形 3: token 缓存复用 =====
  console.log('\n情形 3: token 缓存复用');
  {
    _axiosMock.posts = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.sendText('ou_x', 'hi');
    await app.sendText('ou_y', 'hi2');
    const tokenCalls = _axiosMock.posts.filter(p => p.url.includes('tenant_access_token')).length;
    assert(tokenCalls === 1, `token 只调 1 次 (实际=${tokenCalls})`);
    app.stop();
  }

  // ===== 情形 4: sendText POST 内容正确 =====
  console.log('\n情形 4: sendText POST');
  {
    _axiosMock.posts = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    const r = await app.sendText('ou_abc', 'hello');
    assert(r.ok === true, 'sendText ok');
    assert(/^mock-msg-/.test(r.messageId), `返回 messageId: ${r.messageId}`);
    const msg = _axiosMock.posts.find(p => p.url.includes('/im/v1/messages'));
    assert(!!msg, '调了 /im/v1/messages');
    assert(msg.opts.headers.Authorization === 'Bearer mock-token-123', 'Authorization 是 Bearer token');
    assert(msg.data.receive_id === 'ou_abc', 'receive_id 正确');
    assert(msg.data.msg_type === 'text', 'msg_type=text');
    const content = JSON.parse(msg.data.content);
    assert(content.text === 'hello', `content.text=hello (${content.text})`);
  }

  // ===== 情形 5: sendCard =====
  console.log('\n情形 5: sendCard');
  {
    _axiosMock.posts = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    const r = await app.sendCard('ou_xyz', { header: { title: { tag: 'plain_text', content: '确认' } }, elements: [] });
    assert(r.ok === true, 'sendCard ok');
    const msg = _axiosMock.posts.find(p => p.url.includes('/im/v1/messages') && p.data.card);
    assert(!!msg, '调了 messages 含 card');
    assert(msg.data.msg_type === 'interactive', 'msg_type=interactive');
    assert(msg.data.card.header.title.content === '确认', 'card 内容透传');
  }

  // ===== 情形 6: WS 收 message → onMessage 触发 =====
  console.log('\n情形 6: WS 收消息触发 onMessage');
  {
    _wsMock.instances = [];
    let receivedMsg = null;
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onMessage: async (msg) => { receivedMsg = msg; return 'pong'; }
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    assert(app.isConnected() === true, 'WS 连接后 isConnected=true');

    const frame = makeEventFrame({ sender: 'ou_user1', msgId: 'm-001', text: '查一下 600519' });
    ws._triggerMessage(frame);
    await waitMs(50);
    assert(receivedMsg !== null, 'onMessage 触发');
    assert(receivedMsg.openId === 'ou_user1', `openId 正确: ${receivedMsg?.openId}`);
    assert(receivedMsg.text === '查一下 600519', `text 正确: ${receivedMsg?.text}`);
    assert(receivedMsg.messageId === 'm-001', 'messageId 正确');
    assert(receivedMsg.chatType === 'p2p', 'chatType 正确');
    app.stop();
  }

  // ===== 情形 7: onMessage 返回 string → sendText =====
  console.log('\n情形 7: 回复字符串发文本');
  {
    _axiosMock.posts = [];
    _wsMock.instances = [];
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onMessage: async () => 'echo reply'
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    ws._triggerMessage(makeEventFrame({ sender: 'ou_echo' }));
    await waitMs(80);
    const replyMsg = _axiosMock.posts.find(p => p.url.includes('/im/v1/messages'));
    assert(!!replyMsg, '回发了消息');
    assert(replyMsg.data.receive_id === 'ou_echo', '回给原 sender');
    const content = JSON.parse(replyMsg.data.content);
    assert(content.text === 'echo reply', `回文本: ${content.text}`);
    app.stop();
  }

  // ===== 情形 8: onMessage 返回 {card} → sendCard =====
  console.log('\n情形 8: 回复 card');
  {
    _axiosMock.posts = [];
    _wsMock.instances = [];
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onMessage: async () => ({ card: { header: { title: { tag: 'plain_text', content: 'OK' } } } })
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    ws._triggerMessage(makeEventFrame({ sender: 'ou_card' }));
    await waitMs(80);
    const replyMsg = _axiosMock.posts.find(p => p.url.includes('/im/v1/messages') && p.data.card);
    assert(!!replyMsg, '回发了 card');
    assert(replyMsg.data.msg_type === 'interactive', 'msg_type=interactive');
    app.stop();
  }

  // ===== 情形 9: group chat 不回消息 =====
  console.log('\n情形 9: group chat 不回消息');
  {
    _axiosMock.posts = [];
    _wsMock.instances = [];
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onMessage: async () => 'should not reply'
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const evt = {
      sender: { sender_id: { open_id: 'ou_grp' } },
      message_id: 'm-grp', chat_id: 'c-grp', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text: 'hi' })
    };
    const frame = encodeFrame({
      SeqID: 1, LogID: 0, service: 1, method: 1,
      headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm-grp' }],
      payload: Buffer.from(JSON.stringify(evt), 'utf8')
    });
    ws._triggerMessage(frame);
    await waitMs(80);
    const replyMsg = _axiosMock.posts.find(p => p.url.includes('/im/v1/messages'));
    assert(!replyMsg, 'group chat 没回消息');
    app.stop();
  }

  // ===== 情形 10: WS 断线自动重连 =====
  console.log('\n情形 10: WS 断线自动重连');
  {
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const before = _wsMock.instances.length;
    ws._triggerClose();
    // 重连默认 3s 延迟, 缩短测试等待
    await waitMs(3500);
    const after = _wsMock.instances.length;
    assert(after > before, `重连创建新 ws (before=${before} after=${after})`);
    app.stop();
  }

  // ===== 情形 11: stop 后不再重连 =====
  console.log('\n情形 11: stop 后不再重连');
  {
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    app.stop();
    ws._triggerClose();
    await waitMs(3500);
    const after = _wsMock.instances.length;
    assert(after === 1, `stop 后没新增 ws (count=${after})`);
  }

  // ===== 情形 12: token 刷新机制 =====
  console.log('\n情形 12: token 刷新 (过期前 10 分钟)');
  {
    _axiosMock.posts = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    // 强制让 cache 标记过期
    app._tokenCache = { token: 'old-token', expiresAt: Date.now() + 5 * 60 * 1000 };   // 5 分钟 < 10 分钟
    await app.sendText('ou_x', 'hi');
    const tokenCalls = _axiosMock.posts.filter(p => p.url.includes('tenant_access_token')).length;
    assert(tokenCalls === 1, `过期前 10 分钟主动刷 (实际=${tokenCalls})`);
  }

  // ===== 情形 13: interactive 卡片回调走 onAction =====
  console.log('\n情形 13: interactive 卡片回调');
  {
    _wsMock.instances = [];
    let actionRecv = null;
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onAction: async (act) => { actionRecv = act; }
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const frame = makeEventFrame({ messageType: 'interactive', sender: 'ou_action' });
    ws._triggerMessage(frame);
    await waitMs(50);
    assert(actionRecv !== null, 'onAction 触发');
    assert(actionRecv.openId === 'ou_action', 'onAction.openId 正确');
    assert(actionRecv.action?.askId === 'a1', 'onAction.action.askId 正确');
    assert(actionRecv.action?.decision === 'confirm', 'onAction.action.decision 正确');
    app.stop();
  }

  // ===== 情形 14: onError 钩子触发 =====
  console.log('\n情形 14: onError 钩子');
  {
    let errMsg = null;
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onError: (e) => { errMsg = e.message; }
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    ws._triggerError(new Error('test ws error'));
    await waitMs(50);
    assert(/WS error/.test(errMsg || ''), `onError 收到: ${errMsg}`);
    app.stop();
  }

  // ===== 情形 15: isConnected 反映状态 =====
  console.log('\n情形 15: isConnected 状态');
  {
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    assert(app.isConnected() === false, '初始 false');
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    assert(app.isConnected() === true, 'open 后 true');
    ws._triggerClose();
    await waitMs(20);
    assert(app.isConnected() === false, 'close 后 false');
    app.stop();
  }

  // ===== 情形 16 (新): endpoint discovery 成功 =====
  console.log('\n情形 16: HTTP endpoint discovery 成功');
  {
    _axiosMock.posts = [];
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.start();
    await waitMs(20);
    const epCalls = _axiosMock.posts.filter(p => p.url.includes('/callback/ws/endpoint'));
    assert(epCalls.length === 1, `discovery 调 1 次 (${epCalls.length})`);
    // E2.10 关键证据: discovery 走 https://open.feishu.cn (无 /open-apis 前缀)
    // (实测 https://open.feishu.cn/open-apis/callback/ws/endpoint 返回 404 plain text)
    assert(epCalls[0].url === 'https://open.feishu.cn/callback/ws/endpoint',
      `discovery base 不带 /open-apis (got: ${epCalls[0].url})`);
    assert(epCalls[0].data.AppID === 'cli_t', 'AppID 传入');
    assert(epCalls[0].data.AppSecret === 's', 'AppSecret 传入');
    assert(app._connUrl.includes('wss://'), `connUrl: ${app._connUrl}`);
    assert(app._clientConfig?.PingInterval === 120, `ClientConfig.PingInterval=120`);
    app.stop();
  }

  // ===== 情形 17 (新): endpoint discovery 失败 =====
  console.log('\n情形 17: endpoint discovery 失败');
  {
    _axiosMock.responses.set('endpoint', { code: 230001, msg: 'invalid app_id' });
    let errCaught = null;
    const app = new FeishuApp({
      appId: 'cli_bad', appSecret: 's',
      onError: (e) => { errCaught = e; }
    });
    const ok = await app.start();
    assert(ok === false, 'discovery 失败 → start 返回 false');
    assert(errCaught !== null, 'onError 触发');
    assert(/endpoint discovery/.test(errCaught.message), `错误含 discovery: ${errCaught.message}`);
    _axiosMock.responses.delete('endpoint');
    app.stop();
  }

    // ===== 情形 18 (新): WS connect 后不发 auth frame (鉴权在 URL 握手阶段) =====
  console.log('情形 18: WS connect 后不发 auth frame');
  {
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    // lark_oapi 不在 ws.on('open') 后发 protobuf auth frame,
    // 鉴权通过动态 wss URL 在 WebSocket 升级握手阶段完成。
    assert(ws._sentFrames.length === 0, `connect 后不发 auth frame (${ws._sentFrames.length})`);
    app.stop();
  }
// ===== 情形 19 (新): CONTROL PING → 不崩 =====
  console.log('\n情形 19: CONTROL PING 忽略');
  {
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const pingFrame = encodeFrame({
      SeqID: 99, LogID: 0, service: 1, method: 0,
      headers: [{ key: 'type', value: 'ping' }],
      payload: Buffer.alloc(0)
    });
    let crashed = false;
    try { ws._triggerMessage(pingFrame); } catch { crashed = true; }
    assert(!crashed, 'CONTROL PING 不崩');
    assert(app.isConnected() === true, '连接保持');
    app.stop();
  }

  // ===== 情形 20 (新): CONTROL PONG → 更新 ClientConfig =====
  console.log('\n情形 20: CONTROL PONG 更新 ClientConfig');
  {
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const newConf = { PingInterval: 60, ReconnectCount: 3 };
    const pongFrame = encodeFrame({
      SeqID: 100, LogID: 0, service: 1, method: 0,
      headers: [{ key: 'type', value: 'pong' }],
      payload: Buffer.from(JSON.stringify(newConf), 'utf8')
    });
    ws._triggerMessage(pongFrame);
    await waitMs(20);
    assert(app._clientConfig.PingInterval === 60, `PONG 后 PingInterval=60 (实际=${app._clientConfig.PingInterval})`);
    app.stop();
  }

  // ===== 情形 21 (新): DATA event sum=1 → 直接走 onMessage =====
  console.log('\n情形 21: DATA event sum=1 直接触发');
  {
    _wsMock.instances = [];
    let received = null;
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onMessage: async (msg) => { received = msg; }
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    ws._triggerMessage(makeEventFrame({ msgId: 'm-direct', text: 'sum1' }));
    await waitMs(50);
    assert(received?.text === 'sum1', `sum1 直接触发 onMessage (${received?.text})`);
    app.stop();
  }

  // ===== 情形 22 (新): DATA event sum=3 → 等 3 片齐了再触发 =====
  console.log('\n情形 22: DATA event sum=3 合包');
  {
    _wsMock.instances = [];
    let received = null;
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onMessage: async (msg) => { received = msg; }
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const evtBig = { sender: { sender_id: { open_id: 'ou_big' } }, message_id: 'm-big', chat_id: 'c-big', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'PART_A_PART_B_PART_C' }) };
    const fullPayload = Buffer.from(JSON.stringify(evtBig), 'utf8');
    const part1 = fullPayload.slice(0, 10);
    const part2 = fullPayload.slice(10, 25);
    const part3 = fullPayload.slice(25);
    function makePart(seq, payload) {
      return encodeFrame({
        SeqID: 1, LogID: 0, service: 1, method: 1,
        headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm-big' }, { key: 'sum', value: '3' }, { key: 'seq', value: String(seq) }],
        payload
      });
    }
    ws._triggerMessage(makePart(0, part1));
    await waitMs(20);
    assert(received === null, 'seq=0 时不触发 (还有 2 片未到)');
    ws._triggerMessage(makePart(2, part3));
    await waitMs(20);
    assert(received === null, 'seq=2 来了但还差 seq=1');
    ws._triggerMessage(makePart(1, part2));
    await waitMs(50);
    assert(received !== null, '3 片齐了触发 onMessage');
    if (received) {
      assert(received.openId === 'ou_big', '合包后 openId 正确');
      assert(received.text === 'PART_A_PART_B_PART_C', `合包 text 完整: ${received?.text}`);
    }
    app.stop();
  }

  // ===== 情形 23 (新): DATA card → 走 onAction =====
  console.log('\n情形 23: DATA card 走 onAction');
  {
    _wsMock.instances = [];
    let actionRecv = null;
    const app = new FeishuApp({
      appId: 'cli_t', appSecret: 's',
      onAction: async (act) => { actionRecv = act; }
    });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const cardEvt = { sender: { sender_id: { open_id: 'ou_card2' } }, message_id: 'm-card2', chat_id: 'c-card2', chat_type: 'p2p', message_type: 'interactive', content: JSON.stringify({ action: { value: { askId: 'a2', decision: 'cancel' } } }) };
    const frame = encodeFrame({
      SeqID: 1, LogID: 0, service: 1, method: 1,
      headers: [{ key: 'type', value: 'card' }, { key: 'message_id', value: 'm-card2' }],
      payload: Buffer.from(JSON.stringify(cardEvt), 'utf8')
    });
    ws._triggerMessage(frame);
    await waitMs(50);
    assert(actionRecv !== null, 'onAction 触发');
    assert(actionRecv.action?.askId === 'a2', 'card onAction.askId 正确');
    app.stop();
  }

  // ===== 情形 24 (新): Ping 周期触发 =====
  console.log('\n情形 24: Ping 周期触发');
  {
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    // 强制 PingInterval=0.1s (100ms) 便于测试
    await app.start();
    await waitMs(20);
    app._clientConfig.PingInterval = 0.1;
    app._startPingLoop();   // 用新 interval 重启
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const initial = ws._sentFrames.length;
    await waitMs(350);   // 等 ~3 个 ping
    const after = ws._sentFrames.length;
    assert(after - initial >= 2, `ping 周期触发 (initial=${initial} after=${after})`);
    // 验证最后一条是 PING frame
    const lastPing = decodeFrame(ws._sentFrames[ws._sentFrames.length - 1]);
    const pingType = lastPing.headers.find(h => h.key === 'type')?.value;
    assert(pingType === 'ping', `最后一条是 PING (实际=${pingType})`);
    app.stop();
  }

  // ===== 情形 25 (新): WS close → 调度重连 =====
  console.log('\n情形 25: WS close 触发重连');
  {
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.start();
    await waitMs(20);
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    const before = _wsMock.instances.length;
    ws._triggerClose();
    await waitMs(3500);   // 默认 3s 重连
    const after = _wsMock.instances.length;
    assert(after > before, `重连成功 (before=${before} after=${after})`);
    app.stop();
  }

  // ===== 情形 26 (新): 重连时重新走 endpoint discovery =====
  console.log('\n情形 26: 重连时重新走 endpoint discovery');
  {
    _axiosMock.posts = [];
    _wsMock.instances = [];
    const app = new FeishuApp({ appId: 'cli_t', appSecret: 's' });
    await app.start();
    await waitMs(20);
    let epCount1 = _axiosMock.posts.filter(p => p.url.includes('/callback/ws/endpoint')).length;
    const ws = _wsMock.lastInstance;
    ws._triggerOpen();
    await waitMs(20);
    ws._triggerClose();
    await waitMs(3500);
    let epCount2 = _axiosMock.posts.filter(p => p.url.includes('/callback/ws/endpoint')).length;
    assert(epCount2 > epCount1, `重连触发新 discovery (1=${epCount1} 2=${epCount2})`);
    app.stop();
  }

  console.log('\n' + '='.repeat(50));
  console.log(`V13 Feishu App: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();