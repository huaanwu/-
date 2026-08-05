/**
 * ReverseWatch.AI.Adapter — 跟主程序 AI Service 的唯一衔接点
 *
 * 衔接契约 (跟主程序约定):
 *   - callLLM(opts) → Core.AI.callThrough (委派 Entry, 失败降级 call)
 *   - stockAdvisor(c, ctx) → 详情页用, 透传 5 维技术指标让 LLM 给一句话简评
 *   - butlerReport(snapshot) → 管家周报, 拉全账户快照拼成系统 prompt
 *   - configLLM() → 写 SETTINGS.ai 的 4 个字段 (butlerTone/notifyChannel/autoPush/dailyDigest)
 *
 * 读 SETTINGS: configLLM() (双向)
 * 调 callLLM: stockAdvisor(), butlerReport()
 *
 * 失败兜底: 4 个函数全部 try/catch, 永不让 AI 故障拖垮 UI 渲染
 */
(function () {
  'use strict';

  window.ReverseWatch = window.ReverseWatch || {};
  const A = window.ReverseWatch.AI = window.ReverseWatch.AI || {};

  const DEFAULTS = {
    butlerTone: 'concise',          // concise | detailed | socratic
    notifyChannel: 'toast+web',     // toast | web | toast+web | none
    autoPush: false,                // 总管定时推送开关
    dailyDigest: false              // 每日 09:35 收盘后简报
  };

  /**
   * callLLM — 透传到主程序 AI Service, 自动注入本地/远程策略
   * @param {{prompt:string, systemPrompt?:string, strategy?:string, stream?:boolean, onChunk?:Function}} opts
   * @returns {Promise<string>}
   */
  async function callLLM(opts) {
    try {
      if (!window.Core || !Core.AI || typeof Core.AI.callThrough !== 'function') {
        throw new Error('Core.AI.callThrough 不可用');
      }
      return await Core.AI.callThrough(opts, opts.strategy || 'reverse-watch');
    } catch (e) {
      console.warn('[ReverseWatch.AI] callLLM 失败, 降级空串:', e && e.message);
      return '';  // UI 层按空串走兜底文案
    }
  }

  /**
   * stockAdvisor — 单只标的简评 (详情页升级版 aiChiefAnalyst)
   * @param {{code:string, name:string}} c 标的基础信息
   * @param {{tech:object, news?:string[]}} ctx 技术面 + 可选新闻
   * @returns {Promise<string>} 80-150 字中文简评
   */
  async function stockAdvisor(c, ctx) {
    const tech = (ctx && ctx.tech) || {};
    const sys = '你是 A 股反向策略顾问, 80-150 字中文, 不带情绪, 不给操作建议。';
    const p = `标的: ${c.code} ${c.name}\n技术: ${JSON.stringify(tech)}\n请点评。`;
    return await callLLM({ systemPrompt: sys, prompt: p, strategy: 'reverse-stock' });
  }

  /**
   * butlerReport — 全账户周报, 多模型汇总 (持仓/收益/风险)
   * @param {{holdings:object[], pnl:object, regime:string}} snapshot
   * @returns {Promise<string>} 200-400 字中文周报
   */
  async function butlerReport(snapshot) {
    const s = snapshot || {};
    const sys = '你是私人投资管家, 输出 200-400 字中文周报: 收益归因 + 风险提示 + 下周关注。';
    const p = `市场状态: ${s.regime || '?'}\n持仓数: ${(s.holdings || []).length}\nPnL: ${JSON.stringify(s.pnl || {})}`;
    return await callLLM({ systemPrompt: sys, prompt: p, strategy: 'reverse-butler' });
  }

  /**
   * configLLM — 读写 SETTINGS.ai 的 reverseWatch 子树
   * @param {object} patch 4 个字段之一; 不传则返回当前完整对象
   * @returns {object} SETTINGS.ai.reverseWatch (合并 DEFAULTS)
   */
  function configLLM(patch) {
    try {
      const s = Core.State.get();
      const ai = s.ai || {};
      const cur = { ...DEFAULTS, ...(ai.reverseWatch || {}) };
      if (!patch) return cur;
      const next = { ...cur, ...patch };
      Core.State.set('ai', { ...ai, reverseWatch: next });
      return next;
    } catch (e) {
      console.warn('[ReverseWatch.AI] configLLM 失败:', e && e.message);
      return { ...DEFAULTS };
    }
  }

  A.callLLM = callLLM;
  A.stockAdvisor = stockAdvisor;
  A.butlerReport = butlerReport;
  A.configLLM = configLLM;
  A.DEFAULTS = DEFAULTS;
})();