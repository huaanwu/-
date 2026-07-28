/**
 * Core.State - 全局状态管理
 * 简单的内存 KV,持久化走 Storage.kv
 */
(function() {
  'use strict';

  // 平台检测:
//   - 优先用官方 Capacitor.isNativePlatform() (检查 window.androidBridge / webkit.messageHandlers)
//     Capacitor 8 默认 UA 已不再含 'wv' 标记 (Chromium 110+ + Capacitor 注入器改写 UA),
//     UA 正则失效, 必须用桥接对象检测
//   - 浏览器 dev (vite) UA 也可能 'wv' (老 Edge/某些 ChromeOS), 所以 Capacitor 优先
// 参考: node_modules/@capacitor/core/dist/index.cjs.js:52
const _isNative = (typeof window !== 'undefined'
  && !!window.Capacitor
  && typeof window.Capacitor.isNativePlatform === 'function'
  && window.Capacitor.isNativePlatform());

  // V9: 标记 init() 完成后是否需要打"未配 LAN IP"的引导 toast
  //   供 app.js 在 Core.State.on('initComplete') 时读
  let _needProxyToast = false;

  const _state = {
    currentPage: 'pageWatchlist',
    // proxyBase 启动时按平台 + kv 值自动填:
    //   - 浏览器 dev (vite) 无 kv → '/api/akshare' (走 vite proxy)
    //   - APK 无 kv → '' (空, 等用户在设置页点「🔍 找 PC 上的 dev-proxy」)
    //   - 有合法绝对 URL 的 kv → 直接信任, 任何 LAN IP / 域名 / 端口
    proxyBase: _isNative ? '' : '/api/akshare',
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
        // V9: 默认空, 等用户输入; 浏览器 dev 显式 127.0.0.1 (同机)
        baseURL: _isNative ? '' : 'http://127.0.0.1:8082/v1',
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
   * V9: 不再强制覆盖 proxyBase/localEndpoint — 用户在设置页输入的值就是权威
   *   - 浏览器 dev: kv 缺值 → 用 vite proxy 默认 '/api/akshare'
   *   - APK: kv 缺值 → 不填默认 (空字符串), 等用户去设置页点「🔍 找 PC 上的 dev-proxy」
   *     打一次性 toast 提醒, 不偷偷改写用户配置
   */
  async function init() {
    const proxyBase = await Core.Storage.kvGet('state_proxyBase');
    if (proxyBase && /^https?:\/\//i.test(proxyBase)) {
      // 绝对 URL → 直接用 (任何 LAN IP / 域名 / 端口, 一律信任用户)
      _state.proxyBase = proxyBase;
    } else if (_isNative) {
      // APK + kv 无合法绝对 URL → 留空, 等用户填
      _state.proxyBase = '';
      _needProxyToast = true;  // 标记 init 完成后打一次引导 toast
    } else if (proxyBase) {
      // 浏览器 dev 保留相对路径
      _state.proxyBase = proxyBase;
    }
    const apiKeys = await Core.Storage.kvGet('state_apiKeys');
    if (apiKeys) _state.apiKeys = apiKeys;
    const ai = await Core.Storage.kvGet('state_ai');
    if (ai) _state.ai = { ..._state.ai, ...ai };
    // V9: 信任用户输入 — 任何合法绝对 URL 一律直接用, 不再过滤 127.0.0.1/localhost
    //   (用户可能故意用手机模拟器/同机端口转发)
    const accountCash = await Core.Storage.kvGet('state_accountCash');
    if (typeof accountCash === 'number') _state.accountCash = accountCash;
    const sync = await Core.Storage.kvGet('state_sync');
    if (sync) _state.sync = { ..._state.sync, ...sync };
    // Phase W-1.5: 还原 Core.UserProfile (否则重启浏览器/APK 后用户画像丢回默认)
    const userProfile = await Core.Storage.kvGet('state_userProfile');
    if (userProfile) _state.userProfile = userProfile;
    // V9: 触发 initComplete 事件, 让 app.js 知道是否需要打"未配 LAN IP"引导 toast
    //   _needProxyToast 在 init() 内已按需置 true
    _emit('initComplete', { needProxyToast: _needProxyToast });
  }

  /**
   * V9: 触发 init 之类的无 key 监听 (set() 的监听器都是按 key 注册, 不能复用)
   */
  const _eventListeners = new Map();
  function _emit(event, payload) {
    const list = _eventListeners.get(event);
    if (list) list.forEach(fn => { try { fn(payload); } catch (e) { console.warn('[State] event listener error:', e); } });
  }
  function onEvent(event, fn) {
    if (!_eventListeners.has(event)) _eventListeners.set(event, []);
    _eventListeners.get(event).push(fn);
  }

  window.Core = window.Core || {};
  window.Core.State = { get, set, on, off, init, onEvent };
})();
