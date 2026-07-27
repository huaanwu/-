/**
 * Paper - 模拟盘 (Paper Trading, Phase A)
 * 虚拟资金 + 独立持仓, 用于验证 AI 建议的真实胜率/回撤
 *
 * 设计:
 *   - 模拟账户: kv 'paper_account' = { initialCash, cash, createdAt, positionPct }
 *   - 每日快照: kv 'paper_snapshots' = [{ date, paperTotal, realTotal, csi300 }] (上限 365 条)
 *   - 模拟持仓: 复用 holdings 表, 行上 isPaper=true (真实持仓无此字段, undefined 即真实)
 *   - 模拟交易: 复用 transactions 表, 同样 isPaper=true
 *   - 费用: 佣金万三 (最低 5 元), 卖出另加印花税万五
 *   - A股整手: 买入股数向下取整到 100 的倍数
 *   - 隔离: 真实视图 (holdings/account/journal/app.js) 读取时 .filter(h => !h.isPaper)
 *   - Phase B: 手动/AI 自动买入前走 Core.Discipline.preBuyCheck (isPaper=true, 模拟口径独立锚定)
 */
(function() {
  'use strict';

  const COMMISSION_RATE = 0.0003;      // 佣金万三
  const COMMISSION_MIN = 5;            // 佣金最低 5 元
  const STAMP_TAX_RATE = 0.0005;       // 印花税万五 (仅卖出)
  const LOT_SIZE = 100;                // A股一手
  const SNAPSHOT_LIMIT = 365;          // 快照上限
  const DEFAULT_CASH = 100000;         // 默认初始虚拟资金
  const DEFAULT_POSITION_PCT = 0.10;   // AI 自动成交单次仓位比例

  const Paper = {

    async init() {
      // 已存在则不覆盖
      const acc = await Core.Storage.kvGet('paper_account');
      if (!acc) {
        await Core.Storage.kvSet('paper_account', {
          initialCash: DEFAULT_CASH,
          cash: DEFAULT_CASH,
          createdAt: Date.now(),
          positionPct: DEFAULT_POSITION_PCT
        });
      }
      // 启动时尝试记当日快照 (失败不阻塞启动)
      this.snapshotIfNeeded().catch(e => console.warn('[Paper] 启动快照失败:', e));
    },

    // ========== 纯函数 (不依赖 DOM/IndexedDB, Node 沙箱可测) ==========

    /**
     * 交易费用: 佣金万三 (最低 5 元) + 卖出印花税万五
     * @param {number} amount 成交金额
     * @param {string} side 'buy' | 'sell'
     * @returns {{ commission: number, stampTax: number, total: number }}
     */
    _calcFee(amount, side) {
      // 金额四舍五入到分, 避免浮点尾差 (如 100000×0.0003=29.999...)
      const commission = +Math.max(amount * COMMISSION_RATE, COMMISSION_MIN).toFixed(2);
      const stampTax = side === 'sell' ? +(amount * STAMP_TAX_RATE).toFixed(2) : 0;
      return { commission, stampTax, total: +(commission + stampTax).toFixed(2) };
    },

    /** A股整手: 向下取整到 100 的倍数 */
    _roundLot(shares) {
      return Math.floor((parseFloat(shares) || 0) / LOT_SIZE) * LOT_SIZE;
    },

    /**
     * 快照 append: 同日去重, 上限 SNAPSHOT_LIMIT 条 (滚动截断最旧)
     * 纯函数, 返回新数组, 不改入参
     */
    _pushSnapshot(list, entry) {
      const arr = Array.isArray(list) ? [...list] : [];
      if (entry && entry.date && !arr.some(s => s.date === entry.date)) arr.push(entry);
      return arr.slice(-SNAPSHOT_LIMIT);
    },

    /**
     * AI 自动成交计划: 买入金额 = 现金 × positionPct, 换算整手股数
     * 现金不够付 (含手续费) 或不足一手 → null (调用方 console.warn 跳过)
     */
    _planAutoTrade(cash, positionPct, price) {
      cash = parseFloat(cash) || 0;
      price = parseFloat(price) || 0;
      if (cash <= 0 || price <= 0) return null;
      let shares = this._roundLot(cash * positionPct / price);
      // 手续费可能把总金额顶过现金, 逐手递减
      while (shares >= LOT_SIZE) {
        const amount = shares * price;
        if (amount + this._calcFee(amount, 'buy').total <= cash) return shares;
        shares -= LOT_SIZE;
      }
      return null;
    },

    // ========== 账户与持仓 ==========

    /** 模拟账户 (kv 'paper_account', 不存在时返回默认值) */
    async getAccount() {
      const acc = await Core.Storage.kvGet('paper_account');
      return acc || {
        initialCash: DEFAULT_CASH,
        cash: DEFAULT_CASH,
        createdAt: Date.now(),
        positionPct: DEFAULT_POSITION_PCT
      };
    },

    /** 模拟持仓原始行 (holdings 表 isPaper=true) */
    async _getPaperHoldings() {
      const all = await Core.Storage.all('holdings');
      return (all || []).filter(h => h.isPaper);
    },

    /**
     * 模拟持仓 + 实时行情: [{ ...h, shares, costPrice, price, cost, mkt, pl, plPct }]
     * 单只行情失败 → price/mkt/pl 为 null, 不阻塞其他
     */
    async getPositions() {
      const rows = await this._getPaperHoldings();
      const quotes = {};
      await Promise.all(rows.map(async h => {
        try {
          const q = await Core.Data.getStockQuote(h.code);
          if (q) quotes[h.code] = parseFloat(q.最新价 ?? q.price ?? 0) || null;
        } catch (e) {
          console.warn('[Paper] 拉行情失败:', h.code, e);
        }
      }));
      return rows.map(h => {
        const shares = parseFloat(h.shares) || 0;
        const costPrice = parseFloat(h.costPrice) || 0;
        const price = quotes[h.code] ?? null;
        const cost = shares * costPrice;
        const mkt = price !== null ? shares * price : null;
        const pl = mkt !== null ? mkt - cost : null;
        const plPct = pl !== null && cost > 0 ? pl / cost : null;
        return { ...h, shares, costPrice, price, cost, mkt, pl, plPct };
      });
    },

    // ========== 交易 ==========

    /**
     * 模拟买入 (实时价成交, 计手续费)
     * @param {string} code 6 位代码
     * @param {string} name 名称 (可空)
     * @param {string} market sh/sz (可空, 自动按代码前缀推导)
     * @param {number} shares 股数 (自动向下取整到整手)
     * @param {{ assumption?: string, stopLoss?: number, disciplineWarns?: string[] }} [opts]
     *        Phase B 纪律信息: 非索引字段, 写到 holdings/transactions 行上 (不改 schema)
     * @returns 持仓行 | null (失败 toast + 返回 null)
     */
    async buy(code, name, market, shares, opts = {}) {
      try {
        shares = this._roundLot(shares);
        if (shares < LOT_SIZE) { toastError(`买入不足一手 (${LOT_SIZE} 股)`); return null; }
        const q = await Core.Data.getStockQuote(code);
        const price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
        if (!price) { toastError('拉不到实时价, 无法成交'); return null; }
        const amount = shares * price;
        const fee = this._calcFee(amount, 'buy');
        const acc = await this.getAccount();
        if (amount + fee.total > acc.cash) {
          toastError(`现金不足: 需 ${fmtMoney(amount + fee.total)} (含费), 可用 ${fmtMoney(acc.cash)}`);
          return null;
        }

        // 移动加权成本 (与真实持仓 Holdings.saveTx 一致; 费用不摊入成本, 只扣现金)
        const now = Date.now();
        const rows = await this._getPaperHoldings();
        let h = rows.find(x => x.code === code) || null;
        if (h) {
          const totalShares = h.shares + shares;
          h.costPrice = (h.shares * h.costPrice + shares * price) / totalShares;
          h.shares = totalShares;
          if (name && !h.name) h.name = name;
          // Phase B: 加仓时若调用方给了新的假设/止损, 一并更新 (非索引字段)
          if (opts.assumption) h.assumption = opts.assumption;
          if (opts.stopLoss) h.stopLoss = opts.stopLoss;
          h.updatedAt = now;
          await Core.Storage.put('holdings', h);
        } else {
          h = {
            id: uuid(),
            code,
            name: name || q.名称 || '',
            market: market || Core.Util.stockCodePrefix(code),
            shares,
            costPrice: price,
            isPaper: true,
            createdAt: now,
            updatedAt: now
          };
          if (opts.assumption) h.assumption = opts.assumption;
          if (opts.stopLoss) h.stopLoss = opts.stopLoss;
          await Core.Storage.add('holdings', h);
        }
        const tx = {
          id: uuid(), holdingId: h.id, code,
          type: 'buy', date: fmtDate(new Date()),
          price, shares, fee: fee.total,
          isPaper: true, createdAt: now
        };
        // Phase B 纪律信息 (非索引字段): 假设/止损/警告快照
        if (opts.assumption) tx.assumption = opts.assumption;
        if (opts.stopLoss) tx.stopLoss = opts.stopLoss;
        if (opts.disciplineWarns && opts.disciplineWarns.length) tx.disciplineWarns = opts.disciplineWarns;
        await Core.Storage.add('transactions', tx);
        acc.cash = +(acc.cash - amount - fee.total).toFixed(2);
        await Core.Storage.kvSet('paper_account', acc);
        toastSuccess(`模拟买入 ${code} ${shares} 股 @ ${price} (费 ${fmtMoney(fee.total)})`);
        return h;
      } catch (e) {
        console.warn('[Paper] 买入失败:', e);
        toastError('模拟买入失败: ' + e.message);
        return null;
      }
    },

    /**
     * 模拟卖出 (实时价成交, 计佣金 + 印花税)
     * @param {string} holdingId 模拟持仓行 id
     * @param {number} shares 股数 (卖出不限整手, 但不得超过持仓)
     * @returns 持仓行 | null (失败 toast + 返回 null)
     */
    async sell(holdingId, shares) {
      try {
        const h = await Core.Storage.get('holdings', holdingId);
        if (!h || !h.isPaper) { toastError('模拟持仓不存在'); return null; }
        shares = parseFloat(shares) || 0;
        if (shares <= 0) { toastError('卖出股数必须 > 0'); return null; }
        if (shares > h.shares) { toastError(`卖出股数超过持仓 (持有 ${h.shares})`); return null; }
        const q = await Core.Data.getStockQuote(h.code);
        const price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
        if (!price) { toastError('拉不到实时价, 无法成交'); return null; }
        const amount = shares * price;
        const fee = this._calcFee(amount, 'sell');
        const now = Date.now();
        h.shares -= shares;
        if (h.shares <= 0) {
          // 清仓: 删持仓行 (交易记录保留)
          await Core.Storage.remove('holdings', h.id);
        } else {
          h.updatedAt = now;
          await Core.Storage.put('holdings', h);
        }
        await Core.Storage.add('transactions', {
          id: uuid(), holdingId: h.id, code: h.code,
          type: 'sell', date: fmtDate(new Date()),
          price, shares, fee: fee.total,
          isPaper: true, createdAt: now
        });
        const acc = await this.getAccount();
        acc.cash = +(acc.cash + amount - fee.total).toFixed(2);
        await Core.Storage.kvSet('paper_account', acc);
        toastSuccess(`模拟卖出 ${h.code} ${shares} 股 @ ${price} (费 ${fmtMoney(fee.total)})`);
        return h;
      } catch (e) {
        console.warn('[Paper] 卖出失败:', e);
        toastError('模拟卖出失败: ' + e.message);
        return null;
      }
    },

    /** 重置模拟盘: 清模拟持仓/交易/快照, 现金恢复初始值 (confirm 确认) */
    async resetAccount() {
      if (!confirm('确定重置模拟盘? 模拟持仓/交易记录/曲线全部清空, 现金恢复初始值')) return;
      try {
        for (const h of await this._getPaperHoldings()) {
          await Core.Storage.remove('holdings', h.id);
        }
        const txs = ((await Core.Storage.all('transactions')) || []).filter(t => t.isPaper);
        for (const t of txs) {
          await Core.Storage.remove('transactions', t.id);
        }
        const acc = await this.getAccount();
        acc.cash = acc.initialCash;
        await Core.Storage.kvSet('paper_account', acc);
        await Core.Storage.kvSet('paper_snapshots', []);
        toastSuccess('模拟盘已重置');
        this.renderPage();
      } catch (e) {
        console.warn('[Paper] 重置失败:', e);
        toastError('重置失败: ' + e.message);
      }
    },

    // ========== 每日快照 ==========

    /**
     * 每日快照 (每天一次, 当天已存在则跳过)
     * 口径:
     *   - paperTotal = 模拟现金 + 模拟持仓市值
     *   - realTotal  = 真实持仓市值 (仅股票市值, 不含现金/基金)
     *   - csi300     = 沪深300 现价点位 (拉不到则 null)
     */
    async snapshotIfNeeded() {
      const today = fmtDate(new Date());
      const snaps = (await Core.Storage.kvGet('paper_snapshots')) || [];
      if (snaps.some(s => s.date === today)) return snaps;

      const acc = await this.getAccount();
      const positions = await this.getPositions();
      const paperTotal = acc.cash + positions.reduce((s, p) => s + (p.mkt || 0), 0);

      // 真实持仓市值 (与 account.js 同款: 逐只 getStockQuote; 排除模拟盘行)
      let realTotal = 0;
      try {
        const realHoldings = ((await Core.Storage.all('holdings')) || []).filter(h => !h.isPaper);
        await Promise.all(realHoldings.map(async h => {
          try {
            const q = await Core.Data.getStockQuote(h.code);
            const price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
            realTotal += (parseFloat(h.shares) || 0) * price;
          } catch (e) { /* 单只失败按 0 计 */ }
        }));
      } catch (e) {
        console.warn('[Paper] 真实持仓市值计算失败:', e);
      }

      // 沪深300 现价 (getIndexSpot: 腾讯优先, 失败降级 aktools)
      let csi300 = null;
      try {
        const idx = await Core.Data.getIndexSpot();
        const row = (idx || []).find(i => (i.代码 || i.code) === '000300');
        if (row) csi300 = parseFloat(row.最新价 ?? row.price ?? 0) || null;
      } catch (e) {
        console.warn('[Paper] 沪深300 拉取失败:', e);
      }

      const next = this._pushSnapshot(snaps, {
        date: today,
        paperTotal: +paperTotal.toFixed(2),
        realTotal: +realTotal.toFixed(2),
        csi300
      });
      await Core.Storage.kvSet('paper_snapshots', next);
      return next;
    },

    // ========== AI 自动成交钩子 ==========

    /**
     * AI 选股自动成交 (screener._addWatchlistFromPick 加自选成功后调用)
     * @param {{ code: string, name?: string, market?: string }} pick
     * 买入金额 = 模拟现金 × positionPct; 现金不足/不足一手/任何失败 → console.warn 跳过, 不 throw
     */
    async autoTradeFromPick(pick) {
      try {
        if (!pick || !pick.code) return null;
        const acc = await this.getAccount();
        const q = await Core.Data.getStockQuote(pick.code);
        const price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
        const shares = this._planAutoTrade(acc.cash, acc.positionPct, price);
        if (!shares) {
          console.warn(`[Paper] 自动成交跳过 ${pick.code}: 现金 ${acc.cash} 买不起一手 (价 ${price})`);
          return null;
        }
        // Phase B 交易纪律: AI 自动成交走同一套 preBuyCheck
        // blocks 命中 → console.warn 跳过该笔 (不打扰用户); warns 无人确认不阻塞, 写入交易行 disciplineWarns
        if (Core.Discipline && Core.Discipline.preBuyCheck) {
          // AI 场景无人工假设: 固定归到"题材催化"; 止损默认 成交价 × 0.92 (-8%)
          const assumption = '题材催化';
          const stopLoss = +(price * 0.92).toFixed(2);
          const chk = await Core.Discipline.preBuyCheck({
            code: pick.code, name: pick.name || '', market: pick.market || '',
            price, shares, amount: shares * price,
            isPaper: true, assumption, stopLoss
          });
          if (!chk.ok) {
            console.warn(`[Paper] 自动成交被纪律引擎拦截 ${pick.code}:`, chk.blocks.join('；'));
            return null;
          }
          return await this.buy(pick.code, pick.name || '', pick.market || '', shares,
            { assumption, stopLoss, disciplineWarns: chk.warns });
        }
        return await this.buy(pick.code, pick.name || '', pick.market || '', shares);
      } catch (e) {
        console.warn('[Paper] 自动成交失败:', e);
        return null;
      }
    },

    // ========== 页面 UI ==========

    /** 手动交易表单: 买入 (Phase B: 先过 Core.Discipline.preBuyCheck) */
    async buyFromForm() {
      const parsed = parseStockInput(document.getElementById('paperCode').value);
      if (!parsed) { toastError('代码格式不对 (6 位数字开头)'); return; }
      const shares = parseFloat(document.getElementById('paperShares').value);
      if (!shares || shares <= 0) { toastError('股数必须 > 0'); return; }
      const resultEl = document.getElementById('paperCheckResult');
      const assumption = document.getElementById('paperAssumption').value;
      const stopLoss = parseFloat(document.getElementById('paperStopLoss').value);
      let opts = {};
      if (Core.Discipline && Core.Discipline.preBuyCheck) {
        // 先拉实时价供止损价/金额校验 (拉不到则 price=0, 检查内部降级为 warn)
        let price = 0;
        try {
          const q = await Core.Data.getStockQuote(parsed.code);
          price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
        } catch (e) {
          console.warn('[Paper] 纪律检查前拉价失败:', e);
        }
        const sharesLot = this._roundLot(shares);
        const chk = await Core.Discipline.preBuyCheck({
          code: parsed.code, name: parsed.name, market: '',
          price, shares: sharesLot, amount: sharesLot * price,
          isPaper: true, assumption, stopLoss
        });
        if (!chk.ok) {
          if (resultEl) resultEl.innerHTML = Core.Discipline.renderCheckResult(chk);
          toastError('交易纪律检查未通过, 已拦截');
          return;
        }
        if (chk.warns.length && !confirm(Core.Discipline._resultToText(chk) + '\n\n确认继续买入?')) return;
        opts = { assumption, stopLoss, disciplineWarns: chk.warns };
      }
      const r = await this.buy(parsed.code, parsed.name, '', shares, opts);
      if (r) {
        if (resultEl) resultEl.innerHTML = '';
        this.renderPage();
      }
    },

    /** 手动交易表单: 卖出 (按代码找模拟持仓) */
    async sellFromForm() {
      const parsed = parseStockInput(document.getElementById('paperCode').value);
      if (!parsed) { toastError('代码格式不对 (6 位数字开头)'); return; }
      const shares = parseFloat(document.getElementById('paperShares').value);
      if (!shares || shares <= 0) { toastError('股数必须 > 0'); return; }
      const rows = await this._getPaperHoldings();
      const h = rows.find(x => x.code === parsed.code);
      if (!h) { toastError('模拟盘没有这只持仓'); return; }
      const r = await this.sell(h.id, shares);
      if (r) this.renderPage();
    },

    /** 持仓表行内按钮: 按现价卖出全部 */
    async sellAll(holdingId) {
      const h = await Core.Storage.get('holdings', holdingId);
      if (!h || !h.isPaper) { toastError('模拟持仓不存在'); return; }
      if (!confirm(`按现价卖出全部 ${h.code} ${h.shares} 股?`)) return;
      const r = await this.sell(h.id, h.shares);
      if (r) this.renderPage();
    },

    /** 页面渲染 (挂 window._onShow_pagePaper) */
    async renderPage() {
      const summaryEl = document.getElementById('paperSummary');
      const tableEl = document.getElementById('paperPositions');
      if (!summaryEl || !tableEl) return;

      // 页面展示时也尝试记当日快照 (当天已记则跳过)
      this.snapshotIfNeeded().catch(e => console.warn('[Paper] 页面快照失败:', e));

      const [acc, positions] = await Promise.all([this.getAccount(), this.getPositions()]);
      const mktValue = positions.reduce((s, p) => s + (p.mkt || 0), 0);
      const totalAssets = acc.cash + mktValue;
      // 累计盈亏 = 总资产 - 初始资金 (含已实现盈亏与手续费)
      const totalPL = totalAssets - acc.initialCash;
      const totalPLPct = acc.initialCash > 0 ? totalPL / acc.initialCash : 0;

      summaryEl.innerHTML = `
        <div class="summary-card">
          <div class="label">💵 虚拟现金</div>
          <div class="value">${fmtMoney(acc.cash)}</div>
        </div>
        <div class="summary-card">
          <div class="label">📊 持仓市值</div>
          <div class="value">${fmtMoney(mktValue)}</div>
        </div>
        <div class="summary-card">
          <div class="label">💰 总资产</div>
          <div class="value">${fmtMoney(totalAssets)}</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">初始 ${fmtMoney(acc.initialCash)}</div>
        </div>
        <div class="summary-card">
          <div class="label">📈 累计盈亏</div>
          <div class="value ${pctClass(totalPLPct)}">${fmtMoney(totalPL)}</div>
          <div class="delta ${pctClass(totalPLPct)}">${fmtPct(totalPLPct)}</div>
        </div>
      `;

      if (positions.length === 0) {
        tableEl.innerHTML = `
          <div class="empty">
            <div class="empty-icon">📋</div>
            <div>模拟盘还没有持仓</div>
            <div style="margin-top:8px;font-size:12px;">AI 选股加自选后会自动买入, 也可以上方手动交易</div>
          </div>
        `;
      } else {
        tableEl.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>代码/名称</th><th>持仓股数</th><th>成本价</th><th>现价</th><th>市值</th><th>盈亏</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${positions.map(p => `
                <tr>
                  <td><span class="code">${escapeHtml(p.code)}</span><br><span style="color:var(--text-muted);font-size:11px;">${escapeHtml(p.name || '')}</span></td>
                  <td>${fmtNum(p.shares, 0)}</td>
                  <td>${fmtNum(p.costPrice, 3)}</td>
                  <td>${p.price !== null ? fmtNum(p.price, 2) : '-'}</td>
                  <td>${p.mkt !== null ? fmtMoney(p.mkt) : '-'}</td>
                  <td class="${pctClass(p.plPct)}">
                    ${p.pl !== null ? fmtMoney(p.pl) : '-'}<br>
                    <span style="font-size:11px;">${p.plPct !== null ? fmtPct(p.plPct) : ''}</span>
                  </td>
                  <td><button class="btn btn-sm" onclick="Paper.sellAll('${escapeHtml(p.id)}')">卖出</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }

      await this._renderChart();
    },

    _chart: null,

    /**
     * 表现对比曲线 (ECharts 双轴三线)
     * 左轴: 模拟总资产 / 真实持仓市值 (元, 绝对值)
     * 右轴: 沪深300 (以快照首日 = 100 指数化)
     * 口径差异: 资产线是绝对金额, 沪深300 是指数化相对走势, 两条轴只看各自趋势, 不比绝对高低
     */
    async _renderChart() {
      const chartEl = document.getElementById('paperChart');
      if (!chartEl) return;
      if (this._chart) { this._chart.dispose(); this._chart = null; }
      const snaps = ((await Core.Storage.kvGet('paper_snapshots')) || []).slice(-SNAPSHOT_LIMIT);
      if (snaps.length < 2) {
        chartEl.innerHTML = '<div class="empty" style="padding:24px;">数据积累中, 明天再来看曲线</div>';
        return;
      }
      if (typeof echarts === 'undefined') {
        console.warn('[Paper] echarts 未加载');
        chartEl.innerHTML = '<div class="empty" style="padding:24px;">图表库未加载</div>';
        return;
      }
      chartEl.innerHTML = '<div id="paperChartCanvas" style="width:100%;height:280px;"></div>';
      // 沪深300 指数化基准: 首个有点位的快照 = 100
      const baseRow = snaps.find(s => s.csi300);
      const base = baseRow ? baseRow.csi300 : null;
      const csi300Indexed = snaps.map(s => (s.csi300 && base) ? +(s.csi300 / base * 100).toFixed(2) : null);
      this._chart = echarts.init(document.getElementById('paperChartCanvas'));
      this._chart.setOption({
        tooltip: { trigger: 'axis' },
        legend: {
          data: ['模拟总资产', '真实持仓市值', '沪深300 (首日=100)'],
          textStyle: { color: '#8b949e', fontSize: 11 }
        },
        grid: { left: 70, right: 60, top: 40, bottom: 30 },
        xAxis: { type: 'category', data: snaps.map(s => s.date), axisLabel: { color: '#8b949e', fontSize: 10 } },
        yAxis: [
          { type: 'value', name: '资产 (元)', axisLabel: { color: '#8b949e', fontSize: 10 }, splitLine: { lineStyle: { color: '#21262d' } } },
          { type: 'value', name: '沪深300 指数化', axisLabel: { color: '#8b949e', fontSize: 10 }, splitLine: { show: false } }
        ],
        series: [
          { name: '模拟总资产', type: 'line', data: snaps.map(s => s.paperTotal), smooth: true, showSymbol: false },
          { name: '真实持仓市值', type: 'line', data: snaps.map(s => s.realTotal), smooth: true, showSymbol: false },
          { name: '沪深300 (首日=100)', type: 'line', yAxisIndex: 1, data: csi300Indexed, smooth: true, showSymbol: false, lineStyle: { type: 'dashed' } }
        ]
      });
    }
  };

  window.Paper = Paper;
  window._onShow_pagePaper = function() { Paper.renderPage(); };
})();
