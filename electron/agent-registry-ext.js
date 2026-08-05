/**
 * V13 agentRegistry 扩展 — 域写工具 (R/W 两档, 25 个工具目标)
 *
 * 调 renderer 域方法走 executeJavaScript 桥 (main → renderer)
 * W 类工具在 source='feishu' 时自动走 permission.askConfirm 飞书双确认
 *
 * 加载顺序: agent-registry.js (5 个内建) → agent-registry-ext.js (本文件)
 * 不重复注册同名工具
 */
const { BrowserWindow, app } = require('electron');

/** 测试钩子: 强制 _pickWindow 返 null (V13 测试用) */
function _setPickWindowNull(enabled) {
  _forceNull = !!enabled;
}
let _forceNull = false;

/** 拿到主窗口 (无则返 null, headless 模式下允许降级到 IPC 通知) */
function _pickWindow() {
  if (_forceNull) return null;
  try {
    return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  } catch (e) {
    return null;
  }
}

/**
 * 主进程通用: executeJavaScript 调 renderer 域方法
 * @param {string} expr 完整 JS 表达式 (返 Promise)
 * @param {object} args JSON-safe 入参
 * @returns {Promise<any>}
 */
async function _execInRenderer(expr, args) {
  const win = _pickWindow();
  if (!win) {
    throw new Error('[AgentExt] 无窗口 (headless 模式需切到 IPC 通知路径)');
  }
  // executeJavaScript 不支持 args 形式入参, 必须 stringify 注入
  const argJson = args === undefined ? 'undefined' : JSON.stringify(args);
  const fullExpr = `(${expr})(${argJson})`;
  return win.webContents.executeJavaScript(fullExpr, true);
}

/** 检测是否来自飞书 (W 类需飞书双确认) */
function _isFeishuSource(ctx) {
  return ctx && ctx.source === 'feishu' && typeof ctx.userOpenId === 'string';
}

/** W 类写操作前的飞书确认 (permission.js 在阶段 2 接入, 此处先 stub) */
async function _maybeFeishuConfirm(toolName, args, ctx) {
  if (!_isFeishuSource(ctx)) return true;   // 非飞书调用直接通过 (renderer 弹窗兜底)
  // TODO 阶段 3: 调 permission.askConfirm(toolName, args, ctx.userOpenId)
  // 当前先 console.warn, 不阻塞
  console.warn('[AgentExt] W 类工具 ' + toolName + ' 来自飞书, 应走 permission.askConfirm, 当前 stub 通过');
  return true;
}

