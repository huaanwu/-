/**
 * Core.State - 全局状态管理
 * 简单的内存 KV,持久化走 Storage.kv
 */
(function() {
  'use strict';

  const _state = {
    currentPage: 'pageWatchlist',
    proxyBase: '/api/akshare',   // 运行时可改
    apiKeys: {
      tushare: ''                // 付费 Tushare token(可选)
    },
    ai: {
      provider: 'deepseek',      // deepseek / openai / moonshot / qwen / zhipu / custom
      apiKey: '',                // 运行时 UI 输入, 禁止硬编码
      model: '',                 // 留空用 provider 默认
      baseURL: '',               // 留空用 provider 默认 (custom 必须填)
      temperature: 0.7,
      maxTokens: 8000            // v4-flash/pro 推理模型需要更多 token
    },
    sync: {
      url: '',                   // Supabase Project URL (https://xxx.supabase.co)
      anonKey: '',               // Supabase anon public key
      autoSync: false,           // 自动同步 (改本地后自动推云)
      userEmail: '',             // 登录邮箱
      userId: '',                // 用户 UUID
      accessToken: ''            // JWT (短期, 用完会重登)
    },
    accountCash: 0,              // 现金余额 (用户在资金账户页编辑)
    marketOpen: false
  };

  const _listeners = new Map();

  function get(key) {
    if (!key) return _state;
    return _state[key];
  }

  function set(key, value) {
    const old = _state[key];
    _state[key] = value;
    // 触发监听
    const list = _listeners.get(key);
    if (list) {
      list.forEach(fn => {
        try { fn(value, old); }
        catch (e) { console.warn('[State] listener error:', e); }
      });
    }
    // 持久化重要 key
    if (['proxyBase', 'apiKeys', 'ai', 'accountCash', 'sync'].includes(key)) {
      Core.Storage.kvSet('state_' + key, value);
    }
  }

  function on(key, fn) {
    if (!_listeners.has(key)) _listeners.set(key, []);
    _listeners.get(key).push(fn);
  }

  function off(key, fn) {
    const list = _listeners.get(key);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * 启动时从 IndexedDB 还原
   */
  async function init() {
    const proxyBase = await Core.Storage.kvGet('state_proxyBase');
    if (proxyBase) _state.proxyBase = proxyBase;
    const apiKeys = await Core.Storage.kvGet('state_apiKeys');
    if (apiKeys) _state.apiKeys = apiKeys;
    const ai = await Core.Storage.kvGet('state_ai');
    if (ai) _state.ai = { ..._state.ai, ...ai };
    const accountCash = await Core.Storage.kvGet('state_accountCash');
    if (typeof accountCash === 'number') _state.accountCash = accountCash;
    const sync = await Core.Storage.kvGet('state_sync');
    if (sync) _state.sync = { ..._state.sync, ...sync };
  }

  window.Core = window.Core || {};
  window.Core.State = { get, set, on, off, init };
})();
