/**
 * Alerts - 提醒/监控 (中长线盯盘改造)
 *
 * 双模式分层轮询:
 *   - 短线规则 (价格/涨跌幅/成交量, horizon='short'): 1 分钟轮询,
 *     只在存在启用的短线规则时才起定时器 (没有就不起, 省电省请求)
 *   - 中长线规则 (horizon='long'): 30 分钟调度 tick, 各规则按 nextCheck + 自身频率
 *     (再平衡=intervalDays / 财报日历=日频 / 业绩预告=周频 / 大盘趋势=日频 / 估值=双周频) 决定是否真跑
 *
 * 中长线规则类型:
 *   - rebalance_quarterly 季度再平衡 (已有)
 *   - earnings_disclosure 财报披露前 N 天 (Phase U, 已有)
 *   - earnings_warning    业绩预告异动 (预减/略减/首亏/续亏 命中实盘持仓, 周频, 全局一条)
 *   - regime_change       大盘趋势迁移 (Core.Regime 状态变化时通知, 日频, 全局一条)
 *   - valuation           大盘估值偏离 (指数 PE-TTM 近5年分位超阈值, 双周频, 全局一条)
 *
 * alert 行非索引字段: horizon / nextCheck / lastNotifiedKeys / lastState / lastNotifiedKey
 * 通知走 _notify/_notifyLong → _doNotify, 附"上次类似情境"复盘联动 (_fetchJournalContext)
 */