function registerExtension(agentRegistry) {
  // ========== 自选股 (Watchlist) ==========
  agentRegistry.register({
    name: 'watchlist.add',
    risk: 'W',
    description: '添加自选股。接受 input="代码 名称" 或 {code, name}。',
    input_schema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '代码或"代码 名称", 例 "600519 贵州茅台"' },
        code: { type: 'string', description: '股票代码, 跟 input 二选一' },
        name: { type: 'string', description: '股票名称 (可选)' }
      },
      additionalProperties: false
    },
    handler: async (args, ctx) => {
      if (!await _maybeFeishuConfirm('watchlist.add', args, ctx)) throw new Error('飞书未确认');
      const input = args.input || ((args.code || '') + ' ' + (args.name || '')).trim();
      if (!input) throw new Error('缺 input 或 code');
      return _execInRenderer('(input) => window.Watchlist.add(input)', { input });
    }
  });

  agentRegistry.register({
    name: 'watchlist.remove',
    risk: 'W',
    description: '删除自选股 (按 code)。',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false
    },
    handler: async ({ code }, ctx) => {
      if (!await _maybeFeishuConfirm('watchlist.remove', { code }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(code) => window.Watchlist.remove(code)', { code });
    }
  });

  // ========== 持仓 (Holdings) ==========
  agentRegistry.register({
    name: 'holdings.list',
    risk: 'R',
    description: '列出当前实盘/模拟盘所有持仓 (不区分 isPaper)。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => _execInRenderer('() => window.Core.Storage.all("holdings")')
  });

  agentRegistry.register({
    name: 'holdings.save',
    risk: 'W',
    description: '新建/更新持仓 (id=null 新建, 否则改)。从表单字段填入。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '持仓 ID, null/undefined = 新建' },
        fields: {
          type: 'object',
          description: '持仓字段 {code, name, shares, cost, sleeve, isPaper, ...}',
          additionalProperties: true
        }
      },
      additionalProperties: false
    },
    handler: async ({ id, fields }, ctx) => {
      if (!await _maybeFeishuConfirm('holdings.save', { id, fields }, ctx)) throw new Error('飞书未确认');
      // 模拟表单: 写入 _formDialog 编辑字段再调 save
      return _execInRenderer(
        '({id, fields}) => { window.Holdings._formDialog(id, fields); return window.Holdings.save(id); }',
        { id: id || null, fields: fields || {} }
      );
    }
  });

  agentRegistry.register({
    name: 'holdings.remove',
    risk: 'W',
    description: '删除持仓 (级联删除关联 transactions)。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }, ctx) => {
      if (!await _maybeFeishuConfirm('holdings.remove', { id }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(id) => window.Holdings.remove(id)', { id });
    }
  });

  agentRegistry.register({
    name: 'holdings.saveTx',
    risk: 'W',
    description: '给指定持仓追加一笔交易流水 (买入/卖出/分红)。',
    input_schema: {
      type: 'object',
      properties: {
        holdingId: { type: 'string' },
        fields: { type: 'object', additionalProperties: true }
      },
      required: ['holdingId'],
      additionalProperties: false
    },
    handler: async ({ holdingId, fields }, ctx) => {
      if (!await _maybeFeishuConfirm('holdings.saveTx', { holdingId, fields }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer(
        '({holdingId, fields}) => { window.Holdings._formDialog(null, { ...fields, holdingId }); return window.Holdings.saveTx(holdingId); }',
        { holdingId, fields: fields || {} }
      );
    }
  });

  agentRegistry.register({
    name: 'holdings.confirmPending',
    risk: 'W',
    description: '确认一笔待确认交易 (从 pending → 实际成交)。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }, ctx) => {
      if (!await _maybeFeishuConfirm('holdings.confirmPending', { id }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(id) => window.Holdings.confirmPending(id)', { id });
    }
  });

  agentRegistry.register({
    name: 'holdings.rejectPending',
    risk: 'W',
    description: '拒绝一笔待确认交易 (从 pending 删除)。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }, ctx) => {
      if (!await _maybeFeishuConfirm('holdings.rejectPending', { id }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(id) => window.Holdings.rejectPending(id)', { id });
    }
  });

  // ========== 模拟盘 (Paper) ==========
  agentRegistry.register({
    name: 'paper.buy',
    risk: 'W',
    description: '模拟盘买入。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        name: { type: 'string' },
        market: { type: 'string', enum: ['SH', 'SZ', 'BJ'] },
        shares: { type: 'number' },
        opts: { type: 'object', additionalProperties: true, description: 'Paper.buy 额外参数 (sleeve, price, reason...)' }
      },
      required: ['code', 'shares'],
      additionalProperties: false
    },
    handler: async ({ code, name, market, shares, opts }, ctx) => {
      if (!await _maybeFeishuConfirm('paper.buy', { code, shares }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer(
        '({code, name, market, shares, opts}) => window.Paper.buy(code, name, market, shares, opts)',
        { code, name: name || '', market: market || 'SH', shares, opts: opts || {} }
      );
    }
  });

  agentRegistry.register({
    name: 'paper.sell',
    risk: 'W',
    description: '模拟盘卖出 (按 holdingId 减仓)。',
    input_schema: {
      type: 'object',
      properties: {
        holdingId: { type: 'string' },
        shares: { type: 'number' },
        opts: { type: 'object', additionalProperties: true }
      },
      required: ['holdingId', 'shares'],
      additionalProperties: false
    },
    handler: async ({ holdingId, shares, opts }, ctx) => {
      if (!await _maybeFeishuConfirm('paper.sell', { holdingId, shares }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer(
        '({holdingId, shares, opts}) => window.Paper.sell(holdingId, shares, opts)',
        { holdingId, shares, opts: opts || {} }
      );
    }
  });

  agentRegistry.register({
    name: 'paper.resetAccount',
    risk: 'W',
    description: '重置模拟盘子账户 (清空现金 + 持仓)。sleeve=long|short。',
    input_schema: {
      type: 'object',
      properties: { sleeve: { type: 'string', enum: ['long', 'short'] } },
      additionalProperties: false
    },
    handler: async ({ sleeve }, ctx) => {
      if (!await _maybeFeishuConfirm('paper.resetAccount', { sleeve }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(sleeve) => window.Paper.resetAccount(sleeve)', { sleeve: sleeve || 'long' });
    }
  });

  agentRegistry.register({
    name: 'paper.addCondOrder',
    risk: 'W',
    description: '模拟盘条件单: 触发后自动买入 (例 价格跌到 X 时买 100 股)。',
    input_schema: {
      type: 'object',
      properties: {
        order: { type: 'object', additionalProperties: true }
      },
      required: ['order'],
      additionalProperties: false
    },
    handler: async ({ order }, ctx) => {
      if (!await _maybeFeishuConfirm('paper.addCondOrder', { order }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(order) => window.Paper.addCondOrder(order)', { order });
    }
  });

  agentRegistry.register({
    name: 'paper.cancelCondOrder',
    risk: 'W',
    description: '撤销一笔条件单。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }, ctx) => {
      if (!await _maybeFeishuConfirm('paper.cancelCondOrder', { id }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(id) => window.Paper.cancelCondOrder(id)', { id });
    }
  });

  // ========== 提醒 (Alerts) ==========
  agentRegistry.register({
    name: 'alerts.list',
    risk: 'R',
    description: '列出当前所有提醒规则。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => _execInRenderer('() => window.Core.Storage.all("alerts")')
  });

  agentRegistry.register({
    name: 'alerts.create',
    risk: 'W',
    description: '新建一条提醒规则 (code + 条件)。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        name: { type: 'string' },
        rule: { type: 'object', additionalProperties: true, description: '提醒条件 {type, threshold, direction}' }
      },
      required: ['code'],
      additionalProperties: false
    },
    handler: async ({ code, name, rule }, ctx) => {
      if (!await _maybeFeishuConfirm('alerts.create', { code, rule }, ctx)) throw new Error('飞书未确认');
      // 模拟新建表单字段填入 + 调 save
      return _execInRenderer(
        '({code, name, rule}) => { window.Alerts._formDialog(null, { code, name, rule }); return window.Alerts.save(); }',
        { code, name: name || '', rule: rule || {} }
      );
    }
  });

  agentRegistry.register({
    name: 'alerts.toggle',
    risk: 'W',
    description: '启/停一条提醒规则 (按 id)。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }, ctx) => {
      if (!await _maybeFeishuConfirm('alerts.toggle', { id }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(id) => window.Alerts.toggle(id)', { id });
    }
  });

  // ========== 复盘 (Journal) ==========
  agentRegistry.register({
    name: 'journal.list',
    risk: 'R',
    description: '列出所有复盘笔记。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => _execInRenderer('() => window.Core.Storage.all("journal")')
  });

  agentRegistry.register({
    name: 'journal.save',
    risk: 'W',
    description: '保存一篇复盘笔记 (id=null 新建, 否则覆盖)。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' }
      },
      additionalProperties: false
    },
    handler: async ({ id, title, content }, ctx) => {
      if (!await _maybeFeishuConfirm('journal.save', { id, title }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer(
        '({id, title, content}) => window.Journal.save(id, { title, content })',
        { id: id || null, title: title || '', content: content || '' }
      );
    }
  });

  agentRegistry.register({
    name: 'journal.remove',
    risk: 'W',
    description: '删除一篇复盘笔记。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }, ctx) => {
      if (!await _maybeFeishuConfirm('journal.remove', { id }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer('(id) => window.Journal.remove(id)', { id });
    }
  });

  // ========== 资金账户 (Account) ==========
  agentRegistry.register({
    name: 'account.summary',
    risk: 'R',
    description: '账户资金概览 (现金 + 持仓 + 总资产)。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => _execInRenderer('() => window.Core.Portfolio.getAssets({paper:false})')
  });

  agentRegistry.register({
    name: 'account.cashflowAdd',
    risk: 'W',
    description: '新增一条资金流水 (入金/出金/分红等)。',
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'object', additionalProperties: true, description: '流水字段 {date, type, amount, note}' }
      },
      required: ['fields'],
      additionalProperties: false
    },
    handler: async ({ fields }, ctx) => {
      if (!await _maybeFeishuConfirm('account.cashflowAdd', { fields }, ctx)) throw new Error('飞书未确认');
      return _execInRenderer(
        '({fields}) => { window.Account._openFlowDialog(fields); return window.Account.saveFlow(); }',
        { fields: fields || {} }
      );
    }
  });

  // ========== 触发器 (AI 调度入口) ==========
  agentRegistry.register({
    name: 'trigger.runLongTrader',
    risk: 'W',
    description: '触发长线 AI 选股 (周一自动跑, 这里手动触发)。',
    input_schema: {
      type: 'object',
      properties: { opts: { type: 'object', additionalProperties: true } },
      additionalProperties: false
    },
    handler: async ({ opts }, ctx) => {
      if (!await _maybeFeishuConfirm('trigger.runLongTrader', {}, ctx)) throw new Error('飞书未确认');
      // 修 V12 trigger bug: window.LongTrader 而非 window.Long
      return _execInRenderer(
        '({opts}) => window.LongTrader && window.LongTrader.runNow ? window.LongTrader.runNow(opts || {}) : { error: "LongTrader.runNow 未就绪" }',
        { opts: opts || {} }
      );
    }
  });

  agentRegistry.register({
    name: 'trigger.runShortTrader',
    risk: 'W',
    description: '触发短线 AI 盘前计划。',
    input_schema: {
      type: 'object',
      properties: { opts: { type: 'object', additionalProperties: true } },
      additionalProperties: false
    },
    handler: async ({ opts }, ctx) => {
      if (!await _maybeFeishuConfirm('trigger.runShortTrader', {}, ctx)) throw new Error('飞书未确认');
      return _execInRenderer(
        '({opts}) => window.ShortTrader && window.ShortTrader.runNow ? window.ShortTrader.runNow(opts || {}) : { error: "ShortTrader.runNow 未就绪" }',
        { opts: opts || {} }
      );
    }
  });

  agentRegistry.register({
    name: 'trigger.runScreener',
    risk: 'R',
    description: '触发选股筛选 (R 类: 只读不写)。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => _execInRenderer('() => window.Screener && window.Screener.run ? window.Screener.run() : { error: "Screener.run 未就绪" }', {})
  });

  agentRegistry.register({
    name: 'trigger.checkAlerts',
    risk: 'R',
    description: '触发一次提醒规则检查 (R 类)。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => _execInRenderer('() => window.Alerts && window.Alerts.runLongChecks ? window.Alerts.runLongChecks() : { error: "Alerts.runLongChecks 未就绪" }', {})
  });

  console.log('[AgentExt] 已注册扩展工具 (总计 22 个 W/R 写工具)');
}

module.exports = { registerExtension, _setPickWindowNull };