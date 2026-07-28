/**
 * StockMaster - 主入口
 * 挂全局兼容层 + 初始化
 */

var APP_VERSION = 'v0.1.0';
var APP_BUILD_DATE = '2026-07-26';
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

// ========== 启动 ==========
(async function init() {
  try {
    // 1. 初始化 DB
    await Core.Storage.init();
    console.log('[App] DB ready');

    // 2. 还原 state
    await Core.State.init();

    // 3. 市场状态
    updateMarketStatus();
    setInterval(updateMarketStatus, 60 * 1000);

    // 4. 健康检查(异步,不阻塞 UI)
    Core.Data.health().then(h => {
      if (!h.ok) {
        console.warn('[App] AKShare 代理不通:', h.error);
        // 不弹 toast,启动时太吵
      } else {
        console.log('[App] AKShare proxy ok');
      }
    });

    // 4b. 大盘状态机每日重算 (Z1 Phase A, 接管 Kimi 活)
    // 异步, 失败不阻塞 UI; 每日 1 次 by kv lastDate 去重
    if (window.Core && Core.Regime && Core.Regime.refresh) {
      Core.Regime.refresh().then(rec => {
        console.log('[App] 大盘状态:', rec.state, rec.snapshot ? `HS300 ${rec.snapshot.close} vs MA60 ${rec.snapshot.ma60}` : '(无 snapshot)');
      }).catch(e => console.warn('[App] Regime refresh 失败:', e && e.message || e));
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
    if (window.Journal && Journal.init) Journal.init();
    if (window.Screener && Screener.init) Screener.init();
    if (window.Fund && Fund.init) Fund.init();
    if (window.Backtest && Backtest.init) Backtest.init();
    if (window.Alerts && Alerts.init) Alerts.init();
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
    <div class="form-row" style="position:sticky;bottom:0;background:var(--bg-base);padding:12px 0;margin-top:8px;border-top:1px solid var(--border);z-index:10;">
      <label></label>
      <button class="btn btn-primary" id="saveSettingsBtn" onclick="saveSettings()">💾 保存所有设置</button>
      <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">填完所有改动后点这个一次保存</span>
    </div>
  `;
};

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
//       → 浏览器挨个 fetch {ip}:8089/health (dev-proxy 已加 CORS: *)
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
  // 探测每个候选: fetch {ip}:{port}/health (3s timeout)
  const port = info.port || 8089;
  const tasks = [...candidates].map(async (ip) => {
    const start = Date.now();
    const url = `http://${ip}:${port}/health`;
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
        const url = _apiUrl('/api/akshare/stock_zh_a_spot?symbol=000001');
        // aktools 真限流会卡很久, 8s 超时够了 (stock_zh_a_spot 正常 < 2s)
        const r = await _fetchWithTimeout(url, { cache: 'no-store' }, 8000);
        const t = await r.text();
        const ok = r.ok && t.length > 100 && t.trim().startsWith('[');
        return { ok, latencyMs: Date.now() - start, detail: 'GET ' + url + ' → HTTP ' + r.status + (t.length > 200 ? `, ${t.length} bytes` : `, ${t.slice(0, 80)}`) };
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
  if (h.ok) {
    el.textContent = '✓ 代理正常';
    el.style.color = 'var(--down)';
  } else {
    el.textContent = '✗ ' + h.error;
    el.style.color = 'var(--up)';
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

  if (!silent) toastSuccess('已保存');
  _renderSyncAuth();
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
