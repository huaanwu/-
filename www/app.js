/**
 * StockMaster - 主入口
 * 挂全局兼容层 + 初始化
 */

var APP_VERSION = 'v0.1.0';
var APP_BUILD_DATE = '2026-07-26';

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
    if (window.Journal && Journal.init) Journal.init();
    if (window.Screener && Screener.init) Screener.init();
    if (window.Fund && Fund.init) Fund.init();
    if (window.Backtest && Backtest.init) Backtest.init();
    if (window.Alerts && Alerts.init) Alerts.init();

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
      <label>AKShare 代理地址</label>
      <input type="text" id="settingProxyBase" value="${escapeHtml(state.proxyBase)}"
             placeholder="/api/akshare 或 http://192.168.1.3:8089/api/akshare">
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
      <div style="font-size:12px;color:var(--text-muted);">
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
    const proxyURL = `/api/llm/${p}/v1`;
    if (!baseEl.value || baseEl.value.startsWith('/api/llm/')) {
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
    try { const q = await Core.Data.getStockQuote(h.code); if (q) stockQuotes[h.code] = parseFloat(q.最新价 ?? q.price ?? 0); } catch (e) {}
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
    } catch (e) {}
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
