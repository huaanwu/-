/**
 * V13 阶段 3 (修订) — 飞书应用模块 (主进程, Electron 端)
 *
 * 职责:
 *   - 凭证管理: tenant_access_token 缓存 2h, 过期前 10 分钟主动刷新
 *   - 收消息: 2 步鉴权 (HTTP discovery -> protobuf WS frames)
 *   - 发消息: HTTP POST im/v1/messages?receive_id_type=open_id (axios)
 *   - 命令路由: 收到的文本 -> 解析 (LLM) -> agentRegistry.invoke -> 飞书响应
 *   - 凭证落 Dexie kv (跟 settings-sync 同步)
 *
 * 协议参考: Hermes Python SDK lark_oapi/ws/client.py + pbbp2_pb2.py
 *   不引 @larksuiteoapi/node-sdk (29.7 MB, 重复依赖 ws+axios)
 *   只引 protobufjs (2.7 MB) 做 frame 编解码
 *
 * 公开 API 不变 (permission.js / main.js / 现有 40 测试都依赖):
 *   - constructor({appId, appSecret, onMessage, onAction, onError, onStatus})
 *   - start() -> Promise<boolean>
 *   - stop()
 *   - sendText(openId, text) -> Promise<{ok, messageId?, error?}>
 *   - sendCard(openId, card) -> Promise<{ok, messageId?, error?}>
 *   - isConnected() -> boolean
 */
'use strict';

const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');
const protobuf = require('protobufjs');

// 注意: WS endpoint discovery 不在 /open-apis 前缀下 (实测 https://open.feishu.cn/callback/ws/endpoint
// 返回 200+code=0, 而 https://open.feishu.cn/open-apis/callback/ws/endpoint 返回 404 plain text)
// 所以 discovery 和 REST API 用两个不同 base
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const FEISHU_WS_BASE = 'https://open.feishu.cn';
const FEISHU_ENDPOINT_URI = '/callback/ws/endpoint';

// frame.proto 路径 (跟 feishu-app.js 同目录下的 feishu-proto 子目录)
const PROTO_PATH = path.join(__dirname, 'feishu-proto', 'frame.proto');

// 一次性 loadSync 拿 Frame type,后续 encode/decode 都用它
const _FRAME_TYPE = (() => {
  const root = protobuf.loadSync(PROTO_PATH);
  return root.lookupType('pbbp2.Frame');
})();

// ==================== 凭证 + token 缓存 ====================

class FeishuApp {
  constructor(opts = {}) {
    this.appId = opts.appId || '';
    this.appSecret = opts.appSecret || '';
    this.onMessage = opts.onMessage || (async () => '');
    this.onAction = opts.onAction || (async () => {});
    this.onError = opts.onError || ((e) => console.warn('[Feishu]', e));
    this.onStatus = opts.onStatus || (() => {});

    this._tokenCache = null;        // { token, expiresAt }
    this._ws = null;
    this._wsAlive = false;
    this._wsReconnectDelay = 3000;
    this._stopped = false;

    // 新增 (V13 修订)
    this._connUrl = '';             // 动态 wss URL (1h 有效)
    this._clientConfig = null;      // {PingInterval, ReconnectCount, ...}
    this._pingTimer = null;         // 周期 PING 心跳
    this._seq = 0;                  // 客户端 outbound frame seq 计数
    this._serviceId = 1;            // 从 URL query 提取 service_id (默认 1)
    this._pendingFragments = new Map();   // msgId -> [buf, buf, ...] 合包重组
    this._fragmentTs = new Map();        // msgId -> Date 入队时间 (5s 过期清理)
    this._fragmentCleanupTimer = null;
  }

  // ---------------- token (HTTP JSON) ----------------

