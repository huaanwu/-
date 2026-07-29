/**
 * Core.SettingsSync - 设置项云同步 (WebDAV, v0.2.3)
 *
 * 用户痛点: 每次换设备 / 重装 / 清浏览器缓存, 都要重填所有设置 (provider/apiKey/
 *           第二意见 keys / aktools / 飞书 webhook / 管家 LLM 等).
 *
 * 设计:
 *   - 走标准 WebDAV (PUT/GET) — 任意 WebDAV 服务器 (坚果云 / Nextcloud / 自建 nginx)
 *   - 不加密: 用户选择 (用户自用工具, 单设备 + 私盘)
 *   - 自动触发: 监听 Core.Storage.kvSet/kvDelete, 改动 → debounce 1.5s 后 PUT
 *   - 启动时: 拉一次云端 → 用户选 "应用" 才覆盖本地 (避免覆盖刚改的本地值)
 *   - 单 JSON 文件 ~10 KB, 一次性 PUT/GET, 不分片
 *
 * 不在范围:
 *   - 不替代 Core.Sync (Supabase 业务数据同步)
 *   - 不加密 / 不分版本历史 / 不做冲突合并 (LWW, 服务器端 lastModified 优先)
 *   - 不同步业务表 (watchlist/holdings/...) — 那是 Core.Sync 的事
 *
 * 依赖: dev-proxy 必须启动并暴露 /api/webdav 转发 (避免浏览器 CORS)
 *       dev-proxy.mjs 在 0.2.3+ 已加该路由
 */
