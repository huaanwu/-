/**
 * StockMaster - 主入口
 * 挂全局兼容层 + 初始化
 */

var APP_VERSION = 'v0.1.0';
var APP_BUILD_DATE = '2026-07-28';
var APP_GIT_COMMIT = '';
// build-web.mjs 写入 www/version.json, 启动时读它覆盖 (保证 package.json 是单一来源)
(function _syncVersionFromBuild() {
  try {
    // fetch 在 web worker / file:// 不可用时静默失败
    if (typeof fetch !== 'function') return;
    fetch('/version.json?_=' + Date.now(), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(v => {
        if (!v) return;
        if (v.version) APP_VERSION = 'v' + v.version;
        if (v.buildDate) APP_BUILD_DATE = v.buildDate;
        if (v.gitCommit) APP_GIT_COMMIT = v.gitCommit;
        // 重渲染设置页底部"关于"
        const aboutEl = document.getElementById('appAboutLine');
        if (aboutEl) aboutEl.innerHTML = `StockMaster ${APP_VERSION} · ${APP_BUILD_DATE}${APP_GIT_COMMIT ? ' · ' + APP_GIT_COMMIT : ''}`;
      })
      .catch(e => console.warn('[App] version.json 读取失败, 用本地默认值:', e.message));
  } catch (e) { console.warn('[App] 版本同步初始化失败:', e); }
})();

// ========== 全局兼容层: HTML onclick 调用 ==========
var switchPage = Core.Router.switchPage;
var goSettings = Core.Router.goSettings;
var showToast = Core.Toast.showToast;
var toastSuccess = Core.Toast.success;
var toastError = Core.Toast.error;
var toastInfo = Core.Toast.info;
var toastWarning = Core.Toast.warning;
var escapeHtml = Core.Util.escapeHtml;
var safeHTML = Core.Util.safeHTML;
var fmtNum = Core.Util.fmtNum;
var fmtPct = Core.Util.fmtPct;
var fmtMoney = Core.Util.fmtMoney;
var pctClass = Core.Util.pctClass;
var fmtDate = Core.Util.fmtDate;
var fmtDateTime = Core.Util.fmtDateTime;
var uuid = Core.Util.uuid;
var parseStockInput = Core.Util.parseStockInput;

// ========== 版本升级清理 ==========
(async function() {
  const savedVer = localStorage.getItem('app_version');
  if (savedVer !== APP_VERSION) {
    console.log('[App] 版本升级:', savedVer, '→', APP_VERSION);
    // 升级时清缓存(数据格式可能变)
    if (savedVer) {
      await Core.Storage.cacheClear();
    }
    localStorage.setItem('app_version', APP_VERSION);
  }
})();

// ========== 市场状态判断 ==========
function checkMarketStatus() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const day = now.getDay();
  // 周一到周五
  if (day >= 1 && day <= 5) {
    // 上午 9:30-11:30, 下午 13:00-15:00
    const t = h * 60 + m;
    if ((t >= 9 * 60 + 30 && t <= 11 * 60 + 30) ||
        (t >= 13 * 60 && t <= 15 * 60)) {
      return true;
    }
  }
  return false;
}

function updateMarketStatus() {
  const el = document.getElementById('marketStatus');
  if (!el) return;
  const open = checkMarketStatus();
  el.textContent = open ? '● 开盘' : '● 休市';
  el.className = 'market-status ' + (open ? 'open' : 'closed');
  Core.State.set('marketOpen', open);
}

// ========== 大盘状态机 UI (H3: 多指数徽章 + 失灵红条) ==========
// 顶部 Header 注入一个 <span class="regime-badge"> 在 marketStatus 左侧;
// 失灵时在 <header> 下方注入一个 sticky 红条提醒"指数数据源异常"。
// 5 caller prompt 段 (short-trader / intraday / screener / fund-ai-advisor / journal) 直接调
// Core.Regime.gateMultipliers() 拿数据, 不依赖这里。

function _ensureRegimeBadge() {
  let badge = document.getElementById('regimeBadge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'regimeBadge';
    badge.className = 'regime-badge';
    badge.title = '大盘状态机 (HS300 + CSI1000 + CSI2000 共识)';
    const ms = document.getElementById('marketStatus');
    if (ms && ms.parentNode) ms.parentNode.insertBefore(badge, ms);
    else document.querySelector('.header-right')?.appendChild(badge);
  }
  return badge;
}

function _renderRegimeBadge() {
  if (!window.Core || !Core.Regime || !Core.Regime.gateMultipliers) return;
  const badge = _ensureRegimeBadge();
  const g = Core.Regime.gateMultipliers();
  const staleTag = g.stale ? ' ⚠失灵' : '';
  badge.className = 'regime-badge ' + g.badgeClass + (g.stale ? ' stale' : '');
  badge.textContent = `${g.icon} ${g.label}${staleTag}`;
  if (g.stale) showRegimeAlertBanner(g);
  else hideRegimeAlertBanner();
}

function showRegimeAlertBanner(g) {
  let banner = document.getElementById('regimeAlertBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'regimeAlertBanner';
    banner.className = 'regime-alert';
    const header = document.querySelector('.app-header');
    if (header && header.parentNode) header.parentNode.insertBefore(banner, header.nextSibling);
    else document.body.prepend(banner);
  }
  const failCount = (g && typeof g.staleFailures === 'number') ? g.staleFailures : '';
  const codes = (g && g.indices) ? Object.keys(g.indices) : [];
  const failedList = codes.filter(c => g.indices[c] && g.indices[c].state == null).join(', ') || '未知指数';
  const retryBtn = (failCount !== '' && failCount >= Core.Constants.STALE_FAIL_THRESHOLD)
    ? '<button class="btn btn-sm" id="retryRegimeBtn">🔄 重试</button>' : '';
  banner.innerHTML = `
    <span class="regime-alert-icon">⚠</span>
    <span class="regime-alert-text">大盘状态机失灵 (连续失败 ${failCount} 次, 受影响指数: ${Core.Util.escapeHtml(failedList)}) — 已强制按"震荡市"保守处理, AI 建议自动降仓位 ×${Core.Regime.GATES.range.positionScale}, 建议门槛 0.5。${retryBtn}</span>
    <span class="regime-alert-close" onclick="this.parentElement.remove()">×</span>
  `;
  // Bug 2 修复: 用 addEventListener 替代 onclick 内联, 避免未来引入 XSS 风险
  const retryEl = banner.querySelector('#retryRegimeBtn');
  if (retryEl) {
    retryEl.addEventListener('click', () => {
      Core.Regime.refresh().then(_renderRegimeBadge).catch(e => console.warn('[App] 手动 regime 重试失败:', e));
    });
  }
}

function hideRegimeAlertBanner() {
  const banner = document.getElementById('regimeAlertBanner');
  if (banner) banner.remove();
}

