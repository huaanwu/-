/**
 * Core.AI.ToolRegistry - 动态工具注册表 (Phase 3)
 * 依赖: 无 (纯 IIFE 工具元数据管理 + 自实现 schema 校验)
 *
 * 设计:
 *   - 替换 agent-tools.js 内部硬编码的 Map + reg() 模式; 工具元数据可在运行时增删
 *   - register() 校验必填字段 + domain/effects/risk 枚举; 重名抛 TypeError
 *   - invoke(name, args, ctx) 三态返回 {ok, data, error, effectRequest}
 *     Phase 3 effectRequest 一律 null (handler 仍直接执行 UI/storage 副作用)
 *     Phase 4 改 handler 返回 effectRequest, ToolRegistry 透传到 Orchestrator/agents 做确认流
 *   - list(filter) / get(name) 返回元数据深拷贝 (不含 handler, 防泄露内部函数引用)
 *
 * 不依赖 Core.Storage / Dexie — 这层只管注册和调用, 持久化由 Orchestrator + Tracing 串联
 *
 * CLAUDE.md 安全准则:
 *   - innerHTML 输出不在本文件范围 (UI 渲染由 caller 处理)
 *   - 空 catch 必须 console.warn
 *   - 不引新库; schema 校验 ≤80 行 type/required/properties/enum 自实现
 */
