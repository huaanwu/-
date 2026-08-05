/**
 * AI 管家 renderer-direct 工具集 — 全盘接管 v0.2.0
 *
 * 跟 electron/agent-registry.js (主进程) 不同:
 *   - 这些工具跑在 renderer 进程, 直接调 window.{Domain} API
 *   - 延迟低 (无 IPC), 复用现有域 API
 *   - 适用 UI/数据/写入操作
 * 主进程工具 (文件系统 / 重启 / 健康) 保留在 agent-registry.js
 *
 * 加载顺序: agent.js 加载完后, 在 app.js init() 里 await Core.AgentTools.init()
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;

  /** 工具注册表: name -> { risk, description, schema, handler } */
  const tools = new Map();

  function reg(t) {
    if (!t.name || !t.handler) throw new Error('[AgentTools] 缺 name/handler');
    if (!['L', 'M', 'H'].includes(t.risk)) throw new Error('[AgentTools] 风险等级须 L/M/H: ' + t.name);
    tools.set(t.name, t);
    return t;
  }

  function list() {
    return Array.from(tools.values()).map(t => ({
      name: t.name, risk: t.risk, description: t.description
    }));
  }

  function get(name) { return tools.get(name); }

  /** 工具分发入口. args + ctx 由 Core.Agent 注入. */
  async function invoke(name, args, ctx) {
    const t = tools.get(name);
    if (!t) return { ok: false, error: '未知工具: ' + name };
    try {
      const out = await t.handler(args || {}, ctx || {});
      return { ok: true, data: out };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  // ============ 页面导航 (M) ============
  reg({
    name: 'ui.navigateTo',
    risk: 'M',
    description: '切换到指定页面 (pageWatchlist/pageAccount/pageHoldings/pagePaper/pageJournal/pageScreener/pageStockAdvisor/pageShortTrader/pageLongTrader/pageBacktest/pageAlerts/pageFund/pageSettings)',
    input_schema: {
      type: 'object',
      properties: { pageId: { type: 'string', description: '页面 ID, 例 pageWatchlist' } },
      required: ['pageId'],
      additionalProperties: false
    },
    handler: async ({ pageId }) => {
      if (!Core.Router || !Core.Router.switchPage) throw new Error('Core.Router 未就绪');
      // BUGFIX P2-9: 原代码写死 13 个 pageId, 新增页面要手动同步, 容易漏.
      //   修后用 Core.Router.listPages() 从 DOM 实时扫 .nav-item + .page[id],
      //   新增 page 自动在白名单, 无需改本文件.
      //   兜底: DOM 不可用 (vm 测试 / 极简环境) 时用内置 fallback, 保证向后兼容.
      let valid = (Core.Router.listPages && typeof Core.Router.listPages === 'function')
        ? Core.Router.listPages() : [];
      if (valid.length === 0) {
        valid = ['pageWatchlist','pageAccount','pageHoldings','pagePaper','pageJournal',
          'pageScreener','pageStockAdvisor','pageShortTrader','pageLongTrader','pageBacktest',
          'pageAlerts','pageFund','pageSettings'];
      }
      if (!valid.includes(pageId)) throw new Error('未知页面: ' + pageId + ', 可用: ' + valid.join(', '));
      Core.Router.switchPage(pageId);
      return { navigated: pageId };
    }
  });

  // ============ 读: 自选股 (L) ============
  reg({
    name: 'watchlist.list',
    risk: 'L',
    description: '列出当前自选股 (代码 + 名称)',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const list = await Core.Storage.all('watchlist');
      return { count: list.length, items: list.map(w => ({ code: w.code, name: w.name })) };
    }
  });

  // ============ 写: 自选股 (H) ============
  reg({
    name: 'watchlist.add',
    risk: 'H',
    description: '添加自选股 (代码或"代码 名称"格式). 跳过 UI 弹窗, 直接写库',
    input_schema: {
      type: 'object',
      properties: { input: { type: 'string', description: '代码或代码+名称, 例 "600519" 或 "600519 贵州茅台"' } },
      required: ['input'],
      additionalProperties: false
    },
    handler: async ({ input }) => {
      const parsed = Core.Util.parseStockInput(input);
      if (!parsed) throw new Error('无法解析: ' + input);
      const exists = await Core.Storage.get('watchlist', parsed.code);
      if (exists) return { added: false, reason: 'already_exists', code: parsed.code };
      await Core.Storage.add('watchlist', { code: parsed.code, name: parsed.name || '', addedAt: Date.now() });
      if (window.Watchlist && window.Watchlist.render) window.Watchlist.render();
      return { added: true, code: parsed.code, name: parsed.name };
    }
  });

  reg({
    name: 'watchlist.remove',
    risk: 'H',
    description: '从自选股删除 (跳过 UI confirm)',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false
    },
    handler: async ({ code }) => {
      await Core.Storage.remove('watchlist', code);
      if (window.Watchlist && window.Watchlist.render) window.Watchlist.render();
      return { removed: code };
    }
  });

  // ============ 读: 持仓 (L) ============
  reg({
    name: 'holdings.list',
    risk: 'L',
    description: '列出当前持仓 (代码 + 数量 + 成本)',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const list = await Core.Storage.all('holdings');
      return { count: list.length, items: list };
    }
  });

  // ============ 读: 提醒 (L) ============
  reg({
    name: 'alerts.list',
    risk: 'L',
    description: '列出当前提醒规则',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const list = await Core.Storage.all('alerts');
      return { count: list.length, items: list };
    }
  });

  // ============ 写: 提醒 (H) ============
  reg({
    name: 'alerts.remove',
    risk: 'H',
    description: '按 code 删除提醒规则',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false
    },
    handler: async ({ code }) => {
      // BUGFIX P0-3: 原代码直接 remove('alerts', code), 但 alerts 表主键是 id (UUID) 不是 code.
      //   6 位代码 '600519' 不会匹配任何 id → 工具永远删不成功.
      //   修后按 code 索引查所有匹配行, 再逐个按 id 删.
      const matched = (await Core.Storage.where('alerts', 'code', code)) || [];
      for (const a of matched) {
        await Core.Storage.remove('alerts', a.id);
      }
      if (window.Alerts && window.Alerts.render) window.Alerts.render();
      return { removed: code, count: matched.length };
    }
  });

  // ============ 读: 模拟盘 (L) ============
  // 注意: paper 模块复用了 holdings 表 (行上 isPaper=true 标记), schema 里没有
  //       paper_positions / paper_holdings 这两个独立表名, 直接 d.xxx.toArray() 会
  //       抛 'Cannot read properties of undefined (reading toArray)'
  reg({
    name: 'paper.positions',
    risk: 'L',
    description: '列出模拟盘持仓 (复用 holdings 表 + isPaper=true 过滤)',
    input_schema: {
      type: 'object',
      properties: {
        sleeve: { type: 'string', enum: ['long', 'short', 'all'], description: "子账户过滤: long=长线 / short=短线 / all=全部 (默认 long)" }
      },
      additionalProperties: false
    },
    handler: async ({ sleeve = 'long' } = {}) => {
      const all = (await Core.Storage.all('holdings')) || [];
      let items = all.filter(h => h && h.isPaper === true);
      if (sleeve !== 'all') {
        items = items.filter(h => (h.sleeve || 'long') === sleeve);
      }
      // 顺手带上 account 概览, UI 不用再发第二次
      const accKey = sleeve === 'short' ? 'paper_account_short' : 'paper_account';
      const acc = (await Core.Storage.kvGet(accKey)) || null;
      return { count: items.length, sleeve, items, account: acc };
    }
  });

  // ============ 读: 复盘 (L) ============
  reg({
    name: 'journal.list',
    risk: 'L',
    description: '列出复盘笔记',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      // BUGFIX P0-2: 表名是 'journals' (复数), 原 'journal' 永远返空
      const list = await Core.Storage.all('journals');
      return { count: list.length, items: list };
    }
  });

  // ============ 写: 复盘 (H) ============
  reg({
    name: 'journal.save',
    risk: 'H',
    description: '保存复盘笔记 (强制 overwrite 同名 entry)',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['title', 'content'],
      additionalProperties: false
    },
    handler: async ({ title, content }) => {
      // BUGFIX P0-2: 表名是 'journals' (复数), 原 'journal' 抛 TypeError
      const id = 'manual-' + Date.now();
      await Core.Storage.add('journals', { id, title, content, createdAt: Date.now() });
      if (window.Journal && window.Journal.render) window.Journal.render();
      return { saved: id, title };
    }
  });

  // ============ 读: 资金账户 (L) ============
  reg({
    name: 'account.summary',
    risk: 'L',
    description: '列出账户流水 (近 10 条)',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      // BUGFIX P0-2: 资金流水表名是 'cashflow', 原 'account' 永远返空
      const list = await Core.Storage.all('cashflow');
      return { count: list.length, recent: list.slice(-10) };
    }
  });

  // ============ 触发: AI 自动选 (L, 读多) ============
  reg({
    name: 'trigger.runLongTrader',
    risk: 'M',
    description: '触发长线 AI 自动选股 (currentPage 切到 longTrader)',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      if (!Core.Router) throw new Error('路由未就绪');
      Core.Router.switchPage('pageLongTrader');
      // 触发 onShow 中可能挂的 runNow
      const long = window.Long || window._longTrader;
      if (long && typeof long.runNow === 'function') {
        long.runNow().catch(e => console.warn('[AgentTools] long.runNow:', e.message));
        return { triggered: true, mode: 'auto' };
      }
      return { triggered: true, mode: 'page_only', note: '无 runNow, 用户自行点按钮' };
    }
  });

  reg({
    name: 'trigger.runShortTrader',
    risk: 'M',
    description: '触发短线 AI 盘前计划',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      Core.Router.switchPage('pageShortTrader');
      const short = window.Short || window._shortTrader;
      if (short && typeof short.runNow === 'function') {
        short.runNow().catch(e => console.warn('[AgentTools] short.runNow:', e.message));
        return { triggered: true, mode: 'auto' };
      }
      return { triggered: true, mode: 'page_only' };
    }
  });

  reg({
    name: 'trigger.runScreener',
    risk: 'M',
    description: '触发选股筛选',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      Core.Router.switchPage('pageScreener');
      if (window.Screener && typeof window.Screener.runNow === 'function') {
        window.Screener.runNow().catch(e => console.warn('[AgentTools] screener.runNow:', e.message));
        return { triggered: true, mode: 'auto' };
      }
      return { triggered: true, mode: 'page_only' };
    }
  });

  reg({
    name: 'trigger.runBacktest',
    risk: 'M',
    description: '触发回测 (需要先在 pageBacktest 选好策略)',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      Core.Router.switchPage('pageBacktest');
      if (window.Backtest && typeof window.Backtest.runNow === 'function') {
        window.Backtest.runNow().catch(e => console.warn('[AgentTools] backtest.runNow:', e.message));
        return { triggered: true, mode: 'auto' };
      }
      return { triggered: true, mode: 'page_only' };
    }
  });

  reg({
    name: 'trigger.checkAlerts',
    risk: 'M',
    description: '触发一次提醒检查',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      if (window.Alerts && window.Alerts.runLongChecks) {
        await window.Alerts.runLongChecks();
        return { triggered: true };
      }
      throw new Error('Alerts.runLongChecks 未就绪');
    }
  });

  window.Core.AgentTools = {
    init: async function () {
      console.log('[AgentTools] 已注册 ' + tools.size + ' 个工具');
    },
    list,
    get,
    invoke,
    register: reg
  };
})();