// ========== 启动 ==========
(async function init() {
  try {
    // 1. 初始化 DB
    await Core.Storage.init();
    console.log('[App] DB ready');

    // 2. 还原 state
    await Core.State.init();

    // V9: 监听 initComplete, 若 APK 启动时无合法 proxyBase URL, 引导用户去设置页
    //   (不偷偷改写, 尊重"配置页输入即生效"契约)
    if (Core.State.onEvent) {
      Core.State.onEvent('initComplete', (payload) => {
        if (payload && payload.needProxyToast && Core.Toast) {
          Core.Toast.show('📡 APK 启动: 还没配 AKShare 代理地址 — 打开设置页点「🔍 找 PC 上的 dev-proxy」', 6000);
        }
      });
      // 本轮 init 已完成, 同步触发一次 (上面 onEvent 是为下次启动)
      const _isNativeNow = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      const _pbNow = Core.State.get('proxyBase');
      if (_isNativeNow && (!_pbNow || _pbNow === '')) {
        // V11: APK 首次启动 proxyBase 空 → 后台自动跑 LAN 扫描, 命中自动写回
        setTimeout(() => { _autoDiscoverDevProxy(); }, 1500);
      } else if (_isNativeNow && _pbNow && /^https?:\/\//.test(_pbNow)) {
        // 已有合法 URL → 不动, 但如果不通打提示
        setTimeout(async () => {
          try {
            const r = await fetch(_pbNow.replace(/\/api\/.*$/, '') + '/health', { cache: 'no-store' });
            if (!r.ok && Core.Toast) Core.Toast.show('⚠️ 配置的 dev-proxy 不通 (' + r.status + '), 设置页检查', 5000);
          } catch (e) { /* 网络异常静默 */ }
        }, 2000);
      }
    }

    // 3. 市场状态
    updateMarketStatus();
    setInterval(updateMarketStatus, 60 * 1000);

    // 4. 健康检查(异步,不阻塞 UI)
    Core.Data.health().then(h => {
      if (!h || h.status !== 'ok') {
        console.warn('[App] AKShare 代理不通:', h && h.error);
        // 不弹 toast,启动时太吵
      } else {
        console.log('[App] AKShare proxy ok');
      }
    })
    // 4c. Electron 自动更新通知 (B5 修复: 完整链路接通)
    if (window.electronAPI && window.electronAPI.onUpdateAvailable) {
      // 用户确认下载: 显示 banner 含"立即下载"按钮
      window.electronAPI.onUpdateAvailable(function(info) {
        if (document.getElementById('updateAvailableBanner')) return;
        var el = document.createElement('div');
        el.id = 'updateAvailableBanner';
        el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;background:#0969da;color:#fff;padding:16px 20px;border-radius:8px;max-width:360px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        el.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">发现新版本 v' + (info && info.version ? info.version : '') + '</div><div style="margin-bottom:8px;font-size:12px;opacity:0.9;">是否立即下载?</div>';
        var btn = document.createElement('button');
        btn.textContent = '立即下载';
        btn.style.cssText = 'background:#fff;color:#0969da;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-weight:600;margin-right:6px;';
        btn.onclick = function() {
          if (window.electronAPI.startDownloadUpdate) window.electronAPI.startDownloadUpdate();
          el.remove();
        };
        var dismiss = document.createElement('button');
        dismiss.textContent = '稍后';
        dismiss.style.cssText = 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.4);padding:6px 12px;border-radius:4px;cursor:pointer;';
        dismiss.onclick = function() { el.remove(); };
        el.appendChild(btn);
        el.appendChild(dismiss);
        document.body.appendChild(el);
      });
      // 下载完成: 显示 banner 含"立即重启安装"按钮
      window.electronAPI.onUpdateDownloaded(function(info) {
        if (document.getElementById('updateDownloadedBanner')) return;
        var el = document.createElement('div');
        el.id = 'updateDownloadedBanner';
        el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;background:#1a7f37;color:#fff;padding:16px 20px;border-radius:8px;max-width:360px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        var btn = document.createElement('button');
        btn.textContent = '立即重启安装 (v' + (info && info.version ? info.version : '') + ')';
        btn.style.cssText = 'background:#fff;color:#1a7f37;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:600;margin-top:8px;';
        btn.onclick = function() {
          if (window.electronAPI.installUpdate) window.electronAPI.installUpdate();
          el.remove();
        };
        var dismiss = document.createElement('button');
        dismiss.textContent = '稍后';
        dismiss.style.cssText = 'background:transparent;color:#aaa;border:1px solid #555;padding:8px 14px;border-radius:4px;cursor:pointer;margin-top:8px;margin-left:6px;';
        dismiss.onclick = function() { el.remove(); };
        el.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">已下载完成</div><div style="margin-bottom:4px;">点击重启自动安装</div>';
        el.appendChild(btn);
        el.appendChild(dismiss);
        document.body.appendChild(el);
      });
      // 升级出错: 红色 toast 提示
      window.electronAPI.onUpdateError(function(err) {
        var msg = (err && err.message) ? err.message : '未知错误';
        if (window.Core && Core.Toast && Core.Toast.show) {
          Core.Toast.show('更新失败: ' + msg, 'error');
        } else {
          console.warn('[App] 自动更新失败:', msg);
        }
      });
    }
    // 4c.b Capacitor (Android APK) 自动更新通知 (旧版保留)
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      window.Capacitor.Plugins.App.addListener('update-downloaded', function(info) {
        if (document.getElementById('updateBanner')) return;
        var el = document.createElement('div');
        el.id = 'updateBanner';
        el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;background:#1a7f37;color:#fff;padding:16px 20px;border-radius:8px;max-width:360px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        var btn = document.createElement('button');
        btn.textContent = '立即重启安装 (v' + (info && info.version ? info.version : '') + ')';
        btn.style.cssText = 'background:#fff;color:#1a7f37;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:600;margin-top:8px;';
        btn.onclick = function() {
          if (window.electronAPI && window.electronAPI.installUpdate) {
            window.electronAPI.installUpdate();
          }
          el.remove();
        };
        var dismiss = document.createElement('button');
        dismiss.textContent = '稍后';
        dismiss.style.cssText = 'background:transparent;color:#aaa;border:1px solid #555;padding:8px 14px;border-radius:4px;cursor:pointer;margin-top:8px;margin-left:6px;';
        dismiss.onclick = function() { el.remove(); };
        el.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">发现新版本</div><div style="margin-bottom:4px;">已下载完成,点击重启自动安装</div>';
        el.appendChild(btn);
        el.appendChild(dismiss);
        document.body.appendChild(el);
      });
    }
;

    // 4b. 大盘状态机每日重算 (Z1 Phase A, 接管 Kimi 活; H3 多指数 + 失灵熔断)
    // 异步, 失败不阻塞 UI; 每日 1 次 by kv lastDate 去重
    if (window.Core && Core.Regime && Core.Regime.refresh) {
      Core.Regime.refresh().then(rec => {
        console.log('[App] 大盘状态:', rec.state, rec.snapshot ? `HS300 ${rec.snapshot.close} vs MA60 ${rec.snapshot.ma60}` : '(无 snapshot)');
        // H3: 刷新顶部徽章 + 失灵红条
        _renderRegimeBadge();
      }).catch(e => console.warn('[App] Regime refresh 失败:', e && e.message || e));
      // H3: 订阅 state 切换 → 弹红条
      if (Core.Regime.subscribe) {
        Core.Regime.subscribe(({ oldState, newState, rec }) => {
          console.log(`[App] Regime ${oldState} → ${newState}`);
          _renderRegimeBadge();
        });
      }
      // H3: 启动后仅确保徽章 DOM 存在 + 设初始类名, 真正渲染由 refresh().then() 和 subscribe 负责
      // Bug 4 修复: 去掉立即 _renderRegimeBadge(), refresh() 异步结束后自然会调
      // 如果 _mem 已有当日值 (refresh 早返回), setInterval 5min 后也会补渲染
      // 不在此调 — 避免跟 L176 refresh 完成后的渲染竞态
      if (window.Core && Core.Regime && Core.Regime.gateMultipliers) {
        // 仅确保 DOM 存在, 内容留给 refresh().then() 或 subscribe 填充
        _ensureRegimeBadge();
      }
      // H3: 5 分钟轮询一次, 兜底处理"setInterval 失灵"导致 stale 累计
      setInterval(() => {
        Core.Regime.refresh().then(_renderRegimeBadge).catch(e => console.warn('[App] Regime 周期 refresh 失败:', e && e.message || e));
      }, 5 * 60 * 1000);
    }

    // 5. 初始化各域
    if (window.Watchlist && Watchlist.init) Watchlist.init();
    if (window.Holdings && Holdings.init) Holdings.init();
    if (window.Paper && Paper.init) Paper.init();
    // Phase C: 模拟盘日终小结 (异步, 不阻塞启动, 参照上面 Data.health 的写法)
    if (window.Paper && Paper.maybeGenerateEodReport) {
      Paper.maybeGenerateEodReport().catch(e => console.warn('[App] EOD 小结生成失败:', e));
    }
    // Phase T3: 短线条件单每日结算 (异步, 不阻塞启动; 当日已结算自动跳过)
    if (window.Paper && Paper.settleCondOrders) {
      Paper.settleCondOrders().catch(e => console.warn('[App] 条件单结算失败:', e));
    }
    // P1: Pre-mortem 事后验证 (异步, 扫描 journal 表有 falsifyCondition 且未验证的行)
    if (window.Core && Core.Premortem && Core.Premortem.verifyPendingJournals) {
      (async () => {
        try {
          const rows = (await Core.Storage.all('journals')) || [];
          const getKline = async (code) => Core.Data.getStockKLine(code, 'daily', undefined, undefined, '');
          const r = await Core.Premortem.verifyPendingJournals(rows, getKline, new Date());
          if (r.verified > 0) console.log(`[App] P1 pre-mortem verify: 扫描${r.scanned} 验证${r.verified} 跳过${r.skipped}`);
        } catch (e) { console.warn('[App] P1 pre-mortem verify 失败:', e); }
      })();
    }
    // Phase T2 (ShortTrader): 盘前 AI 短线交易计划 (异步, 不阻塞启动; 交易日 + 无今日记录才生成)
    if (window.ShortTrader && ShortTrader.init) ShortTrader.init();
    if (window.ShortTrader && ShortTrader.maybeGeneratePlan) {
      ShortTrader.maybeGeneratePlan().catch(e => console.warn('[App] 短线今日计划生成失败:', e));
    }
    // Phase T4 (ShortTrader 学习环): 平仓机械 verify + 周末教训提炼 (异步, 不阻塞启动)
    if (window.ShortTrader && ShortTrader.verifyClosedTrades) {
      ShortTrader.verifyClosedTrades().catch(e => console.warn('[App] 短线平仓 verify 失败:', e));
    }
    if (window.ShortTrader && ShortTrader.maybeDistillLessons) {
      ShortTrader.maybeDistillLessons().catch(e => console.warn('[App] 短线教训提炼失败:', e));
    }
    // IntradayTrader: 盘中盯盘层 — v0.2.6 关闭
    // 1 分钟轮询 + LLM 实时决策 = 过度设计, T2 盘前条件单 + T3 日线结算 + T4 学习环已覆盖短线场景
    // 完整删除 www/app/intraday-trader.js (B2 收口)
    // 如需复用, 见 git history commit 365fe9d 之前的版本
    // B4 修复: 启动期预热大盘宽度/风格 (30s 内完成, 让长线/选股页面打开时不再 cold start)
    if (window.Core && Core.Market && typeof Core.Market.warmup === 'function') {
      Core.Market.warmup().catch(e => console.warn('[App] Market.warmup 失败:', e));
    }
    // 初选硬筛后台预热: app 启动后异步拉 2000 只基本面 (7d 缓存), 用户主动跑评分时秒开
    // 失败不阻塞, 跑失败时用户主动跑评分会自然降级 (Scoring 失败时 long-trader 有兜底排序)
    if (window.Core && Core.Scoring && typeof Core.Scoring.warmupFinMap === 'function') {
      Core.Scoring.warmupFinMap().catch(e => console.warn('[App] Scoring.warmupFinMap 失败:', e));
    }
    // LongTrader: 长线 sleeve 自动选股 — 30 分钟检查, 周一距上次 ≥7 天自动跑 AI 选股 → 成交到 long sleeve
    if (window.LongTrader && LongTrader.init) {
      LongTrader.init();
    }
    // Tier 6: LLM 周度动态权重调度 (周日 20:00 自动更新 Scoring 权重)
    if (window.Core && Core.WeightAdvisor && Core.WeightAdvisor.scheduleWeekly) {
      Core.WeightAdvisor.scheduleWeekly();
      // 启动时跑一次, 失败不阻塞
      Core.WeightAdvisor.adviseNow().catch(e => console.warn('[App] WeightAdvisor 启动失败:', e));
    }
    if (window.Journal && Journal.init) Journal.init();
    if (window.Screener && Screener.init) Screener.init();
    if (window.Fund && Fund.init) Fund.init();
    if (window.Backtest && Backtest.init) Backtest.init();
    if (window.Alerts && Alerts.init) Alerts.init();

    // AI 管家 - 启动顺序: Core.Agent 先 await (拉工具表 + 加载授权偏好) → AgentUI 后 (渲染侧边栏, 注册 confirmUI)
    // 必须 await, 否则用户在 AgentUI.init 之后立刻发消息时 _toolsIndex 还没就绪
    if (window.Core && Core.Agent && Core.Agent.init) {
      await Core.Agent.init().catch(e => console.warn('[App] Agent.init 失败:', e));
    }
    if (window.Core && Core.AgentUI && Core.AgentUI.init) {
      Core.AgentUI.init();
    }
    // Phase W-P1: 中长线盯盘改事件驱动 — 启动时先跑一轮 (异步不阻塞, 参照上面 Data.health 的写法;
    // 规则自带 nextCheck 门控, 频繁触发无副作用)
    if (window.Alerts && Alerts.runLongChecks) {
      Alerts.runLongChecks().catch(e => console.warn('[App] 中长线首检失败:', e));
    }

    // 6. 默认页
    switchPage('pageWatchlist');

    // 7. 渲染设置页表单
    if (window._renderSettings) _renderSettings();

    // 8. 注册 Service Worker (PWA 离线基础)
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('[SW] 已注册, scope=' + reg.scope);
      }).catch((e) => {
        console.warn('[SW] 注册失败:', e.message);
      });
    }

    console.log(`[App] StockMaster ${APP_VERSION} 启动完成`);
  } catch (e) {
    console.error('[App] 启动失败:', e);
    toastError('应用启动失败: ' + e.message);
  }
})();