(function() {
  'use strict';

  // 短线规则类型 (1 分钟轮询); 其余一律中长线
  const SHORT_TYPES = ['price_above', 'price_below', 'change_above', 'change_below', 'volume_above'];

  // 全局规则 (不绑定个股代码, 全组合/全市场维度, 每类只需一条)
  const GLOBAL_TYPES = ['rebalance_quarterly', 'earnings_warning', 'regime_change', 'valuation'];

  // 全局规则的固定 code 值 (占位, 无实际含义)
  const GLOBAL_CODE = {
    rebalance_quarterly: 'funds',
    earnings_warning: 'holdings',
    regime_change: 'market',
    valuation: 'market'
  };

  // Regime 三态中文标签 (与 core/regime.js GATES 一致; 本地留一份兜底, vm 测试无 Core.Regime 也能跑)
  const REGIME_LABELS = { bull: '趋势市 🐂', range: '震荡市 ↔️', bear: '下跌市 ⚠' };

  const Alerts = {

    async init() {
      // Phase B-2: 监听 Core.Regime 状态切换 → 弹通知 + 写 alerts 行
      if (window.Core && Core.Regime && typeof Core.Regime.subscribe === 'function') {
        Core.Regime.subscribe(({ oldState, newState, rec }) => {
          this._onRegimeChange(oldState, newState, rec).catch(e =>
            console.warn('[Alerts] 处理 regime 切换失败:', e));
        });
      }
    },

    /**
     * Phase B-2: regime 状态切换处理
     * 读取用户配置 (默认 'deteriorate_only' = 只通知恶化, 即 bull/range → bear)
     * 命中则: 写一条 alerts 行 (active=true, type=regime_change, code='market', aiGenerated:true)
     *         + 弹系统通知 (toast + 浏览器 Notification)
     */
    async _onRegimeChange(oldState, newState, rec) {
      if (!oldState || !newState || oldState === newState) return;
      // 读用户偏好 (deteriorate_only / all)
      const mode = (await Core.Storage.kvGet('alerts_regime_watch_mode')) || 'deteriorate_only';
      const isDeteriorate = (newState === 'bear') && (oldState === 'bull' || oldState === 'range');
      if (mode === 'deteriorate_only' && !isDeteriorate) return;  // 用户要安静, 跳过

      const oldLabel = REGIME_LABELS[oldState] || oldState;
      const newLabel = REGIME_LABELS[newState] || newState;
      const since = rec && rec.since ? rec.since : new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const summary = `${oldLabel} → ${newLabel}`;
      const body = isDeteriorate
        ? `大盘进入下跌市, 中长线纪律: 检查单票集中度, 不主动加仓`
        : `大盘状态从 ${oldLabel} 切换到 ${newLabel}`;

      // 1) 写 alerts 行 (单一全局规则, 已存在则更新状态)
      const existing = await Core.Storage.where('alerts', 'type', 'regime_change');
      const data = {
        id: (existing && existing[0] && existing[0].id) || ('regime-' + Date.now()),
        code: 'market',
        name: '大盘趋势迁移',
        type: 'regime_change',
        active: true,
        triggered: true,
        hitCount: ((existing && existing[0] && existing[0].hitCount) || 0) + 1,
        lastHit: Date.now(),
        lastState: newState,
        lastNotifiedKey: oldState + '_' + newState + '_' + since,
        createdAt: (existing && existing[0] && existing[0].createdAt) || Date.now()
      };
      // 幂等: 同 (old → new @ since) 不重复通知
      if (existing && existing[0] && existing[0].lastNotifiedKey === data.lastNotifiedKey) return;
      await Core.Storage.put('alerts', data);

      // 2) 弹通知 (toast + 浏览器 Notification)
      if (window.toastWarning) toastWarning(`🌊 ${summary}\n${body}`, 8000);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('大盘状态切换', { body: `${summary} · ${body}` }); } catch (e) { /* ignore */ }
      }
    },

    /** 暴露用户偏好 getter 给 settings 页 (Alerts._getRegimeWatchMode / _setRegimeWatchMode) */
    async _getRegimeWatchMode() {
      return (await Core.Storage.kvGet('alerts_regime_watch_mode')) || 'deteriorate_only';
    },
    async _setRegimeWatchMode(mode) {
      if (!['deteriorate_only', 'all'].includes(mode)) throw new Error(`非法模式: ${mode}`);
      await Core.Storage.kvSet('alerts_regime_watch_mode', mode);
    },

    async render() {
      // 规则可能有增删/启停, 顺带同步分层定时器 (幂等, fire-and-forget)
      this._syncTimers().catch(e => console.warn('[Alerts] 定时器同步失败:', e));
      const list = await Core.Storage.all('alerts');
      const root = document.getElementById('alertsList');

      if (!list || list.length === 0) {
        root.innerHTML = `
          <div class="empty">
            <div class="empty-icon">🔔</div>
            <div>还没有提醒规则</div>
            <div style="margin-top:8px;font-size:12px;">中长线: 业绩预告/大盘趋势/估值/再平衡 · 短线: 价格/涨跌幅</div>
          </div>
        `;
        return;
      }

      // 按 active 排序,触发的放前面
      list.sort((a, b) => {
        if (a.triggered && !b.triggered) return -1;
        if (!a.triggered && b.triggered) return 1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

      root.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>代码</th><th>类型</th><th>条件</th><th>状态</th><th>触发次数</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(a => `
              <tr>
                <td><span class="code">${escapeHtml(a.code)}</span><br><span style="color:var(--text-muted);font-size:11px;">${escapeHtml(a.name || '')}</span></td>
                <td>${this._typeLabel(a.type)}<br>${this._horizonBadge(a.type)}</td>
                <td>${this._conditionLabel(a)}</td>
                <td>
                  ${a.triggered
                    ? '<span class="tag down">已触发</span>'
                    : (a.active ? '<span class="tag up">监控中</span>' : '<span class="tag">已暂停</span>')}
                </td>
                <td>${a.hitCount || 0}</td>
                <td>
                  <button class="btn btn-sm" title="AI 解读这条规则" onclick="Alerts._aiInterpretForRule('${a.id}')">🪄</button>
                  <button class="btn btn-sm" onclick="Alerts.toggle('${a.id}')">${a.active ? '⏸' : '▶'}</button>
                  <button class="btn btn-sm" onclick="Alerts.remove('${a.id}')">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    },

    /**
     * 规则打标: 'short' (价格/涨跌幅/成交量, 1 分钟轮询) | 'long' (其余, 低频调度)
     * 运行时一律按 type 分类, 不依赖行上存的 horizon 字段 (老数据兼容)
     */
    _horizonOf(type) {
      return SHORT_TYPES.includes(type) ? 'short' : 'long';
    },

    _horizonBadge(type) {
      return this._horizonOf(type) === 'short'
        ? '<span class="tag">⚡短线</span>'
        : '<span class="tag up">📅中长线</span>';
    },

    /** 类型名归一: B 阶段占位用的 valuation_drift 并入 valuation */
    _normType(t) {
      return t === 'valuation_drift' ? 'valuation' : t;
    },

    _isGlobalType(t) {
      return GLOBAL_TYPES.includes(this._normType(t));
    },

    _typeLabel(t) {
      return {
        price_above: '价格 ≥',
        price_below: '价格 ≤',
        change_above: '涨幅 ≥',
        change_below: '跌幅 ≥',
        volume_above: '成交 ≥',
        rebalance_quarterly: '季度再平衡',
        earnings_disclosure: '📅 财报披露',
        earnings_warning: '⚠️ 业绩预告异动',
        valuation: '📈 估值偏离',
        valuation_drift: '📈 估值偏离',  // B 阶段占位类型名, 兼容老行
        regime_change: '🌊 大盘状态切换'
      }[t] || t;
    },

    _conditionLabel(a) {
      switch (this._normType(a.type)) {
        case 'price_above':
        case 'price_below':
        case 'volume_above':
          return a.value;
        case 'change_above':
        case 'change_below':
          return a.value + '%';
        case 'rebalance_quarterly':
          return (a.intervalDays || 90) + ' 天';
        case 'earnings_disclosure':
          return '提前 ' + (a.leadDays ?? 3) + ' 天';
        case 'earnings_warning':
          return '每周 · 实盘持仓';
        case 'regime_change':
          return '每日 · 状态迁移';
        case 'valuation':
          return '双周 · PE分位≥' + Core.Constants.VALUATION_PERCENTILE_WARN + '%';
      }
      return a.value;
    },

    addDialog() {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Alerts.closeModal()">
          <div class="modal">
            <h3>新建提醒</h3>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.6;">
              💡 中长线持仓(3-12 个月)推荐上方"基本面/大盘"规则,低频检查足够覆盖<br>
              ⚡ 短线场景再选下方的"价格/涨跌幅"
            </div>
            <div class="form-row">
              <label>股票代码</label>
              <input type="text" id="alCode" placeholder="600519" autofocus>
            </div>
            <div class="form-row">
              <label>名称</label>
              <input type="text" id="alName" placeholder="可选">
            </div>
            <div class="form-row">
              <label>类型</label>
              <select id="alType" onchange="Alerts._onTypeChange()">
                <optgroup label="📅 中长线(基本面/大盘)">
                  <option value="earnings_disclosure">📅 财报披露前 N 天</option>
                  <option value="earnings_warning">⚠️ 业绩预告异动(每周·实盘持仓)</option>
                  <option value="regime_change">🌊 大盘状态切换(每日)</option>
                  <option value="valuation">📈 估值偏离(双周·指数PE分位)</option>
                  <option value="rebalance_quarterly">季度再平衡(基金)</option>
                </optgroup>
                <optgroup label="⚡ 短线(价格/涨跌幅)">
                  <option value="price_above">价格突破(≥)</option>
                  <option value="price_below">价格跌破(≤)</option>
                  <option value="change_above">涨幅达到(≥)</option>
                  <option value="change_below">跌幅达到(≥)</option>
                  <option value="volume_above">成交量异常(≥)</option>
                </optgroup>
              </select>
            </div>
            <div id="alHorizonHint" style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.6;"></div>
            <div class="form-row" id="alValueRow">
              <label>阈值</label>
              <input type="number" id="alValue" step="0.01" placeholder="例: 1700 或 5">
              <span id="alUnit" style="font-size:11px;color:var(--text-muted);">元</span>
            </div>
            <div class="form-row" id="alLeadDaysRow" style="display:none;">
              <label>提前天数</label>
              <input type="number" id="alLeadDays" step="1" value="3" min="1" max="30">
              <span style="font-size:11px;color:var(--text-muted);">披露日前 N 天提醒 (默认 3)</span>
            </div>
            <div class="form-row" id="alIntervalRow" style="display:none;">
              <label>提醒周期(天)</label>
              <input type="number" id="alInterval" step="1" value="90" placeholder="90 = 季度">
            </div>
            <div id="alRebalanceTarget" style="display:none;font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.6;">
              💡 季度再平衡: 每 N 天检查一次当前基金配置,<br>
              偏离目标 >5% 时通知你"卖 X 买 Y"。<br>
              目标配置从 Fund tab 的 type 字段自动读(short_bond=20% / pure_bond=80%)。
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
              💡 短线规则每 1 分钟检查(有启用的短线规则才轮询);<br>
              中长线规则按各自周期低频检查(浏览器必须打开)。<br>
              Android 上可配合 Capacitor Local Notifications 推系统通知。
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Alerts.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Alerts.save()">保存</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
      // 默认选中第一个选项(财报披露) — 中长线优先
      const sel = document.getElementById('alType');
      if (sel) sel.value = 'earnings_disclosure';
      this._onTypeChange();
    },

    /**
     * 一键创建季度再平衡 (默认 90 天, 目标配置从 Fund type 自动读)
     */
    async createRebalanceQuick() {
      const rebalanceId = 'rebalance_quarterly';
      const existing = await Core.Storage.where('alerts', 'type', rebalanceId);
      if (existing && existing.length > 0) {
        toastWarning('已存在再平衡提醒, 删了再建');
        return;
      }
      const data = {
        id: 'rebalance-' + Date.now(),
        code: 'funds',
        name: '基金季度再平衡',
        type: rebalanceId,
        horizon: 'long',
        intervalDays: 90,
        nextCheck: Date.now(),  // 立刻提醒一次 (用户能马上看到通知效果)
        active: true,
        hitCount: 0,
        triggered: false,
        createdAt: Date.now()
      };
      await Core.Storage.add('alerts', data);
      toastSuccess('已创建: 每 90 天检查基金配置偏离');
      this.render();
      // 立刻跑一轮中长线检查 (nextCheck=now, 马上给反馈)
      this._checkLong().catch(e => console.warn('[Alerts] 再平衡首检失败:', e));
    },

    _onTypeChange() {
      const t = document.getElementById('alType').value;
      const unit = {
        price_above: '元', price_below: '元',
        change_above: '%', change_below: '%',
        volume_above: '手'
      }[t] || '';
      const el = document.getElementById('alUnit');
      if (el) el.textContent = unit;

      // 切换 row 显示
      const isRebalance = t === 'rebalance_quarterly';
      const isEarnings = t === 'earnings_disclosure';  // Phase U
      const isGlobal = this._isGlobalType(t);          // 全局规则不绑定个股
      const valRow = document.getElementById('alValueRow');
      const intRow = document.getElementById('alIntervalRow');
      const leadRow = document.getElementById('alLeadDaysRow');  // Phase U
      const hint = document.getElementById('alRebalanceTarget');
      if (valRow) valRow.style.display = (isGlobal || isEarnings) ? 'none' : '';
      if (intRow) intRow.style.display = isRebalance ? '' : 'none';
      if (leadRow) leadRow.style.display = isEarnings ? '' : 'none';  // Phase U
      if (hint) hint.style.display = isRebalance ? '' : 'none';

      // 期限提示: 短线规则标"适合日内盯盘", 中长线规则说明检查频率/全局唯一
      const horizonHint = document.getElementById('alHorizonHint');
      if (horizonHint) {
        if (this._horizonOf(t) === 'short') {
          horizonHint.textContent = '⚡ 短线规则, 适合日内盯盘 (1 分钟轮询)';
        } else {
          const longHints = {
            earnings_disclosure: '📅 中长线规则: 日频检查, 披露日前 N 天通知',
            earnings_warning: '📅 中长线规则: 每周扫全市场业绩预告, 命中实盘持仓的预减/首亏等才通知 (全局只需一条)',
            regime_change: '📅 中长线规则: 每日比对大盘状态机 (趋势/震荡/下跌), 状态迁移时通知 (全局只需一条)',
            valuation: '📅 中长线规则: 双周看指数 PE-TTM 近5年分位, 偏贵时提示放缓建仓 (全局只需一条)',
            rebalance_quarterly: '📅 中长线规则: 按周期检查基金配置偏离'
          };
          horizonHint.textContent = longHints[this._normType(t)] || '📅 中长线规则, 低频检查';
        }
      }

      // 全局规则不需要代码
      const codeEl = document.getElementById('alCode');
      if (codeEl) {
        codeEl.disabled = isGlobal;
        if (isGlobal) codeEl.value = GLOBAL_CODE[this._normType(t)] || 'market';
      }
    },

    async save() {
      const type = document.getElementById('alType').value;
      const code = document.getElementById('alCode').value.trim();
      const name = document.getElementById('alName').value.trim();

      // 再平衡类型: 不需要 code/value, 用 intervalDays
      if (type === 'rebalance_quarterly') {
        const intervalDays = parseInt(document.getElementById('alInterval').value) || 90;
        if (intervalDays < 7) { toastError('周期最少 7 天'); return; }
        const data = {
          id: uuid(),
          code: 'funds', name: '基金季度再平衡',
          type, intervalDays,
          horizon: 'long',
          nextCheck: Date.now() + intervalDays * 24 * 60 * 60 * 1000,
          active: true,
          hitCount: 0,
          triggered: false,
          createdAt: Date.now()
        };
        await Core.Storage.add('alerts', data);
        this.closeModal();
        toastSuccess(`已添加: 每 ${intervalDays} 天提醒再平衡`);
        this.render();
        return;
      }

      // Phase U: 财报披露类型
      if (type === 'earnings_disclosure') {
        if (!code || !/^\d{6}$/.test(code)) { toastError('代码必须 6 位'); return; }
        const leadDays = parseInt(document.getElementById('alLeadDays').value) || 3;
        if (leadDays < 1 || leadDays > 30) { toastError('提前天数 1-30'); return; }
        const data = {
          id: uuid(),
          code, name, type, leadDays,
          horizon: 'long',
          active: true,
          hitCount: 0,
          triggered: false,
          _hitKey: null,  // 幂等 key, 同周期不重复触发
          createdAt: Date.now()
        };
        await Core.Storage.add('alerts', data);
        this.closeModal();
        toastSuccess(`已添加: ${name || code} 财报披露前 ${leadDays} 天提醒`);
        this.render();
        return;
      }

      // 中长线全局规则 (业绩预告异动 / 大盘状态切换 / 估值偏离):
      // 不绑定个股, 每类全局只需一条; 创建后立刻首检 (nextCheck=now) 让用户马上看到效果
      if (type === 'earnings_warning' || type === 'regime_change' || type === 'valuation' || type === 'valuation_drift') {
        const canonType = this._normType(type);
        // 唯一性: 同类型 (含 B 阶段占位名) 只允许一条
        const dup1 = await Core.Storage.where('alerts', 'type', canonType);
        const dup2 = canonType === 'valuation' ? await Core.Storage.where('alerts', 'type', 'valuation_drift') : [];
        if ((dup1 && dup1.length > 0) || (dup2 && dup2.length > 0)) {
          toastWarning('该规则全局只需一条, 已存在 (删了再建)');
          return;
        }
        const defaultNames = {
          earnings_warning: '业绩预告异动',
          regime_change: '大盘状态切换',
          valuation: '大盘估值偏离'
        };
        const data = {
          id: uuid(),
          code: GLOBAL_CODE[canonType] || 'market',
          name: name || defaultNames[canonType],
          type: canonType,
          horizon: 'long',
          nextCheck: Date.now(),       // 立刻首检
          active: true,
          hitCount: 0,
          triggered: false,
          lastNotifiedKeys: {},        // earnings_warning: code → `${报告期}_${预告类型}` 去重
          lastState: null,             // regime_change: 上次大盘状态
          lastNotifiedKey: null,       // valuation: 上次通知的分位 key
          createdAt: Date.now()
        };
        await Core.Storage.add('alerts', data);
        this.closeModal();
        toastSuccess(`已添加: ${data.name} (中长线, 低频检查)`);
        this.render();
        // 立刻跑一轮中长线检查 (首检反馈)
        this._checkLong().catch(e => console.warn('[Alerts] 中长线首检失败:', e));
        return;
      }

      const value = parseFloat(document.getElementById('alValue').value);
      if (!code || !/^\d{6}$/.test(code)) { toastError('代码必须 6 位'); return; }
      if (!value) { toastError('阈值必填'); return; }
      const data = {
        id: uuid(),
        code, name, type, value,
        horizon: 'short',
        active: true,
        hitCount: 0,
        triggered: false,
        createdAt: Date.now()
      };
      await Core.Storage.add('alerts', data);
      this.closeModal();
      toastSuccess('已添加');
      this.render();
    },

    async toggle(id) {
      const a = await Core.Storage.get('alerts', id);
      if (!a) return;
      a.active = !a.active;
      a.triggered = false;  // 重新激活时清触发态
      await Core.Storage.put('alerts', a);
      this.render();
    },

    async remove(id) {
      if (!confirm('确定删除此提醒?')) return;
      await Core.Storage.remove('alerts', id);
      toastSuccess('已删除');
      this.render();
    },

    // ==================== 分层轮询 ====================
    // 短线定时器: 1 分钟, 只在存在启用的短线规则时运行
    // 中长线定时器: 30 分钟调度 tick, 各规则按 nextCheck + 自身频率决定要不要真跑
    // 定时器工厂可注入 (测试可断言注册/清除次数)
    _timers: { short: null, long: null },
    _setInterval: (fn, ms) => setInterval(fn, ms),
    _clearInterval: (t) => clearInterval(t),

    /**
     * 启动轮询: 按当前规则表决定起哪些定时器
     */
    async startPolling() {
      await this._syncTimers();
    },

    stopPolling() {
      if (this._timers.short) { this._clearInterval(this._timers.short); this._timers.short = null; }
      if (this._timers.long) { this._clearInterval(this._timers.long); this._timers.long = null; }
    },

    /**
     * 定时器与规则表对齐 (幂等):
     *   有启用的短线规则 ↔ short 定时器在跑
     *   有启用的中长线规则 ↔ long 定时器在跑
     * save/toggle/remove 后经 render() 自动重同步
     */
    async _syncTimers() {
      let list = [];
      try {
        list = await Core.Storage.all('alerts');
      } catch (e) {
        console.warn('[Alerts] 读规则表失败, 定时器保持现状:', e);
        return;
      }
      const hasShort = (list || []).some(a => a.active && this._horizonOf(a.type) === 'short');
      const hasLong = (list || []).some(a => a.active && this._horizonOf(a.type) === 'long');

      if (hasShort && !this._timers.short) {
        this._timers.short = this._setInterval(
          () => this._checkShort().catch(e => console.warn('[Alerts] 短线检查失败:', e)),
          Core.Constants.ALERT_TICK_SHORT_MS
        );
      } else if (!hasShort && this._timers.short) {
        this._clearInterval(this._timers.short);
        this._timers.short = null;
      }

      if (hasLong && !this._timers.long) {
        this._timers.long = this._setInterval(
          () => this._checkLong().catch(e => console.warn('[Alerts] 中长线检查失败:', e)),
          Core.Constants.ALERT_TICK_LONG_MS
        );
      } else if (!hasLong && this._timers.long) {
        this._clearInterval(this._timers.long);
        this._timers.long = null;
      }
    },

    /**
     * 短线检查 (1 分钟轮询): 价格/涨跌幅/成交量, 行为与原 _check 的行情类一致
     */
    async _checkShort() {
      const list = await Core.Storage.where('alerts', 'active', true);
      const stockAlerts = (list || []).filter(a => this._horizonOf(a.type) === 'short');
      if (!stockAlerts.length) return;

      let spotMap = {};
      try {
        const all = await Core.Data.getStockSpot();
        all.forEach(s => { spotMap[s.代码] = s; });
      } catch (e) {
        console.warn('[Alerts] 行情拉取失败:', e);
        return;
      }
      for (const a of stockAlerts) {
        const s = spotMap[a.code];
        if (!s) continue;
        const price = parseFloat(s.最新价);
        const changePct = parseFloat(s.涨跌幅);
        const volume = parseFloat(s.成交量);
        let hit = false;
        switch (a.type) {
          case 'price_above': hit = price >= a.value; break;
          case 'price_below': hit = price <= a.value; break;
          case 'change_above': hit = changePct >= a.value; break;
          case 'change_below': hit = changePct <= -Math.abs(a.value); break;
          case 'volume_above': hit = volume >= a.value; break;
        }
        if (hit && !a.triggered) {
          a.triggered = true;
          a.hitCount = (a.hitCount || 0) + 1;
          a.lastHit = Date.now();
          await Core.Storage.put('alerts', a);
          this._notify(a, s);
        } else if (!hit && a.triggered) {
          a.triggered = false;
          await Core.Storage.put('alerts', a);
        }
      }
    },

    /**
     * 中长线调度 (30 分钟 tick): 遍历中长线规则, 到点 (nextCheck) 才真跑, 跑完按自身频率推进
     */
    async _checkLong() {
      const list = await Core.Storage.where('alerts', 'active', true);
      const longAlerts = (list || []).filter(a => this._horizonOf(a.type) === 'long');
      if (!longAlerts.length) return;

      for (const a of longAlerts) {
        if (!this._nextCheckDue(a, Date.now())) continue;
        const type = this._normType(a.type);
        try {
          if (type === 'rebalance_quarterly') {
            await this._runRebalanceCheck(a);
          } else if (type === 'earnings_disclosure') {
            await this._runEarningsDisclosureCheck(a);
            a.nextCheck = Date.now() + this._freqMs(a);
            await Core.Storage.put('alerts', a);
          } else if (type === 'earnings_warning') {
            const done = await this._checkEarningsWarning(a);
            if (done) {
              a.nextCheck = Date.now() + this._freqMs(a);
              await Core.Storage.put('alerts', a);
            }
          } else if (type === 'regime_change') {
            const done = await this._checkRegimeChange(a);
            if (done) {
              a.nextCheck = Date.now() + this._freqMs(a);
              await Core.Storage.put('alerts', a);
            }
          } else if (type === 'valuation') {
            const done = await this._checkValuation(a);
            if (done) {
              a.nextCheck = Date.now() + this._freqMs(a);
              await Core.Storage.put('alerts', a);
            }
          }
        } catch (e) {
          console.warn('[Alerts] 中长线规则检查失败:', a.type, e);
        }
      }
    },

    /** 到点判定: 无 nextCheck 视为到点 (老数据首跑) */
    _nextCheckDue(a, now) {
      if (a.type === 'rebalance_quarterly') {
        // 再平衡保留原有回退口径: nextCheck 缺失时用 createdAt + intervalDays
        const nc = a.nextCheck || ((a.createdAt || 0) + (a.intervalDays || 90) * 24 * 60 * 60 * 1000);
        return now >= nc;
      }
      return !a.nextCheck || now >= a.nextCheck;
    },

    /** 规则检查频率: 再平衡用行上 intervalDays, 其余走 Constants.ALERT_LONG_FREQ_MS */
    _freqMs(a) {
      if (a.intervalDays) return a.intervalDays * 24 * 60 * 60 * 1000;
      return Core.Constants.ALERT_LONG_FREQ_MS[this._normType(a.type)] || Core.Constants.ALERT_TICK_LONG_MS;
    },

    /** 再平衡检查 (原 _check 第 3 段, 逻辑不变: 无论是否触发都推进 nextCheck) */
    async _runRebalanceCheck(a) {
      const drift = await this._computeRebalanceDrift();
      if (drift) {
        this._notifyRebalance(a, drift);
      } else {
        console.warn('[Alerts] 再平衡: 无基金数据或拉不到净值');
      }
      a.nextCheck = Date.now() + (a.intervalDays || 90) * 24 * 60 * 60 * 1000;
      a.hitCount = (a.hitCount || 0) + 1;
      a.lastHit = Date.now();
      await Core.Storage.put('alerts', a);
    },

    /** 财报日历检查 (原 _check 第 2 段, 逻辑不变) */
    async _runEarningsDisclosureCheck(a) {
      try {
        const next = await Core.Data.getStockNextDisclosure(a.code);
        if (!next || !next.noticeDate) return;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const notice = new Date(next.noticeDate); notice.setHours(0, 0, 0, 0);
        const daysLeft = Math.round((notice - today) / 86400000);
        // 触发条件: 距披露日 <= N 天 (默认 3), 且未触发过这次披露
        const leadDays = a.leadDays ?? 3;
        const shouldHit = daysLeft >= 0 && daysLeft <= leadDays;
        // 用 reportPeriod + noticeDate 做幂等 key, 同一披露周期只触发一次
        const hitKey = `${next.reportPeriod || ''}_${next.noticeDate}`;
        if (shouldHit && a._hitKey !== hitKey) {
          a.triggered = true;
          a._hitKey = hitKey;
          a.hitCount = (a.hitCount || 0) + 1;
          a.lastHit = Date.now();
          await Core.Storage.put('alerts', a);
          this._notifyEarnings(a, next, daysLeft);
        } else if (!shouldHit && a.triggered) {
          // 披露日已过, 重置 (等下一季度)
          a.triggered = false;
          a._hitKey = null;
          await Core.Storage.put('alerts', a);
        }
      } catch (e) {
        console.warn('[Alerts] 财报日历检查失败:', a.code, e);
      }
    },

    // ==================== 中长线规则: 业绩预告异动 (周频) ====================

    /**
     * 拉全市场最新业绩预告 (stock_yjyg_em, 走 Core.Data.fetch 6h 缓存, cache key 带日期防陈旧),
     * 过滤出实盘持仓 (!isPaper) 中的负面预告 (预减/略减/首亏/续亏) → 通知。
     * 去重: a.lastNotifiedKeys[code] = `${报告期}_${预告类型}`, 同 code 同报告期同类型只通知一次。
     * @returns {Promise<boolean>} true=本轮检查完成 (可推进 nextCheck); false=拉数失败 (下轮重试)
     */
    async _checkEarningsWarning(a) {
      // 实盘持仓代码集合
      const holdings = await Core.Storage.all('holdings');
      const codes = new Set(
        (holdings || [])
          .filter(h => !h.isPaper)
          .map(h => this._normalizeCode6(h.code))
          .filter(Boolean)
      );
      if (codes.size === 0) return true;  // 无实盘持仓, 算检查完成

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let rows;
      try {
        rows = await Core.Data.fetch(`alerts_yjyg_${today}`, 'stock_yjyg_em', {}, Core.Constants.ALERT_LONG_CACHE_TTL_MS);
      } catch (e) {
        console.warn('[Alerts] 业绩预告拉取失败, 下轮重试:', e);
        return false;
      }

      const hits = this._filterEarningsWarnings(rows, codes, Date.now());
      if (!a.lastNotifiedKeys || typeof a.lastNotifiedKeys !== 'object') a.lastNotifiedKeys = {};
      const notifiedHits = [];  // 本轮新通知的 hit, 用于 AI 归因 (异步, 不阻塞)
      let notified = 0;
      for (const h of hits) {
        const key = `${h.periodKey}_${h.type}`;
        // 同 code 同报告期同类型只通知一次 (数组存多 key: 同期"预减→首亏"修正公告是两条独立信号)
        const seen = a.lastNotifiedKeys[h.code];
        const seenArr = Array.isArray(seen) ? seen : (seen ? [seen] : []);
        if (seenArr.includes(key)) continue;
        seenArr.push(key);
        a.lastNotifiedKeys[h.code] = seenArr;
        notified++;
        notifiedHits.push(h);
        this._notifyLong(a, this._earningsWarningMsg(h), h.code);
      }
      if (notified > 0) {
        a.triggered = true;
        a.hitCount = (a.hitCount || 0) + notified;
        a.lastHit = Date.now();
        // Phase B-1: 异步 AI 归因 (失败降级硬编码兜底, 不影响主通知)
        // 只取第一条 hit 写 aiNarrative (避免 AI 重复调用 + 弹窗读最近一条足够)
        const firstHit = notifiedHits[0];
        if (firstHit) {
          this._aiEarningsNarrative(a, firstHit).then(narrative => {
            console.log('[DEBUG-B1] .then 触发, narrative=', JSON.stringify(narrative).slice(0, 100));
            try {
              a.aiNarrative = narrative;
              a.aiNarrativeAt = Date.now();
              a.aiNarrativeHit = firstHit;
              Core.Storage.put('alerts', a).catch(e => console.warn('[Alerts] 写 aiNarrative 失败:', e));
            } catch (e) { console.warn('[Alerts] aiNarrative 落库失败:', e); }
          }).catch(e => console.warn('[Alerts] AI 归因 promise reject:', e));
        }
      }
      return true;
    },

    /**
     * 业绩预告过滤 (纯函数, 测试钩子):
     *   1) 预告类型在负面名单 (预减/略减/首亏/续亏)
     *   2) 公告日期在新鲜度窗口内 (半年, 防 aktools 历史回填)
     *   3) 代码命中实盘持仓
     * @param {Array} rows stock_yjyg_em 返回
     * @param {Set<string>} codes 实盘持仓 6 位代码
     * @param {number} nowMs 当前时间 (注入便于测试)
     * @returns {Array<{code,name,type,summary,periodKey}>}
     */
    _filterEarningsWarnings(rows, codes, nowMs) {
      if (!Array.isArray(rows) || !codes || codes.size === 0) return [];
      const negTypes = Core.Constants.EARNINGS_WARNING_NEGATIVE_TYPES;
      const freshCutoff = (nowMs || Date.now()) - Core.Constants.EARNINGS_WARNING_FRESH_MS;
      const out = [];
      for (const r of rows) {
        const type = String(r['业绩预告类型'] || r['预告类型'] || '');
        if (!negTypes.includes(type)) continue;
        // 公告日期新鲜度 (多字段名容错, 与 data.js Y1 防御一致; 无日期字段时放行, 由报告期去重兜底)
        const dStr = r['公告日期'] || r['最新公告日期'] || r['报告日期'] || r['发布日期'];
        if (dStr) {
          const ts = Date.parse(dStr);
          if (!isNaN(ts) && ts < freshCutoff) continue;
        }
        const code = this._normalizeCode6(r['股票代码'] || r.code);
        if (!code || !codes.has(code)) continue;
        out.push({
          code,
          name: String(r['股票简称'] || r.name || code),
          type,
          summary: String(r['业绩预告摘要'] || r.summary || ''),
          periodKey: this._yjygPeriodKey(r)
        });
      }
      return out;
    },

    /** 报告期 key (纯函数): 优先「报告期」字段, 缺失时退化为公告日期 (保证同批公告不重复) */
    _yjygPeriodKey(r) {
      const p = r['报告期'] || r['报告日期'];
      if (p) return String(p).slice(0, 10);
      const d = r['公告日期'] || r['最新公告日期'] || r['发布日期'];
      return d ? String(d).slice(0, 10) : 'unknown';
    },

    /** 6 位代码归一 (纯函数): 容忍 '600519' / 'SH600519' / '600519.SH' */
    _normalizeCode6(raw) {
      const m = String(raw == null ? '' : raw).match(/(\d{6})/);
      return m ? m[1] : null;
    },

    /** 业绩预告通知文案: 带归因 ("为什么应该关心") */
    _earningsWarningMsg(h) {
      let msg = `⚠️ ${h.name}(${h.code}) 业绩预告: ${h.type}`;
      if (h.summary) msg += `\n${h.summary.slice(0, 80)}`;
      msg += '\n💡 中长线持仓遇到业绩下修信号, 建议复核当初买入逻辑(业绩拐点/估值修复)是否仍成立, 再决定加仓/持有/减仓。';
      return msg;
    },

    /**
     * Phase B-1: AI 归因业绩预告 (异步, 不阻塞主通知; 失败 fallback 硬编码模板)
     * 把结果写到 a.aiNarrative 字段, 供 _aiInterpretForRule 弹窗读取
     */
    async _aiEarningsNarrative(a, h) {
      if (!window.Core || !Core.AI) return this._fallbackEarningsNarrative(h);
      const code = h.code;
      const tname = h.name || code;
      const summary = (h.summary || '').slice(0, 80);
      const systemPrompt = [
        '你是「业绩预告归因助手」, 给小白用户解释一条业绩下修信号意味着什么。',
        '- 100-200 字中文, 2 段: ⚡ 这条信号在说什么 / 📌 对中长线持仓的下一步动作',
        '- 不要推荐具体买卖金额, 只解释逻辑、优先级',
        '- 不要凭空举数字, 只引用用户实际数据 (代码/名称/预告类型/摘要)',
        '- 不知道就明说 "需要看更多数据", 不要编'
      ].join('\n');
      const prompt = `事件:
- 标的: ${code} (${tname})
- 预告类型: ${h.type}
- 摘要: ${summary || '(无)'}
- 报告期: ${h.periodKey}
请输出归因。`;

      try {
        const text = await Core.AI.call({ systemPrompt, prompt, stream: false, maxTokens: 400 });
        const narrative = String(text || '').trim();
        if (!narrative) return this._fallbackEarningsNarrative(h);
        return narrative;
      } catch (e) {
        console.warn('[Alerts] AI 业绩归因失败, 用硬编码兜底:', e.message || e);
        return this._fallbackEarningsNarrative(h);
      }
    },

    /** AI 失败兜底: 简单模板 (不调 AI) */
    _fallbackEarningsNarrative(h) {
      const t = h.type;
      const severity = ['首亏', '续亏', '增亏'].includes(t) ? '严重' :
                       ['略减', '预减'].includes(t) ? '中度' : '轻微';
      return `⚡ 业绩预告 ${t}, 信号强度 ${severity}。\n📌 中长线纪律: 看当初买入逻辑(业绩拐点/估值修复)是否仍成立, 再决定持有/减仓。`;
    },

    // ==================== 中长线规则: 大盘状态切换 (日频) ====================

    /**
     * 读 Core.Regime (refresh 内部每日去重), 与 a.lastState 对比, 状态迁移时通知。
     * 首次运行只记录基线, 不通知。
     * @returns {Promise<boolean>} true=检查完成; false=Regime 不可用 (下轮重试)
     */
    async _checkRegimeChange(a) {
      if (!window.Core || !Core.Regime) {
        console.warn('[Alerts] Core.Regime 不可用, 跳过大盘状态检查');
        return false;
      }
      let rec;
      try {
        rec = await Core.Regime.refresh();
      } catch (e) {
        console.warn('[Alerts] Regime 刷新失败, 下轮重试:', e);
        return false;
      }
      const cur = rec && rec.state;
      if (!cur) return false;

      if (a.lastState && a.lastState !== cur) {
        const text = this._regimeNotifyText(a.lastState, cur);
        if (text) this._notifyLong(a, text, null);
        a.triggered = true;
        a.hitCount = (a.hitCount || 0) + 1;
        a.lastHit = Date.now();
      }
      a.lastState = cur;
      return true;
    },

    /**
     * 大盘状态迁移文案 (纯函数, 测试钩子)
     * @returns {string|null} 非法状态返 null
     */
    _regimeNotifyText(fromState, toState) {
      const labels = (window.Core && Core.Regime && Core.Regime.GATES)
        ? Object.fromEntries(Object.entries(Core.Regime.GATES).map(([k, g]) => [k, `${g.label} ${g.icon}`]))
        : REGIME_LABELS;
      if (!labels[fromState] || !labels[toState]) return null;
      let msg = `🌊 大盘状态切换: ${labels[fromState]} → ${labels[toState]}`;
      if (toState === 'bear') {
        msg += '\n💡 沪深300 跌破 MA60 且趋势下行: 买入门槛已提高(回测 Sharpe 阈值上调/建议仓位减半), 中长线新建仓建议放缓, 已有持仓按各自止损纪律执行。';
      } else if (toState === 'bull') {
        msg += '\n💡 沪深300 站上 MA60 且均线上行: 建仓环境转暖, 可按纪律正常执行买入计划, 仍须过个股层面校验。';
      } else {
        msg += '\n💡 市场方向不明: 维持原计划, 不追涨不杀跌, 等趋势明朗再加大动作。';
      }
      return msg;
    },

    // ==================== 中长线规则: 估值偏离 (双周频) ====================

    /**
     * 指数 PE-TTM 近 5 年分位 ≥ 阈值 → 通知"市场整体偏贵, 与低估值买入逻辑相悖"。
     * 数据源: stock_market_pe_lg (与 data.js Phase M Tier 1 同一接口, 共享 ai_ctx_pe 缓存)。
     * 个股 PE 5 年分位无已验证数据源, 不做个股级 (宁缺毋假)。
     * 分位字段缺失 → 本轮静默跳过 (不通知), 只推进 nextCheck。
     * 去重: lastNotifiedKey = 超阈指数名列表, 离开阈值区后重新进入会再通知。
     * @returns {Promise<boolean>} true=检查完成; false=拉数失败 (下轮重试)
     */
    async _checkValuation(a) {
      let rows;
      try {
        // 复用 data.js 的 cache key 'ai_ctx_pe', 与 AI 上下文共享 6h 缓存
        rows = await Core.Data.fetch('ai_ctx_pe', 'stock_market_pe_lg', {}, Core.Constants.ALERT_LONG_CACHE_TTL_MS);
      } catch (e) {
        console.warn('[Alerts] 估值数据拉取失败, 下轮重试:', e);
        return false;
      }

      const verdict = this._judgeValuation(rows);
      if (!verdict) {
        // 分位数据不可用 → 宁缺毋假, 静默跳过
        console.warn('[Alerts] 估值分位数据不可用 (pe_percentile_5y 缺失), 本轮跳过');
        a.lastNotifiedKey = null;
        return true;
      }
      const key = verdict.hits.map(h => h.name).sort().join('+');
      if (verdict.hits.length > 0 && a.lastNotifiedKey !== key) {
        this._notifyLong(a, this._valuationMsg(verdict), null);
        a.triggered = true;
        a.hitCount = (a.hitCount || 0) + 1;
        a.lastHit = Date.now();
      }
      a.lastNotifiedKey = verdict.hits.length > 0 ? key : null;  // 跌回阈值下 → 清空, 下次进入再通知
      return true;
    },

    /**
     * 估值判定 (纯函数, 测试钩子):
     *   解析 stock_market_pe_lg 行 → 目标指数 → 分位 ≥ VALUATION_PERCENTILE_WARN 的为 hits
     * @returns {{hits: Array<{name,pe,percentile}>}|null} null=全部指数都拿不到分位 (数据不可用)
     */
    _judgeValuation(rows) {
      if (!Array.isArray(rows)) return null;
      const wanted = Core.Constants.VALUATION_INDEX_NAMES;
      const threshold = Core.Constants.VALUATION_PERCENTILE_WARN;
      const items = [];
      for (const row of rows) {
        const name = String(row.index_name || row.name || '').trim();
        if (!wanted.some(w => name.includes(w))) continue;
        const pe = parseFloat(row.pe_ttm || row.pe);
        const pct = parseFloat(row.pe_percentile_5y ?? row.percentile);
        if (isNaN(pe)) continue;
        items.push({ name, pe, percentile: isNaN(pct) ? null : pct });
      }
      if (items.length === 0) return null;
      if (items.every(it => it.percentile === null)) return null;  // 分位全缺 → 不可用
      const hits = items.filter(it => it.percentile !== null && it.percentile >= threshold);
      return { hits, items };
    },

    /** 估值偏离通知文案: 带归因 */
    _valuationMsg(verdict) {
      const lines = verdict.hits.map(h => `${h.name} PE-TTM ${h.pe.toFixed(1)} (近5年分位 ${Math.round(h.percentile)}%)`);
      return '📈 大盘估值偏离\n' + lines.join('\n') +
        `\n💡 分位 ≥ ${Core.Constants.VALUATION_PERCENTILE_WARN}% 说明市场整体偏贵, 与"低估值买入"逻辑相悖: 新建仓建议更挑剔(提高选股标准/缩小仓位), 已有持仓按各自逻辑持有, 不必因指数贵而单独卖出。`;
    },

    /**
     * 中长线通知统一入口: 拼大盘快照 + "上次类似情境"复盘上下文 (code 为 null 时跳过复盘)
     */
    _notifyLong(a, baseMsg, code) {
      Promise.all([
        this._fetchMarketInline(),
        code ? this._fetchJournalContext(code, a.type) : Promise.resolve(null)
      ]).then(([marketLine, journalLine]) => {
        let msg = baseMsg;
        if (marketLine) msg += `\n📊 ${marketLine}`;
        if (journalLine) msg += `\n${journalLine}`;
        this._doNotify(a, null, msg);
      }).catch(() => this._doNotify(a, null, baseMsg));
    },

    /**
     * Phase U: 财报披露提醒 (toast + 浏览器通知 + AI 上下文)
     */
    _notifyEarnings(a, next, daysLeft) {
      const code = a.code;
      const name = a.name || code;
      const period = next.reportPeriod || '本季度';
      const date = next.noticeDate;
      const title = `📅 ${name} 财报 ${daysLeft} 天后披露`;
      const body = `${period} 报告 (${date}), 请关注.`;
      if (window.toastInfo) toastInfo(`${title} · ${body}`);
      // 浏览器通知 (Phase U 拓展)
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification(title, { body }); } catch (e) { /* ignore */ }
      }
      // 触发后顺手拉一次财报历史 (Phase R 联动)
      Core.Data.getStockFinancialHistory(code).catch(e => { /* best effort */ });
    },

    /**
     * 计算基金组合的当前配置 vs 目标配置,返回偏离度详情
     * target: { type -> 目标占比 }  默认 { short_bond: 0.2, pure_bond: 0.8 }
     * 偏离阈值 5% 触发提醒
     */
    async _computeRebalanceDrift(targetRatio = { ...Core.Constants.REBALANCE_TARGET_DEFAULT }) {
      try {
        const funds = await Core.Storage.all('funds');
        const valid = funds.filter(f => f.shares > 0 && f.costNav > 0);
        if (valid.length === 0) return null;

        // 拉所有基金最新净值
        const rows = [];
        let total = 0;
        for (const f of valid) {
          let nav = f.costNav;  // fallback
          try {
            const data = await Core.Data.getFundSpot(f.code);
            if (Array.isArray(data) && data.length > 0) {
              const latest = data[data.length - 1];
              const v = parseFloat(latest.单位净值 || latest['单位净值'] || latest.value);
              if (v) nav = v;
            }
          } catch (e) {
            console.warn('[Alerts] 拉净值失败:', f.code, e);
          }
          const value = f.shares * nav;
          const type = f.type || 'other';
          rows.push({ code: f.code, name: f.name || f.code, type, value, nav, shares: f.shares });
          total += value;
        }

        // 按 type 聚合
        const current = {};
        for (const r of rows) {
          current[r.type] = (current[r.type] || 0) + r.value;
        }

        // 计算偏离
        const drift = { rows, total, current, target: targetRatio, items: [] };
        let maxDrift = 0;
        for (const [type, tgt] of Object.entries(targetRatio)) {
          const cur = current[type] || 0;
          const curPct = total > 0 ? cur / total : 0;
          const diff = curPct - tgt;
          maxDrift = Math.max(maxDrift, Math.abs(diff));
          drift.items.push({ type, target: tgt, current: curPct, diff });
        }
        drift.maxDrift = maxDrift;
        drift.shouldRebalance = maxDrift > Core.Constants.REBALANCE_DRIFT_THRESHOLD;  // 偏离 > 5% 触发

        return drift;
      } catch (e) {
        console.warn('[Alerts] 再平衡计算失败:', e);
        return null;
      }
    },

    _notifyRebalance(a, drift) {
      const totalStr = fmtMoney(drift.total);
      const driftPct = (drift.maxDrift * 100).toFixed(1);
      let body;
      if (drift.shouldRebalance) {
        body = `组合总额 ${totalStr}, 偏离 ${driftPct}% (阈值 5%)\n`;
        for (const it of drift.items) {
          const cur = (it.current * 100).toFixed(1);
          const tgt = (it.target * 100).toFixed(1);
          const diff = (it.diff * 100).toFixed(1);
          const sign = it.diff > 0 ? '+' : '';
          body += `  ${it.type}: 实际 ${cur}% / 目标 ${tgt}% (${sign}${diff}%)\n`;
        }
        body += '👉 建议: 卖超配的, 买欠配的, 回到 20/80';
      } else {
        body = `组合总额 ${totalStr}, 偏离 ${driftPct}% (在阈值 5% 内, 暂无需再平衡)`;
      }
      const title = drift.shouldRebalance ? '🔔 该再平衡了' : '✅ 基金配置正常';
      const fullMsg = `${title}\n${body}`;

      if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) {
        Capacitor.Plugins.LocalNotifications.schedule({
          notifications: [{
            id: Math.floor(Math.random() * 100000),
            title,
            body: body.replace(/\n/g, ' | '),
            schedule: { at: new Date(Date.now() + 100) }
          }]
        }).catch(e => console.warn('[Alerts] local notification failed:', e));
      }
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/icons/icon-192.png' });
      }
      toastWarning(fullMsg, 8000);
    },

    /**
     * 拉大盘快照 (用于通知 inline 显示)
     * 返回简短的 1-2 行字符串
     */
    async _fetchMarketInline() {
      if (!window.Core || !Core.Market) return null;
      try {
        const snap = await Core.Market.get('wide');
        if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) return null;
        // 选最重要的 3 个: 上证/深证/沪深300
        const pickCodes = ['上证指数', '深证成指', '沪深300'];
        const picked = snap.items.filter(it => pickCodes.some(c => (it.name || '').includes(c))).slice(0, 3);
        return picked.map(it => {
          const sign = it.change > 0 ? '+' : '';
          return `${it.name} ${it.price.toFixed(0)} ${sign}${it.change.toFixed(2)}%`;
        }).join(' · ');
      } catch (e) {
        return null;
      }
    },

    _notify(a, s) {
      const baseMsg = `${a.code} ${a.name || s.名称} 触发提醒:${this._typeLabel(a.type)} ${a.value}`;
      // 拉大盘 + 复盘上下文 (并行, 不阻塞通知, 异步附加)
      Promise.all([
        this._fetchMarketInline(),
        this._fetchJournalContext(a.code, a.type)
      ]).then(([marketLine, journalLine]) => {
        let msg = baseMsg;
        if (marketLine) msg += `\n📊 ${marketLine}`;
        if (journalLine) msg += `\n${journalLine}`;
        this._doNotify(a, s, msg);
      }).catch(() => this._doNotify(a, s, baseMsg));
    },

    /**
     * 5.1.2 + 5.2.3: 拉该代码最近 30 天的复盘历史, 拼成 1-2 行摘要附到提醒
     * 5.2.3 增强: 接受 alertType, 同时找 "相同 assumption 标签的旧复盘" 作为 "上次类似情境怎么处理的"
     *
     * 返回多行字符串:
     *   📓 复盘历史 (30天内):
     *     茅台加仓(2026-07-15) 跌了 5% 加仓...
     *   🔁 上次类似情境: 估值修复 + 长期持有中 → 赚了 12%
     *   或只返回前一段 (找不到类似情境)
     */
    async _fetchJournalContext(code, alertType) {
      try {
        if (!code || !window.Core || !Core.Storage) return null;
        const all = await Core.Storage.all('journals');
        const cutoff = Date.now() - 30 * 86400000;
        const inCutoff = (j) => {
          if (j.createdAt && j.createdAt >= cutoff) return true;
          if (j.date) {
            const d = new Date(j.date);
            if (!isNaN(d.getTime()) && d.getTime() >= cutoff) return true;
          }
          return false;
        };
        const sameCode = (all || []).filter(j => j.code && j.code === code && inCutoff(j));
        if (sameCode.length === 0) return null;

        // 按 createdAt 降序, 取最近 2 条
        const recent = sameCode
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, 2);
        const lines = recent.map(j => {
          const snippet = (j.content || '').replace(/\n+/g, ' ').slice(0, 60);
          return `${j.title || '(无标题)'}(${j.date || ''}) ${snippet}${(j.content || '').length > 60 ? '...' : ''}`;
        });
        let result = `📓 复盘历史 (30天内):\n  ${lines.join('\n  ')}`;

        // 5.2.3: 找"上次类似情境"——按 alertType 反推场景
        // 简单启发: 价格类提醒 → 找 assumption='技术突破' 或 '估值修复' 的旧复盘
        //          涨幅类提醒 → 找 assumption='题材催化' 或 '业绩拐点'
        //          跌涨幅类 → 找 emotion='恐慌割肉' 或 '计划内止损'
        const alertTagMap = {
          'price_above': ['技术突破', '估值修复'],
          'price_below': ['长期持有中', '其他'],  // 跌破: 看是否有"还拿着"的复盘
          'change_above': ['题材催化', '业绩拐点'],
          'change_below': ['恐慌割肉', '计划内止损', '长期持有中'],
          'volume_above': ['题材催化', '技术突破'],
          // 中长线: 业绩预告/财报披露 → 业绩类假设的复盘最有对照价值
          'earnings_warning': ['业绩拐点', '估值修复'],
          'earnings_disclosure': ['业绩拐点', '估值修复']
        };
        const wantAssumption = alertTagMap[alertType] || [];
        if (wantAssumption.length > 0) {
          // 找同代码 + 同 assumption 标签的旧复盘 (排除已 verify=verified 的)
          const similar = sameCode
            .filter(j => j.assumption && wantAssumption.includes(j.assumption))
            .filter(j => j.verify !== 'verified')  // 找还没验证的, 对比才有意义
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
          if (similar) {
            const snippet = (similar.content || '').replace(/\n+/g, ' ').slice(0, 50);
            const tagStr = [similar.assumption, similar.emotion].filter(Boolean).join(' + ');
            result += `\n🔁 上次类似情境 (${tagStr}): ${snippet}${(similar.content || '').length > 50 ? '...' : ''}`;
          }
        }
        return result;
      } catch (e) {
        console.warn('[Alerts] _fetchJournalContext 失败:', e);
        return null;
      }
    },

    _doNotify(a, s, msg) {
      // 浏览器通知
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification('StockMaster 提醒', { body: msg, icon: '/icons/icon-192.png' });
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission();
        }
      }
      // Capacitor Local Notifications(APK 环境)
      if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) {
        Capacitor.Plugins.LocalNotifications.schedule({
          notifications: [{
            id: Math.floor(Math.random() * 100000),
            title: 'StockMaster 提醒',
            body: msg,
            schedule: { at: new Date(Date.now() + 100) }
          }]
        }).catch(e => console.warn('[Alerts] local notification failed:', e));
      }
      // Toast 兜底
      toastWarning(msg, 5000);
    },

    closeModal() {
      document.getElementById('modalRoot').innerHTML = '';
    },

    // ==================== Phase AlertsAgent: AI 助手弹窗 ====================

    /**
     * AI 助手弹窗 (两阶段: 输入 → parseIntent → preview → 用户确认 → applyIntents)
     * 全部走 Core.AlertsAgent, AI 不直接写库
     */
    async aiAssistantDialog() {
      if (!window.Core || !Core.AlertsAgent) {
        toastError('AI 助手未加载, 请刷新页面');
        return;
      }
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Alerts.closeModal()">
          <div class="modal" style="max-width:640px;width:100%;">
            <h3>🤖 AI 盯盘助手</h3>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6;">
              用自然语言告诉 AI 你想盯什么, 它会先生成预览让你确认, 再写库。<br>
              例: 「给 600519 设个 1700 止盈」「跌 5% 提醒我」「把这条规则删了」
            </div>
            <div class="form-row">
              <label>你想做什么？</label>
              <textarea id="aaInput" rows="3" style="width:100%;resize:vertical;font-size:13px;"
                        placeholder="例: 600519 设个 1700 止盈提醒, 跌 5% 也加一个"></textarea>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
              <button class="btn" id="aaSendBtn" onclick="Alerts._aaRunParse()">✨ 让 AI 解析</button>
              <button class="btn btn-ghost btn-sm" onclick="Alerts._aaQuickFill()">📋 一键填充: 全部实盘加财报披露</button>
              <span id="aaStatus" style="font-size:12px;color:var(--text-muted);margin-left:auto;"></span>
            </div>
            <div id="aaPreview" style="margin-top:10px;"></div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Alerts.closeModal()">取消</button>
              <button class="btn btn-primary" id="aaApplyBtn" disabled onclick="Alerts._aaApply()">✅ 确认落库</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
      // 状态 (暂存 preview, 用户确认后传给 apply)
      this._aaLastIntents = null;
      const ta = document.getElementById('aaInput');
      if (ta) ta.focus();
    },

    /**
     * 一键填充: 把所有实盘持仓加一条 "财报披露前 3 天" 提醒
     * (Core.AlertsAgent.suggestForHoldings 纯逻辑, 不调 AI)
     */
    async _aaQuickFill() {
      if (!window.Core || !Core.AlertsAgent) return;
      const holdings = await Core.Storage.all('holdings');
      const specs = Core.AlertsAgent.suggestForHoldings(holdings || []);
      if (specs.length === 0) {
        toastWarning('当前没有实盘持仓, 无可推荐');
        return;
      }
      // 转成 intents (每条 create)
      const intents = specs.map(s => ({
        action: 'create',
        specs: s,
        reasoning: '实盘持仓默认加一条财报披露前 3 天提醒'
      }));
      this._aaLastIntents = intents;
      this._aaRenderPreview(intents);
      toastInfo(`已生成 ${specs.length} 条预览, 检查无误后点确认`);
    },

    /**
     * 跑 AI 解析用户输入 → preview
     */
    async _aaRunParse() {
      const btn = document.getElementById('aaSendBtn');
      const status = document.getElementById('aaStatus');
      const ta = document.getElementById('aaInput');
      if (!ta || !ta.value.trim()) {
        toastWarning('请先输入');
        return;
      }
      if (!window.Core || !Core.AlertsAgent || !Core.AI) {
        toastError('AI 未配置 (设置页 → AI 大模型)');
        return;
      }
      btn.disabled = true;
      if (status) status.textContent = '⏳ AI 解析中...';
      try {
        const holdings = await Core.Storage.all('holdings');
        const r = await Core.AlertsAgent.parseIntent(ta.value.trim(), {
          holdings: (holdings || []).map(h => ({ code: h.code, name: h.name, isPaper: h.isPaper }))
        });
        this._aaLastIntents = r.intents;
        this._aaRenderPreview(r.intents);
        if (status) status.textContent = `✅ ${r.intents.length} 条建议`;
      } catch (e) {
        if (status) status.textContent = '❌';
        toastError('AI 解析失败: ' + (e.message || e));
        console.warn('[Alerts] AI 助手解析失败:', e);
      } finally {
        btn.disabled = false;
      }
    },

    /**
     * 渲染预览 (list + checkbox 自动勾上 create/delete 的项)
     */
    _aaRenderPreview(intents) {
      const root = document.getElementById('aaPreview');
      const applyBtn = document.getElementById('aaApplyBtn');
      if (!root) return;
      const previews = Core.AlertsAgent.previewIntents(intents);
      if (previews.length === 0) {
        root.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">无预览</div>';
        if (applyBtn) applyBtn.disabled = true;
        return;
      }
      root.innerHTML = previews.map((p, i) => `
        <div style="padding:10px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;background:var(--bg-base);">
          <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;">
            <input type="checkbox" data-aa-idx="${i}" checked style="margin-top:3px;">
            <div style="flex:1;">
              <div style="font-weight:600;">${escapeHtml(p.title)}</div>
              <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${p.body || ''}</div>
            </div>
          </label>
        </div>
      `).join('');
      if (applyBtn) applyBtn.disabled = false;
    },

    /**
     * 用户点确认 → 收集勾选 → applyIntents → 刷新列表 → 关闭弹窗
     */
    async _aaApply() {
      const applyBtn = document.getElementById('aaApplyBtn');
      const status = document.getElementById('aaStatus');
      if (!this._aaLastIntents || this._aaLastIntents.length === 0) {
        toastWarning('没有待应用的规则');
        return;
      }
      // 收集勾选
      const checkedIdx = new Set(
        Array.from(document.querySelectorAll('#aaPreview input[type="checkbox"][data-aa-idx]'))
          .filter(cb => cb.checked)
          .map(cb => parseInt(cb.dataset.aaIdx, 10))
      );
      const intents = this._aaLastIntents.filter((_, i) => checkedIdx.has(i));
      if (intents.length === 0) {
        toastWarning('没勾选任何规则');
        return;
      }
      applyBtn.disabled = true;
      if (status) status.textContent = `⏳ 写入 ${intents.length} 条...`;
      try {
        const r = await Core.AlertsAgent.applyIntents(intents, { confirmed: true });
        toastSuccess(`已落库: 新建 ${r.written} / 删除 ${r.deleted}`);
        this.closeModal();
        this.render();
        // 短线新增时立刻同步分层定时器 (幂等)
        this._syncTimers().catch(e => console.warn('[Alerts] syncTimers 失败:', e));
      } catch (e) {
        toastError('落库失败: ' + (e.message || e));
        console.warn('[Alerts] AI 助手落库失败:', e);
        applyBtn.disabled = false;
        if (status) status.textContent = '❌';
      }
    },

    /**
     * 列表行 AI 解读按钮: 弹一个只读 modal, 显示 Core.AlertsAgent.interpretAlert 输出
     * 只读, 不改规则
     */
    async _aiInterpretForRule(id) {
      if (!window.Core || !Core.AlertsAgent) {
        toastError('AI 助手未加载');
        return;
      }
      const all = await Core.Storage.all('alerts');
      const a = all.find(x => x.id === id);
      if (!a) { toastError('找不到这条规则'); return; }
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Alerts.closeModal()">
          <div class="modal" style="max-width:600px;width:100%;">
            <h3>🪄 AI 解读这条规则</h3>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
              ${escapeHtml(a.code)} · ${this._typeLabel(a.type)} · ${escapeHtml(this._conditionLabel(a))}
              ${a.triggered ? ' · <span style="color:var(--down);">已触发 ' + (a.hitCount || 0) + ' 次</span>' : ''}
            </div>
            <div id="aiInterpBody" style="padding:14px;background:var(--bg-base);border-radius:6px;line-height:1.7;font-size:13px;min-height:80px;">
              ⏳ AI 解读中, 大约 10-30 秒...
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Alerts.closeModal()">关闭</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
      try {
        // 拉最近 3 条同 (code, type) 的触发历史 (自身之外, 作为 context)
        const history = all
          .filter(x => x.code === a.code && x.type === a.type && x.id !== a.id && x.lastHit)
          .sort((p, q) => (q.lastHit || 0) - (p.lastHit || 0))
          .slice(0, 3)
          .map(x => ({ 当天: new Date(x.lastHit).toISOString().slice(0, 10), 阈值: x.value || x.leadDays || x.intervalDays }));
        // 大盘状态 (Core.Regime 有就带, 没就 null)
        let regime = null;
        try {
          if (Core.Regime && typeof Core.Regime.get === 'function') {
            const r = await Core.Regime.get();
            if (r && r.state) regime = { state: r.state, label: (r.state === 'bull' ? '趋势市 🐂' : r.state === 'bear' ? '下跌市 ⚠' : '震荡市 ↔️') };
          }
        } catch (e) { /* regime 不可用不阻断 */ }
        const text = await Core.AlertsAgent.interpretAlert(a, { history, regime });
        const el = document.getElementById('aiInterpBody');
        if (el) {
          // Phase B-1: 业绩预告类规则若已有 aiNarrative (之前触发时 AI 写的), 优先显示 (避免重复调 AI)
          let body = '';
          if (a.type === 'earnings_warning' && a.aiNarrative) {
            body = '<div style="color:var(--accent);font-size:11px;margin-bottom:6px;">📌 触发时 AI 归因 (缓存):</div>'
              + escapeHtml(a.aiNarrative).replace(/\n/g, '<br>')
              + '<hr style="border:0;border-top:1px dashed var(--border);margin:12px 0;">'
              + '<div style="color:var(--accent);font-size:11px;margin-bottom:6px;">🤖 AI 重新解读:</div>'
              + escapeHtml(text).replace(/\n/g, '<br>');
          } else {
            body = escapeHtml(text).replace(/\n/g, '<br>');
          }
          el.innerHTML = body;
        }
      } catch (e) {
        const el = document.getElementById('aiInterpBody');
        if (el) el.textContent = '❌ ' + (e.message || e);
        console.warn('[Alerts] AI 解读失败:', e);
      }
    }
  };

  window.Alerts = Alerts;
  window._onShow_pageAlerts = function() { Alerts.render(); };

  // 启动分层轮询 (短线 1 分钟 / 中长线 30 分钟调度, 按需起定时器)
  document.addEventListener('DOMContentLoaded', () => {
    Alerts.startPolling().catch(e => console.warn('[Alerts] 启动轮询失败:', e));
  });
})();