(function() {
  'use strict';

  const VALID_DOMAINS = ['read', 'write', 'effect', 'rpc'];
  const VALID_EFFECTS = ['storage', 'ui', 'remote'];
  const VALID_RISKS = ['L', 'M', 'H', 'R', 'W'];
  const RISK_ALIAS = { L: 'R', H: 'W' }; // 旧 L→R(读) / H→W(写) 别名

  /** 工具注册表: name → {meta, handler} */
  const _tools = new Map();

  // ========== Schema 校验 (自实现, ≤80 行) ==========

  /**
   * 校验 args 是否符合 schema. 支持:
   *   - type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
   *   - required: string[]
   *   - properties: { [key]: { type, enum?, required? } }
   *   - enum: any[] (用于 type 字段枚举)
   *   - additionalProperties: false (严格模式, 字段多了就报错)
   * @returns {{ ok: boolean, error?: string, value?: any }}
   */
  function _validateBasic(schema, args) {
    if (!schema || typeof schema !== 'object') return { ok: true, value: args };
    args = args || {};
    const errs = [];
    const knownProps = new Set();

    // 1. required 字段必须存在
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (args[k] === undefined || args[k] === null) {
          errs.push(`missing required field: ${k}`);
        } else {
          knownProps.add(k);
        }
      }
    }

    // 2. properties 校验
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, propSchema] of Object.entries(schema.properties)) {
        knownProps.add(k);
        if (args[k] === undefined) continue; // 未提供不强制要求 (除非在 required 里)
        const v = args[k];
        const t = propSchema.type;
        if (t === 'string' && typeof v !== 'string') errs.push(`${k}: expected string, got ${typeof v}`);
        else if (t === 'number' && typeof v !== 'number') errs.push(`${k}: expected number, got ${typeof v}`);
        else if (t === 'integer' && (!Number.isInteger(v))) errs.push(`${k}: expected integer, got ${v}`);
        else if (t === 'boolean' && typeof v !== 'boolean') errs.push(`${k}: expected boolean, got ${typeof v}`);
        else if (t === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) errs.push(`${k}: expected object`);
        else if (t === 'array' && !Array.isArray(v)) errs.push(`${k}: expected array`);
        if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(v)) {
          errs.push(`${k}: must be one of [${propSchema.enum.join(', ')}]`);
        }
      }
    }

    // 3. additionalProperties: false — 严格模式
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(args)) {
        if (!knownProps.has(k)) errs.push(`unknown field: ${k}`);
      }
    }

    if (errs.length) return { ok: false, error: errs.join('; ') };
    return { ok: true, value: args };
  }

  // ========== 公开 API ==========

  /**
   * 注册工具
   * @param {{
   *   name: string,
   *   domain: 'read'|'write'|'effect'|'rpc',
   *   effects?: string[],
   *   provider: string,
   *   schemaVersion: string,
   *   description: string,
   *   risk?: 'L'|'M'|'H',
   *   inputSchema?: object,
   *   handler: (args: any, ctx: any) => any | Promise<any>
   * }} meta
   */
  function register(meta) {
    if (!meta || typeof meta !== 'object') throw new TypeError('register: meta 必须是非空对象');
    const required = ['name', 'domain', 'provider', 'schemaVersion', 'description', 'handler'];
    for (const k of required) {
      if (meta[k] === undefined || meta[k] === null || meta[k] === '') {
        throw new TypeError(`register: meta.${k} 必填`);
      }
    }
    if (!VALID_DOMAINS.includes(meta.domain)) throw new TypeError(`register: domain 必须是 [${VALID_DOMAINS.join('/')}], 收到 ${meta.domain}`);
    if (meta.effects && !Array.isArray(meta.effects)) throw new TypeError('register: effects 必须是数组');
    if (meta.effects) {
      for (const e of meta.effects) {
        if (!VALID_EFFECTS.includes(e)) throw new TypeError(`register: effect 必须是 [${VALID_EFFECTS.join('/')}], 收到 ${e}`);
      }
    }
    if (meta.risk && !VALID_RISKS.includes(meta.risk)) throw new TypeError(`register: risk 必须是 [${VALID_RISKS.join('/')}], 收到 ${meta.risk}`);
    // 规范化 risk: L→R / H→W (兼容旧 L/M/H 和新 R/W)
    if (RISK_ALIAS[meta.risk]) meta.risk = RISK_ALIAS[meta.risk];
    if (typeof meta.handler !== 'function') throw new TypeError('register: handler 必须是函数');
    if (_tools.has(meta.name)) throw new TypeError(`register: 工具 ${meta.name} 已存在, 重名注册需先 unregister`);

    _tools.set(meta.name, {
      meta: {
        name: meta.name,
        domain: meta.domain,
        effects: meta.effects || [],
        provider: meta.provider,
        schemaVersion: meta.schemaVersion,
        description: meta.description,
        risk: meta.risk || 'L',
        inputSchema: meta.inputSchema || null
      },
      handler: meta.handler
    });
  }

  /** 注销工具 (Phase 4+ 才需要, 当前留 stub) */
  function unregister(name) {
    return _tools.delete(name);
  }

  /**
   * 调用工具
   * @param {string} name
   * @param {object} args
   * @param {{ runId?: string, agent?: string, page?: string, requester?: string }} [ctx]
   * @returns {Promise<{ ok: boolean, data?: any, error?: string, effectRequest: null }>}
   */
  async function invoke(name, args, ctx) {
    const entry = _tools.get(name);
    if (!entry) return { ok: false, error: `工具 ${name} 未注册`, effectRequest: null };

    // schema 校验
    if (entry.meta.inputSchema) {
      const v = _validateBasic(entry.meta.inputSchema, args);
      if (!v.ok) return { ok: false, error: v.error, effectRequest: null };
    }

    ctx = ctx || {};
    try {
      const result = await entry.handler(args || {}, ctx);
      // Phase 3: handler 直接执行副作用, 返回数据即 data; effectRequest 一律 null
      // Phase 4: handler 改为返回 {kind, payload, requiresConfirm} 或 data, 由 ToolRegistry 拆 effectRequest
      const data = (result && typeof result === 'object' && 'data' in result && !Array.isArray(result))
        ? result.data : result;
      return { ok: true, data, effectRequest: null };
    } catch (e) {
      console.warn('[ToolRegistry] 调用失败:', name, e);
      return { ok: false, error: e && e.message ? e.message : String(e), effectRequest: null };
    }
  }

  /**
   * 获取工具元数据 (深拷贝, 不含 handler)
   * @param {string} name
   */
  function get(name) {
    const entry = _tools.get(name);
    if (!entry) return null;
    return JSON.parse(JSON.stringify(entry.meta));
  }

  /**
   * 列出工具元数据 (深拷贝, 不含 handler)
   * @param {{ domain?: string, effects?: string[], risk?: string }} [filter]
   */
  function list(filter) {
    filter = filter || {};
    // 兼容旧 risk 别名
    if (filter.risk && RISK_ALIAS[filter.risk]) filter.risk = RISK_ALIAS[filter.risk];
    const out = [];
    for (const entry of _tools.values()) {
      const m = entry.meta;
      if (filter.domain && m.domain !== filter.domain) continue;
      if (filter.risk && m.risk !== filter.risk) continue;
      if (filter.effects && filter.effects.length) {
        // 至少有一个 effect 在 filter.effects 中
        const has = filter.effects.some(e => m.effects.includes(e));
        if (!has) continue;
      }
      out.push(JSON.parse(JSON.stringify(m)));
    }
    return out;
  }

  /** 测试/调试用: 当前已注册的工具数 */
  function size() {
    return _tools.size;
  }

  // 暴露
  window.Core = window.Core || {};
  window.Core.AI = window.Core.AI || {};
  window.Core.AI.ToolRegistry = {
    register, unregister, invoke, get, list, size,
    // 暴露给 Orchestrator/agents 测试用
    _tools,
    _validateBasic,
    VALID_DOMAINS, VALID_EFFECTS, VALID_RISKS
  };
})();