/**
 * V11: APK 首次启动自动跑 LAN 扫描, 找 dev-proxy (端口 8089)
 *   直接打 LAN IP, 不走 _apiUrl (proxyBase 还没配置, 走不通)
 *   命中 → 自动写回 state, 弹 toast 提示
 *   失败 → toast 引导去设置页手动填
 *
 * 候选 IP 来自常见家用子网 (.1-.10 含网关 + 常用设备) — 假设 PC 大概率在网关附近
 *   如果用户 PC IP 在 .20+.50+.100 等不常见位置, 此函数扫不到, 需要手动填
 */
async function _autoDiscoverDevProxy() {
  const port = 8089;
  // V15.3: Race 模式 — 只要一个命中立即返回, 不等所有 IP 超时
  // 常见家用子网 + 部分商用 (OpenWrt / 软路由常见)
  const subnets = ['192.168.1', '192.168.0', '192.168.31', '10.0.0', '172.20', '172.24'];
  const candidates = [];
  for (const sn of subnets) {
    for (let i = 1; i <= 10; i++) candidates.push(`${sn}.${i}`);
  }
  // 用 Promise.race: 第一个命中的 IP 立即胜出
  // 兜底: 最多 concurrent 10 (Android WebView 连接池有限)
  const result = await new Promise((resolve) => {
    let done = false;
    let pending = 0;
    function check(ip) {
      pending++;
      const c = new AbortController();
      const timer = setTimeout(() => c.abort(), 3000);
      fetch(`http://${ip}:${port}/ping`, { cache: 'no-store', signal: c.signal })
        .then(r => { clearTimeout(timer); return r.ok ? r.json() : null; })
        .then(j => { if (!done && j && j.status === 'ok' && j.ping) { done = true; resolve({ ip, j }); } })
        .catch(() => { clearTimeout(timer); })
        .finally(() => { pending--; if (!done && pending === 0) resolve(null); });
    }
    // 分批: 一次并发 10, 每批 3s
    const BATCH = 10;
    (function nextBatch(idx) {
      if (done) return;
      const batch = candidates.slice(idx, idx + BATCH);
      if (batch.length === 0) { setTimeout(() => { if (!done) resolve(null); }, 3000); return; }
      batch.forEach(check);
      setTimeout(() => nextBatch(idx + BATCH), 200);
    })(0);
  });
  if (!result) {
    if (window.Core && Core.Toast) Core.Toast.show('📡 APK 自动发现失败 — 打开设置页手动填代理地址', 6000);
    return;
  }
  const picked = result;
  const proxyUrl = `http://${picked.ip}:${port}/api/akshare`;
  window.Core.State.set('proxyBase', proxyUrl);
  if (window.Core && Core.Toast) Core.Toast.show(`📡 自动发现 dev-proxy @ ${picked.ip}:${port}`, 5000);
  console.log('[App] V15.3 auto-discover 命中:', proxyUrl);
  // V15.3: 通过 dev-proxy 服务端扫本地大模型（不走手机直连，无 CORS 问题）
  _discoverLLMviaProxy();
  // V15.3: 自动发现成功后刷新当前页面数据
  const curPage = window.Core.State.get('currentPage');
  if (curPage && window.Core && Core.Router) {
    Core.Router.switchPage(curPage);
  }
}

/** V15.3: 通过 dev-proxy 的服务端扫描找本地大模型（不走手机直连，无 CORS 问题） */
async function _discoverLLMviaProxy() {
  try {
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (p) => p;
    const resp = await fetch(_apiUrl('/api/discover/local-llm'), { method: 'GET', cache: 'no-store' });
    if (!resp.ok) return;
    const j = await resp.json();
    if (!j || !j.found || !j.found.length) return;
    const best = j.found[0];
    const model = (best.models && best.models[0]) || '';
    if (!model) return;
    const ai = window.Core.State.get('ai') || {};
    ai.localEndpoint = { baseURL: best.baseURL, apiKey: '', model };
    ai.preferLocal = true;
    window.Core.State.set('ai', ai);
    if (window.Core && Core.Toast) Core.Toast.show(`🤖 自动发现本地 LLM @ ${best.baseURL} / ${model}`, 6000);
    console.log('[App] V15.3 auto-discover LLM via proxy:', best.baseURL, model);
  } catch (_) { /* 静默失败，手动扫不影响 */ }
}

