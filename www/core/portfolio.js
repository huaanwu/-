/**
 * Core.Portfolio - 资产口径统一 (FIX-3)
 *
 * 之前 5 处变体:
 *   - Core.Discipline._getRealAssets()     (纪律检查)
 *   - Core.Discipline._getPaperAssets()    (纪律检查, 模拟盘)
 *   - www/app/account.js:106               (账户页)
 *   - www/app/paper.js:480 / :718          (模拟盘 UI 两处)
 *   - www/app.js:755-796                    (快照生成)
 *
 * 收口后: 所有调用方统一用 Core.Portfolio.getAssets({ paper: bool })
 *
 * 口径 (与 _getRealAssets 完全一致, 这是纪律检查的分母, 不能变):
 *   totalAssets = cash + stockMkt + fundMkt  (paper: 没有基金, 只有 cash + stockMkt)
 *   - cash:     实盘走 State.accountCash;  模拟盘走 kv 'paper_account'.cash
 *   - stockMkt: Σ(shares × 最新价), 行情拉取失败回退成本价 (costPrice ?? cost),
 *               quoteFail 计数, 调用方据此提示用户"估值偏宽"
 *   - fundMkt:  Σ(shares × 最新净值), 失败回退 costNav
 *   - valueByCode: { code: 市值 }, 给"单票集中度"等场景用 (纪律已用, AI prompt 也可参考)
 *
 * 加载顺序: 在 storage.js / data.js / state.js 之后, discipline 之前
 */
(function() {
  'use strict';
  window.Core = window.Core || {};

  async function _getStockMkt(paperOnly) {
    const holdings = ((await window.Core.Storage.all('holdings')) || [])
      .filter(h => paperOnly ? !!h.isPaper : !h.isPaper);
    let stockMkt = 0, quoteFail = 0;
    const valueByCode = {};
    await Promise.all(holdings.map(async (h) => {
      const shares = parseFloat(h.shares) || 0;
      if (shares <= 0) return;
      let price = null;
      try {
        const q = await window.Core.Data.getStockQuote(h.code);
        price = q ? (parseFloat(q.最新价 ?? q.price) || null) : null;
      } catch (e) {
        console.warn('[Portfolio] 拉行情失败:', h.code, e);
      }
      if (!price) { quoteFail++; price = parseFloat(h.costPrice ?? h.cost) || 0; }
      const v = shares * price;
      valueByCode[h.code] = (valueByCode[h.code] || 0) + v;
      stockMkt += v;
    }));
    return { stockMkt, quoteFail, valueByCode };
  }

  async function _getFundMkt(paperOnly) {
    // 基金无 isPaper 字段 (paper 模式不持基金), paper 模式直接跳过
    if (paperOnly) return { fundMkt: 0, quoteFail: 0 };
    const funds = (await window.Core.Storage.all('funds')) || [];
    let fundMkt = 0, quoteFail = 0;
    await Promise.all(funds.map(async (f) => {
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
        console.warn('[Portfolio] 拉基金净值失败:', f.code, e);
      }
      if (!nav) { quoteFail++; nav = parseFloat(f.costNav) || 0; }
      fundMkt += shares * nav;
    }));
    return { fundMkt, quoteFail };
  }

  async function _getCash(paperOnly) {
    if (paperOnly) {
      const acc = (await window.Core.Storage.kvGet('paper_account')) || { cash: 0 };
      return parseFloat(acc.cash) || 0;
    }
    return parseFloat(window.Core.State.get('accountCash')) || 0;
  }

  /**
   * @param {{ paper?: boolean }} [opts]
   * @returns { Promise<{ cash, stockMkt, fundMkt, totalAssets, valueByCode, quoteFail, paper: boolean }> }
   */
  async function getAssets(opts = {}) {
    const paper = !!opts.paper;
    const cash = await _getCash(paper);
    const s = await _getStockMkt(paper);
    const f = await _getFundMkt(paper);
    const totalAssets = paper ? (cash + s.stockMkt) : (cash + s.stockMkt + f.fundMkt);
    return {
      cash, stockMkt: s.stockMkt, fundMkt: f.fundMkt,
      totalAssets,
      valueByCode: s.valueByCode,
      quoteFail: s.quoteFail + f.quoteFail,
      paper
    };
  }

  window.Core.Portfolio = { getAssets };
})();