  async _getToken() {
    if (this._tokenCache && this._tokenCache.expiresAt > Date.now() + 10 * 60 * 1000) {
      return this._tokenCache.token;
    }
    try {
      const r = await axios.post(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
        app_id: this.appId,
        app_secret: this.appSecret
      }, { timeout: 10 * 1000 });
      if (r.data && r.data.code === 0 && r.data.tenant_access_token) {
        const ttl = (r.data.expire || 7200) * 1000;
        this._tokenCache = { token: r.data.tenant_access_token, expiresAt: Date.now() + ttl };
        return this._tokenCache.token;
      }
      throw new Error('tenant_access_token 失败: ' + JSON.stringify(r.data));
    } catch (e) {
      const msg = '[Feishu] token 获取失败: ' + (e.response?.data?.msg || e.message);
      this.onError(new Error(msg));
      throw new Error(msg);
    }
  }

  // ---------------- 发消息 (HTTP POST, API 不变) ----------------

  async sendText(receiveId, text) {
    if (!receiveId) return { ok: false, error: 'receiveId 为空' };
    try {
      const token = await this._getToken();
      const r = await axios.post(
        `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id`,
        {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: String(text || '') })
        },
        { headers: { Authorization: 'Bearer ' + token }, timeout: 15 * 1000 }
      );
      if (r.data && r.data.code === 0) {
        return { ok: true, messageId: r.data.data?.message_id };
      }
      return { ok: false, error: 'code=' + r.data?.code + ' ' + r.data?.msg };
    } catch (e) {
      return { ok: false, error: e.response?.data?.msg || e.message };
    }
  }

  async sendCard(receiveId, card) {
    try {
      const token = await this._getToken();
      const r = await axios.post(
        `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id`,
        {
          receive_id: receiveId,
          msg_type: 'interactive',
          card: card
        },
        { headers: { Authorization: 'Bearer ' + token }, timeout: 15 * 1000 }
      );
      if (r.data && r.data.code === 0) {
        return { ok: true, messageId: r.data.data?.message_id };
      }
      return { ok: false, error: 'code=' + r.data?.code + ' ' + r.data?.msg };
    } catch (e) {
      return { ok: false, error: e.response?.data?.msg || e.message };
    }
  }

  // ---------------- WS 2 步鉴权 (核心新逻辑) ----------------

  async start() {
    if (!this.appId || !this.appSecret) {
      this.onError(new Error('[Feishu] appId/appSecret 未配置'));
      return false;
    }
    this._stopped = false;
    try {
      // 第一步: HTTP endpoint discovery 拿动态 wss URL
      await this._getConnUrl();
      // 第二步: 异步连 WS (成功/失败都不阻塞 start 返回)
      this._connectWs().catch((e) => {
        this.onError(e);
        if (!this._stopped) this._scheduleReconnect();
      });
      return true;
    } catch (e) {
      this.onError(e);
      this._scheduleReconnect();
      return false;
    }
  }

  /**
   * HTTP POST /callback/ws/endpoint 拿动态 wss URL + ClientConfig
   * 协议: JSON body {AppID, AppSecret}, 返 {code, msg, data: {URL, ClientConfig}}
   */
  async _getConnUrl() {
    const r = await axios.post(FEISHU_WS_BASE + FEISHU_ENDPOINT_URI, {
      AppID: this.appId,
      AppSecret: this.appSecret
    }, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 10 * 1000
    });
    if (!r.data || r.data.code !== 0) {
      throw new Error('[Feishu] endpoint discovery 失败: ' + JSON.stringify(r.data));
    }
    const data = r.data.data || {};
    if (!data.URL) {
      throw new Error('[Feishu] endpoint discovery 返回无 URL: ' + JSON.stringify(r.data));
    }
    this._connUrl = data.URL;
    // 从 URL query 提取 service_id / device_id (跟 lark_oapi Python SDK client.py:196-199 一致)
    try {
      const u = new URL(data.URL);
      const svc = u.searchParams.get('service_id');
      if (svc) this._serviceId = parseInt(svc, 10) || 1;
    } catch (e) { /* URL 解析失败就用默认 1 */ }
    if (data.ClientConfig) this._clientConfig = data.ClientConfig;
    if (!this._clientConfig) {
      this._clientConfig = { PingInterval: 120, ReconnectCount: 0, ReconnectInterval: 60, ReconnectNonce: 30 };
    }
  }

  _connectWs() {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this._connUrl);
        this._ws = ws;

        ws.on('open', () => {
          this._wsAlive = true;
          this._wsReconnectDelay = 3000;
          this.onStatus({ connected: true, lastError: null });
          console.log('[Feishu] WS 已连, app_id=' + this.appId.slice(0, 8) + '...');
          // 不主动发 protobuf auth frame — 动态 wss URL 已在 WS 升级握手阶段完成鉴权。
          // lark_oapi client.py: 201 只做了 websockets.connect(conn_url), 其后直接
          // create_task(_receive_message_loop), never 发 auth frame。
          // HEADER_HANDSHAKE_STATUS / HEADER_HANDSHAKE_AUTH_ERRCODE 都在 HTTP 101 响应里。
          // 如果服务端返回 403/514，connect 阶段就会抛异常，不走 ws.on('open')。
          // 启动 ping 周期
          this._startPingLoop();
          // 启动合包过期清理
          this._startFragmentCleanup();
          resolve();
        });

        ws.on('message', (raw) => {
          console.log('[Feishu] msg len=' + (raw ? raw.length || raw.byteLength || 0 : 0));
          this._handleFrame(raw).catch((e) => this.onError(e));
        });

        ws.on('close', (code, reason) => {
          this._wsAlive = false;
          this._stopPingLoop();
          this.onStatus({ connected: false, lastError: 'ws closed: ' + (code || '') });
          if (!this._stopped) this._scheduleReconnect();
        });

        ws.on('error', (e) => {
          this._wsAlive = false;
          this.onError(new Error('[Feishu] WS error: ' + (e.message || e)));
          // 不 reject(), 因为 open 事件已 resolve promise (lark_oapi 也从不 reject)
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  _startPingLoop() {
    const intervalMs = (this._clientConfig?.PingInterval || 120) * 1000;
    this._stopPingLoop();
    this._pingTimer = setInterval(() => this._sendPing(), intervalMs);
  }

  _stopPingLoop() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _sendPing() {
    if (!this._ws || this._ws.readyState !== 1) return;
    try {
      const bytes = _FRAME_TYPE.encode(_FRAME_TYPE.create({
        SeqID: this._seq++,
        LogID: 0,
        service: this._serviceId,
        method: 0,
        headers: [{ key: 'type', value: 'ping' }]
      })).finish();
      this._ws.send(bytes);
    } catch (e) {
      this.onError(new Error('[Feishu] ping 失败: ' + e.message));
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = this._wsReconnectDelay;
    this._wsReconnectDelay = Math.min(this._wsReconnectDelay * 2, 60 * 1000);
    console.log('[Feishu] ' + (delay / 1000) + 's 后重连');
    setTimeout(() => {
      if (this._stopped) return;
      this.start().catch(() => {});
    }, delay);
  }

  // ---------------- Frame 处理 (decode + 路由 + 合包) ----------------

  async _handleFrame(raw) {
    let frame;
    try {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      frame = _FRAME_TYPE.decode(buf);
    } catch (e) {
      this.onError(new Error('[Feishu] frame decode 失败: ' + e.message));
      return;
    }
    const method = frame.method;
    if (method === 0) return this._handleControlFrame(frame);
    if (method === 1) return this._handleDataFrame(frame);
    // 未知 method 忽略
  }

  _handleControlFrame(frame) {
    const type = _getHeader(frame, 'type');
    if (type === 'ping') return;   // 服务端 ping, 忽略 (我们只 ping 服务端)
    if (type === 'pong') {
      // PONG 可能带 ClientConfig 更新 (payload 是 JSON)
      if (frame.payload && frame.payload.length > 0) {
        try {
          const confJson = Buffer.from(frame.payload).toString('utf8');
          this._clientConfig = JSON.parse(confJson);
          // PingInterval 变化时调整定时器
          this._startPingLoop();
        } catch (e) {
          // payload 不是 JSON, 忽略
        }
      }
      return;
    }
    // 其他 control 类型忽略 (lark_oapi client.py _handle_control_frame 只处理 PING/PONG)
  }

  async _handleDataFrame(frame) {
    const type = _getHeader(frame, 'type');
    const msgId = _getHeader(frame, 'message_id') || ('auto-' + Date.now() + '-' + this._seq);
    const sumStr = _getHeader(frame, 'sum') || '1';
    const seqStr = _getHeader(frame, 'seq') || '0';
    const sum = parseInt(sumStr, 10);
    const seq = parseInt(seqStr, 10);

    if (!frame.payload) return;
    const payload = this._maybeCombine(msgId, sum, seq, frame.payload);
    if (!payload) return;

    let evt;
    try {
      evt = JSON.parse(Buffer.from(payload).toString('utf8'));
    } catch (e) {
      this.onError(new Error('[Feishu] DATA payload JSON 解析失败: ' + e.message));
      return;
    }

    // V13: 飞书事件结构是嵌套的 { schema, header, event: { sender, message } },
    // event 字段内部才是实际消息体。lark_oapi 也有同样展开逻辑。
    const innerEvent = evt && evt.event ? evt.event : evt;

    if (type === 'event') return this._dispatchEvent(innerEvent);
    if (type === 'card') return this._dispatchCard(innerEvent);
  }

  _dispatchEvent(evt) {
    // V13: 飞书 im.message.receive_v1 事件结构:
    //   { sender: { sender_id: { open_id, union_id, user_id } },
    //     message: { message_id, chat_id, chat_type, message_type, content } }
    const sender = evt.sender?.sender_id?.open_id || evt.sender?.open_id;
    const msg = evt.message || evt;
    const msgId = msg.message_id;
    const chatId = msg.chat_id;
    const chatType = msg.chat_type;
    const msgType = msg.message_type;
    // 跳过非消息事件（如已读回执、系统通知等），它们没有 message_type
    if (!msgType) return;
    let text = '';
    let cardAction = null;
    if (msgType === 'text') {
      try {
        const c = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        text = c?.text || '';
      } catch { text = ''; }
    } else if (msgType === 'interactive') {
      try {
        const c = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        cardAction = c?.action?.value || null;
        text = c?.text || (cardAction ? '[action] ' + JSON.stringify(cardAction) : '');
      } catch { text = ''; }
    } else {
      text = '[不支持的消息类型: ' + msgType + ']';
    }

    // 卡片回调优先
    if (cardAction) {
      return this.onAction({ openId: sender, messageId: msgId, chatId, action: cardAction });
    }
    // 普通消息: 调 onMessage, 拿回 reply 后自动 p2p 回发
    const self = this;
    Promise.resolve()
      .then(() => self.onMessage({ openId: sender, text, messageId: msgId, chatId, chatType, msgType }))
      .then(async (reply) => {
        if (reply && chatType === 'p2p') {
          if (typeof reply === 'string') {
            await self.sendText(sender, reply);
          } else if (reply.text) {
            await self.sendText(sender, reply.text);
          } else if (reply.card) {
            await self.sendCard(sender, reply.card);
          }
        }
      })
      .catch((e) => self.onError(new Error('[Feishu] handler 失败: ' + (e.message || e))));
  }

  _dispatchCard(evt) {
    // 卡片回调通常走 message_type=interactive, 这里兜底
    const sender = evt.sender?.sender_id?.open_id || evt.sender?.open_id;
    const msgId = evt.message_id;
    const chatId = evt.chat_id;
    let actionVal = null;
    try {
      const c = typeof evt.content === 'string' ? JSON.parse(evt.content) : evt.content;
      actionVal = c?.action?.value || c;
    } catch { actionVal = null; }
    return this.onAction({ openId: sender, messageId: msgId, chatId, action: actionVal });
  }

  _maybeCombine(msgId, sum, seq, payload) {
    if (sum <= 1) return payload;
    if (!this._pendingFragments.has(msgId)) {
      // 必须 fill(null) — new Array(n) 创建 sparse array,Array.prototype.every 会跳过
      // empty slots 返 vacuously true,导致合包提前触发 Buffer.concat 拿到 undefined 报错。
      this._pendingFragments.set(msgId, new Array(sum).fill(null));
      this._fragmentTs.set(msgId, Date.now());
    }
    const arr = this._pendingFragments.get(msgId);
    if (seq < 0 || seq >= arr.length) {
      this.onError(new Error('[Feishu] 合包 seq 越界: msgId=' + msgId + ' seq=' + seq + ' sum=' + sum));
      return null;
    }
    arr[seq] = payload;
    if (arr.every((x) => Buffer.isBuffer(x))) {
      this._pendingFragments.delete(msgId);
      this._fragmentTs.delete(msgId);
      const combined = Buffer.concat(arr);
      if (process.env.FEISHU_DEBUG) console.log('[Feishu] combine complete: msgId=' + msgId + ' totalBytes=' + combined.length);
      return combined;
    }
    return null;
  }

  _startFragmentCleanup() {
    if (this._fragmentCleanupTimer) return;
    this._fragmentCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [msgId, ts] of this._fragmentTs) {
        if (now - ts > 5000) {
          this._pendingFragments.delete(msgId);
          this._fragmentTs.delete(msgId);
          this.onError(new Error('[Feishu] 合包重组超时清理: msgId=' + msgId));
        }
      }
    }, 5000);
  }

  _stopFragmentCleanup() {
    if (this._fragmentCleanupTimer) {
      clearInterval(this._fragmentCleanupTimer);
      this._fragmentCleanupTimer = null;
    }
  }

  // ---------------- 生命周期 ----------------

  stop() {
    this._stopped = true;
    this._stopPingLoop();
    this._stopFragmentCleanup();
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this._wsAlive = false;
    this._pendingFragments.clear();
    this._fragmentTs.clear();
    this.onStatus({ connected: false, lastError: 'stopped' });
  }

  isConnected() { return this._wsAlive; }
}

// ==================== helper ====================

function _getHeader(frame, key) {
  if (!frame.headers || frame.headers.length === 0) return '';
  for (const h of frame.headers) {
    if (h.key === key) return h.value;
  }
  return '';
}

module.exports = { FeishuApp, FEISHU_API_BASE, _FRAME_TYPE };