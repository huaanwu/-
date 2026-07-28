/**
 * Core.UserProfile - 用户画像 (风险偏好/期限/权益/收益回撤目标)
 *
 * 单一事实来源, 选股/选基 prompt 都从这里读取:
 *   - fund/ai-advisor.js: formatUserProfile() 注入 systemPrompt
 *   - screener.js: formatUserProfile() 注入 systemPrompt
 *   - settings 页: load/save 编辑入口
 *
 * 7 字段 schema:
 *   risk         'conservative' | 'moderate' | 'balanced'
 *   horizon      '1y' | '1-3y' | '3y+'
 *   allowEquity  'no' | 'yes'                       (选股侧暂用 'no' 兼容)
 *   preference   string (自由文本)
 *   blacklist    string (逗号分隔)
 *   targetReturn number (年化%, 默认 5)
 *   maxDrawdown  number (可接受回撤%, 默认 10)
 *
 * 持久化: 走 Core.State('userProfile'), 自动写 kv 'state_userProfile'.
 *
 * 文案沿用 fund/ai-advisor.js 既有 3 档 risk 描述 (L164-168), 保持 LLM 输出风格不变.
 */
(function() {
  'use strict';

  const SCHEMA = ['risk', 'horizon', 'allowEquity', 'preference', 'blacklist', 'targetReturn', 'maxDrawdown'];

  const DEFAULTS = Object.freeze({
    risk: 'moderate',
    horizon: '1-3y',
    allowEquity: 'no',
    preference: '',
    blacklist: '',
    targetReturn: 5,
    maxDrawdown: 10
  });

  // 文案与 fund/ai-advisor.js L164-170 保持一致 (迁移后 ai-advisor 改读这里)
  const RISK_TEXT = Object.freeze({
    conservative: '极度保守 - 最大回撤 < 2%, 跑赢存款利率 (1.5-2.5%) 即可, 不接受任何本金损失',
    moderate:     '稳健 - 最大回撤 5-10%, 目标年化 4-6%',
    balanced:     '平衡 - 可接受 10-20% 回撤, 目标年化 8%+'
  });
  const HORIZON_TEXT = Object.freeze({
    '1y':   '1 年内 (短久期)',
    '1-3y': '1-3 年 (中长久期)',
    '3y+':  '3 年以上 (长长久期)'
  });
  const ALLOW_EQUITY_TEXT = Object.freeze({
    yes: '允许股票类资产 (上限可由 allowEquityPct 调整, 当前未细分)',
    no:  '仅基金/债券类资产'
  });

  function mergeWithDefaults(profile) {
    const m = { ...DEFAULTS };
    if (profile && typeof profile === 'object') {
      for (const k of SCHEMA) {
        const v = profile[k];
        if (v !== undefined && v !== null && v !== '') m[k] = v;
      }
    }
    if (typeof m.targetReturn !== 'number' || !isFinite(m.targetReturn)) {
      const n = parseFloat(m.targetReturn);
      m.targetReturn = isFinite(n) ? n : DEFAULTS.targetReturn;
    }
    if (typeof m.maxDrawdown !== 'number' || !isFinite(m.maxDrawdown)) {
      const n = parseFloat(m.maxDrawdown);
      m.maxDrawdown = isFinite(n) ? n : DEFAULTS.maxDrawdown;
    }
    return m;
  }

  function validate(profile) {
    const errors = [];
    if (!profile || typeof profile !== 'object') {
      return { valid: false, errors: ['profile 不是对象'] };
    }
    if (!Object.prototype.hasOwnProperty.call(RISK_TEXT, profile.risk)) {
      errors.push('risk 必须是 conservative/moderate/balanced 之一');
    }
    if (!Object.prototype.hasOwnProperty.call(HORIZON_TEXT, profile.horizon)) {
      errors.push('horizon 必须是 1y/1-3y/3y+ 之一');
    }
    if (!Object.prototype.hasOwnProperty.call(ALLOW_EQUITY_TEXT, profile.allowEquity)) {
      errors.push('allowEquity 必须是 yes/no 之一');
    }
    const tr = parseFloat(profile.targetReturn);
    if (!isFinite(tr) || tr < 0 || tr > 100) errors.push('targetReturn 必须在 0-100 之间');
    const md = parseFloat(profile.maxDrawdown);
    if (!isFinite(md) || md < 0 || md > 100) errors.push('maxDrawdown 必须在 0-100 之间');
    return { valid: errors.length === 0, errors };
  }

  function load() {
    try {
      return mergeWithDefaults(Core.State.get('userProfile', null));
    } catch (e) {
      console.warn('[UserProfile] load 失败:', e);
      return { ...DEFAULTS };
    }
  }

  function save(profile) {
    try {
      const m = mergeWithDefaults(profile);
      const v = validate(m);
      if (!v.valid) {
        console.warn('[UserProfile] save 被拒:', v.errors.join('; '));
        return false;
      }
      Core.State.set('userProfile', m);
      return true;
    } catch (e) {
      console.warn('[UserProfile] save 失败:', e);
      return false;
    }
  }

  function riskLabel(v) { return RISK_TEXT[v] || RISK_TEXT[DEFAULTS.risk]; }
  function horizonLabel(v) { return HORIZON_TEXT[v] || HORIZON_TEXT[DEFAULTS.horizon]; }
  function allowEquityLabel(v) { return ALLOW_EQUITY_TEXT[v] || ALLOW_EQUITY_TEXT[DEFAULTS.allowEquity]; }

  window.Core = window.Core || {};
  window.Core.UserProfile = {
    SCHEMA, DEFAULTS,
    RISK_TEXT, HORIZON_TEXT, ALLOW_EQUITY_TEXT,
    load, save, mergeWithDefaults, validate,
    riskLabel, horizonLabel, allowEquityLabel
  };
})();