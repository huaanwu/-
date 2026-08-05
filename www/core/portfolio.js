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

  async function _getStockMkt(paperOnly, sleeve) {
    const holdings = ((await window.Core.Storage.all('holdings')) || [])
      .filter(h => paperOnly ? !!h.isPaper : !h.isPaper)
      // T1 分账户: 模拟盘按 sleeve 过滤; 存量行无 sleeve 字段视为 'long' (向后兼容)
      .filter(h => !paperOnly || (h.sleeve || 'long') === sleeve);
    let stockMkt = 0, quoteFail = 0;
    // Phase 2.4: 走 Facade.getQuoteMany 批量, 节省 N 次 fetch → 1 次批量
    // quote 失败回退 costPrice, 累加 valueByCode (被外部 portfolio 聚合使用)
    const valueByCode = {};
    const codes = holdings.filter(h => (parseFloat(h.shares) || 0) > 0).map(h => h.code).filter(Boolean);
    const envs = await window.Core.Data.Facade.getQuoteMany(codes).catch(() => []);
    const envByCode = {};
    envs.forEach(env => {
      if (env && env.symbol) envByCode[env.symbol] = env;
    });
    holdings.forEach((h) => {
      const shares = parseFloat(h.shares) || 0;
      if (shares <= 0) return;
      const env = envByCode[h.code];
      let price = (env && env.payload && env.payload.price != null) ? env.payload.price : null;
      if (price == null) { quoteFail++; price = parseFloat(h.costPrice ?? h.cost) || 0; }
      const v = shares * price;
      valueByCode[h.code] = (valueByCode[h.code] || 0) + v;
      stockMkt += v;
    });
    return { stockMkt, quoteFail, valueByCode };
  }

  async function _getFundMkt(paperOnly) {
    // 基金无 isPaper 字段 (paper 模式不持基金), paper 模式直接跳过
    if (paperOnly) return { fundMkt: 0, quoteFail: 0 };
    const funds = (await window.Core.Storage.all('funds')) || [];
    let fundMkt = 0, quoteFail = 0;
    // BUGFIX P1-5: 原代码 `Promise.all(funds.map(...))` 一把全打, 100 只基金 = 100 并发.
    //   aktools 没限流, 触发 429/超时后全部失败 → fundMkt 全部回退 costNav, 估值偏宽.
    //   修后: 分批 8 并发 + 同批内 Promise.all. 200 只基金 ≈ 25s, 仍可接受, 但服务端压力降一个数量级.
    const CONCURRENCY = 8;
    const NAV_TASKS = funds
      .filter(f => (parseFloat(f && f.shares) || 0) > 0)
      .map(f => async () => {
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
        if (!nav) {
          quoteFail++;
          nav = parseFloat(f.costNav) || 0;
        }
        const shares = parseFloat(f.shares) || 0;
        fundMkt += shares * nav;
      });
    for (let i = 0; i < NAV_TASKS.length; i += CONCURRENCY) {
      await Promise.all(NAV_TASKS.slice(i, i + CONCURRENCY).map(t => t()));
    }
    return { fundMkt, quoteFail };
  }

  async function _getCash(paperOnly, sleeve) {
    if (paperOnly) {
      // T1: 'long' 沿用存量 kv paper_account (不迁移), 'short' 用 paper_account_short
      const key = sleeve === 'short' ? 'paper_account_short' : 'paper_account';
      const acc = (await window.Core.Storage.kvGet(key)) || { cash: 0 };
      return parseFloat(acc.cash) || 0;
    }
    return parseFloat(window.Core.State.get('accountCash')) || 0;
  }

  /**
   * @param {{ paper?: boolean, sleeve?: 'long'|'short' }} [opts]
   *        sleeve 仅 paper=true 时有效, 默认 'long' (存量数据无 sleeve 字段 = long)
   * @returns { Promise<{ cash, stockMkt, fundMkt, totalAssets, valueByCode, quoteFail, paper: boolean, sleeve: string }> }
   */
  async function getAssets(opts = {}) {
    const paper = !!opts.paper;
    const sleeve = opts.sleeve === 'short' ? 'short' : 'long';
    const cash = await _getCash(paper, sleeve);
    const s = await _getStockMkt(paper, sleeve);
    const f = await _getFundMkt(paper);
    const totalAssets = paper ? (cash + s.stockMkt) : (cash + s.stockMkt + f.fundMkt);
    return {
      cash, stockMkt: s.stockMkt, fundMkt: f.fundMkt,
      totalAssets,
      valueByCode: s.valueByCode,
      quoteFail: s.quoteFail + f.quoteFail,
      paper,
      sleeve
    };
  }

  window.Core.Portfolio = { getAssets };
})();