// ========== 设置页渲染 ==========
window._renderSettings = function() {
  const root = document.getElementById('settingsForm');
  if (!root) return;

  const state = Core.State.get();
  const ai = state.ai || {};
  const localEp = ai.localEndpoint || {};
  const providerOptions = Object.entries(Core.AI.PROVIDERS)
    .map(([k, v]) => `<option value="${k}" ${ai.provider === k ? 'selected' : ''}>${v.name}</option>`)
    .join('');
  // 提示当前 provider 支持的模型列表
  const currentPcfg = Core.AI.getProviderConfig(ai.provider || 'deepseek');
  const modelHint = ai.model
    ? `当前已设: ${escapeHtml(ai.model)} (留空用默认 ${currentPcfg.defaultModel}; 其他可填: ${currentPcfg.models.join(', ')})`
    : `默认: ${currentPcfg.defaultModel}; 可填: ${currentPcfg.models.join(', ')}`;

  // 渲染后异步更新 sync auth area + 第二意见 key 带出 + AI 预设徽章
  setTimeout(() => {
    _renderSyncAuth();
    onSecondProviderChange();
    _refreshAIStatus();
    _refreshSyncStatus();
    if (window._bindUserProfileLive) _bindUserProfileLive();
  }, 0);
  root.innerHTML = `
    <div class="form-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
      <label style="font-size:14px;font-weight:600;">📊 数据源路由 (c v0.2)</label>
      <div style="font-size:11px;color:var(--text-muted);line-height:1.5;margin-bottom:6px;">
        ✅ <b>当前已自动 fallback</b>:<br>
        &nbsp;&nbsp;• <b>单只股票/指数</b> → 腾讯财经 <code>qt.gtimg.cn</code> (GBK→UTF8, CORS 友好, 实时)<br>
        &nbsp;&nbsp;• <b>全 A股 (选股)</b> → 东方财富 <code>push2.eastmoney.com/api/qt/clist/get</code> (一次 5000+ 只, CORS 友好)<br>
        &nbsp;&nbsp;• <b>腾讯/东财失败时</b> → 降级 aktools (<code>stock_zh_a_spot</code>, 需 dev-proxy 8089)<br>
        ⚠️ <b>AKShare 已知限流</b> (2026 频繁 5xx), 重启 <code>python -m aktools --port 8088</code> 或等 1 分钟。
      </div>
    </div>
    <div class="form-row">
      <label>🔧 服务自检 (APK 在外网/连不上后端时点这个)</label>
      <button class="btn" onclick="selfCheckServices()">▶ 一键自检 dev-proxy / aktools / LLM</button>
      <span id="selfCheckResult" style="font-size:12px;color:var(--text-muted);margin-left:8px;"></span>
    </div>
    <div id="selfCheckList" style="margin-top:8px;"></div>

    <div class="form-row">
      <label>📡 局域网自动发现 dev-proxy (APK 在手机上用)</label>
      <button class="btn" onclick="discoverDevProxy()">🔍 找 PC 上的 dev-proxy</button>
      <span id="devProxyDiscoverResult" style="font-size:12px;color:var(--text-muted);margin-left:8px;"></span>
    </div>
    <div id="devProxyDiscoverList" style="margin-top:8px;"></div>

    <div class="form-row">
      <label>AKShare 代理地址</label>
      <input type="text" id="settingProxyBase" value="${escapeHtml(state.proxyBase)}"
             placeholder="http://192.168.1.3:8089/api/akshare">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.5;">
        💡 浏览器 dev 用 <code>/api/akshare</code> (走 vite proxy);<br>
        📱 APK/手机 用 <code>http://192.168.1.3:8089/api/akshare</code> (你的 PC 局域网 IP)
      </div>
    </div>
    <div class="form-row">
      <label>Tushare Token</label>
      <input type="text" id="settingTushareToken" value="${escapeHtml(state.apiKeys.tushare || '')}"
             placeholder="可选,用于深度财务数据">
    </div>

    <div class="form-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
      <label style="font-size:14px;font-weight:600;">🤖 AI 大模型 (用于选基/解读)</label>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
        配置后可在 🏦 基金 tab 用 "🤖 AI 选基"。支持所有 OpenAI 兼容 API。
      </div>
      <div id="aiPresetBadge" style="display:none;font-size:11px;background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);border-radius:6px;padding:6px 10px;margin-bottom:8px;line-height:1.5;">
        ✅ <b>已预填默认值</b>: 优先本地 qwen3 (<code>http://127.0.0.1:8082/v1</code>, 模型 <code>qwen36-35b-a3b</code>)。
        本地不验 key, 留空即可直接用; 想换远程 API 在下面填 Remote API Key 即可。
      </div>
    </div>
    <div class="form-row">
      <label>Provider</label>
      <select id="settingAIProvider" onchange="onAIProviderChange()">
        ${providerOptions}
      </select>
    </div>
    <div class="form-row">
      <label>API Key</label>
      <input type="password" id="settingAIApiKey" value="${escapeHtml(ai.apiKey || '')}"
             placeholder="sk-...  (本地大模型可留空)" autocomplete="off">
    </div>
    <div class="form-row">
      <label>
        <input type="checkbox" id="settingAIUseProxy" onchange="onAIUseProxyChange()" ${ai.useProxy !== false ? 'checked' : ''}>
        🔀 通过本地代理 (解决浏览器 CORS)
      </label>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
        勾选后 baseURL 自动填 <code>/api/llm/{provider}/v1</code>, 由 dev-proxy (端口 8089) 转发。
        <br>⚠ 自定义本地大模型 (LM Studio / Ollama) 不要勾, 直接填 baseURL。
      </div>
    </div>
    <div class="form-row">
      <label>Base URL</label>
      <input type="text" id="settingAIBaseURL" value="${escapeHtml(ai.baseURL || '')}"
             placeholder="自动 / 留空用 provider 默认 / 例: http://192.168.1.5:1234/v1">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;" id="baseURLHint"></div>
    </div>
    <div class="form-row">
      <label>模型 (留空用默认)</label>
      <input type="text" id="settingAIModel" value="${escapeHtml(ai.model || '')}"
             placeholder="例: deepseek-v4-flash / gpt-4o-mini">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${modelHint}</div>
    </div>
    <div class="form-row">
      <label>测试连接</label>
      <button class="btn" onclick="testAI()">🔗 测试 AI 连接</button>
      <span id="aiTestResult" style="font-size:12px;color:var(--text-muted);margin-left:8px;"></span>
    </div>

    <div class="form-row">
      <label>当前生效</label>
      <span id="aiCurrentConfig" style="font-size:12px;color:var(--text-secondary);"></span>
    </div>

    <div class="form-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
      <label style="font-size:14px;font-weight:600;">🏠 本地大模型 (5.3.3 优先)</label>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;line-height:1.5;">
        家庭部署 (LM Studio / Ollama / vLLM) 用 OpenAI 兼容协议。<br>
        勾上"优先本地"后, <b>所有 AI 调用</b>默认走本地, 远程仅作降级。
        <br>💡 <code>opts.local</code> 三态: true 强制本地 / false 强制远程 / 未指定按勾选。
      </div>
    </div>
    <div class="form-row">
      <label>
        <input type="checkbox" id="settingAIPreferLocal" ${ai.preferLocal === true ? 'checked' : ''}>
        ✅ 优先使用本地 (无本地时降级远程)
      </label>
    </div>
    <div class="form-row">
      <label>本地 Base URL</label>
      <input type="text" id="settingAILocalBaseURL" value="${escapeHtml(localEp.baseURL || '')}"
             placeholder="例: http://192.168.1.10:1234/v1">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
        LM Studio 默认 <code>http://localhost:1234/v1</code> · Ollama 默认 <code>http://localhost:11434/v1</code>
      </div>
    </div>
    <div class="form-row">
      <label>本地 API Key (可留空)</label>
      <input type="text" id="settingAILocalApiKey" value="${escapeHtml(localEp.apiKey || '')}"
             placeholder="留空 (本地一般不验)" autocomplete="off">
    </div>
    <div class="form-row">
      <label>本地模型</label>
      <input type="text" id="settingAILocalModel" value="${escapeHtml(localEp.model || '')}"
             placeholder="例: qwen2.5-7b-instruct / deepseek-r1-distill">
    </div>
    <div class="form-row">
      <label>测试本地连接</label>
      <button class="btn" onclick="testLocalAI()">🏠 测试本地 AI</button>
      <span id="aiLocalTestResult" style="font-size:12px;color:var(--text-muted);margin-left:8px;"></span>
    </div>
    <div class="form-row">
      <label>自动发现 (局域网)</label>
      <button class="btn" onclick="discoverLLM()">🔍 扫描本地大模型</button>
      <span id="aiDiscoverResult" style="font-size:12px;color:var(--text-muted);margin-left:8px;"></span>
    </div>
    <div id="aiDiscoverList"></div>

    <div class="form-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
      <label style="font-size:14px;font-weight:600;">🤝 第二意见 (双模型交叉验证, Phase D2)</label>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;line-height:1.5;">
        给 💡 单股简评配第二个 LLM: 选一个 ≠ 主 Provider 的厂商, 填它的 API Key, 保存。<br>
        之后在 💡 简评弹窗点 "🤝 第二意见", 两个模型对同一份上下文各评一次 + 主模型出一致性小结。<br>
        已配置 Key 的 Provider: <b>${_secondOpinionConfiguredList()}</b>
      </div>
    </div>
    <div class="form-row">
      <label>第二意见 Provider</label>
      <select id="settingSecondProvider" onchange="onSecondProviderChange()">
        ${_secondProviderOptions(ai.provider || 'deepseek')}
      </select>
    </div>
    <div class="form-row">
      <label>第二意见 API Key</label>
      <input type="password" id="settingSecondApiKey" value="" placeholder="sk-...  (留空 = 删除该 Provider 的 Key)" autocomplete="off">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Key 按 Provider 分别保存, 切换上面的下拉会带出已存的 Key。</div>
    </div>

    <div class="form-row">
      <label>健康检查</label>
      <button class="btn" onclick="checkHealth()">🔗 检查代理连接</button>
      <span id="healthResult" style="font-size:12px;color:var(--text-muted);"></span>
    </div>
    <div class="form-row">
      <label>数据管理</label>
      <button class="btn btn-ghost" onclick="exportData()">📦 导出</button>
      <button class="btn btn-ghost" onclick="importData()">📥 导入</button>
      <button class="btn btn-ghost" onclick="exportTodaySnapshot()">📅 导出今日快照</button>
      <button class="btn btn-danger" onclick="clearAllData()">🗑 清空所有数据</button>
    </div>

    <div class="form-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
      <label style="font-size:14px;font-weight:600;">☁️ Supabase 云同步 (可选)</label>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;line-height:1.5;">
        配一次, 电脑+手机+任何设备数据自动同步。<br>
        1. 去 <a href="https://supabase.com" target="_blank" style="color:var(--link);">supabase.com</a> 注册创项目 (免费)<br>
        2. SQL Editor 跑 <code>scripts/supabase_schema.sql</code><br>
        3. Project Settings → API 复制 URL 和 anon key 粘下面<br>
        4. 邮箱注册账号 → 点 "🔄 立即同步"
      </div>
      <div id="syncPresetBadge" style="font-size:11px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin-bottom:8px;line-height:1.5;color:var(--text-muted);">
        💡 <b>同步设置</b>: 已默认开启自动同步 (改本地后自动推云), 只需填 URL + anon key + 注册账号即可。
      </div>
    </div>
    <div class="form-row">
      <label>Project URL</label>
      <input type="text" id="settingSyncUrl" value="${escapeHtml(Core.State.get('sync')?.url || '')}"
             placeholder="https://xxxxx.supabase.co">
    </div>
    <div class="form-row">
      <label>Anon Public Key</label>
      <input type="password" id="settingSyncAnonKey" value="${escapeHtml(Core.State.get('sync')?.anonKey || '')}"
             placeholder="eyJhbGciOi...  (anon public, 不是 service_role!)" autocomplete="off">
    </div>
    <div class="form-row">
      <label>自动同步</label>
      <label style="font-weight:normal;">
        <input type="checkbox" id="settingSyncAuto" ${Core.State.get('sync')?.autoSync !== false ? 'checked' : ''}>
        ✅ 改本地数据后自动推云
      </label>
    </div>
    <div class="form-row">
      <label>当前状态</label>
      <span id="syncStatus" style="font-size:12px;color:var(--text-secondary);"></span>
    </div>
    <div class="form-row">
      <label>账户</label>
      <div id="syncAuthArea">
        <span style="font-size:12px;color:var(--text-muted);">保存配置后此处显示登录/注册按钮</span>
      </div>
    </div>
    <div class="form-row">
      <label>同步</label>
      <button class="btn btn-primary" onclick="syncNow()">🔄 立即全量同步</button>
      <button class="btn" onclick="syncPushOnly()">⬆️ 仅推送本地</button>
      <button class="btn" onclick="syncPullOnly()">⬇️ 仅拉取云端</button>
      <div id="syncResult" style="font-size:11px;color:var(--text-muted);margin-top:6px;"></div>
    </div>
    <div class="form-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
      <label>关于</label>
      <div style="font-size:12px;color:var(--text-muted);" id="appAboutLine">
        StockMaster ${APP_VERSION} · ${APP_BUILD_DATE}<br>
        自用工具 · 数据本地化 · 零合规风险<br>
        <a href="https://github.com/akfamily/akshare" target="_blank" style="color:var(--link);">数据源 AKShare</a>
      </div>
    </div>
    ${_renderUserProfileSection()}
    <div class="form-row" style="position:sticky;bottom:0;background:var(--bg-base);padding:12px 0;margin-top:8px;border-top:1px solid var(--border);z-index:10;">
      <label></label>
      <button class="btn btn-primary" id="saveSettingsBtn" onclick="saveSettings()">💾 保存所有设置</button>
      <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">填完所有改动后点这个一次保存</span>
    </div>
  `;
};

// ===== 用户画像 (Core.UserProfile) 设置区块 =====
// 数据源: Core.UserProfile, 单一事实来源, 选股/选基 prompt 都从这里读
// persist 走 Core.State('userProfile') → kv 'state_userProfile' (state.js 白名单已含)

