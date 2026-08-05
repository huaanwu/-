/**
 * Core.AlertsAgent - AI 代理操作 alerts 规则
 *
 * 目的: 用户是小白, 写规则不会用; 让 AI 替用户管理盯盘规则 (创建/修改/删除/解读)。
 * 设计原则:
 *   1) 两阶段落库: parseIntent → validateSpecs → previewSpecs → applySpecs (用户点确认才写)
 *   2) 白名单校验: type/field/枚举值 全部走硬编码白名单, 防止 AI 幻觉污染数据
 *   3) AI 只是文本生成器, 不是投资专家; 所有结构性决策 (类型选择/字段填充) 走 schema
 *   4) AI 解读: 现有规则触发时调用, 给一段自然语言解读, 不直接改规则
 *
 * 暴露方法 (window.Core.AlertsAgent):
 *   - parseIntent(userText, ctx?)         自然语言 → intent 结构 ({action, specs, reasoning})
 *   - validateSpecs(specs)                单条 spec 校验 → 修正或抛错
 *   - previewSpecs(intents)               多条 spec 预览 (UI 用)
 *   - applySpecs(preview, confirmed?)     用户确认后落库 (默认要求 confirmed=true)
 *   - suggestForHoldings(holdings)        扫描持仓 → 推荐应设哪些规则
 *   - interpretAlert(alert, history?)     已有规则触发 → AI 自然语言解读
 *
 * 不暴露:
 *   - 任何直接写 Storage 的方法 (apply 是唯一入口, 且要求 confirmed)
 *   - 任何 prompt 模板字符串 (调试时可单独 import, 不进 window)
 */
