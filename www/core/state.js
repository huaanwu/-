/**
 * Core.State - 全局状态管理
 * 简单的内存 KV,持久化走 Storage.kv
 */
(function() {
  'use strict';

  // 平台检测: Capacitor webview 的 UA 含 'wv' (Android WebView) 或者 '; wv)' 标记
  // 浏览器 dev (Chrome/Edge) UA 没这个标记
  // 参考: https://developer.chrome.com/docs/multidevice/user-agent/#webview_user_agent
  const _isNative = (typeof navigator !== 'undefined' && /; wv\)|\bwv\b/.test(navigator.userAgent || ''));

  const _state = {
    currentPage: 'pageWatchlist',
    // proxyBase 启动时按平台自动填:
    //   - 浏览器 dev (vite) → '/api/akshare' (走 vite proxy)
    //   - APK / Capacitor   → 'http://192.168.1.3:8089/api/akshare' (PC 局域网 IP)
    // 用户改后从 IndexedDB 读, 这里的默认仅首次启动生效
    proxyBase: _isNative ? 'http://192.168.1.3:8089/api/akshare' : '/api/akshare',
    apiKeys: {
      tushare: ''                // 付费 Tushare token(可选)
    },
    ai: {
      provider: 'custom',         // 改默认 provider 为 custom (本地 qwen3 :8082)
      apiKey: '',                 // 运行时 UI 输入, 禁止硬编码
      model: '',                  // 留空用 localEndpoint.model
      baseURL: '',                // 留空 → AI service 自动用 localEndpoint
      useProxy: false,            // 本地不走 dev-proxy (raw 直连)
      temperature: 0.7,
      maxTokens: 8000,            // 推理模型需更多 token
      preferLocal: true,          // ✅ 默认优先本地 (无本地时降级远程)
      localEndpoint: {
        // APK 平台用 PC 局域网 IP, 浏览器 dev 用 127.0.0.1
        baseURL: _isNative ? 'http://192.168.1.3:8082/v1' : 'http://127.0.0.1:8082/v1',
        apiKey: '',                            // 运行时 UI 输入
        model: 'qwen36-35b-a3b'                // 本地模型实测名称
      }
    },
    sync: {
      url: '',                    // Supabase Project URL
      anonKey: '',                // Supabase anon public key
      autoSync: true,             // ✅ 默认开启自动同步 (需配 url+anonKey)
      userEmail: '',              // 登录邮箱
      userId: '',                 // 用户 UUID
      accessToken: ''             // JWT (短期)
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
    if (['proxyBase', 'apiKeys', 'ai', 'accountCash', 'sync', 'userProfile'].includes(key)) {
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
   * V8: APK 启动时如果 kv 残留的是浏览器相对路径 (/api/akshare), 强制改写为 LAN IP
   *      否则 APK 会用相对路径打到手机自己 localhost → 数据全断
   */
  async function init() {
    const proxyBase = await Core.Storage.kvGet('state_proxyBase');
    if (proxyBase && /^https?:\/\//i.test(proxyBase)) {
      // 绝对 URL → 直接用
      _state.proxyBase = proxyBase;
    } else if (_isNative) {
      // APK + kv 值无效 (undefined 或相对路径) → 强制硬编码 LAN IP
      console.log('[State] APK 启动, proxyBase 强制覆盖为 LAN IP (原值:', proxyBase || 'null', ')');
      _state.proxyBase = 'http://192.168.1.3:8089/api/akshare';
      Core.Storage.kvSet('state_proxyBase', _state.proxyBase).catch(() => {});
    } else if (proxyBase) {
      // 浏览器 dev 保留相对路径
      _state.proxyBase = proxyBase;
    }
    const apiKeys = await Core.Storage.kvGet('state_apiKeys');
    if (apiKeys) _state.apiKeys = apiKeys;
    const ai = await Core.Storage.kvGet('state_ai');
    if (ai) _state.ai = { ..._state.ai, ...ai };
    // V8: APK + ai.localEndpoint.baseURL 含 127.0.0.1 → 强制改写为 LAN IP
    if (_isNative && _state.ai && _state.ai.localEndpoint) {
      const le = _state.ai.localEndpoint;
      if (le.baseURL && /127\.0\.0\.1|localhost/.test(le.baseURL)) {
        console.log('[State] APK 启动, localEndpoint.baseURL 强制改写为 LAN IP');
        le.baseURL = 'http://192.168.1.3:8082/v1';
        Core.Storage.kvSet('state_ai', _state.ai).catch(() => {});
      }
    }
    const accountCash = await Core.Storage.kvGet('state_accountCash');
    if (typeof accountCash === 'number') _state.accountCash = accountCash;
    const sync = await Core.Storage.kvGet('state_sync');
    if (sync) _state.sync = { ..._state.sync, ...sync };
    // Phase W-1.5: 还原 Core.UserProfile (否则重启浏览器/APK 后用户画像丢回默认)
    const userProfile = await Core.Storage.kvGet('state_userProfile');
    if (userProfile) _state.userProfile = userProfile;
  }

  window.Core = window.Core || {};
  window.Core.State = { get, set, on, off, init };
})();