function _renderUserProfileSection() {
  if (!window.Core || !window.Core.UserProfile) return '';
  const p = window.Core.UserProfile.load();
  const UP = window.Core.UserProfile;
  const riskOpts = Object.keys(UP.RISK_TEXT).map(k =>
    `<option value="${k}" ${p.risk === k ? 'selected' : ''}>${k}</option>`).join('');
  const horizonOpts = Object.keys(UP.HORIZON_TEXT).map(k =>
    `<option value="${k}" ${p.horizon === k ? 'selected' : ''}>${k}</option>`).join('');
  const allowEquityOpts = Object.keys(UP.ALLOW_EQUITY_TEXT).map(k =>
    `<option value="${k}" ${p.allowEquity === k ? 'selected' : ''}>${k}</option>`).join('');
  return `
    <div class="form-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
      <label style="font-size:14px;font-weight:600;">👤 用户画像 (选股/选基 AI prompt 统一来源)</label>
      <div style="font-size:11px;color:var(--text-muted);line-height:1.5;margin-bottom:6px;">
        ✅ 改这里后, AI 选基/选股会立刻按新画像重新推荐 (不需要重启)。<br>
        第一次跑 AI 时已自动注入 systemPrompt, 不再硬编码"长期稳健型"。
      </div>
    </div>
    <div class="form-row">
      <label>风险偏好 (3 档)</label>
      <select id="settingUPRisk">${riskOpts}</select>
    </div>
    <div class="form-row">
      <label>投资期限 (3 档)</label>
      <select id="settingUPHorizon">${horizonOpts}</select>
    </div>
    <div class="form-row">
      <label>是否允许权益类</label>
      <select id="settingUPAllowEquity">${allowEquityOpts}</select>
    </div>
    <div class="form-row">
      <label>个人偏好 (自由文本, 可空)</label>
      <input type="text" id="settingUPPreference" value="${escapeHtml(p.preference || '')}"
             placeholder="例: 重仓蓝筹, 不买 ST, 偏好红利">
    </div>
    <div class="form-row">
      <label>行业/品种黑名单 (逗号分隔, 可空)</label>
      <input type="text" id="settingUPBlacklist" value="${escapeHtml(p.blacklist || '')}"
             placeholder="例: ST, 教育, 房地产">
    </div>
    <div class="form-row">
      <label>目标年化收益率 (%)</label>
      <input type="number" id="settingUPTargetReturn" value="${p.targetReturn}"
             step="0.5" min="0" max="100">
    </div>
    <div class="form-row">
      <label>可接受最大回撤 (%)</label>
      <input type="number" id="settingUPMaxDrawdown" value="${p.maxDrawdown}"
             step="0.5" min="0" max="100">
    </div>
    <div class="form-row">
      <label>📋 当前 prompt 预览 (Core.AI.formatUserProfile)</label>
      <pre id="settingUPPromptPreview"
           style="background:var(--bg-base);padding:8px;font-size:11px;border-radius:4px;white-space:pre-wrap;max-height:200px;overflow:auto;margin:0;"></pre>
    </div>
  `;
}

function _refreshUserProfilePreview() {
  const pre = document.getElementById('settingUPPromptPreview');
  if (!pre || !window.Core || !window.Core.AI) return;
  // 临时组装"用户编辑后"的 profile 用于预览, 不持久化
  const draft = {
    risk: document.getElementById('settingUPRisk')?.value,
    horizon: document.getElementById('settingUPHorizon')?.value,
    allowEquity: document.getElementById('settingUPAllowEquity')?.value,
    preference: document.getElementById('settingUPPreference')?.value || '',
    blacklist: document.getElementById('settingUPBlacklist')?.value || '',
    targetReturn: parseFloat(document.getElementById('settingUPTargetReturn')?.value),
    maxDrawdown: parseFloat(document.getElementById('settingUPMaxDrawdown')?.value)
  };
  // 直接复用 Core.UserProfile.mergeWithDefaults + 三个 *Label 函数模拟
  const UP = window.Core.UserProfile;
  const m = UP.mergeWithDefaults(draft);
  const lines = [
    '- 风险偏好: ' + UP.riskLabel(m.risk),
    '- 投资期限: ' + UP.horizonLabel(m.horizon),
    '- 是否允许权益类: ' + UP.allowEquityLabel(m.allowEquity),
    '- 目标年化收益率: ' + m.targetReturn + '%',
    '- 可接受最大回撤: ' + m.maxDrawdown + '%'
  ];
  if (m.preference && String(m.preference).trim()) lines.push('- 个人偏好: ' + m.preference);
  if (m.blacklist && String(m.blacklist).trim()) lines.push('- 行业/品种黑名单: ' + m.blacklist);
  pre.textContent = lines.join('\n');
}

function _saveUserProfile() {
  const draft = {
    risk: document.getElementById('settingUPRisk')?.value,
    horizon: document.getElementById('settingUPHorizon')?.value,
    allowEquity: document.getElementById('settingUPAllowEquity')?.value,
    preference: document.getElementById('settingUPPreference')?.value || '',
    blacklist: document.getElementById('settingUPBlacklist')?.value || '',
    targetReturn: parseFloat(document.getElementById('settingUPTargetReturn')?.value),
    maxDrawdown: parseFloat(document.getElementById('settingUPMaxDrawdown')?.value)
  };
  // 数字字段走 parseFloat (空字符串 → NaN → 默认值, 见 mergeWithDefaults 兜底)
  const r = window.Core.UserProfile.save(draft);
  if (!r) toastError('画像保存失败: 请检查风险/期限/收益/回撤是否在合法范围');
  return r;
}

window._renderUserProfileSection = _renderUserProfileSection;
window._saveUserProfile = _saveUserProfile;
window._refreshUserProfilePreview = _refreshUserProfilePreview;

// ===== Phase D2: 第二意见 (双模型交叉验证) 设置辅助 =====
// key 存 Core.State.apiKeys.llm = { [provider]: key }, 与主 AI 配置的单一 apiKey 互不干扰
// custom 不走 dev-proxy, 不作为第二意见候选

function _secondOpinionLlmKeys() {
  const apiKeys = Core.State.get('apiKeys') || {};
  return apiKeys.llm || {};
}

function _secondOpinionConfiguredList() {
  const configured = Object.keys(_secondOpinionLlmKeys()).filter(p => _secondOpinionLlmKeys()[p]);
  return configured.length > 0 ? configured.join(', ') : '无';
}

function _secondProviderOptions(currentProvider) {
  const keys = _secondOpinionLlmKeys();
  const candidates = Object.keys(Core.AI.PROVIDERS).filter(p => p !== 'custom');
  // 默认选中: 第一个 ≠ 主 provider 且已配 key 的; 否则第一个 ≠ 主 provider 的
  const def = candidates.find(p => p !== currentProvider && keys[p]) || candidates.find(p => p !== currentProvider) || candidates[0];
  return candidates.map(p =>
    `<option value="${p}" ${p === def ? 'selected' : ''}>${escapeHtml(Core.AI.PROVIDERS[p].name)}${keys[p] ? ' ✓' : ''}</option>`
  ).join('');
}

window.onSecondProviderChange = function() {
  const p = document.getElementById('settingSecondProvider')?.value;
  const input = document.getElementById('settingSecondApiKey');
  if (input) input.value = (_secondOpinionLlmKeys()[p]) || '';
};

window.onAIProviderChange = function() {
  const p = document.getElementById('settingAIProvider').value;
  const cfg = Core.AI.getProviderConfig(p);
  const modelEl = document.getElementById('settingAIModel');
  const baseEl = document.getElementById('settingAIBaseURL');
  if (modelEl && !modelEl.value) modelEl.placeholder = '默认: ' + (cfg.defaultModel || '(必填)');
  if (baseEl && !baseEl.value) baseEl.placeholder = cfg.baseURL ? `默认: ${cfg.baseURL}` : '必填 (OpenAI 兼容)';
  // 切换 provider 时, 如果勾选了本地代理, 自动填 baseURL
  window.onAIUseProxyChange();
};

window.onAIUseProxyChange = function() {
  const useProxy = document.getElementById('settingAIUseProxy')?.checked;
  const p = document.getElementById('settingAIProvider').value;
  const baseEl = document.getElementById('settingAIBaseURL');
  const hint = document.getElementById('baseURLHint');
  if (!baseEl) return;
  if (useProxy && p !== 'custom') {
    // 自动填本地代理 URL
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (x) => x;
    const proxyURL = _apiUrl(`/api/llm/${p}/v1`);
    if (!baseEl.value || baseEl.value.startsWith('/api/llm/') || /^https?:\/\/.+\/api\/llm\//.test(baseEl.value)) {
      baseEl.value = proxyURL;
    }
    if (hint) hint.innerHTML = '✓ 通过 dev-proxy 转发, 浏览器无 CORS。生产 APK 部署时改为局域网 IP 即可。';
  } else {
    if (hint) hint.innerHTML = useProxy ? '⚠ custom provider 不走代理, 直接连' : '✗ 未走代理, 浏览器可能 CORS 拦截。已知公网 API (DeepSeek/OpenAI/Moonshot) 都可能拦, 建议勾上。';
  }
};

window.testAI = async function() {
  // 先保存当前输入
  saveSettings(true);
  const el = document.getElementById('aiTestResult');
  el.textContent = '测试中...';
  el.style.color = 'var(--text-muted)';
  const r = await Core.AI.testConnection();
  if (r.ok) {
    el.innerHTML = `✓ ${r.provider}/${r.model}  ${r.latencyMs}ms — "${escapeHtml(r.reply)}"`;
    el.style.color = 'var(--up)';
  } else {
    el.textContent = '✗ ' + r.error;
    el.style.color = 'var(--down)';
  }
};

// 5.3.3 本地 LLM 连接测试 (强制走本地, 不降级)
window.testLocalAI = async function() {
  saveSettings(true);
  const el = document.getElementById('aiLocalTestResult');
  el.textContent = '测试中 (本地)...';
  el.style.color = 'var(--text-muted)';
  try {
    // 先看本地配置
    const ep = Core.AI.resolveEndpoint({ local: true });
    if (!ep.isLocal) {
      el.innerHTML = '⚠ 未启用本地 (本地 baseURL 缺), 实际走远程: ' + escapeHtml(ep.baseURL || '(无)');
      el.style.color = 'var(--text-muted)';
      return;
    }
    el.textContent = `测试 ${ep.baseURL} / ${ep.model}...`;
    const start = Date.now();
    // 强制 local=true
    const text = await Core.AI.call({
      prompt: '请用中文只回一个词: 通',
      maxTokens: 500,
      temperature: 0,
      local: true
    });
    el.innerHTML = `✓ 本地 ${ep.model}  ${Date.now() - start}ms — "${escapeHtml(text.trim())}"`;
    el.style.color = 'var(--up)';
  } catch (e) {
    el.innerHTML = '✗ ' + escapeHtml(e.message);
    el.style.color = 'var(--down)';
  }
};