(function () {
  'use strict';

  const REMOTE_FILENAME = 'stockmaster-settings.json';
  const DEBOUNCE_MS = 1500;

  // 设置项白名单 (kvSet/kvDel 只对这些 key 触发同步)
  // 改 Core.State 白名单时记得同步更新这里, 不然新设置项不会云同步
  const SETTINGS_KEYS = new Set([
    'state_proxyBase',
    'state_apiKeys',
    'state_ai',
    'state_sync',
    'state_accountCash',
    'state_userProfile',
    'agent_auth_policy',
    'agent_once_allow',
    'agent_llm_config',
    'discipline_config',
    'feishu_webhook'
  ]);

  // ============ 配置 (用户填的 WebDAV) ============
  let _config = null;  // { url, username, password, autoSync }
  let _configLoaded = false;

  async function _loadConfig() {
    if (_configLoaded) return _config;
    try {
      const raw = await Core.Storage.kvGet('settings_sync_config');
      _config = raw || null;
    } catch (_) { _config = null; }
    _configLoaded = true;
    return _config;
  }

  async function setConfig(cfg) {
    _config = cfg && typeof cfg === 'object' && cfg.url ? cfg : null;
    _configLoaded = true;
    try {
      if (_config) await Core.Storage.kvSet('settings_sync_config', _config);
      else await Core.Storage.kvDel('settings_sync_config');
    } catch (_) {}
    return _config;
  }

  function getConfig() {
    return _config ? Object.assign({}, _config) : null;
  }

  function isEnabled() {
    return !!(_config && _config.url && _config.autoSync !== false);
  }

  // ============ 本地状态 ============
  // _lastRemoteMtime: 上次 pull 拿到的服务器 mtime (ISO), 启动冲突判断用
  // _pendingPush: 是否有挂起的 push (debounce 计时中)
  // _pushTimer: setTimeout handle
  // _localDirty: 本地有未推送的改动 (kv watcher 触发)
  let _lastRemoteMtime = null;
  let _localDirty = false;
  let _pushTimer = null;
  let _lastPushError = null;
  let _lastPushAt = null;

  // ============ 收集 + 应用设置项 ============
  /**
   * 收集当前本地所有设置项 kv 值
   * @returns {Object} { version, items: { key: value } }
   */
  async function collect() {
    const items = {};
    for (const k of SETTINGS_KEYS) {
      try {
        const v = await Core.Storage.kvGet(k);
        if (v !== undefined && v !== null) items[k] = v;
      } catch (_) { /* 单 key 失败不阻塞整批 */ }
    }
    return { version: 1, ts: new Date().toISOString(), items };
  }

  /**
   * 应用设置项到本地 (覆盖模式: 已存在的 key 覆盖, 不在白名单的 key 忽略)
   * @param {Object} payload collect() 的返回结构
   * @returns {Object} { applied: string[], skipped: string[] }
   */
  async function apply(payload) {
    if (!payload || !payload.items || typeof payload.items !== 'object') {
      return { applied: [], skipped: [], error: 'payload 格式不对' };
    }
    const applied = [];
    const skipped = [];
    for (const [k, v] of Object.entries(payload.items)) {
      if (!SETTINGS_KEYS.has(k)) { skipped.push(k); continue; }
      try {
        await Core.Storage.kvSet(k, v);
        applied.push(k);
      } catch (e) {
        console.warn('[SettingsSync] apply', k, '失败:', e.message);
      }
    }
    return { applied, skipped };
  }

  // ============ WebDAV HTTP ============
  /**
   * 转发到 dev-proxy /api/webdav, dev-proxy 拿到 target 后带 Authorization 转发到坚果云等
   * 路径: PUT /api/webdav?url=...&username=...&password=...  body = JSON
   *      GET /api/webdav?url=...&username=...&password=...  返回 body
   * 注: dev-proxy 用 query 传 url/credentials 而不是 header, 是因为浏览器 fetch 自定义
   *    header 在 CORS 预检时会多一次 OPTIONS, 简单请求 (GET/HEAD/POST) 性能更好
   */
  function _apiUrl(path) {
    return (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl(path) : path;
  }

  /**
   * v0.2.4 重试: 网络错误 / 5xx 重试 3 次指数退避 (500ms, 1000ms), HTTP 4xx 不重试 (凭据/路径错)
   * @param {Function} fn _httpPut 或 _httpGet
   * @param {string} opName 用于日志
   */
  async function _withRetry(fn, ...args) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try { return await fn(...args); }
      catch (e) {
        lastErr = e;
        const m = (e && e.message) || '';
        const isClientErr = /HTTP 4\d\d/.test(m);  // 4xx 不重试
        if (isClientErr || i === 2) break;
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));  // 500, 1000ms
      }
    }
    throw lastErr;
  }

  function _webdavPath(targetUrl) {
    // 拼 query: url 是 WebDAV 服务器上一个目录/文件 base, filename 由 dev-proxy 拼
    // 简化: 前端传完整 PUT URL (含 filename), dev-proxy 拿到后原样转发
    const u = new URL(_apiUrl('/api/webdav'));
    u.searchParams.set('url', targetUrl);
    if (_config.username) u.searchParams.set('username', _config.username);
    if (_config.password) u.searchParams.set('password', _config.password);
    return u.toString();
  }

  async function _httpPut(targetUrl, bodyObj) {
    const url = _webdavPath(targetUrl);
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      cache: 'no-store'
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`PUT HTTP ${resp.status}: ${t.slice(0, 200)}`);
    }
    return resp;
  }

  async function _httpGet(targetUrl) {
    const url = _webdavPath(targetUrl);
    const resp = await fetch(url, {
      method: 'GET',
      cache: 'no-store'
    });
    if (resp.status === 404) return { exists: false };
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`GET HTTP ${resp.status}: ${t.slice(0, 200)}`);
    }
    const text = await resp.text();
    // 某些 WebDAV 服务器 (坚果云) GET 返回 ETag/Last-Modified 在 header, 单独拿
    const lastMod = resp.headers.get('Last-Modified') || resp.headers.get('last-modified') || null;
    return { exists: true, body: text, mtime: lastMod };
  }

  // ============ Push / Pull ============
  /**
   * v0.2.4 同步保险:
   *   1) GET 云端当前版本 → 备份到 settings_snapshots (本地, 即使后面 push 失败也能恢复)
   *   2) PUT 新版本 (本地 collect 结果)
   *   3) PUT 失败 → 用刚才备份的 remote 重 PUT, 让云端回滚到 push 前的状态
   *   (本地不动, 因为本地本来就是用户改的那一份, push 失败 = 用户可能想保留本地)
   */
  async function push(opts = {}) {
    if (!_config || !_config.url) throw new Error('SettingsSync 未配置 (url 为空)');
    const targetUrl = _config.url.replace(/\/$/, '') + '/' + REMOTE_FILENAME;
    // 1) 读云端, 备份到本地 (带重试, 网络抖动自动恢复)
    let remote = null;
    try {
      const r = await _withRetry(_httpGet, targetUrl);
      if (r.exists) {
        try { remote = JSON.parse(r.body); } catch (_) { remote = null; }
      }
    } catch (_) { /* GET 失败不影响 push, 视为第一次推 */ }
    if (remote && remote.items) {
      try {
        await _saveBackup(remote, 'pre-push');
      } catch (e) {
        console.warn('[SettingsSync] 备份云端上一版失败:', e.message);
      }
    }
    // 2) PUT 新版本 (带重试 + confirm 钩子)
    const payload = await collect();
    // v0.2.4 confirm hook: 默认实现是 noop, app.js 可注册 confirmPush(() => bool)
    if (_confirmPushFn && !opts.skipConfirm) {
      const ok = await _confirmPushFn({
        targetUrl,
        items: Object.keys(payload.items).length,
        willOverwrite: !!remote
      });
      if (!ok) {
        throw new Error('用户取消推送');
      }
    }
    try {
      await _withRetry(_httpPut, targetUrl, payload);
      _localDirty = false;
      _lastPushAt = new Date().toISOString();
      _lastPushError = null;
      return { pushed: Object.keys(payload.items).length, at: _lastPushAt, backedUp: !!remote };
    } catch (e) {
      _lastPushError = e.message;
      // 3) 失败回滚 (恢复云端到 push 前)
      if (remote) {
        try {
          await _withRetry(_httpPut, targetUrl, remote);
          console.log('[SettingsSync] push 失败, 已回滚云端到上一版');
        } catch (e2) {
          _lastPushError = e.message + ' (回滚云端也失败: ' + e2.message + ')';
          console.warn('[SettingsSync] 回滚云端失败:', e2.message);
        }
      }
      throw e;
    }
  }

  /**
   * v0.2.4 注册 confirm 钩子 (push 前调一次, 返回 false 取消)
   * app.js 在 init 时注册: SettingsSync.setConfirmPushFn(async ({items, willOverwrite}) => {
   *   return confirm('将覆盖云端, 继续?');
   * });
   * 用户在 UI 上勾选 "不再确认" 时存 kv 'settings_sync_skip_confirm', app.js 根据它 bypass
   */
  let _confirmPushFn = null;
  function setConfirmPushFn(fn) { _confirmPushFn = (typeof fn === 'function') ? fn : null; }
  function getConfirmPushFn() { return _confirmPushFn; }

  /**
   * 把一份云端 JSON (含 version/ts/items) 落到本地 settings_snapshots
   * 保留最近 N 份 (走 kv 'settings_sync_backup_keep', 默认 5)
   */
  async function _saveBackup(payload, reason) {
    if (!Core.Storage || !Core.Storage.saveSettingsSnapshot) {
      console.warn('[SettingsSync] Storage 未挂载, 跳过备份');
      return null;
    }
    const id = 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const snap = {
      id,
      ts: new Date().toISOString(),
      reason: reason || 'manual',
      version: payload.version || 1,
      sourceTs: payload.ts || null,
      items: payload.items || {}
    };
    await Core.Storage.saveSettingsSnapshot(snap);
    return id;
  }

  /** 暴露给 UI: 手动备份当前本地 (不带云端内容) */
  async function backupLocal() {
    const localPayload = await collect();
    const id = await _saveBackup(localPayload, 'manual');
    return { id, items: Object.keys(localPayload.items).length };
  }

  async function listBackups() {
    if (!Core.Storage || !Core.Storage.listSettingsSnapshots) return [];
    return await Core.Storage.listSettingsSnapshots();
  }

  /**
   * 从某份备份还原到本地 (覆盖白名单 key, 不在白名单的 key 忽略)
   * 用户点 [↩️ 恢复] 才调, 默认 applyLocal=false 不直接覆盖
   */
  async function restoreBackup(id, opts = {}) {
    if (!Core.Storage || !Core.Storage.getSettingsSnapshot) throw new Error('Storage 未挂载');
    const snap = await Core.Storage.getSettingsSnapshot(id);
    if (!snap) throw new Error('备份不存在: ' + id);
    if (opts.applyLocal !== true) {
      // 默认只返回 payload 给 UI, 让用户再次确认
      return { backup: snap, applied: false };
    }
    // 先备份当前本地 (防 restore 把好版本覆盖了)
    const currentPayload = await collect();
    await _saveBackup(currentPayload, 'pre-restore');
    const a = await apply(snap);
    return { backup: snap, applied: true, appliedKeys: a.applied, skippedKeys: a.skipped };
  }

  async function deleteBackup(id) {
    if (!Core.Storage || !Core.Storage.deleteSettingsSnapshot) return;
    await Core.Storage.deleteSettingsSnapshot(id);
  }

  /**
   * 拉取远端设置
   * @param {boolean} applyLocal 是否直接覆盖本地 (默认 false — 返回给 UI 让用户确认)
   * @returns {Object} { payload, applied, skipped, exists, mtime }
   */
  async function pull(opts = {}) {
    if (!_config || !_config.url) throw new Error('SettingsSync 未配置 (url 为空)');
    const targetUrl = _config.url.replace(/\/$/, '') + '/' + REMOTE_FILENAME;
    const r = await _httpGet(targetUrl);
    if (!r.exists) return { exists: false, payload: null };
    let payload;
    try { payload = JSON.parse(r.body); }
    catch (e) { throw new Error('云端 JSON 解析失败: ' + e.message); }
    _lastRemoteMtime = r.mtime || payload.ts || null;
    if (opts.applyLocal) {
      const a = await apply(payload);
      return { exists: true, payload, applied: a.applied, skipped: a.skipped, mtime: _lastRemoteMtime };
    }
    return { exists: true, payload, mtime: _lastRemoteMtime };
  }

  async function testConnection() {
    if (!_config || !_config.url) throw new Error('未配置 URL');
    const targetUrl = _config.url.replace(/\/$/, '') + '/' + REMOTE_FILENAME;
    // 用 GET 试, 不存在算 OK (PUT 测试需要写权限, GET 仅需读权限; 写权限错误由真实 push 暴露)
    const r = await _httpGet(targetUrl);
    return { ok: true, exists: r.exists, mtime: r.mtime };
  }

  // ============ 自动同步 (debounce) ============
  function _onKvChange(key, value) {
    if (!isEnabled()) return;       // 用户没开 autoSync
    if (!SETTINGS_KEYS.has(key)) return;  // 业务 key 跳过
    _localDirty = true;
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(async () => {
      _pushTimer = null;
      if (!_localDirty) return;
      try {
        // v0.2.4 autoSync 自动跳 confirm (避免打扰)
        const r = await push({ skipConfirm: true });
        console.log('[SettingsSync] auto push:', r);
        // 成功 → 清掉角标
        if (typeof window._renderSyncErrorBadge === 'function') window._renderSyncErrorBadge(false);
      } catch (e) {
        _lastPushError = e.message;
        console.warn('[SettingsSync] auto push 失败:', e.message);
        // v0.2.4 失败 → 触发全局角标
        if (typeof window._renderSyncErrorBadge === 'function') window._renderSyncErrorBadge(true);
      }
    }, DEBOUNCE_MS);
  }

  /**
   * 启动监听 + 启动时拉一次 (但 applyLocal=false, 让用户在 UI 点"应用"才覆盖)
   * 由 app.js init() 末尾调用
   */
  async function init() {
    await _loadConfig();
    // 订阅 kv 改动
    if (Core.Storage && Core.Storage.onKvChange) {
      Core.Storage.onKvChange(_onKvChange);
    }
    console.log('[SettingsSync] 已挂载, enabled=' + isEnabled() + ', 白名单 key 数=' + SETTINGS_KEYS.size);
  }

  // ============ 状态查询 (UI 用) ============
  function getStatus() {
    return {
      enabled: isEnabled(),
      configured: !!(_config && _config.url),
      url: _config ? _config.url : '',
      username: _config ? _config.username : '',
      autoSync: _config ? _config.autoSync !== false : false,
      localDirty: _localDirty,
      lastPushAt: _lastPushAt,
      lastPushError: _lastPushError,
      lastRemoteMtime: _lastRemoteMtime,
      keysTracked: Array.from(SETTINGS_KEYS)
    };
  }

  // ============ 暴露 ============
  window.Core = window.Core || {};
  window.Core.SettingsSync = {
    init,
    collect,
    apply,
    push,
    pull,
    testConnection,
    setConfig,
    getConfig,
    isEnabled,
    getStatus,
    backupLocal,
    listBackups,
    restoreBackup,
    deleteBackup,
    setConfirmPushFn,
    getConfirmPushFn,
    // 测试钩子
    _SETTINGS_KEYS: SETTINGS_KEYS,
    _REMOTE_FILENAME: REMOTE_FILENAME
  };
})();