(function() {
  'use strict';

  // ============== 类型 / 字段白名单 (与 www/app/alerts.js 严格同步) ==============

  const TYPE_DEFS = {
    // 短线 (1 分钟轮询, 绑定个股)
    price_above:      { horizon: 'short', requires: ['code', 'value'], valueType: 'price',   unit: '元', min: 0.01, max: 100000 },
    price_below:      { horizon: 'short', requires: ['code', 'value'], valueType: 'price',   unit: '元', min: 0.01, max: 100000 },
    change_above:     { horizon: 'short', requires: ['code', 'value'], valueType: 'pct',     unit: '%',  min: 0.1,  max: 50 },
    change_below:     { horizon: 'short', requires: ['code', 'value'], valueType: 'pct',     unit: '%',  min: 0.1,  max: 50 },
    volume_above:     { horizon: 'short', requires: ['code', 'value'], valueType: 'volume',  unit: '手', min: 1,    max: 1e8 },
    // 中长线 (绑定个股)
    earnings_disclosure: { horizon: 'long', requires: ['code'], leadDays: { default: 3, min: 1, max: 30 } },
    // 中长线 (全局, 无 code)
    earnings_warning: { horizon: 'long', global: true, requires: [], defaultName: '业绩预告异动' },
    regime_change:    { horizon: 'long', global: true, requires: [], defaultName: '大盘状态切换' },
    valuation:         { horizon: 'long', global: true, requires: [], defaultName: '估值偏离' },
    rebalance_quarterly: { horizon: 'long', global: true, requires: [], intervalDays: { default: 90, min: 7, max: 365 } }
  };

  const GLOBAL_CODE = {
    earnings_warning: 'holdings',
    regime_change: 'market',
    valuation: 'market',
    rebalance_quarterly: 'funds'
  };

  // ============== 工具 ==============

  function _normCode6(raw) {
    const m = String(raw == null ? '' : raw).match(/(\d{6})/);
    return m ? m[1] : null;
  }

  function _err(msg) {
    return new Error('[AlertsAgent] ' + msg);
  }

  /**
   * 校验单条 spec, 修正可修字段, 不可修抛错
   * @param {object} spec { type, code?, name?, value?, leadDays?, intervalDays? }
   * @returns {object} 修正后的 spec
   * @throws {Error} 字段非法/类型未知
   */
  function validateSpec(spec) {
    if (!spec || typeof spec !== 'object') throw _err('spec 必须是对象');
    const type = spec.type;
    const def = TYPE_DEFS[type];
    if (!def) throw _err('未知规则类型: ' + type);

    const out = { type };

    // code (短线 + earnings_disclosure 需要)
    if (def.requires.includes('code')) {
      const code = _normCode6(spec.code);
      if (!code) throw _err(`规则 ${type} 需要 6 位股票代码, 收到: ${spec.code}`);
      out.code = code;
      out.name = String(spec.name || code);
    } else if (def.global) {
      out.code = GLOBAL_CODE[type] || 'market';
      out.name = String(spec.name || def.defaultName || type);
    } else {
      out.code = _normCode6(spec.code) || '';
      out.name = String(spec.name || '');
    }

    // value (短线)
    if (def.valueType) {
      const v = parseFloat(spec.value);
      if (!isFinite(v)) throw _err(`规则 ${type} 需要阈值 value, 收到: ${spec.value}`);
      if (v < def.min || v > def.max) throw _err(`规则 ${type} 阈值越界 [${def.min}, ${def.max}], 收到: ${v}`);
      out.value = +v.toFixed(def.valueType === 'price' ? 2 : (def.valueType === 'volume' ? 0 : 2));
    }

    // leadDays
    if (def.leadDays) {
      const ld = parseInt(spec.leadDays, 10);
      out.leadDays = isFinite(ld) && ld >= def.leadDays.min && ld <= def.leadDays.max
        ? ld
        : def.leadDays.default;
    }

    // intervalDays
    if (def.intervalDays) {
      const id = parseInt(spec.intervalDays, 10);
      out.intervalDays = isFinite(id) && id >= def.intervalDays.min && id <= def.intervalDays.max
        ? id
        : def.intervalDays.default;
    }

    return out;
  }

  /**
   * 校验多条, 失败聚合报错
   * @param {Array<object>} specs
   * @returns {Array<object>}
   */
  function validateSpecs(specs) {
    if (!Array.isArray(specs)) throw _err('specs 必须是数组');
    return specs.map((s, i) => {
      try { return validateSpec(s); }
      catch (e) { throw _err(`第 ${i + 1} 条: ${e.message}`); }
    });
  }

  // ============== 自然语言 → spec (走 AI) ==============

  /**
   * 把用户自然语言喂给 AI, 输出 JSON spec 数组
   * 设计: prompt 极简, 强约束输出格式; 校验在 validateSpec (白名单)
   * @param {string} userText 用户的请求, 例: "给我 600519 设个 1700 止盈, 再给跌 5% 加个提醒"
   * @param {object} [ctx] { holdings?: [{code,name}] } 给 AI 上下文, 帮它消歧
   * @returns {Promise<{intents: Array<{action:'create'|'update'|'delete', specs: object, reasoning: string}>, rawText: string}>}
   */
  async function parseIntent(userText, ctx) {
    if (!userText || typeof userText !== 'string') throw _err('请输入自然语言指令');
    if (!window.Core || !Core.AI) throw _err('Core.AI 不可用');

    const holdings = (ctx && Array.isArray(ctx.holdings)) ? ctx.holdings : [];
    const typeList = Object.keys(TYPE_DEFS).map(t => `${t} (${TYPE_DEFS[t].horizon === 'short' ? '短线' : '中长线'})`).join(', ');

    const systemPrompt = [
      '你是「盯盘规则助手」, 把用户的自然语言转成结构化 spec。',
      '规则类型 (只用这些, 不要编造): ' + typeList,
      '字段: type 必填; code (短线 + earnings_disclosure 需要 6 位数字); value (price 元 / pct % / volume 手); leadDays (1-30, earnings_disclosure 用); intervalDays (7-365, rebalance_quarterly 用)。',
      'action: create 新建, update 修改 (需 spec 含 id), delete 删除 (需 spec 含 id)。',
      'reasoning: 一句话中文解释你为什么这样解析。',
      '用户当前持仓: ' + (holdings.length ? holdings.map(h => `${h.code || h.代码}${h.name || h.名称 ? ' ' + (h.name || h.名称) : ''}`).join(', ') : '(空)'),
      '严格输出 JSON: {"intents": [{"action": "...", "specs": {...}, "reasoning": "..."}, ...]}, 不输出任何其他文字。'
    ].join('\n');

    const prompt = `用户指令: ${userText}\n\n请输出 JSON。`;

    let text;
    try {
      text = await Core.AI.Entry.callThrough({
        systemPrompt, prompt,
        stream: false, maxTokens: 600,
        page: 'alerts', purpose: 'parse-intent'
      }, 'alerts');
    } catch (e) {
      throw _err('AI 调用失败: ' + (e.message || e));
    }

    // 抽 JSON (容错: AI 偶尔包 ```json ... ```)
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) throw _err('AI 未返回 JSON, 原文: ' + text.slice(0, 200));
    let parsed;
    try { parsed = JSON.parse(m[0]); }
    catch (e) { throw _err('AI JSON 解析失败: ' + e.message); }
    if (!Array.isArray(parsed.intents)) throw _err('AI 返回缺 intents 数组');

    // 校验每条 spec, 不通过抛错 (不静默丢弃, 让用户知道 AI 编造了什么)
    for (let i = 0; i < parsed.intents.length; i++) {
      const it = parsed.intents[i];
      if (!['create', 'update', 'delete'].includes(it.action)) {
        throw _err(`第 ${i + 1} 条 action 非法: ${it.action}`);
      }
      // delete 只需 type + id; create/update 走 validateSpec
      if (it.action !== 'delete') {
        const specs = Array.isArray(it.specs) ? it.specs : [it.specs];
        const validated = specs.map(s => validateSpec(s));
        it.specs = validated.length === 1 ? validated[0] : validated;
      } else {
        if (!it.specs || !it.specs.id) throw _err(`第 ${i + 1} 条 delete 缺 id`);
      }
    }

    return { intents: parsed.intents, rawText: text };
  }

  // ============== 预览 / 落库 ==============

  /**
   * 把 intents 转成可读的预览 (UI 直接显示)
   * @param {Array} intents
   * @returns {Array<{action, title, body, alertData?, id?}>}
   */
  function previewIntents(intents) {
    return intents.map((it, idx) => {
      const reasoning = it.reasoning || '';
      if (it.action === 'delete') {
        return {
          action: 'delete',
          title: `🗑 删除规则 #${it.specs.id}`,
          body: reasoning,
          id: it.specs.id
        };
      }
      const s = it.specs;
      const def = TYPE_DEFS[s.type];
      const horizonLabel = def && def.horizon === 'short' ? '⚡ 短线' : '📅 中长线';
      let detail = '';
      if (s.code) detail += `<span class="code">${s.code}</span> `;
      if (s.value != null) detail += `阈值 <strong>${s.value}</strong> ${def.unit} `;
      if (s.leadDays != null) detail += `提前 <strong>${s.leadDays}</strong> 天 `;
      if (s.intervalDays != null) detail += `每 <strong>${s.intervalDays}</strong> 天 `;
      const title = `${horizonLabel} · ${_typeLabel(s.type)} · ${(s.name || s.code || '').trim()}`;
      return {
        action: it.action,
        title,
        body: detail + (reasoning ? '<div style="color:var(--text-muted);margin-top:4px;">' + reasoning + '</div>' : '')
      };
    });
  }

  function _typeLabel(t) {
    return ({
      price_above: '价格 ≥',
      price_below: '价格 ≤',
      change_above: '涨幅 ≥',
      change_below: '跌幅 ≥',
      volume_above: '成交 ≥',
      rebalance_quarterly: '季度再平衡',
      earnings_disclosure: '📅 财报披露',
      earnings_warning: '⚠️ 业绩预告异动',
      valuation: '📈 估值偏离',
      regime_change: '🌊 大盘状态切换'
    })[t] || t;
  }

  /**
   * 用户确认后落库 (默认要求 confirmed=true, 防止误调)
   * @param {Array} intents
   * @param {object} [opts] { confirmed?: boolean }
   * @returns {Promise<{written: number, deleted: number}>}
   */
  async function applyIntents(intents, opts) {
    if (!Array.isArray(intents) || intents.length === 0) {
      throw _err('intents 为空, 无可应用');
    }
    if (!opts || opts.confirmed !== true) {
      throw _err('应用前必须用户确认 (传 {confirmed: true})');
    }
    if (!window.Core || !Core.Storage) throw _err('Core.Storage 不可用');

    let written = 0, deleted = 0;
    for (const it of intents) {
      if (it.action === 'delete') {
        const id = it.specs.id;
        const found = await Core.Storage.get('alerts', id);
        if (found) { await Core.Storage.remove('alerts', id); deleted++; }
        continue;
      }
      const s = it.specs;
      if (it.action === 'update') {
        if (!s.id) throw _err('update 缺 id');
        const existing = await Core.Storage.get('alerts', s.id);
        if (!existing) throw _err('update 找不到规则: ' + s.id);
        const merged = Object.assign({}, existing, s, { id: s.id, aiGenerated: true, aiUpdatedAt: Date.now() });
        await Core.Storage.put('alerts', merged);
        written++;
        continue;
      }
      // create
      const data = {
        id: 'ai-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        code: s.code, name: s.name, type: s.type,
        horizon: TYPE_DEFS[s.type] ? TYPE_DEFS[s.type].horizon : 'long',
        active: true, hitCount: 0, triggered: false, createdAt: Date.now(),
        aiGenerated: true, aiCreatedAt: Date.now()
      };
      if (s.value != null) data.value = s.value;
      if (s.leadDays != null) data.leadDays = s.leadDays;
      if (s.intervalDays != null) {
        data.intervalDays = s.intervalDays;
        data.nextCheck = Date.now() + s.intervalDays * 24 * 60 * 60 * 1000;
      }
      await Core.Storage.add('alerts', data);
      written++;
    }

    return { written, deleted };
  }

  // ============== 持仓推荐 ==============

  /**
   * 扫描当前持仓, 推荐应设哪些规则 (每只持仓最常见 2 条: 财报披露 + 1 条价值位)
   * 纯逻辑, 不调 AI, 供 UI 一键填充
   * @param {Array} holdings [{code, name, isPaper, ...}]
   * @returns {Array<object>} spec 数组
   */
  function suggestForHoldings(holdings) {
    if (!Array.isArray(holdings)) return [];
    const real = holdings.filter(h => !h.isPaper);
    const out = [];
    for (const h of real) {
      const code = _normCode6(h.code);
      if (!code) continue;
      out.push({ type: 'earnings_disclosure', code, name: h.name || code, leadDays: 3 });
    }
    return out;
  }

  // ============== AI 解读已触发规则 ==============

  /**
   * 把已触发的 alert + 该规则历史喂给 AI, 生成自然语言解读
   * 不直接改规则, 只生成文本供 UI 显示
   * @param {object} alert alerts 行
   * @param {object} [ctx] { history?: Array, regime?: {state, label}, holdings?: Array }
   * @returns {Promise<string>} 中文解读, 200-400 字
   */
  async function interpretAlert(alert, ctx) {
    if (!alert || !alert.type) throw _err('alert 不合法');
    if (!window.Core || !Core.AI) throw _err('Core.AI 不可用');

    const history = (ctx && Array.isArray(ctx.history)) ? ctx.history.slice(-3) : [];
    const regime = ctx && ctx.regime ? ctx.regime : null;

    const systemPrompt = [
      '你是「盯盘事件解读助手」, 给小白用户解释一条已触发的提醒意味着什么。',
      '- 200-400 字中文, 分 3 段: ⚡ 这条触发了什么 / 📖 对持仓意味着什么 / 🎯 建议怎么应对',
      '- 不要推荐具体买卖金额, 只解释逻辑、风险、优先级',
      '- 引用用户实际数据 (持仓代码/名称/规则类型/大盘状态), 不要凭空举数字',
      '- 不知道就明说"需要看更多数据", 不要编'
    ].join('\n');

    const prompt = `事件:
- 规则类型: ${alert.type}
- 标的: ${alert.code}${alert.name ? ' (' + alert.name + ')' : ''}
- 阈值: ${alert.value != null ? alert.value : (alert.leadDays != null ? '提前 ' + alert.leadDays + ' 天' : alert.intervalDays != null ? '每 ' + alert.intervalDays + ' 天' : '全局')}
- 触发次数: ${alert.hitCount || 0}
- 上次触发: ${alert.lastHit ? new Date(alert.lastHit).toISOString().slice(0, 10) : '首次'}
- 大盘状态: ${regime ? (regime.label || regime.state) : '未知'}
近期同规则历史 (最近 3 条): ${history.length ? JSON.stringify(history) : '无'}

请输出解读。`;

    let text;
    try {
      text = await Core.AI.Entry.callThrough({
        systemPrompt, prompt,
        stream: false, maxTokens: 500,
        page: 'alerts', purpose: 'interpret-alert'
      }, 'alerts');
    } catch (e) {
      throw _err('AI 调用失败: ' + (e.message || e));
    }
    return String(text || '').trim();
  }

  // ============== 暴露 ==============

  window.Core = window.Core || {};
  window.Core.AlertsAgent = {
    parseIntent,
    validateSpec,
    validateSpecs,
    previewIntents,
    applyIntents,
    suggestForHoldings,
    interpretAlert,
    TYPE_DEFS    // 测试 / 调试用
  };
})();