// 局域网自动发现 dev-proxy (给 APK 用) —
// 步骤: 浏览器 fetch dev-proxy 的 /api/discover/dev-proxy → 拿 serverIPs 列表
//       → 浏览器挨个 fetch {ip}:8089/ping (纯内存, 不探测 aktools, 快)
//       → 命中即填入 settingProxyBase, 一键保存
window.discoverDevProxy = async function() {
  const status = document.getElementById('devProxyDiscoverResult');
  const list = document.getElementById('devProxyDiscoverList');
  if (status) { status.textContent = '⏳ 探测中...'; status.style.color = 'var(--text-muted)'; }
  if (list) list.innerHTML = '';
  window._discoveredDevProxies = [];
  let info;
  try {
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (x) => x;
    const r = await fetch(_apiUrl('/api/discover/dev-proxy'), { cache: 'no-store' });
    if (!r.ok) throw new Error('dev-proxy 返回 HTTP ' + r.status);
    info = await r.json();
  } catch (e) {
    if (status) { status.textContent = '❌ 拿不到候选 IP: ' + e.message + ' (dev-proxy 没在跑?)'; status.style.color = 'var(--down)'; }
    console.warn('[discoverDevProxy] 拿 serverIPs 失败:', e);
    return;
  }
  // 候选 IP: 1) dev-proxy 报的 serverIPs 2) 当前页 origin 拆出来的 host (说不定是 IP)
  const candidates = new Set(info.serverIPs || []);
  try {
    const cur = new URL(location.href);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(cur.hostname)) candidates.add(cur.hostname);
    if (cur.hostname.endsWith('.local')) candidates.add(cur.hostname);
  } catch (e) { /* ignore */ }
  if (candidates.size === 0) {
    if (status) { status.textContent = '❌ dev-proxy 没拿到任何 LAN IP (虚拟网卡? 防火墙?)'; status.style.color = 'var(--down)'; }
    return;
  }
  // V15: 探测每个候选: fetch {ip}:{port}/ping (纯内存, 不探测 aktools, 快)
  const port = info.port || 8089;
  const tasks = [...candidates].map(async (ip) => {
    const start = Date.now();
    const url = `http://${ip}:${port}/ping`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const resp = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      const j = await resp.json().catch(() => null);
      return { ip, port, ok: resp.ok && j && j.status === 'ok', latencyMs: Date.now() - start, j };
    } catch (e) {
      clearTimeout(timer);
      return { ip, port, ok: false, latencyMs: Date.now() - start, error: e.message };
    }
  });
  const results = await Promise.all(tasks);
  const found = results.filter(r => r.ok).sort((a, b) => a.latencyMs - b.latencyMs);
  window._discoveredDevProxies = found;
  if (status) {
    status.textContent = `扫了 ${results.length} 个候选 IP, 命中 ${found.length} 个`;
    status.style.color = found.length > 0 ? 'var(--up)' : 'var(--down)';
  }
  if (!list) return;
  if (found.length === 0) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 0;line-height:1.6;">
      未发现 dev-proxy。可能: ① dev-proxy 没在跑 (PC 上 gst-dev) ② 手机和 PC 不在同一 WiFi ③ PC 防火墙拦了 8089<br>
      候选列表: ${[...candidates].map(ip => `<code>${escapeHtml(ip)}:${port}</code>`).join(', ')}
    </div>`;
    return;
  }
  list.innerHTML = found.map((f, idx) => `
    <div class="data-card" style="margin-top:8px;padding:10px;">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;">
        <div style="flex:1;">
          <div style="font-weight:600;">📡 ${escapeHtml(f.ip)}:${f.port} <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">(${f.latencyMs}ms)</span></div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">将填入 <code>http://${escapeHtml(f.ip)}:${f.port}/api/akshare</code></div>
        </div>
        <button class="btn btn-sm btn-primary" onclick="applyDiscoveredDevProxy(${idx})">使用</button>
      </div>
    </div>
  `).join('');
};

window.applyDiscoveredDevProxy = async function(idx) {
  const found = window._discoveredDevProxies || [];
  const f = found[idx];
  if (!f) return;
  const newProxy = `http://${f.ip}:${f.port}/api/akshare`;
  const input = document.getElementById('settingProxyBase');
  if (input) input.value = newProxy;
  // saveSettings(true) 持久化 + 静默保存
  if (window.saveSettings) {
    window.saveSettings(true);
    if (window.toastSuccess) toastSuccess('已应用: ' + newProxy);
  }
};

// 服务自检 (Phase Z) — 一键看 dev-proxy / aktools / 本地 LLM 是否在线
window.selfCheckServices = async function() {
  const status = document.getElementById('selfCheckResult');
  const list = document.getElementById('selfCheckList');
  if (status) { status.textContent = '⏳ 自检中...'; status.style.color = 'var(--text-muted)'; }
  if (list) list.innerHTML = '';

  // 用 _apiUrl() 统一翻译 (APK 走 proxyBase, 浏览器走相对路径 → vite proxy)
  const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (x) => x;

  // 包一层带超时的 fetch: Android WebView fetch 没有超时, 长 scan 容易直接 reject "Failed to fetch"
  const _fetchWithTimeout = async (url, opts = {}, ms = 8000) => {
    const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    if (ctl) opts.signal = ctl.signal;
    const t = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) {} }, ms);
    try {
      return await fetch(url, opts);
    } finally { clearTimeout(t); }
  };

  const checks = [
    {
      name: 'dev-proxy',
      desc: 'Node 代理 (行情/行业/LLM/扫描 都在这里)',
      test: async () => {
        const start = Date.now();
        const url = _apiUrl('/health');
        const r = await _fetchWithTimeout(url, { cache: 'no-store' }, 4000);
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch (e) {}
        const ok = r.ok && !!j;
        return { ok, latencyMs: Date.now() - start, detail: 'GET ' + url + ' → ' + (j ? ('akshare_target=' + (j.akshare_target || '?')) : ('HTTP ' + r.status + ' (非 JSON): ' + t.slice(0, 80))) };
      }
    },
    {
      name: 'aktools',
      desc: 'Python AKShare 后端 (深度财务/龙虎榜 等)',
      test: async () => {
        const start = Date.now();
        // 用 /health 拿 dev-proxy 反馈的 akshare_status, 避免 stock_zh_a_spot?symbol (aktools 0.0.91+ 报 500)
        const url = _apiUrl('/health');
        const r = await _fetchWithTimeout(url, { cache: 'no-store' }, 8000);
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
        const akshareOk = j && j.akshare_status === 'ok';
        return {
          ok: r.ok && akshareOk,
          latencyMs: Date.now() - start,
          detail: 'GET ' + url + ' → ' + (j ? 'akshare_status=' + j.akshare_status : 'HTTP ' + r.status + ' (无 JSON)')
        };
      }
    },
    {
      name: '本地大模型',
      desc: '扫描局域网 qwen/Ollama/LM Studio',
      test: async () => {
        const start = Date.now();
        const url = _apiUrl('/api/discover/local-llm');
        // discoverLocalLLM 内部 fetch 没 timeout, 包一层避免 20 个 LAN 端点扫描卡死
        const probe = await _fetchWithTimeout(url, { method: 'GET', cache: 'no-store' }, 10000)
          .then(async r => ({ status: r.status, json: r.ok ? await r.json() : null }))
          .catch(e => ({ status: 0, json: null, err: String(e) }));
        if (probe.status !== 200 || !probe.json) {
          throw new Error('HTTP ' + probe.status + (probe.err ? ' (' + probe.err + ')' : ''));
        }
        const j = probe.json;
        const found = j.found || [];
        return {
          ok: found.length > 0,
          latencyMs: Date.now() - start,
          detail: 'GET ' + url + ' → ' + found.length + ' 个候选 (扫了 ' + (j.scanned || 0) + ' 个端点, dev-proxy 在 ' + (j.host || '127.0.0.1') + ')'
        };
      }
    }
  ];

  const results = await Promise.all(checks.map(async (c) => {
    try {
      const r = await c.test();
      return { ...c, ...r, error: null };
    } catch (e) {
      return { ...c, ok: false, latencyMs: 0, detail: '', error: e.message };
    }
  }));

  const allOk = results.every(r => r.ok);
  const someOk = results.some(r => r.ok);
  if (status) {
    status.textContent = allOk
      ? '✅ 全部服务正常'
      : (someOk ? '⚠️ 部分服务异常' : '❌ 全部服务不可用 (手机端请检查 dev-proxy 是否在 PC 跑)');
    status.style.color = allOk ? 'var(--up)' : (someOk ? 'var(--accent)' : 'var(--down)');
  }
  if (list) {
    list.innerHTML = results.map((r, i) => {
      const tag = r.ok
        ? `<span style="color:var(--up);font-weight:600;">✅</span>`
        : (r.error ? `<span style="color:var(--down);font-weight:600;">❌</span>` : `<span style="color:var(--down);font-weight:600;">❌</span>`);
      const ms = r.latencyMs ? `${r.latencyMs}ms` : '-';
      const detail = r.error ? `<code style="color:var(--down);">${escapeHtml(r.error)}</code>` : escapeHtml(r.detail || '');
      return `
        <div style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:12px;line-height:1.6;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>${tag} <b>${escapeHtml(r.name)}</b> <span style="color:var(--text-muted);">— ${escapeHtml(r.desc)}</span></div>
            <div style="font-size:11px;color:var(--text-muted);">${ms}</div>
          </div>
          ${detail ? `<div style="margin-top:4px;color:var(--text-muted);font-size:11px;">${detail}</div>` : ''}
        </div>`;
    }).join('');
    // 故障提示
    if (!allOk) {
      list.innerHTML += `
        <div style="margin-top:8px;padding:8px;background:var(--bg-base);border-radius:6px;font-size:11px;color:var(--text-muted);line-height:1.7;">
          <b>修复步骤</b>:<br>
          ① 在 PC 上跑 <code>gst-dev</code> 起 dev-proxy + vite<br>
          ② 跑 <code>python -m aktools --host 127.0.0.1 --port 8088</code><br>
          ③ 确认 PC 的 IP 在手机能 ping 通<br>
          ④ 在 AKShare 代理地址 输入 <code>http://PC的IP:8089/api/akshare</code>
        </div>`;
    }
  }
};

