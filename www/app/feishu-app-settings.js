/**
 * V13 阶段 5.3 — 飞书设置页 UI
 *
 * 4 个输入框:
 *   - APP ID
 *   - APP Secret
 *   - 允许的 openId (逗号分隔)
 *   - 启用开关
 *
 * 数据落 Dexie kv (feishu_app_id / feishu_app_secret / feishu_allowed_open_ids / feishu_enabled),
 * 通过 electronAPI.feishuSetCreds 推到主进程 (主进程据此启停飞书).
 */
(function () {
  'use strict';

  const KV_KEYS = {
    appId: 'feishu_app_id',
    appSecret: 'feishu_app_secret',
    allowedOpenIds: 'feishu_allowed_open_ids',
    enabled: 'feishu_enabled'
  };

  function _esc(s) {
    if (s === null || s === undefined) return '';
    // 复用 Core.Util.escapeHtml 防 XSS (项目统一函数, 见 www/core/util.js)
    if (window.Core && Core.Util && Core.Util.escapeHtml) return Core.Util.escapeHtml(String(s));
    // 兜底: 内联实现 (Core.Util 还没加载的极端情况)
    return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  async function _load() {
    return {
      appId: (await Core.Storage.kvGet(KV_KEYS.appId)) || '',
      appSecret: (await Core.Storage.kvGet(KV_KEYS.appSecret)) || '',
      allowedOpenIds: (await Core.Storage.kvGet(KV_KEYS.allowedOpenIds)) || [],
      enabled: (await Core.Storage.kvGet(KV_KEYS.enabled)) !== false
    };
  }

  async function _getLlmConfig() {
    try {
      const ai = await Core.Storage.kvGet('state_ai');
      if (ai) return { provider: ai.provider || 'deepseek', apiKey: ai.apiKey || (ai.localEndpoint ? ai.localEndpoint.apiKey : '') || '', model: ai.model || '' };
    } catch (e) { /* kv 读失败忽略 */ }
    return { provider: 'deepseek', apiKey: '', model: '' };
  }

  async function _save(cfg) {
    await Core.Storage.kvSet(KV_KEYS.appId, cfg.appId || '');
    await Core.Storage.kvSet(KV_KEYS.appSecret, cfg.appSecret || '');
    await Core.Storage.kvSet(KV_KEYS.allowedOpenIds, cfg.allowedOpenIds || []);
    await Core.Storage.kvSet(KV_KEYS.enabled, !!cfg.enabled);
    // 推送到主进程 (主进程据 ipc 重启飞书)
    if (window.electronAPI && window.electronAPI.feishuSetCreds) {
      try {
        const llmConfig = await _getLlmConfig();
        await window.electronAPI.feishuSetCreds({
          appId: cfg.appId || '',
          appSecret: cfg.appSecret || '',
          allowedOpenIds: cfg.allowedOpenIds || [],
          enabled: !!cfg.enabled,
          llmConfig
        });
      } catch (e) {
        console.warn('[FeishuSettings] 推送到主进程失败:', e.message);
      }
    }
  }

  function _render(container) {
    if (!container) return;
    container.innerHTML = `
      <div class="feishu-settings">
        <h3>📱 飞书机器人绑定 (V13)</h3>
        <p class="hint">在飞书后台创建"企业自建应用", 拿到 APP_ID 和 APP_SECRET, 填到这里, 桌面端管家就能收到你的飞书消息并回复.</p>
        <table class="kv-table">
          <tr>
            <td><label for="feishu-app-id">APP ID</label></td>
            <td><input id="feishu-app-id" type="text" placeholder="cli_xxxxxxxx" autocomplete="off"></td>
          </tr>
          <tr>
            <td><label for="feishu-app-secret">APP SECRET</label></td>
            <td><input id="feishu-app-secret" type="password" placeholder="(保密)" autocomplete="off"></td>
          </tr>
          <tr>
            <td><label for="feishu-allow-list">允许的 openId</label></td>
            <td>
              <input id="feishu-allow-list" type="text" placeholder="ou_aaa,ou_bbb (逗号分隔, 留空=不限制)" autocomplete="off">
              <div class="hint" style="font-size:11px;margin-top:4px">首次跟机器人互动后, 在飞书后台"消息接收记录"里能看到自己的 open_id</div>
            </td>
          </tr>
          <tr>
            <td><label for="feishu-enabled">启用</label></td>
            <td><input id="feishu-enabled" type="checkbox"> <span class="hint" style="font-size:12px">勾选后飞书机器人长连启动</span></td>
          </tr>
        </table>
        <div style="margin-top:12px">
          <button id="feishu-save-btn" class="btn-primary">💾 保存</button>
          <button id="feishu-test-btn" class="btn-secondary">📡 测试连接</button>
          <span id="feishu-status" style="margin-left:12px;font-size:12px;color:#666"></span>
        </div>
        <div class="hint" style="margin-top:12px;font-size:11px">
          ⚙️ 凭证会跟着 SettingsSync 跨设备同步; 主进程通过 WebSocket 长连到飞书 (<code>wss://open.feishu.cn</code>), 不需要公网入口.
        </div>
      </div>
    `;

    // 加载现有值
    _load().then(cfg => {
      const $id = document.getElementById('feishu-app-id');
      const $secret = document.getElementById('feishu-app-secret');
      const $allow = document.getElementById('feishu-allow-list');
      const $enabled = document.getElementById('feishu-enabled');
      if ($id) $id.value = cfg.appId;
      if ($secret) $secret.value = cfg.appSecret;
      if ($allow) $allow.value = (cfg.allowedOpenIds || []).join(',');
      if ($enabled) $enabled.checked = cfg.enabled;
    });

    // 保存按钮
    const saveBtn = document.getElementById('feishu-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const cfg = {
          appId: (document.getElementById('feishu-app-id') || {}).value || '',
          appSecret: (document.getElementById('feishu-app-secret') || {}).value || '',
          allowedOpenIds: ((document.getElementById('feishu-allow-list') || {}).value || '')
            .split(',').map(s => s.trim()).filter(Boolean),
          enabled: (document.getElementById('feishu-enabled') || {}).checked
        };
        await _save(cfg);
        const $st = document.getElementById('feishu-status');
        if ($st) { $st.textContent = '✅ 已保存 (' + new Date().toLocaleTimeString() + ')'; $st.style.color = '#0a0'; }
        if (typeof Core.Toast !== 'undefined' && Core.Toast.show) Core.Toast.show('飞书凭证已保存');
      });
    }

    // 测试连接
    const testBtn = document.getElementById('feishu-test-btn');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const $st = document.getElementById('feishu-status');
        if ($st) { $st.textContent = '🔄 测试中...'; $st.style.color = '#666'; }
        if (window.electronAPI && window.electronAPI.feishuGetCreds) {
          const cur = await window.electronAPI.feishuGetCreds();
          if ($st) {
            $st.textContent = cur && cur.appId
              ? '✅ 主进程已收到凭证, appId=' + cur.appId.slice(0, 12) + '...'
              : '⚠️ 主进程尚未收到凭证';
            $st.style.color = cur && cur.appId ? '#0a0' : '#a60';
          }
        }
      });
    }
  }

  function init() {
    // 启动时把本地凭证推给主进程 (主进程早期 IPC handler 已注册)
    _load().then(cfg => {
      if (window.electronAPI && window.electronAPI.feishuSetCreds) {
        _getLlmConfig().then(llmConfig => {
          window.electronAPI.feishuSetCreds({
            appId: cfg.appId,
            appSecret: cfg.appSecret,
            allowedOpenIds: cfg.allowedOpenIds,
            enabled: cfg.enabled,
            llmConfig
          }).catch(() => {});
        });
      }
    });
  }

  // 暴露给 app.js 在设置页挂载
  window.Core = window.Core || {};
  window.Core.FeishuSettings = { render: _render, load: _load, save: _save, init };
})();