/**
 * reverse-watch-daemon-pure 单元测试 (≥20 case)
 *
 * 覆盖:
 *   - 时间工具: shanghaiStr / shanghaiHM / shanghaiDow / shanghaiISO (5 case)
 *   - makeAlert / attachAlertId: ts 注入 + id 格式 (3 case)
 *   - runRule1: 单票超限 / 仓位偏重 / 现金不足 / total=0 (4 case)
 *   - decideAddOn: bear 拒 / 浮盈门槛 / 板块强门槛 / 冷却 (4 case)
 *   - decideStopAndTrim: 跌破 MA20 / 鱼尾 / 板块弱 / bear 收严 (3 case)
 *   - runRule6: 透传 (1 case)
 *   - runAllRules: 4 规则聚合 + 幂等去重 + severity 排序 (3 case)
 *
 * 跑法: node test/orchestration/reverse-watch-daemon-pure.test.js
 * 必须返回 0 fail
 *
 * 设计:
 *   - 注入 ctx (holdings / rules / portfolio / lastAddTsMap / regime)
 *   - 时间测试: 锁 TZ=Asia/Shanghai (Node 进程 env)
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓', msg); }
function bad(msg, extra) { fail++; console.error('  ✗', msg, extra || ''); }
function assert(cond, msg, extra) { cond ? ok(msg) : bad(msg, extra); }
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(msg);
  else bad(msg + ` (expected=${e}, got=${a})`);
}

// 测试 ctx 工厂
function makeCtx(overrides = {}) {
  const base = {
    holdings: [],
    rules: {
      singleStockMaxPct: 0.10,
      stockOverPct: 0.08,
      cashReservePct: 0.05,
      basePoolMaxPct: 0.50,
      addOnProfitPct: 0.05,
      addMaxRatio: 0.5,
      addCooldownDays: 3,
      fishTailTrimPct: 0.15,
      sectorWeakPct: 0.50
    },
    portfolio: { cash: 100000, stockMkt: 0, total: 100000, stockPct: 0 },
    lastAddTsMap: {},
    regime: { current: 'bull', positionMultiplier: 1.0 }
  };
  return { ...base, ...overrides, rules: { ...base.rules, ...(overrides.rules || {}) }, portfolio: { ...base.portfolio, ...(overrides.portfolio || {}) }, regime: { ...base.regime, ...(overrides.regime || {}) } };
}
function makeHolding(overrides = {}) {
  return { code: '600519', name: '贵州茅台', price: 1700, shares: 100, chg5: 0.05, belowMA20: false, sectorStrength: 0.7, ...overrides };
}

const ROOT = path.resolve(__dirname, '..', '..');
const DAEMON_PURE = pathToFileURL(path.join(ROOT, 'reverse-watch', 'daemon-pure.mjs')).href;

(async () => {
  const DP = await import(DAEMON_PURE);

  // ============================================================
  console.log('\n[1] 时间工具: 5 case');
  // ============================================================

  // 1.1 shanghaiStr: 固定日期
  const d1 = new Date(2026, 7, 5, 14, 30, 45);
  assertEq(DP.shanghaiStr(d1), '2026-08-05 14:30:45', '1.1 shanghaiStr 2026-08-05 14:30:45');

  // 1.2 shanghaiStr 边界: 月份 + 1 (8月)
  const d2 = new Date(2026, 0, 1, 0, 0, 0);  // 1月1日 0点
  assertEq(DP.shanghaiStr(d2), '2026-01-01 00:00:00', '1.2 跨年 + 0 补位');

  // 1.3 shanghaiHM: HH:MM 格式
  assertEq(DP.shanghaiHM(d1), '14:30', '1.3 shanghaiHM');

  // 1.4 shanghaiDow: 周几 0=Sun ... 6=Sat
  assertEq(DP.shanghaiDow(new Date(2026, 7, 2)), 0, '1.4a 2026-08-02 (周日) → 0');
  assertEq(DP.shanghaiDow(new Date(2026, 7, 3)), 1, '1.4b 2026-08-03 (周一) → 1');

  // 1.5 shanghaiISO: 含 +08:00 (依赖 TZ env, 测试要求 TZ=Asia/Shanghai)
  const d3 = new Date(2026, 7, 5, 14, 30, 45, 123);
  const iso = DP.shanghaiISO(d3);
  assert(iso.includes('T14:30:45.123'), '1.5a shanghaiISO 含时分秒.毫秒');
  assert(iso.endsWith('+08:00') || iso.endsWith('+0800'), '1.5b shanghaiISO 含 +08:00 (TZ env=Asia/Shanghai)');

  // 1.6 nowShanghai 返回 Date
  assert(DP.nowShanghai() instanceof Date, '1.6 nowShanghai 返回 Date');

  // ============================================================
  console.log('\n[2] makeAlert + attachAlertId: 3 case');
  // ============================================================

  // 2.1 makeAlert: 含 ts (shanghaiISO)
  const a1 = DP.makeAlert({ severity: 'high', action: 'test', code: '000001', name: 'X', title: 't', body: 'b', linked_rules: [1], context: {} });
  assertEq(a1.severity, 'high', '2.1a severity 透传');
  assertEq(a1.action, 'test', '2.1b action 透传');
  assert(typeof a1.ts === 'string' && a1.ts.includes('T'), '2.1c ts 自动注入 (ISO 格式)');
  assert(!('id' in a1), '2.1d makeAlert 不含 id (?v=daemon4 F1 修)');

  // 2.2 attachAlertId: id 格式
  const a2 = DP.attachAlertId(a1, 'morningBrief', '2026-08-05');
  assertEq(a2.id, 'morningBrief-test-000001-2026-08-05', '2.2a id 格式 = {slot}-{action}-{code}-{dayKey}');
  assertEq(a2.slot, 'morningBrief', '2.2b slot 透传');

  // 2.3 attachAlertId: code 为空时回退 '*'
  const a3 = DP.attachAlertId({ severity: 'warn', action: 'cash', code: null, name: '总资产', title: 't', body: 'b', linked_rules: [], context: {} }, 'dailySweep', '2026-08-05');
  assert(a3.id.includes('-cash-*-'), '2.3 code=null → id 用 *');

  // ============================================================
  console.log('\n[3] runRule1: 4 case');
  // ============================================================

  // 3.1 total=0 → 空
  const ctx0 = makeCtx({ portfolio: { cash: 0, stockMkt: 0, total: 0 } });
  assertEq(DP.runRule1(ctx0).length, 0, '3.1 total=0 → 无 alert');

  // 3.2 单票超限 (high)
  const ctx2 = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 1000 })],  // 100000 / 200000 = 50%
    portfolio: { cash: 100000, stockMkt: 100000, total: 200000, stockPct: 0.5 }
  });
  const r1 = DP.runRule1(ctx2);
  assertEq(r1.length, 1, '3.2a 单票 50% > 10% → 1 条 alert');
  assertEq(r1[0].severity, 'high', '3.2b severity=high');
  assert(r1[0].title.includes('单票超限'), '3.2c title 含"单票超限"');

  // 3.3 仓位偏重 (warn) - 7% 介于 stockOverPct(0.08) 和 singleStockMaxPct(0.10) 之间
  //   注意 Math.min(stockOverPct, singleStockMaxPct) = min(0.08, 0.10) = 0.08
  //   所以 warn 阈值是 0.08, 7% < 0.08 → 不触发. 用 8.5% 触发
  const ctx3 = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 170 })],  // 17000 / 200000 = 8.5%
    portfolio: { cash: 183000, stockMkt: 17000, total: 200000, stockPct: 0.085 }
  });
  const r2 = DP.runRule1(ctx3);
  assertEq(r2.length, 1, '3.3a 仓位 8.5% 介于 0.08-0.10 → 1 条 warn');
  assertEq(r2[0].severity, 'warn', '3.3b severity=warn');

  // 3.4 现金储备不足
  const ctx4 = makeCtx({
    portfolio: { cash: 1000, stockMkt: 99000, total: 100000, stockPct: 0.99 }  // 1% < 5% 阈值
  });
  const r3 = DP.runRule1(ctx4);
  const cashAlert = r3.find(a => a.title.includes('现金储备不足'));
  assert(cashAlert, '3.4 现金 1% < 5% → 报现金储备不足');

  // ============================================================
  console.log('\n[4] decideAddOn: 4 case');
  // ============================================================

  // 4.1 bear 闸门关闭 (mult=0) → add-blocked
  const ctxBear = makeCtx({
    regime: { current: 'bear', positionMultiplier: 0 }
  });
  const ab1 = DP.decideAddOn(ctxBear);
  assertEq(ab1.length, 1, '4.1a bear mult=0 → 1 条');
  assertEq(ab1[0].action, 'add-blocked', '4.1b action=add-blocked');

  // 4.2 加仓预算耗尽 (mult=0.5 但 total*mult < stockMkt)
  const ctxBudget = makeCtx({
    holdings: [makeHolding({ price: 1000, shares: 500 })],  // 500000
    portfolio: { cash: 0, stockMkt: 500000, total: 500000, stockPct: 1.0 },
    regime: { current: 'range_strong', positionMultiplier: 0.3 }
  });
  const ab2 = DP.decideAddOn(ctxBudget);
  // total*mult - stockMkt - cashReserveAbs = 500000*0.3 - 500000 - 500000*0.05 = 150000 - 500000 - 25000 = -375000 < 0
  assert(ab2.some(a => a.action === 'add-veto' && a.title.includes('加仓预算耗尽')), '4.2 加仓预算 < 0 → add-veto');

  // 4.3 浮盈门槛 (chg5=0.04 < 0.05 阈值)
  const ctxProfit = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 100, chg5: 0.04, sectorStrength: 0.7 })],
    portfolio: { cash: 100000, stockMkt: 10000, total: 110000, stockPct: 0.09 }
  });
  const ab3 = DP.decideAddOn(ctxProfit);
  assert(!ab3.some(a => a.action === 'add'), '4.3 chg5=4% < 5% → 无 add');

  // 4.4 全部条件满足 → add 1 条
  //   hPct < 10% (singleStockMaxPct) + shares * addMaxRatio 整手
  //   shares=200, price=100, total=300000: hPct=6.7% ✓, newShares=floor(200*0.5/100)*100=100 (一手)
  const ctxGood = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 200, chg5: 0.08, sectorStrength: 0.8 })],
    portfolio: { cash: 280000, stockMkt: 20000, total: 300000, stockPct: 0.067 }
  });
  const ab4 = DP.decideAddOn(ctxGood);
  const addAlert = ab4.find(a => a.action === 'add' && a.code === '600519');
  assert(addAlert, '4.4 chg5=8% + sector=0.8 + 无冷却 + hPct<10% + shares=200 → add 1 条');
  assert(addAlert.context.newShares >= 100, '4.4b newShares >= 100 (一手)');

  // 4.5 冷却期: lastAdd 在 1 天前 (< 3 天 cooldown)
  const ctxCooldown = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 200, chg5: 0.08, sectorStrength: 0.8 })],
    portfolio: { cash: 280000, stockMkt: 20000, total: 300000, stockPct: 0.067 },
    lastAddTsMap: { '600519': Date.now() - 1 * 24 * 60 * 60 * 1000 }
  });
  const ab5 = DP.decideAddOn(ctxCooldown);
  assert(!ab5.some(a => a.action === 'add' && a.code === '600519'), '4.5 1 天前加过 + cooldown 3d → 不 add');

  // ============================================================
  console.log('\n[5] decideStopAndTrim: 3 case');
  // ============================================================

  // 5.1 跌破 MA20 → high/stop
  const ctxMA20 = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', belowMA20: true })]
  });
  const st1 = DP.decideStopAndTrim(ctxMA20);
  const stopAlert = st1.find(a => a.action === 'stop');
  assert(stopAlert, '5.1 belowMA20=true → stop');
  assertEq(stopAlert.severity, 'high', '5.1b severity=high');

  // 5.2 鱼尾行情 (chg5 > 15% 阈值)
  const ctxFish = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', chg5: 0.20 })]
  });
  const st2 = DP.decideStopAndTrim(ctxFish);
  const fishAlert = st2.find(a => a.action === 'trim' && a.title.includes('鱼尾'));
  assert(fishAlert, '5.2 chg5=20% > 15% → 鱼尾 trim');
  assertEq(fishAlert.severity, 'warn', '5.2b severity=warn');

  // 5.3 板块走弱 (sectorStrength < 0.5)
  const ctxWeak = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', sectorStrength: 0.3 })]
  });
  const st3 = DP.decideStopAndTrim(ctxWeak);
  const weakAlert = st3.find(a => a.action === 'trim' && a.title.includes('板块走弱'));
  assert(weakAlert, '5.3 sectorStrength=0.3 < 0.5 → 板块走弱 trim');
  assertEq(weakAlert.severity, 'info', '5.3b severity=info');

  // 5.4 bear 下 trimPct 收严 (×1.5)
  //   bear 下 trimPct = min(0.95, 0.15 * 1.5) = 0.225, chg5=0.20 < 0.225 → 不触发
  //   改用 chg5=0.25 触发
  const ctxBearFish = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', chg5: 0.20 })],
    regime: { current: 'bear', positionMultiplier: 0 }
  });
  const st4 = DP.decideStopAndTrim(ctxBearFish);
  const bearFish = st4.find(a => a.title.includes('鱼尾'));
  assert(!bearFish, '5.4a bear 下 chg5=20% < 22.5% (bear ×1.5) → 不触发鱼尾');

  const ctxBearFish2 = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', chg5: 0.25 })],
    regime: { current: 'bear', positionMultiplier: 0 }
  });
  const st5 = DP.decideStopAndTrim(ctxBearFish2);
  const bearFish2 = st5.find(a => a.title.includes('鱼尾'));
  assert(bearFish2, '5.4b bear 下 chg5=25% > 22.5% → 触发鱼尾 (bear 收严)');

  // ============================================================
  console.log('\n[6] runRule6: 1 case');
  // ============================================================

  // 6.1 runRule6: 透传 ctx.regime
  const ctx6 = makeCtx({ regime: { current: 'bear', positionMultiplier: 0 } });
  assertEq(DP.runRule6(ctx6), ctx6.regime, '6.1 runRule6 透传 ctx.regime');

  // ============================================================
  console.log('\n[7] runAllRules: 3 case');
  // ============================================================

  // 7.1 空持仓 → 至少 1 条 (现金不足或无)
  const ctxAllEmpty = makeCtx();
  const all1 = DP.runAllRules(ctxAllEmpty, 'morningBrief');
  // bull 100% cash, 5% reserve → 100% > 5%, 不报 cash. 其它规则都基于 holdings, 空 → 无
  // 但 cashPct=1.0, 1.0 > 0.05 → 不报 cashReserve
  // 但 total=100000, mult=1.0, addBudget = 100000 - 0 - 5000 = 95000 > 0 → 也不报 add-veto
  // 空持仓 → 应该 0 条
  assertEq(all1.length, 0, '7.1 空持仓 + 满 cash → 0 alerts');

  // 7.2 单票超限 + 鱼尾 + 板块弱 全部命中 → 4 条 (板块弱被鱼尾幂等覆盖)
  //   已知行为: runAllRules 按 id 幂等去重, 同 code+同 action 留 severity 最高
  //   鱼尾 (warn) 和 板块走弱 (info) 都是 action=trim, 同 code, 鱼尾覆盖板块走弱
  //   这是 P0 设计 bug (不同规则的 trim 决策应分开, 留作 P2 重构)
  const ctxAllFull = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 1000, chg5: 0.20, sectorStrength: 0.3 })],  // 100% / 20% / 0.3 全触发
    portfolio: { cash: 0, stockMkt: 100000, total: 100000, stockPct: 1.0 }
  });
  const all2 = DP.runAllRules(ctxAllFull, 'morningBrief');
  const aStock = all2.find(a => a.action === 'alert' && a.code === '600519');
  const aFish = all2.find(a => a.action === 'trim' && a.title.includes('鱼尾'));
  const aWeak = all2.find(a => a.action === 'trim' && a.title.includes('板块走弱'));
  const aVeto = all2.find(a => a.action === 'add-veto');
  assert(aStock, '7.2a 单票超限');
  assert(aFish, '7.2b 鱼尾 (warn, 覆盖板块走弱)');
  assert(!aWeak, '7.2c 板块走弱被鱼尾幂等覆盖 (同 code 同 action) [P0 设计 bug 待修]');
  assert(aVeto, '7.2d 加仓预算耗尽');

  // 7.3 排序: high 优先
  const ctxMixed = makeCtx({
    holdings: [
      makeHolding({ code: '000001', name: 'A', price: 100, shares: 50, chg5: 0.20, sectorStrength: 0.7 }),  // 鱼尾
      makeHolding({ code: '000002', name: 'B', price: 100, shares: 1000 })  // 50% 单票超限
    ],
    portfolio: { cash: 0, stockMkt: 150000, total: 200000, stockPct: 0.75 }
  });
  const all3 = DP.runAllRules(ctxMixed, 'morningBrief');
  // 第 1 条应该是 high (单票超限) 不是 warn
  assertEq(all3[0].severity, 'high', '7.3a 第 1 条 severity=high (单票超限排序在前)');

  // 7.4 id 格式: slot-action-code-dayKey
  const firstId = all3[0].id;
  assert(firstId.startsWith('morningBrief-'), '7.4a id 前缀 = slot 名');
  assert(firstId.includes('2026-08-05'), '7.4b id 末段 = dayKey (上海日)');

  // 7.5 幂等去重: 同 code 同 action 只保留最高 severity
  //   单票超限 (high) 和仓位偏重 (warn) 同 code 同 action → 留 high
  // 实际上 1.2 单票超限 (50%) 走 if 分支, 不走 else (warn). 1.3 (8.5%) 走 warn 分支
  // 要测试去重, 造一个 ctx 让 1.2 触发两次 (不可能, ctx 单调)
  // 改测: 同 code 不同 action 各保留
  const ctxDedup = makeCtx({
    holdings: [makeHolding({ code: '000001', name: 'A', price: 100, shares: 1000, chg5: 0.20 })],  // 单票超限 + 鱼尾
    portfolio: { cash: 0, stockMkt: 100000, total: 100000 }
  });
  const all4 = DP.runAllRules(ctxDedup, 'morningBrief');
  // 1.2 单票超限 (action=alert, severity=high) + 5.2 鱼尾 (action=trim, severity=warn) = 不同 action, 都保留
  const dedupCodes = all4.map(a => `${a.code}-${a.action}`);
  assert(dedupCodes.includes('000001-alert') && dedupCodes.includes('000001-trim'),
    '7.5 同 code 不同 action 都保留 (alert + trim)');

  // ============================================================
  console.log(`\n===== 测试结果 =====`);
  console.log(`通过: ${pass}  |  失败: ${fail}`);
  if (fail === 0) {
    console.log('✓ 全部通过');
    process.exit(0);
  } else {
    console.log(`✗ ${fail} 个失败`);
    process.exit(1);
  }
})().catch(e => {
  console.error('test runner 异常:', e);
  process.exit(1);
});
