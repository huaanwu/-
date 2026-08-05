/**
 * V13 阶段 4 测试 — 飞书命令解析 (LLM → ToolRegistry)
 *
 * 覆盖:
 *   1. _listTools 从 agentRegistry 抽元数据
 *   2. _buildSystemPrompt 含工具清单 + R/W 分级
 *   3. parseUserMessage 工具调用情形 → {tool, args}
 *   4. parseUserMessage W 类工具 → 转 clarify
 *   5. parseUserMessage 闲聊 → {intent:chat, reply}
 *   6. parseUserMessage 信息不够 → {intent:clarify, question}
 *   7. parseUserMessage LLM 返 raw 文本 → 兜底 chat
 *   8. parseUserMessage 工具名不存在 → clarify
 *   9. parseUserMessage LLM 抛错 → {error}
 *  10. 解析 args 校验 (基本类型对齐)
 *  11. parseUserMessage 单次只调 1 个工具 (prompt 约束)
 */
'use strict';

const Module = require('module');
const origLoad = Module._load;
const _httpMock = { responses: new Map(), lastRequest: null };

// mock http
const origRequest = require('http').request;
const http = require('http');
http.request = function (opts, cb) {
  _httpMock.lastRequest = opts;
  const fakeReq = {
    on: (evt, fn) => { fakeReq['_' + evt] = fn; },
    write: () => {},
    end: () => {
      const body = _httpMock.responses.get('default') || '{"content":"{\\"intent\\":\\"chat\\",\\"reply\\":\\"hi\\"}"}';
      const res = {
        statusCode: 200,
        on: (evt, fn) => { if (evt === 'data') fn(body); if (evt === 'end') fn(); }
      };
      if (cb) cb(res);
    },
    destroy: () => {}
  };
  return fakeReq;
};

const { parseUserMessage, _listTools, _buildSystemPrompt } = require('../../electron/feishu-parser');

const _reg = {
  list: () => [
    { name: 'holdings.list', description: '查持仓', risk: 'R', input_schema: { type: 'object', properties: {} } },
    { name: 'paper.submitTrade', description: '模拟买', risk: 'W', input_schema: { type: 'object', properties: { code: { type: 'string' }, shares: { type: 'number' } } } }
  ]
};

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

