/**
 * Core.Data.Schema - 数据契约层 (Phase 1.1)
 *
 * 职责:
 *   - 定义统一 DataEnvelope 的字段约束 (quote.v3 / holding.v1 / ...)
 *   - 提供 validate(envelope, schemaVersion) 纯函数
 *   - 给数据来源/时效/质量打枚举标签, 不做业务判断
 *
 * 设计:
 *   - 每个 schema 版本独立导出 (CONSTANTS.SCHEMAS), 升级时加新版本号不破坏旧
 *   - validate 只返回 { status, warnings, errors }, 不 throw
 *   - 不依赖 Core.* 任何其他模块, 纯静态定义, 可独立测试
 */
(function() {
  'use strict';

  // ===== 枚举常量 (全大写, 防止字符串拼错) =====
  const PROVIDERS = Object.freeze({
    TENGXUN: 'tengxun',
    SINA: 'sina',
    AKTOOLS: 'aktools',
    DERIVED: 'derived'
  });

  const MARKETS = Object.freeze({
    SH: 'SH', SZ: 'SZ', BJ: 'BJ', HK: 'HK', US: 'US', OTC: 'OTC'
  });

  const ASSET_TYPES = Object.freeze({
    STOCK: 'stock', FUND: 'fund', INDEX: 'index', BOND: 'bond', FUTURE: 'future'
  });

  const FRESHNESS = Object.freeze({
    REALTIME: 'realtime', DELAYED: 'delayed', EOD: 'eod', HISTORICAL: 'historical'
  });

  const QUALITY = Object.freeze({
    OK: 'ok', STALE: 'stale', PARTIAL: 'partial', FAILED: 'failed', DERIVED: 'derived'
  });

  const VALIDATION_STATUS = Object.freeze({
    PENDING: 'pending', PASSED: 'passed', WARNED: 'warned', FAILED: 'failed'
  });

  const CATEGORIES = Object.freeze({
    QUOTE: 'quote', HOLDING: 'holding', FUND: 'fund',
    MACRO: 'macro', MARKET_WIDTH: 'marketWidth',
    JOURNAL: 'journal', ALERT: 'alert', PORTFOLIO: 'portfolio'
  });

  // ===== 字段类型定义 (每个 schemaVersion 一份) =====
  // 字段描述:
  //   type:    'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  //   required: 是否必填
  //   enum:    (可选) 候选值数组
  const SCHEMAS = Object.freeze({
    'quote.v3': Object.freeze({
      category: CATEGORIES.QUOTE,
      fields: Object.freeze({
        symbol:           { type: 'string',  required: true },
        name:             { type: 'string',  required: false },
        market:           { type: 'string',  required: true, enum: Object.values(MARKETS) },
        price:            { type: 'number',  required: false },
        prevClose:        { type: 'number',  required: false },
        open:             { type: 'number',  required: false },
        high:             { type: 'number',  required: false },
        low:              { type: 'number',  required: false },
        change:           { type: 'number',  required: false },
        changePercent:    { type: 'number',  required: false },
        volume:           { type: 'number',  required: false },
        amount:           { type: 'number',  required: false },
        turnoverRate:     { type: 'number',  required: false },
        pe:               { type: 'number',  required: false },
        circMarketCap:    { type: 'number',  required: false },
        totalMarketCap:   { type: 'number',  required: false },
        timestamp:        { type: 'string',  required: false }
      })
    })
  });

  /**
   * 校验一个 envelope 的 payload 是否符合给定 schemaVersion
   * @param {object} envelope - 完整 DataEnvelope (含 payload 字段)
   * @param {string} schemaVersion - 例 'quote.v3'
   * @returns {{status: string, warnings: string[], errors: string[]}}
   */
  function validate(envelope, schemaVersion) {
    const result = { status: VALIDATION_STATUS.PASSED, warnings: [], errors: [] };
    if (!envelope || typeof envelope !== 'object') {
      result.status = VALIDATION_STATUS.FAILED;
      result.errors.push('envelope is not an object');
      return result;
    }
    const schema = SCHEMAS[schemaVersion];
    if (!schema) {
      result.status = VALIDATION_STATUS.FAILED;
      result.errors.push('unknown schemaVersion: ' + schemaVersion);
      return result;
    }
    if (envelope.category && envelope.category !== schema.category) {
      result.warnings.push('category mismatch: envelope=' + envelope.category + ' schema=' + schema.category);
    }
    const payload = envelope.payload || {};
    for (const fieldName of Object.keys(schema.fields)) {
      const fieldDef = schema.fields[fieldName];
      const value = payload[fieldName];
      if (value === undefined || value === null) {
        if (fieldDef.required) {
          result.errors.push('missing required field: ' + fieldName);
          result.status = VALIDATION_STATUS.FAILED;
        }
        continue;
      }
      const actualType = typeof value;
      const expectedType = fieldDef.type;
      if (expectedType === 'integer' && actualType === 'number') continue; // 数字都接受
      if (actualType !== expectedType) {
        result.warnings.push('type mismatch on ' + fieldName + ': expected ' + expectedType + ' got ' + actualType);
        if (result.status === VALIDATION_STATUS.PASSED) result.status = VALIDATION_STATUS.WARNED;
        continue;
      }
      if (fieldDef.enum && !fieldDef.enum.includes(value)) {
        result.warnings.push('enum mismatch on ' + fieldName + ': ' + value + ' not in ' + JSON.stringify(fieldDef.enum));
        if (result.status === VALIDATION_STATUS.PASSED) result.status = VALIDATION_STATUS.WARNED;
      }
    }
    return result;
  }

  window.Core = window.Core || {};
  window.Core.Data = window.Core.Data || {};
  window.Core.Data.Schema = Object.freeze({
    PROVIDERS, MARKETS, ASSET_TYPES, FRESHNESS, QUALITY, VALIDATION_STATUS, CATEGORIES,
    SCHEMAS, validate
  });
})();