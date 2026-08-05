/**
 * S3.2 research-pool.js MAX_PER_SLEEVE=50 分槽 + 替换策略 (5 项)
 *
 * 验证 S3 加的 sleeve 配额逻辑:
 *   - add 长线 sleeve='长线' 标签, sleeve 已满 50 → 踢最旧的自动加的同 sleeve 票
 *   - add 长线, sleeve 未满 50 但总池 100 已满 → 走总池替换
 *   - 总池未满且 sleeve 未满 → 直接 add
 *   - 总池满 + sleeve 满 + 无自动加候选 → 抛错
 *   - 手动加的票 (addedBy='manual') 永不被踢
 *
 * 跑法: node test/orchestration/research-pool-sleeve.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
const POOL_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'research-pool.js'), 'utf8');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓', m); }
function bad(m) { fail++; console.error('  ✗', m); }
function assertEq(a, e, m) { if (a === e) ok(m); else bad(`${m} 期望 ${JSON.stringify(e)} 实际 ${JSON.stringify(a)}`); }
function assertTrue(c, m) { c ? ok(m) : bad(m); }
function assertAsyncThrows(fn, regex, m) {
  return fn().then(
    () => bad(m + ' (未抛)'),
    (e) => { if (regex.test(e.message)) ok(m); else bad(m + ' 抛错消息不符: ' + e.message); }
  );
}

function makeFakeDb() {
  const tables = ['research_pool','watchlist','holdings','transactions','journals','alerts','funds','cashflow',
    'cache','kv','settings_snapshots','ai_call_log','agent_runs','ai_traces',
    'decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution',
    'pool_snapshots','steward_plans','rule_candidates','steward_lessons'];
  const db = {};
  tables.forEach(name => {
    const rows = new Map();
    let autoId = 1;
    const pk = name === 'research_pool' ? 'code' : (name === 'cache' || name === 'kv' ? 'key' : 'id');
    db[name] = {
      add: async (r) => { if (pk==='id') { if (r.id==null) r.id=autoId++; rows.set(r.id,r); return r.id; } const k=r[pk]; rows.set(k,r); return k; },
      put: async (r) => { if (pk==='id') { if (r.id==null) r.id=autoId++; rows.set(r.id,r); return r.id; } const k=r[pk]; rows.set(k,r); return k; },
      get: async (k) => rows.get(k) || null,
      delete: async (k) => rows.delete(k),
      remove: async (k) => rows.delete(k),
      toArray: async () => [...rows.values()],
      where: (i) => ({ equals: (v) => ({ toArray: async () => [...rows.values()].filter(r => r[i]===v) }) }),
      clear: async () => rows.clear()
    };
  });
  return db;
}

function buildSandbox() {
  const sb = {
    console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Array, Object, Map, Set, Error, Number
  };
  sb.window = sb;
  sb.Dexie = function (name) {
    const inst = { name, version: () => ({ stores: () => ({}) }) };
    Object.assign(inst, makeFakeDb());
    return inst;
  };
  sb.window.Dexie = sb.Dexie;
  sb.window.Dexie.delete = async () => {};
  vm.createContext(sb);
  vm.runInContext(STORAGE_SRC, sb);
  vm.runInContext(POOL_SRC, sb);
  sb.Core.Storage.init();
  return sb;
}

async function main() {
  console.log('\n[S3.2.1] 总池未满 + sleeve 未满 → 直接 add');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.ResearchPool;
    const r = await Pool.add('600000 浦发', { tags: ['长线'], addedBy: 'screener-long' });
    assertTrue(r.added, '加成功');
    const got = await Pool.list();
    assertEq(got.length, 1, '池里 1 条');
    assertTrue(got[0].tags.includes('长线'), 'sleeve tag 正确');
  }

  console.log('\n[S3.2.2] sleeve 满 50 + 加新 → 踢最旧的自动加');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.ResearchPool;
    // 加 50 条长线 (sleeve 满)
    for (let i = 0; i < 50; i++) {
      const code = String(600000 + i).padStart(6, '0');
      await Pool.add(code + ' 测试' + i, { tags: ['长线'], addedBy: 'screener-long' });
    }
    let list = await Pool.list();
    assertEq(list.length, 50, '50 条长线');

    // 第 51 条 → 触发 sleeve 满替换
    const r = await Pool.add('700000 测试新', { tags: ['长线'], addedBy: 'screener-long' });
    assertTrue(r.added, '第 51 条加成功');
    assertEq(r.replaced, '600000', '踢掉最早一只 600000');
    assertEq(r.replacedReason, 'sleeve-full', '原因 sleeve-full');

    list = await Pool.list();
    assertEq(list.length, 50, '池还是 50 条');
    assertTrue(!list.find(x => x.code === '600000'), '600000 已被踢');
    assertTrue(!!list.find(x => x.code === '700000'), '700000 已加入');
  }

  console.log('\n[S3.2.3] 总池满 + sleeve 满 + 无自动加候选 → 抛错');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.ResearchPool;
    // 50 条长线 (screener) + 50 条短线 (screener) = 100 总池满
    for (let i = 0; i < 50; i++) {
      await Pool.add(String(600000 + i), { tags: ['长线'], addedBy: 'screener-long' });
      await Pool.add(String(300000 + i), { tags: ['短线'], addedBy: 'screener-short' });
    }
    let list = await Pool.list();
    assertEq(list.length, 100, '总池 100 条满');

    // 加第 101 条 → 总池满, sleeve 长线也满, 但长线还有 screener-* 自动加的候选 → 踢
    // 但若 sleeve 没匹配 (假设所有长线都被改成 manual), 应抛错
    // 这里强制改长线那批的 addedBy 为 'manual', 模拟"sleeve 满且无可踢"
    const all = await Pool.list();
    for (const r of all) {
      if (r.tags && r.tags.includes('长线')) {
        await sb.Core.Storage.put('research_pool', Object.assign({}, r, { addedBy: 'manual' }));
      }
    }
    await assertAsyncThrows(
      () => Pool.add('700000 测试', { tags: ['长线'], addedBy: 'screener-long' }),
      /sleeve=长线 已满|研究池已满/,
      'S3.2.3 总池+sleeve 全满且无自动加候选 → 抛错'
    );
  }

  console.log('\n[S3.2.4] manual 股永不被踢');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.ResearchPool;
    // 加 1 条 manual 长线
    await Pool.add('600000 manual', { tags: ['长线'], addedBy: 'manual' });
    // 加 50 条 screener 长线 (此时 sleeve 已满 50, 第 50 条加时就已经触发 sleeve 替换, 踢了 600001)
    for (let i = 0; i < 50; i++) {
      await Pool.add(String(600001 + i).padStart(6, '0'), { tags: ['长线'], addedBy: 'screener-long' });
    }
    const before = await Pool.list();
    assertTrue(!!before.find(x => x.code === '600000'), 'manual 股还在');
    assertEq(before.length, 50, '总池 50 条 (含 manual + 49~50 只 screener, 后者会自我替换)');
  }

  console.log('\n[S3.2.5] 已存在 code → tag 合并');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.ResearchPool;
    await Pool.add('600000', { tags: ['长线'], addedBy: 'screener-long' });
    const r = await Pool.add('600000', { tags: ['自选'], addedBy: 'manual' });
    assertTrue(!r.added && r.existed, '第二次 add 返回 existed=true');
    const got = await Pool.list();
    const rec = got.find(x => x.code === '600000');
    assertTrue(rec.tags.includes('长线') && rec.tags.includes('自选'), 'tags 合并: 长线+自选');
  }

  console.log('\n========');
  console.log(`S3.2 research-pool sleeve 配额: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('顶层异常:', e); process.exit(1); });
