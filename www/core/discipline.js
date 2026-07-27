/**
 * Core.Discipline - 交易纪律引擎 (Phase B)
 * 依赖: Core.Storage / Core.Data / Core.State / Core.Util
 *
 * 在买入动作发生前做代码层硬校验 (不是 prompt 层), 实盘 (holdings.js) 与
 * 模拟盘 (paper.js) 共用同一套检查, 两套账本各自独立 (isPaper 隔离, 互不混用):
 *   - blocks: 硬拦截 (买入假设/止损价必填、单票集中度、股票总仓位、月度回撤熔断)
 *   - warns:  确认后放行 (追高、同代码/同假设历史重复错误)
 *   - 检查本身失败 (行情/存储异常) 不 block 交易, 降级为 warn
 * 卖出路径不做任何拦截。
 */
(function() {
  'use strict';

  window.Core = window.Core || {};

  // 买入假设枚举 (与 www/app/journal.js 的 ASSUMPTIONS 保持一致, 改这里要同步改那边)
  const ASSUMPTIONS = ['业绩拐点', '估值修复', '题材催化', '技术突破', '分红套利', '其他'];

  const CONFIG_KEY = 'discipline_config';               // kv: 纪律配置
  const ANCHOR_KEY = 'discipline_month_anchor';         // kv: 实盘月度锚点 { month, startTotal }
  const ANCHOR_KEY_PAPER = 'discipline_month_anchor_paper'; // kv: 模拟盘月度锚点 (独立账本)

  // 默认配置 (出厂设置, 真值在 Core.Constants — 改一处生效全栈)
  const DEFAULT_CONFIG = {
    maxSingleStockPct: Core.Constants.MAX_SINGLE_STOCK_PCT,  // 单票占总资产上限
    maxTotalPositionPct: 0.95,                              // 股票总仓位上限
    chaseWarnPct: 5,                                        // 当日涨幅超过此值视为追高 (警告不拦截)
    maxMonthlyDrawdownPct: Core.Constants.MAX_MONTHLY_DRAWDOWN_PCT,  // 月度回撤熔断线
    maxSingleIndustryPct: Core.Constants.MAX_SINGLE_INDUSTRY_PCT,   // 单行业集中度上限 (预留)
    enabled: true
  };

  /** 百分比文案: 0.235 → "23.5%" */
  function pctText(p, decimals = 1) {
    return (Number(p) * 100).toFixed(decimals) + '%';
  }

  window.Core.Discipline = {
    ASSUMPTIONS,
    DEFAULT_CONFIG,

    /** 当前月份 'YYYY-MM' (本地时区), 独立成方法便于测试注入/对账 */
    _currentMonth() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    },

    // ========== 配置 (kv 'discipline_config', 懒加载) ==========

    /** 读配置 (合并默认值; 读取失败用默认值, 不阻塞) */
    async getConfig() {
      let saved = null;
      try {
        saved = await window.Core.Storage.kvGet(CONFIG_KEY);
      } catch (e) {
        console.warn('[Discipline] 读配置失败, 用默认值:', e);
      }
      return { ...DEFAULT_CONFIG, ...(saved || {}) };
    },

    /** 合并写回配置, 返回合并后的完整配置 */
    async setConfig(partial) {
      const merged = { ...(await this.getConfig()), ...(partial || {}) };
      await window.Core.Storage.kvSet(CONFIG_KEY, merged);
      return merged;
    },

    // ========== 纯函数 (不依赖 DOM/IndexedDB, 可注入依赖, Node 沙箱可测) ==========

    /**
     * 输入校验: 买入假设必填 (枚举内) + 止损价必填且 < 买入价
     * @returns string[] blocks (空数组 = 通过)
     */
    _checkInputs({ assumption, stopLoss, price }) {
      const blocks = [];
      if (!assumption || !ASSUMPTIONS.includes(assumption)) {
        blocks.push(`买入假设必填 (${ASSUMPTIONS.join('/')})`);
      }
      const sl = parseFloat(stopLoss);
      if (!sl || sl <= 0) {
        blocks.push('止损价必填且必须 > 0');
      } else if (price > 0 && sl >= price) {
        blocks.push(`止损价 ${sl} 必须低于买入价 ${price}`);
      }
      return blocks;
    },

    /**
     * 单票集中度: positionValue (含同 code 已有持仓 + 本次买入) / totalAssets 超限 → block 文案
     * @returns string | null
     */
    _checkConcentration({ positionValue, totalAssets, config }) {
      if (!(totalAssets > 0)) return null;
      const pct = positionValue / totalAssets;
      if (pct > config.maxSingleStockPct) {
        return `买入后单票占比 ${pctText(pct)}, 超过上限 ${pctText(config.maxSingleStockPct, 0)}`;
      }
      return null;
    },

    /**
     * 股票总仓位: stockValue (含本次买入) / totalAssets 超限 → block 文案
     * @returns string | null
     */
    _checkTotalPosition({ stockValue, totalAssets, config }) {
      if (!(totalAssets > 0)) return null;
      const pct = stockValue / totalAssets;
      if (pct > config.maxTotalPositionPct) {
        return `买入后股票总仓位 ${pctText(pct)}, 超过上限 ${pctText(config.maxTotalPositionPct, 0)}`;
      }
      return null;
    },

    /**
     * 月度锚点滚动: 无锚点/跨月/锚点非法 → 返回新锚点 { month, startTotal: currentTotal } (调用方负责写回)
     * 同月 → 原样返回 (引用相等, 调用方据此判断要不要写)
     */
    _monthAnchorNext(anchor, month, currentTotal) {
      if (!anchor || anchor.month !== month || !(anchor.startTotal > 0)) {
        return { month, startTotal: currentTotal };
      }
      return anchor;
    },

    /**
     * 月度回撤熔断: 当前总资产 < 月初锚点 × (1 - 熔断线) → block 文案 (只拦买入, 卖出永远允许)
     * @returns string | null
     */
    _checkDrawdown({ currentTotal, anchor, config }) {
      if (!anchor || !(anchor.startTotal > 0)) return null;
      const limit = anchor.startTotal * (1 - config.maxMonthlyDrawdownPct);
      if (currentTotal < limit) {
        const dd = 1 - currentTotal / anchor.startTotal;
        return `本月回撤已触及熔断线 ${pctText(config.maxMonthlyDrawdownPct, 0)} (实际回撤 ${pctText(dd)}), 本月只准减仓`;
      }
      return null;
    },

    /**
     * 追高: 当日涨跌幅 > chaseWarnPct → warn 文案 (警告不拦截)
     * @returns string | null
     */
    _checkChase({ changePct, config }) {
      const v = parseFloat(changePct);
      if (isNaN(v)) return null;
      if (v > config.chaseWarnPct) return `今日已涨 ${v.toFixed(2)}%, 确认追高?`;
      return null;
    },

    /**
     * 重复错误拦截: 汇总同代码 / 同假设的历史复盘
     * 含 "🔁 AI 事后验证" 的条目单独计数, 正文含 "不成立" 计为验证失败
     * @param {Array} codeJournals 同代码笔记
     * @param {Array} sameAssumptionJournals 同 assumption 标签笔记
     * @param {string} assumption 本次买入假设
     * @returns string[] 如 ["该代码 2 次历史复盘, 1 次验证不成立", "该假设(题材催化)历史上用过 5 次"]
     */
    _summarizeHistory(codeJournals, sameAssumptionJournals, assumption) {
      const history = [];
      const verifiedOf = (list) => (list || []).filter(j => (j.content || '').includes('🔁 AI 事后验证'));
      const failedOf = (list) => verifiedOf(list).filter(j => /不成立/.test(j.content || ''));
      if (codeJournals && codeJournals.length) {
        let s = `该代码 ${codeJournals.length} 次历史复盘`;
        const v = verifiedOf(codeJournals).length, f = failedOf(codeJournals).length;
        if (v) s += `, ${v} 次已经事后验证`;
        if (f) s += `, ${f} 次验证不成立`;
        history.push(s);
      }
      if (assumption && sameAssumptionJournals && sameAssumptionJournals.length) {
        let s = `该假设(${assumption})历史上用过 ${sameAssumptionJournals.length} 次`;
        const f = failedOf(sameAssumptionJournals).length;
        if (f) s += `, ${f} 次验证不成立`;
        history.push(s);
      }
      return history;
    },

    // ========== 资产口径 (实盘/模拟盘两套独立账本) ==========

    /**
     * 实盘资产口径 (与 www/app/account.js 一致): 现金 + 股票市值 + 基金市值
     * 行情拉取失败回退成本价/成本净值 (quoteFail 计数, 调用方据此提示"估算偏宽")
     */
    async _getRealAssets() {
      const cash = parseFloat(window.Core.State.get('accountCash')) || 0;
      const holdings = ((await window.Core.Storage.all('holdings')) || []).filter(h => !h.isPaper);
      let stockMkt = 0, quoteFail = 0;
      const valueByCode = {};
      await Promise.all(holdings.map(async h => {
        const shares = parseFloat(h.shares) || 0;
        if (shares <= 0) return;
        let price = null;
        try {
          const q = await window.Core.Data.getStockQuote(h.code);
          price = q ? (parseFloat(q.最新价 ?? q.price) || null) : null;
        } catch (e) {
          console.warn('[Discipline] 拉行情失败:', h.code, e);
        }
        if (!price) { quoteFail++; price = parseFloat(h.costPrice ?? h.cost) || 0; } // 行情失败回退成本价
        const v = shares * price;
        valueByCode[h.code] = (valueByCode[h.code] || 0) + v;
        stockMkt += v;
      }));
      let fundMkt = 0;
      const funds = (await window.Core.Storage.all('funds')) || [];
      await Promise.all(funds.map(async f => {
        const shares = parseFloat(f.shares) || 0;
        if (shares <= 0) return;
        let nav = null;
        try {
          const arr = await window.Core.Data.getFundSpot(f.code);
          if (Array.isArray(arr) && arr.length > 0) {
            const last = arr[arr.length - 1];
            nav = parseFloat(last.单位净值 ?? last.value) || null;
          }
        } catch (e) {
          console.warn('[Discipline] 拉基金净值失败:', f.code, e);
        }
        if (!nav) { quoteFail++; nav = parseFloat(f.costNav) || 0; } // 失败回退成本净值
        fundMkt += shares * nav;
      }));
      return { cash, stockMkt, fundMkt, totalAssets: cash + stockMkt + fundMkt, valueByCode, quoteFail };
    },

    /**
     * 模拟盘资产口径: 模拟现金 (kv 'paper_account') + 模拟持仓市值 (isPaper=true 行)
     * 与实盘账本完全隔离, 分母同为模拟口径
     */
    async _getPaperAssets() {
      const acc = (await window.Core.Storage.kvGet('paper_account')) || { cash: 0 };
      const cash = parseFloat(acc.cash) || 0;
      const holdings = ((await window.Core.Storage.all('holdings')) || []).filter(h => h.isPaper);
      let stockMkt = 0, quoteFail = 0;
      const valueByCode = {};
      await Promise.all(holdings.map(async h => {
        const shares = parseFloat(h.shares) || 0;
        if (shares <= 0) return;
        let price = null;
        try {
          const q = await window.Core.Data.getStockQuote(h.code);
          price = q ? (parseFloat(q.最新价 ?? q.price) || null) : null;
        } catch (e) {
          console.warn('[Discipline] 拉行情失败:', h.code, e);
        }
        if (!price) { quoteFail++; price = parseFloat(h.costPrice ?? h.cost) || 0; } // 行情失败回退成本价
        const v = shares * price;
        valueByCode[h.code] = (valueByCode[h.code] || 0) + v;
        stockMkt += v;
      }));
      return { cash, stockMkt, fundMkt: 0, totalAssets: cash + stockMkt, valueByCode, quoteFail };
    },

    // ========== 主入口: 买入前纪律检查 ==========

    /**
     * 买入前纪律检查 (实盘/模拟盘共用)
     * @param {{ code: string, name?: string, market?: string, price?: number,
     *           shares?: number, amount?: number, isPaper?: boolean,
     *           assumption?: string, stopLoss?: number }} input
     * @returns {Promise<{ ok: boolean, blocks: string[], warns: string[], history: string[] }>}
     *   ok = blocks.length === 0; 检查本身失败不 block 交易, 降级为 warn
     */
    async preBuyCheck(input) {
      const result = { ok: true, blocks: [], warns: [], history: [] };
      const config = await this.getConfig();
      if (!config.enabled) return result; // 引擎关闭 → 全部放行
      input = input || {};
      const price = parseFloat(input.price) || 0;

      // 1. 输入校验 (不依赖外部数据, 永远执行)
      result.blocks.push(...this._checkInputs({ assumption: input.assumption, stopLoss: input.stopLoss, price }));

      try {
        const code = input.code;
        const shares = parseFloat(input.shares) || 0;
        const buyAmount = parseFloat(input.amount) || (price * shares) || 0;

        // 2. 资产口径 (isPaper 决定走哪套账本)
        const assets = input.isPaper ? await this._getPaperAssets() : await this._getRealAssets();
        if (assets.quoteFail > 0) result.warns.push('部分行情不可用, 已按成本价估算, 检查结果可能偏宽');
        if (!(assets.totalAssets > 0)) {
          result.warns.push('总资产为 0 (未记账?), 比例类检查跳过');
        } else {
          // 3. 单票集中度 (含同 code 已有持仓 + 本次买入)
          const positionValue = (assets.valueByCode[code] || 0) + buyAmount;
          const concBlock = this._checkConcentration({ positionValue, totalAssets: assets.totalAssets, config });
          if (concBlock) result.blocks.push(concBlock);

          // 4. 股票总仓位 (买入不改变总资产: 现金↓股票↑, 分母用买入前口径)
          const posBlock = this._checkTotalPosition({ stockValue: assets.stockMkt + buyAmount, totalAssets: assets.totalAssets, config });
          if (posBlock) result.blocks.push(posBlock);

          // 5. 月度回撤熔断 (月初首次检查写锚点, 跨月自动重置; 实盘/模拟盘各自锚定)
          const anchorKey = input.isPaper ? ANCHOR_KEY_PAPER : ANCHOR_KEY;
          const month = this._currentMonth();
          const oldAnchor = await window.Core.Storage.kvGet(anchorKey);
          const anchor = this._monthAnchorNext(oldAnchor, month, assets.totalAssets);
          if (anchor !== oldAnchor) await window.Core.Storage.kvSet(anchorKey, anchor);
          const ddBlock = this._checkDrawdown({ currentTotal: assets.totalAssets, anchor, config });
          if (ddBlock) result.blocks.push(ddBlock);
        }

        // 6. 追高 (当日涨跌幅, 拉不到行情只提示不拦)
        try {
          const q = await window.Core.Data.getStockQuote(code);
          const changePct = q ? parseFloat(q.涨跌幅 ?? q.changePct) : NaN;
          const chaseWarn = this._checkChase({ changePct, config });
          if (chaseWarn) result.warns.push(chaseWarn);
        } catch (e) {
          console.warn('[Discipline] 追高检查行情失败:', e);
          result.warns.push('行情不可用, 追高检查跳过');
        }

        // 7. 重复错误拦截 (同代码 + 同假设的历史复盘, 不建新表)
        const codeJournals = code ? (await window.Core.Storage.where('journals', 'code', code)) : [];
        const allJournals = (await window.Core.Storage.all('journals')) || [];
        const sameAssumption = input.assumption ? allJournals.filter(j => j.assumption === input.assumption) : [];
        result.history = this._summarizeHistory(codeJournals, sameAssumption, input.assumption);
        if (result.history.length) result.warns.push('📜 ' + result.history.join('；'));
      } catch (e) {
        // 检查本身失败 (行情/存储异常) 不得 block 交易, 降级为 warn
        console.warn('[Discipline] 检查失败, 降级放行:', e);
        result.warns.push('行情/存储不可用, 部分检查跳过');
      }

      result.ok = result.blocks.length === 0;
      return result;
    },

    // ========== UI 助手 ==========

    /**
     * 检查结果 → HTML 字符串 (全部 escapeHtml, 可直接 innerHTML 进确认区)
     * @param {{ blocks: string[], warns: string[], history: string[] }} result
     * @returns string
     */
    renderCheckResult(result) {
      if (!result) return '';
      const esc = (s) => window.Core.Util.escapeHtml(s);
      const parts = [];
      if (result.blocks && result.blocks.length) {
        parts.push(
          '<div class="discipline-result" style="border-left:3px solid var(--down);padding:6px 10px;margin:8px 0;background:rgba(248,81,73,.08);">' +
          result.blocks.map(b => `<div style="color:var(--down);font-size:12px;">⛔ ${esc(b)}</div>`).join('') +
          '</div>'
        );
      }
      if (result.warns && result.warns.length) {
        parts.push(
          '<div class="discipline-result" style="border-left:3px solid var(--warn, #d29922);padding:6px 10px;margin:8px 0;background:rgba(210,153,34,.08);">' +
          result.warns.map(w => `<div style="color:var(--warn, #d29922);font-size:12px;">⚠️ ${esc(w)}</div>`).join('') +
          '</div>'
        );
      }
      return parts.join('');
    },

    /**
     * 检查结果 → 纯文本 (供 confirm 展示; history 已在 preBuyCheck 里折叠进 warns)
     * @returns string
     */
    _resultToText(result) {
      if (!result) return '';
      const lines = [];
      (result.warns || []).forEach(w => lines.push('⚠️ ' + w));
      (result.blocks || []).forEach(b => lines.push('⛔ ' + b));
      return lines.join('\n');
    }
  };
})();
