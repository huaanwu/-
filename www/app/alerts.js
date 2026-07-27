/**
 * Alerts - 提醒/监控
 * 价格/涨跌幅提醒,使用浏览器通知 / Capacitor Local Notifications
 */
(function() {
  'use strict';

  const Alerts = {

    async init() {},

    async render() {
      const list = await Core.Storage.all('alerts');
      const root = document.getElementById('alertsList');

      if (!list || list.length === 0) {
        root.innerHTML = `
          <div class="empty">
            <div class="empty-icon">🔔</div>
            <div>还没有提醒规则</div>
            <div style="margin-top:8px;font-size:12px;">价格破位/涨跌幅到位时弹通知</div>
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
                <td>${this._typeLabel(a.type)}</td>
                <td>${this._conditionLabel(a)}</td>
                <td>
                  ${a.triggered
                    ? '<span class="tag down">已触发</span>'
                    : (a.active ? '<span class="tag up">监控中</span>' : '<span class="tag">已暂停</span>')}
                </td>
                <td>${a.hitCount || 0}</td>
                <td>
                  <button class="btn btn-sm" onclick="Alerts.toggle('${a.id}')">${a.active ? '⏸' : '▶'}</button>
                  <button class="btn btn-sm" onclick="Alerts.remove('${a.id}')">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    },

    _typeLabel(t) {
      return {
        price_above: '价格 ≥',
        price_below: '价格 ≤',
        change_above: '涨幅 ≥',
        change_below: '跌幅 ≥',
        volume_above: '成交 ≥',
        rebalance_quarterly: '季度再平衡',
        earnings_disclosure: '📅 财报披露'
      }[t] || t;
    },

    _conditionLabel(a) {
      switch (a.type) {
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
      }
      return a.value;
    },

    addDialog() {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Alerts.closeModal()">
          <div class="modal">
            <h3>新建提醒</h3>
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
                <option value="price_above">价格突破(≥)</option>
                <option value="price_below">价格跌破(≤)</option>
                <option value="change_above">涨幅达到(≥)</option>
                <option value="change_below">跌幅达到(≥)</option>
                <option value="volume_above">成交量异常(≥)</option>
                <option value="rebalance_quarterly">季度再平衡(基金)</option>
                <option value="earnings_disclosure">📅 财报披露前 N 天</option>
              </select>
            </div>
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
              💡 监控中:每 60 秒检查一次(浏览器必须打开)。<br>
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
      const valRow = document.getElementById('alValueRow');
      const intRow = document.getElementById('alIntervalRow');
      const leadRow = document.getElementById('alLeadDaysRow');  // Phase U
      const hint = document.getElementById('alRebalanceTarget');
      if (valRow) valRow.style.display = (isRebalance || isEarnings) ? 'none' : '';
      if (intRow) intRow.style.display = isRebalance ? '' : 'none';
      if (leadRow) leadRow.style.display = isEarnings ? '' : 'none';  // Phase U
      if (hint) hint.style.display = isRebalance ? '' : 'none';

      // 再平衡不需要代码
      const codeEl = document.getElementById('alCode');
      if (codeEl) {
        codeEl.disabled = isRebalance;
        if (isRebalance) codeEl.value = 'funds';
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

      const value = parseFloat(document.getElementById('alValue').value);
      if (!code || !/^\d{6}$/.test(code)) { toastError('代码必须 6 位'); return; }
      if (!value) { toastError('阈值必填'); return; }
      const data = {
        id: uuid(),
        code, name, type, value,
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

    /**
     * 启动轮询(每 60 秒)
     */
    startPolling() {
      if (this._timer) return;
      this._timer = setInterval(() => this._check(), 60 * 1000);
    },

    stopPolling() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    async _check() {
      const list = await Core.Storage.where('alerts', 'active', true);
      if (!list.length) return;

      // 分离: 行情类 / 再平衡类 / 财报日历类
      const stockAlerts = list.filter(a => a.type !== 'rebalance_quarterly' && a.type !== 'earnings_disclosure');
      const rebalanceAlerts = list.filter(a => a.type === 'rebalance_quarterly');
      const earningsAlerts = list.filter(a => a.type === 'earnings_disclosure');

      // 1. 行情类: 一次拉行情
      if (stockAlerts.length > 0) {
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
      }

      // 2. 财报日历类 (Phase U): 拉单股下次披露日, 距今 ≤ N 天触发
      for (const a of earningsAlerts) {
        try {
          const next = await Core.Data.getStockNextDisclosure(a.code);
          if (!next || !next.noticeDate) continue;
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
      }

      // 3. 再平衡类: 检查 nextCheck
      for (const a of rebalanceAlerts) {
        const nextCheck = a.nextCheck || (a.createdAt + (a.intervalDays || 90) * 86400000);
        if (Date.now() < nextCheck) continue;

        // 计算当前基金配置
        const drift = await this._computeRebalanceDrift();
        if (drift) {
          this._notifyRebalance(a, drift);
        } else {
          console.warn('[Alerts] 再平衡: 无基金数据或拉不到净值');
        }

        // 推进下次检查时间(无论是否触发都推进,避免重复刷屏)
        a.nextCheck = Date.now() + (a.intervalDays || 90) * 86400000;
        a.hitCount = (a.hitCount || 0) + 1;
        a.lastHit = Date.now();
        await Core.Storage.put('alerts', a);
      }
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
    async _computeRebalanceDrift(targetRatio = { short_bond: 0.20, pure_bond: 0.80 }) {
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
        drift.shouldRebalance = maxDrift > 0.05;  // 偏离 >5% 触发

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
          'volume_above': ['题材催化', '技术突破']
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
    }
  };

  window.Alerts = Alerts;
  window._onShow_pageAlerts = function() { Alerts.render(); };

  // 启动轮询
  document.addEventListener('DOMContentLoaded', () => {
    Alerts.startPolling();
  });
})();