// 局域网自动发现本地大模型 (Phase 自动发现)
window.discoverLLM = async function() {
  const status = document.getElementById('aiDiscoverResult');
  const list = document.getElementById('aiDiscoverList');
  if (status) { status.textContent = '⏳ 扫描中(1-3 秒)...'; status.style.color = 'var(--text-muted)'; }
  if (list) list.innerHTML = '';
  window._discoveredLLMs = [];
  try {
    const r = await Core.AI.discoverLocalLLM();
    if (status) {
      status.textContent = `扫描 ${r.scanned} 个端点, 命中 ${r.found.length} 个; dev-proxy 在 ${r.host}`;
      status.style.color = r.found.length > 0 ? 'var(--up)' : 'var(--text-muted)';
    }
    if (!list) return;
    if (r.found.length === 0) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">未发现本地大模型。检查:① dev-proxy 在跑 ② LLM 服务启动 ③ 端口在白名单 (8082/1234/11434/11435/8000)</div>';
      return;
    }
    window._discoveredLLMs = r.found;
    list.innerHTML = r.found.map((f, idx) => `
      <div class="data-card" style="margin-top:8px;padding:10px;">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;">
          <div style="flex:1;">
            <div style="font-weight:600;">${escapeHtml(f.label)} <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">(${f.latencyMs}ms)</span></div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;font-family:monospace;">${escapeHtml(f.baseURL)}</div>
            <div style="font-size:12px;margin-top:4px;">模型: ${f.models.map(m => `<code style="background:var(--bg-base);padding:1px 4px;border-radius:3px;">${escapeHtml(m)}</code>`).join(' ')}</div>
          </div>
          <button class="btn btn-sm btn-primary" onclick="applyDiscoveredLLM(${idx})">使用</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    if (status) {
      status.textContent = '❌ 扫描失败: ' + e.message;
      status.style.color = 'var(--down)';
    }
    console.warn('[discoverLLM] 错误:', e);
  }
};

// 手动测试长线 AI 选股（强制跳过周一/7天限制，直接跑完整管线）
// B3 修复: 按钮已归位到 paper.js 长线 tab (manualLongResult), 设置页不再有按钮
// B7 修复: 90s 总超时兜底 (LongTrader.runNow 内部异常被吞, 不超时 UI 永远卡)
window.manualLongTrader = async function() {
  const el = document.getElementById('manualLongResult');
  if (el) { el.textContent = '⏳ 正在拉行情+评分+LLM 选股（可能需要 30-90 秒）...'; el.style.color = 'var(--text-muted)'; }
  if (!window.LongTrader) { if (el) { el.textContent = '❌ LongTrader 未加载'; el.style.color = 'var(--down)'; } return; }
  const TIMEOUT_MS = 90000;
  let timer = null;
  try {
    const racePromise = LongTrader.runNow({ force: true });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('LongTrader.runNow 超时 (' + (TIMEOUT_MS / 1000) + 's)')), TIMEOUT_MS);
    });
    await Promise.race([racePromise, timeoutPromise]);
    if (el) { el.textContent = '✅ 长线选股完成，请查看上方结果'; el.style.color = 'var(--up)'; }
  } catch (e) {
    if (el) { el.textContent = '❌ 失败: ' + e.message; el.style.color = 'var(--down)'; }
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// 手动测试短线盘前计划（强制重新生成，忽略今日已生成记录）
// B3 修复: 按钮已归位到 paper.js 短线 tab (manualShortResult), 设置页不再有按钮
// B7 修复: 60s 总超时兜底 (同 manualLongTrader, 短线 LLM 决策更快给 60s)
window.manualShortPlan = async function() {
  const el = document.getElementById('manualShortResult');
  if (el) { el.textContent = '⏳ 正在生成短线盘前计划（可能需要 30-60 秒）...'; el.style.color = 'var(--text-muted)'; }
  if (!window.ShortTrader) { if (el) { el.textContent = '❌ ShortTrader 未加载'; el.style.color = 'var(--down)'; } return; }
  const TIMEOUT_MS = 60000;
  let timer = null;
  try {
    const racePromise = ShortTrader.generatePlan({ now: new Date() });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('ShortTrader.generatePlan 超时 (' + (TIMEOUT_MS / 1000) + 's)')), TIMEOUT_MS);
    });
    const r = await Promise.race([racePromise, timeoutPromise]);
    if (el) {
      const n = r && r.plans ? r.plans.length : 0;
      el.textContent = n > 0 ? `✅ 短线计划生成完成 (${n} 条)，查看上方结果` : '✅ 已运行，请查看结果';
      el.style.color = 'var(--up)';
    }
  } catch (e) {
    if (el) { el.textContent = '❌ 失败: ' + e.message; el.style.color = 'var(--down)'; }
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// 用户点 [使用] 候选 → 填入设置 + 自动测试
window.applyDiscoveredLLM = async function(idx) {
  const found = window._discoveredLLMs || [];
  const f = found[idx];
  if (!f) return;
  // 1) 填 UI 字段
  document.getElementById('settingAILocalBaseURL').value = f.baseURL;
  if (f.models.length > 0) {
    document.getElementById('settingAILocalModel').value = f.models[0];
  }
  // 2) 自动勾 preferLocal
  const cb = document.getElementById('settingAIPreferLocal');
  if (cb && !cb.checked) cb.checked = true;
  // 3) 持久化 + 测试
  await saveSettings(true);
  await testLocalAI();
  // 4) toast 提示
  if (window.toastSuccess) toastSuccess('已应用: ' + f.label + ' / ' + f.models[0]);
};

// 显示当前 AI 配置 (本地/远程) + 预填提示
function _refreshAIStatus() {
  const ai = Core.State.get('ai') || {};
  const local = ai.localEndpoint || {};
  const prefLocal = ai.preferLocal === true && !!local.baseURL;

  const badge = document.getElementById('aiPresetBadge');
  if (badge) badge.style.display = prefLocal ? 'block' : 'none';

  const cur = document.getElementById('aiCurrentConfig');
  if (!cur) return;
  // 模拟 resolveEndpoint 但不实际发请求
  const parts = [];
  if (prefLocal) {
    parts.push(`🏠 本地: ${escapeHtml(local.baseURL)} / ${escapeHtml(local.model)}`);
  }
  if (ai.baseURL || ai.apiKey) {
    parts.push(`☁️ 远程: provider=${escapeHtml(ai.provider || 'custom')} model=${escapeHtml(ai.model || '(默认)')}`);
  }
  if (!prefLocal && !ai.apiKey) {
    parts.push('<span style="color:var(--down);">⚠ 未配置 (本地+远程都无)</span>');
  }
  cur.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

// 显示当前云同步状态
function _refreshSyncStatus() {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const s = Core.State.get('sync') || {};
  const hasCfg = !!(s.url && s.anonKey);
  const auto = s.autoSync !== false;
  const parts = [];
  if (!hasCfg) {
    parts.push('<span style="color:var(--text-muted);">⚪ 未配置 (URL/anonKey 缺)</span>');
  } else {
    parts.push('<span style="color:var(--up);">✓ 已配置 URL + Key</span>');
  }
  parts.push(`自动同步: <b>${auto ? '开' : '关'}</b>`);
  if (s.userEmail) parts.push(`登录: ${escapeHtml(s.userEmail)}`);
  el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

window.checkHealth = async function() {
  const el = document.getElementById('healthResult');
  el.textContent = '检查中...';
  el.style.color = 'var(--text-muted)';
  const h = await Core.Data.health();
  // B1 修复: Core.Data.health() 返 { status, error }, 不是 { ok }
  if (h && h.status === 'ok') {
    el.textContent = '✓ 代理正常';
    el.style.color = 'var(--up)';
  } else {
    el.textContent = '✗ ' + (h && h.error ? h.error : '未知错误');
    el.style.color = 'var(--down)';
  }
};

window.saveSettings = function(silent) {
  const proxyBase = document.getElementById('settingProxyBase').value.trim() || '/api/akshare';
  const tushareToken = document.getElementById('settingTushareToken').value.trim();
  // Phase D2: 第二意见的 per-provider key (map), 只更新当前选中的那个 provider, 其余保留
  const llmKeys = { ...(Core.State.get('apiKeys').llm || {}) };
  const secondProvider = document.getElementById('settingSecondProvider')?.value || '';
  const secondKey = document.getElementById('settingSecondApiKey')?.value.trim() || '';
  if (secondProvider) {
    if (secondKey) llmKeys[secondProvider] = secondKey;
    else delete llmKeys[secondProvider];
  }
  Core.State.set('proxyBase', proxyBase);
  Core.State.set('apiKeys', { ...Core.State.get('apiKeys'), tushare: tushareToken, llm: llmKeys });

  // AI 配置
  const aiProvider = document.getElementById('settingAIProvider')?.value || 'deepseek';
  const aiApiKey = document.getElementById('settingAIApiKey')?.value.trim() || '';
  const aiModel = document.getElementById('settingAIModel')?.value.trim() || '';
  const aiBaseURL = document.getElementById('settingAIBaseURL')?.value.trim() || '';
  const aiUseProxy = document.getElementById('settingAIUseProxy')?.checked || false;
  // 5.3.3 本地 LLM
  const aiPreferLocal = document.getElementById('settingAIPreferLocal')?.checked || false;
  const aiLocalBaseURL = document.getElementById('settingAILocalBaseURL')?.value.trim() || '';
  const aiLocalApiKey = document.getElementById('settingAILocalApiKey')?.value.trim() || '';
  const aiLocalModel = document.getElementById('settingAILocalModel')?.value.trim() || '';
  Core.State.set('ai', {
    provider: aiProvider,
    apiKey: aiApiKey,
    model: aiModel,
    baseURL: aiBaseURL,
    useProxy: aiUseProxy,
    preferLocal: aiPreferLocal,
    localEndpoint: {
      baseURL: aiLocalBaseURL,
      apiKey: aiLocalApiKey,
      model: aiLocalModel
    }
  });

  // Supabase 配置
  const syncUrl = document.getElementById('settingSyncUrl')?.value.trim() || '';
  const syncAnonKey = document.getElementById('settingSyncAnonKey')?.value.trim() || '';
  const syncAuto = document.getElementById('settingSyncAuto')?.checked ?? true;
  Core.State.set('sync', { ...Core.State.get('sync'), url: syncUrl, anonKey: syncAnonKey, autoSync: syncAuto });

  // 用户画像 (Core.UserProfile) - 校验失败不阻塞其他项保存, 弹 toastError
  _saveUserProfile();

  if (!silent) toastSuccess('已保存');
  _renderSyncAuth();
};

// Settings UI 加载完后, 绑 UP 表单 onchange 实时刷新 preview
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('saveSettingsBtn');
  if (btn) btn.onclick = saveSettings;
  // UP 输入框实时预览 (在 _renderSettings 后由 goSettings 调 _refreshUserProfilePreview)
});

window._bindUserProfileLive = function() {
  ['settingUPRisk', 'settingUPHorizon', 'settingUPAllowEquity',
   'settingUPPreference', 'settingUPBlacklist',
   'settingUPTargetReturn', 'settingUPMaxDrawdown'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', _refreshUserProfilePreview);
  });
  _refreshUserProfilePreview();
};

// ===== Supabase 同步 UI =====
function _renderSyncAuth() {
  const area = document.getElementById('syncAuthArea');
  if (!area) return;
  if (!Core.Sync) { area.innerHTML = '⚠ Core.Sync 未加载'; return; }
  const status = Core.Sync.getStatus();
  if (!status.configured) {
    area.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">先填 Project URL 和 anon key 然后 [保存]</span>';
    return;
  }
  if (status.loggedIn) {
    area.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="color:var(--up);">✓ 已登录: ${escapeHtml(status.email)}</span>
        <button class="btn btn-sm" onclick="syncSignOut()">登出</button>
      </div>
    `;
  } else {
    area.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input type="email" id="syncEmail" placeholder="邮箱" style="width:180px;">
        <input type="password" id="syncPwd" placeholder="密码 (≥6位)" style="width:140px;">
        <button class="btn btn-sm btn-primary" onclick="syncSignIn()">登录</button>
        <button class="btn btn-sm" onclick="syncSignUp()">注册</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
        注册会发验证邮件 (Supabase 默认); 可在 Supabase Auth 设置里关掉确认
      </div>
    `;
  }
}

window.syncSignIn = async function() {
  const email = document.getElementById('syncEmail')?.value.trim();
  const pwd = document.getElementById('syncPwd')?.value;
  if (!email || !pwd) { toastError('填邮箱和密码'); return; }
  try {
    await Core.Sync.signIn(email, pwd);
    _renderSyncAuth();
  } catch (e) { toastError('登录失败: ' + e.message); }
};

window.syncSignUp = async function() {
  const email = document.getElementById('syncEmail')?.value.trim();
  const pwd = document.getElementById('syncPwd')?.value;
  if (!email || !pwd) { toastError('填邮箱和密码'); return; }
  if (pwd.length < 6) { toastError('密码 ≥ 6 位'); return; }
  try {
    await Core.Sync.signUp(email, pwd);
    _renderSyncAuth();
  } catch (e) { toastError('注册失败: ' + e.message); }
};

window.syncSignOut = async function() {
  await Core.Sync.signOut();
  _renderSyncAuth();
};

window.syncNow = async function() {
  const r = document.getElementById('syncResult');
  r.textContent = '⏳ 同步中 (8 张表)...';
  r.style.color = 'var(--text-muted)';
  try {
    const stats = await Core.Sync.fullSync();
    const tables = Object.entries(stats.tables)
      .map(([t, s]) => `${t}: ↑${s.pushed}↓${s.pulled}${s.error ? '✗' : ''}`)
      .join('  ');
    r.innerHTML = `✓ 同步完成: 推 ${stats.pushed} 条, 拉 ${stats.pulled} 条. ${tables}`;
    r.style.color = 'var(--up)';
    toastSuccess('同步完成');
  } catch (e) {
    r.textContent = '✗ 失败: ' + e.message;
    r.style.color = 'var(--down)';
    toastError('同步失败: ' + e.message);
  }
};

window.syncPushOnly = async function() {
  const r = document.getElementById('syncResult');
  r.textContent = '⏳ 推送中...';
  try {
    const stats = await Core.Sync.pushOnly();
    r.innerHTML = `✓ 推送 ${stats.pushed} 条`;
    r.style.color = 'var(--up)';
  } catch (e) {
    r.textContent = '✗ ' + e.message;
    r.style.color = 'var(--down)';
  }
};

window.syncPullOnly = async function() {
  const r = document.getElementById('syncResult');
  r.textContent = '⏳ 拉取中...';
  try {
    const stats = await Core.Sync.pullOnly();
    r.innerHTML = `✓ 拉取 ${stats.pulled} 条 (本地数据已被覆盖, 刷新页面看新数据)`;
    r.style.color = 'var(--up)';
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    r.textContent = '✗ ' + e.message;
    r.style.color = 'var(--down)';
  }
};

window.clearAllData = async function() {
  if (!confirm('确定清空所有数据?持仓/复盘/自选/提醒/缓存全部清空,不可恢复!')) return;
  await Core.Storage.clearAll();
  toastSuccess('已清空,刷新页面...');
  setTimeout(() => location.reload(), 1000);
};

window.exportData = async function() {
  const data = {
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    // 8 张业务表
    watchlist: await Core.Storage.all('watchlist'),
    holdings: await Core.Storage.all('holdings'),
    transactions: await Core.Storage.all('transactions'),
    journals: await Core.Storage.all('journals'),
    alerts: await Core.Storage.all('alerts'),
    funds: await Core.Storage.all('funds'),
    cashflow: await Core.Storage.all('cashflow'),
    // state 关键配置 (不含 API key, 仅同步 proxyBase / accountCash / ai.useProxy 等)
    state: {
      proxyBase: Core.State.get('proxyBase'),
      accountCash: Core.State.get('accountCash')
    }
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stockmaster-backup-${fmtDate(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toastSuccess('已导出 (含 8 张表 + 状态)');
};

/**
 * 导出今日快照 (轻量版, 给 scripts/daily_summary.mjs 用)
 * 格式: { date, totalValue, cash, stockValue, fundValue, holdings, funds, cashflow }
 */
window.exportTodaySnapshot = async function() {
  const today = new Date().toISOString().slice(0, 10);
  const cash = parseFloat(Core.State.get('accountCash')) || 0;

  const [holdings, funds, flow] = await Promise.all([
    // 排除模拟盘 (isPaper) 行, 快照总资产只算真实持仓
    Core.Storage.all('holdings').then(list => (list || []).filter(h => !h.isPaper)),
    Core.Storage.all('funds'),
    Core.Storage.all('cashflow')
  ]);

  // 拉实时价 (并行, 失败降级)
  const stockQuotes = {};
  await Promise.all(holdings.map(async h => {
    try { const q = await Core.Data.getStockQuote(h.code); if (q) stockQuotes[h.code] = parseFloat(q.最新价 ?? q.price ?? 0); } catch (e) { console.warn('[snapshot] 拉行情失败:', h.code, e); }
  }));
  const fundNavs = {};
  await Promise.all(funds.map(async f => {
    if (!f.shares || f.shares <= 0) return;
    try {
      const arr = await Core.Data.getFundSpot(f.code);
      if (Array.isArray(arr) && arr.length > 0) {
        const last = arr[arr.length - 1];
        const nav = parseFloat(last.单位净值 || last['单位净值'] || last.value);
        if (nav) fundNavs[f.code] = nav;
      }
    } catch (e) { console.warn('[snapshot] 拉净值失败:', f.code, e); }
  }));

  // 算
  let stockValue = 0, fundValue = 0;
  const hOut = holdings.map(h => {
    const shares = parseFloat(h.shares) || 0;
    const cost = parseFloat(h.cost) || 0;
    const price = stockQuotes[h.code] || 0;
    const marketValue = shares * price;
    const costTotal = shares * cost;
    const pl = marketValue - costTotal;
    const plPct = costTotal > 0 ? pl / costTotal : 0;
    stockValue += marketValue;
    return {
      code: h.code, name: h.name,
      shares, cost, currentPrice: price,
      marketValue, profitLoss: pl, profitLossPct: plPct
    };
  }).filter(x => x.shares > 0);

  const fOut = funds.map(f => {
    const shares = parseFloat(f.shares) || 0;
    const costNav = parseFloat(f.costNav) || 0;
    const nav = fundNavs[f.code] || 0;
    const marketValue = shares * nav;
    const costTotal = shares * costNav;
    const pl = marketValue - costTotal;
    fundValue += marketValue;
    return {
      code: f.code, name: f.name, type: f.type,
      shares, costNav, currentNav: nav,
      marketValue, profitLoss: pl
    };
  }).filter(x => x.shares > 0);

  const cOut = (flow || []).filter(c => c.date === today).map(c => ({
    date: c.date, type: c.type, amount: c.amount, target: c.target, note: c.note
  }));

  const data = {
    date: today,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    totalValue: cash + stockValue + fundValue,
    cash, stockValue, fundValue,
    holdings: hOut,
    funds: fOut,
    cashflow: cOut
  };

  const fname = `daily_snapshot_${today.replace(/-/g, '')}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  a.click();
  URL.revokeObjectURL(url);
  toastSuccess(`已导出 ${fname} (持仓 ${hOut.length} 股票 + ${fOut.length} 基金, 操作 ${cOut.length} 笔)`);
  return data;
};

window.importData = function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm(`将导入 ${file.name}, 会覆盖本地所有数据。继续？`)) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      let totalCount = 0;
      for (const table of ['watchlist', 'holdings', 'transactions', 'journals', 'alerts', 'funds', 'cashflow']) {
        if (Array.isArray(data[table])) {
          await Core.Storage.clear(table);
          for (const item of data[table]) {
            await Core.Storage.add(table, item);
          }
          totalCount += data[table].length;
        }
      }
      // 还原 state (不含 API key)
      if (data.state) {
        if (typeof data.state.proxyBase === 'string') Core.State.set('proxyBase', data.state.proxyBase);
        if (typeof data.state.accountCash === 'number') Core.State.set('accountCash', data.state.accountCash);
      }
      toastSuccess(`已导入 ${totalCount} 条记录, 刷新页面...`);
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      toastError('导入失败: ' + err.message);
    }
  };
  input.click();
};

// 设置页保存按钮
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('saveSettingsBtn');
  if (btn) btn.onclick = saveSettings;
});