(async () => {
  // ===== 情形 1: _listTools =====
  console.log('\n情形 1: _listTools 抽元数据');
  {
    const reg = {
      list: () => [
        { name: 'holdings.list', description: '查持仓', risk: 'R', input_schema: { type: 'object', properties: {} } },
        { name: 'paper.submitTrade', description: '模拟买', risk: 'W', input_schema: { type: 'object', properties: { code: { type: 'string' } } } }
      ]
    };
    const tools = _listTools(reg);
    assert(tools.length === 2, `2 工具 (${tools.length})`);
    assert(tools[0].risk === 'R' && tools[1].risk === 'W', 'risk 区分 R/W');
    assert(tools[1].input_schema.properties.code, 'input_schema 含 code');
  }

  // ===== 情形 2: _buildSystemPrompt 含 R/W =====
  console.log('\n情形 2: system prompt');
  {
    const prompt = _buildSystemPrompt([
      { name: 'a', description: 'A', risk: 'R', input_schema: { type: 'object', properties: {} } },
      { name: 'b', description: 'B', risk: 'W', input_schema: { type: 'object', properties: {} } }
    ]);
    assert(/可用工具/.test(prompt), '含工具列表');
    assert(/R=只读/.test(prompt) || /\[R\]/.test(prompt), '含 R 标识');
    assert(/\[W\]/.test(prompt), '含 W 标识');
    assert(/chat|clarify/.test(prompt), '含意图分流说明');
  }

  // ===== 情形 3: parseUserMessage R 工具 → {tool, args} =====
  console.log('\n情形 3: R 类工具调用');
  {
    _httpMock.responses.set('default', JSON.stringify({ content: '{"tool":"holdings.list","args":{},"rationale":"查持仓"}' }));
    const r = await parseUserMessage({
      text: '我持仓里有什么',
      agentRegistry: { list: () => [{ name: 'holdings.list', description: '查持仓', risk: 'R', input_schema: { type: 'object', properties: {} } }] },
      llmConfig: { provider: 'deepseek' }
    });
    assert(r.tool === 'holdings.list', `tool=holdings.list (${r.tool})`);
    assert(r.args && typeof r.args === 'object', 'args 是对象');
    assert(r.rationale === '查持仓', 'rationale');
  }

  // ===== 情形 4: W 类工具 → 转 confirm (带 tool + args, 待主进程挂起 + 用户确认) =====
  console.log('\n情形 4: W 类 → confirm');
  {
    _httpMock.responses.set('default', JSON.stringify({ content: '{"tool":"paper.submitTrade","args":{"code":"600519","shares":100},"rationale":"买入"}' }));
    const r = await parseUserMessage({
      text: '模拟买 100 股 600519',
      agentRegistry: { list: () => [{ name: 'paper.submitTrade', description: '模拟买', risk: 'W', input_schema: { type: 'object', properties: { code: { type: 'string' }, shares: { type: 'number' } } } }] },
      llmConfig: { provider: 'deepseek' }
    });
    assert(r.intent === 'confirm', `转 confirm (${r.intent})`);
    assert(r.tool === 'paper.submitTrade', `confirm 携带 tool 名: ${r.tool}`);
    assert(r.args && r.args.code === '600519', `confirm 携带 args.code: ${JSON.stringify(r.args)}`);
    assert(/确认|paper.submitTrade/.test(r.question || ''), `含确认提示: ${r.question}`);
  }

  // 4b: pending 上下文 — 用户回 "确认" 时复用挂起工具 (不重新调 LLM)
  {
    let recorded = null;
    const fakePending = {
      set: (openId, payload) => { recorded = { openId, payload }; return payload; },
      get: (openId) => recorded && recorded.openId === openId ? recorded.payload : null
    };
    fakePending.set('ou_x', { tool: 'paper.submitTrade', args: { code: '600519', shares: 100 }, rationale: 'test' });
    const r = await parseUserMessage({ text: '确认', agentRegistry: _reg, pending: fakePending, openId: 'ou_x' });
    assert(r.confirmReuse === true, '4b "确认" 复用 pending → confirmReuse=true');
    assert(r.tool === 'paper.submitTrade', '4b confirmReuse 仍带 tool');
  }

  // 4c: pending 上下文 — 用户回 "取消" 时走 cancelled (不重新调 LLM)
  {
    const fakePending = {
      _stored: { openId: 'ou_y', payload: { tool: 'paper.submitTrade', args: {}, rationale: '' } },
      set: () => null,
      get: (openId) => fakePending._stored.openId === openId ? fakePending._stored.payload : null
    };
    const r = await parseUserMessage({ text: '取消', agentRegistry: _reg, pending: fakePending, openId: 'ou_y' });
    assert(r.intent === 'cancelled', '4c "取消" → cancelled');
    assert(r.tool === 'paper.submitTrade', '4c cancelled 仍带 tool (用于回执)');
  }

  // ===== 情形 5: 闲聊 → chat =====
  console.log('\n情形 5: 闲聊 chat');
  {
    _httpMock.responses.set('default', JSON.stringify({ content: '{"intent":"chat","reply":"你好, 我是 stock-master 管家"}' }));
    const r = await parseUserMessage({
      text: '你好',
      agentRegistry: { list: () => [] },
      llmConfig: { provider: 'deepseek' }
    });
    assert(r.intent === 'chat', 'chat 意图');
    assert(r.reply === '你好, 我是 stock-master 管家', 'reply 内容');
  }

  // ===== 情形 6: 信息不够 → clarify =====
  console.log('\n情形 6: 信息不够 clarify');
  {
    _httpMock.responses.set('default', JSON.stringify({ content: '{"intent":"clarify","question":"请提供股票代码"}' }));
    const r = await parseUserMessage({
      text: '加自选',
      agentRegistry: { list: () => [{ name: 'watchlist.add', description: '加自选', risk: 'W', input_schema: { type: 'object', properties: { code: { type: 'string' } } } }] },
      llmConfig: { provider: 'deepseek' }
    });
    assert(r.intent === 'clarify', 'clarify 意图');
    assert(/代码/.test(r.question || ''), `问题: ${r.question}`);
  }

  // ===== 情形 7: raw 文本兜底 =====
  console.log('\n情形 7: raw 文本');
  {
    _httpMock.responses.set('default', JSON.stringify({ content: '我是 stock-master 管家, 你好' }));
    const r = await parseUserMessage({
      text: 'hi',
      agentRegistry: { list: () => [] },
      llmConfig: { provider: 'deepseek' }
    });
    assert(r.intent === 'chat', 'raw 文本当 chat');
    assert(r.reply && r.reply.includes('stock-master'), 'reply 含 stock-master');
  }

  // ===== 情形 8: 工具名不存在 =====
  console.log('\n情形 8: 工具不存在');
  {
    _httpMock.responses.set('default', JSON.stringify({ content: '{"tool":"nonexistent","args":{}}' }));
    const r = await parseUserMessage({
      text: '调不存在工具',
      agentRegistry: { list: () => [{ name: 'holdings.list', description: '', risk: 'R', input_schema: {} }] },
      llmConfig: { provider: 'deepseek' }
    });
    assert(r.intent === 'clarify', '不存在转 clarify');
    assert(/nonexistent|不存在/.test(r.question || ''), `提示不存在: ${r.question}`);
  }

  // ===== 情形 9: LLM 抛错 =====
  console.log('\n情形 9: LLM 失败');
  {
    _httpMock.responses.set('default', JSON.stringify({ error: 'quota exceeded' }));
    const r = await parseUserMessage({
      text: '查持仓',
      agentRegistry: { list: () => [{ name: 'holdings.list', description: '', risk: 'R', input_schema: {} }] },
      llmConfig: { provider: 'deepseek' }
    });
    assert(r.error && /quota|失败/.test(r.error), `error: ${r.error}`);
  }

  // ===== 情形 10: args 校验 (基本) =====
  console.log('\n情形 10: args 校验');
  {
    _httpMock.responses.set('default', JSON.stringify({ content: '{"tool":"watchlist.add","args":{"code":"600519"},"rationale":"加自选茅台"}' }));
    const r = await parseUserMessage({
      text: '加自选 600519',
      agentRegistry: { list: () => [{ name: 'watchlist.add', description: '', risk: 'W', input_schema: { type: 'object', properties: { code: { type: 'string' } } } }] },
      llmConfig: { provider: 'deepseek' }
    });
    // W 类强制 confirm (待用户确认), 不论 args 是否齐
    assert(r.intent === 'confirm', 'W 类 → confirm, 不论 args 是否齐');
    assert(r.tool === 'watchlist.add', 'W 类 confirm 携带 tool');
  }

  // ===== 情形 11: system prompt 强制单工具 =====
  console.log('\n情形 11: 系统 prompt 约束');
  {
    const prompt = _buildSystemPrompt([
      { name: 'a', description: 'A', risk: 'R', input_schema: {} },
      { name: 'b', description: 'B', risk: 'R', input_schema: {} }
    ]);
    assert(/单次只调一个工具/.test(prompt) || /不串调/.test(prompt), '含单工具约束');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`V13 Feishu Parser: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
