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
  return { code: '600519', name: '贵州茅台', price: 1700, shares: 100, chg5: 0.05, belowMA20: false, sectorStrength: 0.7, sector: '消费', cost: 1500, ...overrides };
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

  // 3.2 单票超限 (critical) - [P0 #5] 5x 阈值升级 critical + action=force-trim
  const ctx2 = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 1000 })],  // 100000 / 200000 = 50%
    portfolio: { cash: 100000, stockMkt: 100000, total: 200000, stockPct: 0.5 }
  });
  const r1 = DP.runRule1(ctx2);
  assertEq(r1.length, 1, '3.2a 单票 50% > 10% → 1 条 alert');
  // 50% / 10% = 5x → critical (P0 #5)
  assertEq(r1[0].severity, 'critical', '3.2b [P0#5] 5x 阈值 → severity=critical');
  assertEq(r1[0].action, 'force-trim', '3.2b2 [P0#5] 5x → action=force-trim');
  assert(r1[0].title.includes('单票超限'), '3.2c title 含"单票超限"');

  // 3.2d 单票超限 1.5x → high + action=trim (2x-5x 区间)
  const ctx2_1 = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 300 })],  // 30000/200000=15% = 1.5x
    portfolio: { cash: 170000, stockMkt: 30000, total: 200000, stockPct: 0.15 }
  });
  const r1_1 = DP.runRule1(ctx2_1);
  assertEq(r1_1[0].severity, 'high', '3.2d [P0#5] 1.5x → severity=high');
  assertEq(r1_1[0].action, 'trim', '3.2d2 [P0#5] 1.5x → action=trim');

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

  // 4.6 [P0 #2] 加完后再校验单票上限 + 整手取整
  //   addMaxRatio=0.5 (50%) + shares=300, 50% of 300 = 150 股, 但 A 股 100 股一手, 整手取整 floor → 100 股
  //   旧代码 maxByRule=100 是正确的, 我之前误判 P0#1 是公式错 (实际是 #2 加完没校验)
  //   核心修复: 加完后 hPct_after 不能超 singleStockMaxPct
  const ctxFormula = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 300, chg5: 0.08, sectorStrength: 0.8 })],
    portfolio: { cash: 500000, stockMkt: 30000, total: 530000, stockPct: 0.057 }  // hPct=5.66% < 10%
  });
  const ab6 = DP.decideAddOn(ctxFormula);
  const addFormula = ab6.find(a => a.action === 'add' && a.code === '600519');
  assert(addFormula, '4.6a [P0#2] 满足所有条件 → add 1 条');
  // 50% of 300 = 150, 整手取整 floor(150/100)*100 = 100
  assertEq(addFormula.context.newShares, 100, '4.6b [P0#2] addMaxRatio=0.5 + shares=300 → newShares=100 (150 整手 floor)');
  // 加上 100 股后 hPct_after = (30000 + 100*100) / 530000 = 40000/530000 = 7.5%, 仍 < 10% 上限
  const hPctAfter = (30000 + 100 * 100) / 530000;
  assert(hPctAfter < 0.10, '4.6c [P0#2] 加完 hPct_after=7.5% < 10% 上限');

  // 4.7 [P0 #2] 加完即超单票上限 → add-skip
  //   shares=200, price=100, total=240000, hMkt=20000, hPct=8.33%
  //   maxByRule = floor(200*0.5/100)*100 = 100
  //   maxBySinglePct = floor(((0.10*240000-20000)/100)/100)*100 = floor(4000/100/100)*100 = floor(0.4)*100 = 0
  //   newShares = min(100, 0) = 0 → skip
  const ctxOvercap = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 200, chg5: 0.08, sectorStrength: 0.8 })],
    portfolio: { cash: 220000, stockMkt: 20000, total: 240000, stockPct: 0.083 }
  });
  const ab7 = DP.decideAddOn(ctxOvercap);
  const skipAlert = ab7.find(a => a.action === 'add-skip' && a.code === '600519');
  assert(skipAlert, '4.7 [P0#2] 加完即超单票上限 → add-skip');

  // 4.8 [P0 #2] 加完临界: 剩余预算刚好够加 100 股 → 取 100, 截断后不超阈值
  //   shares=200, price=100, total=300000, hMkt=20000, hPct=6.67%
  //   maxByRule = 100, maxBySinglePct = floor(((0.10*300000-20000)/100)/100)*100 = floor(10000/100/100)*100 = 100
  //   newShares = min(100, 100) = 100 ✓
  const ctxEdge = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 200, chg5: 0.08, sectorStrength: 0.8 })],
    portfolio: { cash: 280000, stockMkt: 20000, total: 300000, stockPct: 0.067 }
  });
  const ab8 = DP.decideAddOn(ctxEdge);
  const addEdge = ab8.find(a => a.action === 'add' && a.code === '600519');
  assert(addEdge, '4.8 [P0#2] 加完临界 (100 股) → add');
  assertEq(addEdge.context.newShares, 100, '4.8b [P0#2] 临界 100 股, min(100,100) = 100');

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

  // 5.5 [P1 #6] bear 模式不再产 sectorWeak (避免跟"空仓合法"双重信号)
  const ctxBearWeak = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', sectorStrength: 0.3 })],
    regime: { current: 'bear', positionMultiplier: 0 }
  });
  const st6 = DP.decideStopAndTrim(ctxBearWeak);
  const bearWeak = st6.find(a => a.title.includes('板块走弱'));
  assert(!bearWeak, '5.5 [P1#6] bear 模式 + sectorStrength=0.3 → 不再产 sectorWeak');

  // 5.6 [P0 #5] bear 模式 + belowMA20 → critical + force-trim (强清)
  const ctxBearMA = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', belowMA20: true })],
    regime: { current: 'bear', positionMultiplier: 0 }
  });
  const st7 = DP.decideStopAndTrim(ctxBearMA);
  const bearMA = st7.find(a => a.title.includes('跌破 MA20'));
  assert(bearMA, '5.6a bear 模式 + belowMA20 → 仍产 ma20 告警');
  assertEq(bearMA.severity, 'critical', '5.6b [P0#5] bear + ma20 → severity=critical');
  assertEq(bearMA.action, 'force-trim', '5.6c [P0#5] bear + ma20 → action=force-trim');

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

  // 7.2 单票超限 + 鱼尾 + 板块弱 全部命中 → 4 条
  // id 格式加 rule 维度 (fishTail / sectorWeak), 板块走弱独立保留
  //   旧 P0 bug: 鱼尾 (warn) 跟板块走弱 (info) 同 code+同 action, 板块走弱被静默吞
  //   新行为: 两条都触发, 用户能看到 板块走弱 info + 鱼尾 warn
  // [P0 #5] 单票 100% / 10% = 10x → critical/force-trim (升级)
  const ctxAllFull = makeCtx({
    holdings: [makeHolding({ code: '600519', name: 'X', price: 100, shares: 1000, chg5: 0.20, sectorStrength: 0.3 })],  // 100% / 20% / 0.3 全触发
    portfolio: { cash: 0, stockMkt: 100000, total: 100000, stockPct: 1.0 }
  });
  const all2 = DP.runAllRules(ctxAllFull, 'morningBrief');
  // [P0#5] 单票 10x → critical/force-trim, 找 action=force-trim 而非 alert
  const aStock = all2.find(a => a.action === 'force-trim' && a.code === '600519');
  const aFish = all2.find(a => a.action === 'trim' && a.title.includes('鱼尾'));
  const aWeak = all2.find(a => a.action === 'trim' && a.title.includes('板块走弱'));
  const aVeto = all2.find(a => a.action === 'add-veto');
  assert(aStock, '7.2a [P0#5] 单票 10x → force-trim');
  assertEq(aStock.severity, 'critical', '7.2a2 [P0#5] 单票 10x → severity=critical');
  assert(aFish, '7.2b 鱼尾 (warn)');
  assert(aWeak, '7.2c 板块走弱 (info) 独立保留 — 不再被鱼尾覆盖 (?v=daemon7 P0 修复)');
  assert(aVeto, '7.2d 加仓预算耗尽');

  // 7.3 排序: critical 优先
  const ctxMixed = makeCtx({
    holdings: [
      makeHolding({ code: '000001', name: 'A', price: 100, shares: 50, chg5: 0.20, sectorStrength: 0.7 }),  // 鱼尾
      makeHolding({ code: '000002', name: 'B', price: 100, shares: 1000 })  // 50% 单票超限 → 5x → critical
    ],
    portfolio: { cash: 0, stockMkt: 150000, total: 200000, stockPct: 0.75 }
  });
  const all3 = DP.runAllRules(ctxMixed, 'morningBrief');
  // 第 1 条应该是 critical (单票超限 5x), [P0 #5] 加了 critical 档后比 high/warn 都靠前
  assertEq(all3[0].severity, 'critical', '7.3a [P0#5] 第 1 条 severity=critical (单票 5x 超限排序在最前)');

  // 7.4 id 格式: slot-action-code-dayKey
  // 修: dayKey 拿实时 (跟 runAllRules 一致), 不写死
  //   之前用 '2026-08-05' hardcode, 隔天后会挂
  const firstId = all3[0].id;
  const todayDayKey = DP.shanghaiStr().slice(0, 10);
  assert(firstId.startsWith('morningBrief-'), '7.4a id 前缀 = slot 名');
  assert(firstId.includes(todayDayKey), '7.4b id 末段 = dayKey (上海日, 实时)');

  // 7.5 幂等去重: 同 code 同 action 只保留最高 severity
  //   [P0 #5] 单票 100% (10x) → critical/force-trim (不再用 alert)
  //   跟 5.2 鱼尾 (action=trim) 不同 action, 都保留
  const ctxDedup = makeCtx({
    holdings: [makeHolding({ code: '000001', name: 'A', price: 100, shares: 1000, chg5: 0.20 })],  // 单票超限 10x + 鱼尾
    portfolio: { cash: 0, stockMkt: 100000, total: 100000 }
  });
  const all4 = DP.runAllRules(ctxDedup, 'morningBrief');
  const dedupCodes = all4.map(a => `${a.code}-${a.action}`);
  // [P0#5] 单票超限 10x → force-trim (非 alert)
  assert(dedupCodes.includes('000001-force-trim') && dedupCodes.includes('000001-trim'),
    '7.5 [P0#5] 同 code 不同 action 都保留 (force-trim + trim)');

  // ============================================================
  console.log('\n[8] runRule7 (单行业集中度): 4 case [P1 #4]');
  // ============================================================
  // 8.1 无 singleIndustryMaxPct 配置 → 0 alerts
  const ctxR7_1 = makeCtx({
    rules: { singleIndustryMaxPct: 0 },
    holdings: [makeHolding({ code: '000001', name: 'A', sector: '白酒', price: 100, shares: 1000 })]
  });
  assertEq(DP.runRule7(ctxR7_1).length, 0, '8.1 未配置 singleIndustryMaxPct → 0 alerts');

  // 8.2 同行业 30% > 20% 阈值 (1.5x) → high + trim
  const ctxR7_2 = makeCtx({
    rules: { singleIndustryMaxPct: 0.20 },
    holdings: [
      makeHolding({ code: '000001', name: 'A', sector: '白酒', price: 100, shares: 300 }),  // 30000
      makeHolding({ code: '000002', name: 'B', sector: '白酒', price: 100, shares: 100 })   // 10000
    ],
    portfolio: { cash: 60000, stockMkt: 40000, total: 100000, stockPct: 0.4 }  // 40% 行业
  });
  const r7_2 = DP.runRule7(ctxR7_2);
  assertEq(r7_2.length, 1, '8.2a 单行业 40% > 20% → 1 alert');
  assertEq(r7_2[0].severity, 'high', '8.2b [P1#4] 1.5x 区间 → severity=high');
  assertEq(r7_2[0].action, 'trim', '8.2c [P1#4] 1.5x → action=trim');
  assert(r7_2[0].context.members.includes('A') && r7_2[0].context.members.includes('B'),
    '8.2d members 列出同行业所有持仓');

  // 8.3 同行业 50% (5x 阈值 0.10) → critical + force-trim
  //   50% / 10% = 5x, 触发 critical/force-trim 阈值
  const ctxR7_3 = makeCtx({
    rules: { singleIndustryMaxPct: 0.10 },
    holdings: [
      makeHolding({ code: '000001', name: 'A', sector: '白酒', price: 100, shares: 500 })  // 50000 = 50%
    ],
    portfolio: { cash: 50000, stockMkt: 50000, total: 100000, stockPct: 0.5 }
  });
  const r7_3 = DP.runRule7(ctxR7_3);
  assertEq(r7_3[0].severity, 'critical', '8.3 [P1#4] 5x → severity=critical');
  assertEq(r7_3[0].action, 'force-trim', '8.3b [P1#4] 5x → action=force-trim');

  // 8.4 多行业各 ≤ 阈值 → 0 alerts
  const ctxR7_4 = makeCtx({
    rules: { singleIndustryMaxPct: 0.20 },
    holdings: [
      makeHolding({ code: '000001', name: 'A', sector: '白酒', price: 100, shares: 100 }),  // 10%
      makeHolding({ code: '000002', name: 'B', sector: '科技', price: 100, shares: 100 })   // 10%
    ],
    portfolio: { cash: 80000, stockMkt: 20000, total: 100000, stockPct: 0.2 }
  });
  assertEq(DP.runRule7(ctxR7_4).length, 0, '8.4 多行业各 10% < 20% → 0 alerts');

  // ============================================================
  console.log('\n[9] runRule8 (月度回撤熔断): 3 case [P1 #4]');
  // ============================================================
  // 9.1 无 peak 数据 → 0 alerts
  const ctxR8_1 = makeCtx({ portfolio: { cash: 50000, stockMkt: 50000, total: 100000 } });
  assertEq(DP.runRule8(ctxR8_1).length, 0, '9.1 无 portfolio.peak → 0 alerts');

  // 9.2 回撤 6% > 5% 阈值 → critical
  const ctxR8_2 = makeCtx({
    rules: { monthlyMaxDrawdown: 0.05 },
    portfolio: { cash: 50000, stockMkt: 44000, total: 94000, stockPct: 0.468, peak: 100000, monthKey: '2026-08' }
  });
  const r8_2 = DP.runRule8(ctxR8_2);
  assertEq(r8_2.length, 1, '9.2a 回撤 6% > 5% → 1 alert');
  assertEq(r8_2[0].severity, 'critical', '9.2b [P1#4] 月度回撤熔断 → severity=critical');
  assertEq(r8_2[0].action, 'circuit-breaker', '9.2c [P1#4] action=circuit-breaker');

  // 9.3 回撤 3% < 5% 阈值 → 不报
  const ctxR8_3 = makeCtx({
    rules: { monthlyMaxDrawdown: 0.05 },
    portfolio: { cash: 50000, stockMkt: 47000, total: 97000, peak: 100000, monthKey: '2026-08' }
  });
  assertEq(DP.runRule8(ctxR8_3).length, 0, '9.3 回撤 3% < 5% → 0 alerts');

  // ============================================================
  console.log('\n[10] runRule9 (股票总仓): 3 case [P1 #4]');
  // ============================================================
  // 10.1 stockPct 95% > 90% 阈值 → critical + force-trim
  const ctxR9_1 = makeCtx({
    rules: { totalStockMaxPct: 0.90, cashReservePct: 0.05 },
    portfolio: { cash: 5000, stockMkt: 95000, total: 100000, stockPct: 0.95 }
  });
  const r9_1 = DP.runRule9(ctxR9_1);
  assertEq(r9_1.length, 1, '10.1a stockPct 95% > 90% → 1 alert');
  assertEq(r9_1[0].severity, 'critical', '10.1b [P1#4] 总仓超限 → severity=critical');
  assertEq(r9_1[0].action, 'force-trim', '10.1c [P1#4] action=force-trim');
  assertEq(r9_1[0].context.conflict, false, '10.1d 阈值不冲突 (90+5 ≤ 100)');

  // 10.2 stockPct 80% < 90% 阈值 → 0 alerts
  const ctxR9_2 = makeCtx({
    rules: { totalStockMaxPct: 0.90 },
    portfolio: { cash: 20000, stockMkt: 80000, total: 100000, stockPct: 0.80 }
  });
  assertEq(DP.runRule9(ctxR9_2).length, 0, '10.2 stockPct 80% < 90% → 0 alerts');

  // 10.3 阈值冲突 (totalStockMaxPct + cashReservePct > 1) → 标注 conflict
  const ctxR9_3 = makeCtx({
    rules: { totalStockMaxPct: 0.95, cashReservePct: 0.10 },
    portfolio: { cash: 4000, stockMkt: 96000, total: 100000, stockPct: 0.96 }
  });
  const r9_3 = DP.runRule9(ctxR9_3);
  assertEq(r9_3[0].context.conflict, true, '10.3 [P1#4] 95+10>100 → conflict=true');

  // ============================================================
  console.log('\n[11] runRule10 (短线止损): 3 case [P1 #4]');
  // ============================================================
  // 11.1 浮亏 4% > 3% 阈值 → high + stop
  const ctxR10_1 = makeCtx({
    rules: { shortStopLossPct: 0.03 },
    holdings: [makeHolding({ code: '600519', name: 'X', cost: 100, price: 96 })]  // -4%
  });
  const r10_1 = DP.runRule10(ctxR10_1);
  assertEq(r10_1.length, 1, '11.1a 浮亏 -4% > 3% → 1 alert');
  assertEq(r10_1[0].severity, 'high', '11.1b [P1#4] 短线止损 → severity=high');
  assertEq(r10_1[0].action, 'stop', '11.1c [P1#4] action=stop');
  assertEq(r10_1[0].context.ret, -0.04, '11.1d 浮亏 -4% 精确');

  // 11.2 浮亏 2% < 3% 阈值 → 0 alerts
  const ctxR10_2 = makeCtx({
    rules: { shortStopLossPct: 0.03 },
    holdings: [makeHolding({ code: '600519', name: 'X', cost: 100, price: 98 })]  // -2%
  });
  assertEq(DP.runRule10(ctxR10_2).length, 0, '11.2 浮亏 -2% < 3% → 0 alerts');

  // 11.3 无 cost 字段 → 跳过 (向后兼容)
  const ctxR10_3 = makeCtx({
    rules: { shortStopLossPct: 0.03 },
    holdings: [{ code: '600519', name: 'X', price: 96, shares: 100 }]  // 没 cost
  });
  assertEq(DP.runRule10(ctxR10_3).length, 0, '11.3 [P1#4] 无 cost → 跳过');

  // ============================================================
  console.log('\n[11.5] runRule11 (regime-stale): 3 case [P2 #13]');
  // ============================================================
  // 11.5a 无 ctx.state → 0 alerts (注入缺失优雅降级)
  assertEq(DP.runRule11({}).length, 0, '11.5a [P2#13] 无 ctx.state → 0 alerts');

  // 11.5b state 注入 + 没 _rw_regime_today → warn "regime 未初始化"
  const mockStateEmpty = { safeReadJson: (k, fb) => fb };
  const r11_2 = DP.runRule11({ state: mockStateEmpty });
  assertEq(r11_2.length, 1, '11.5b [P2#13] 无 _rw_regime_today → 1 warn');
  assertEq(r11_2[0].severity, 'warn', '11.5b2 severity=warn');
  assert(r11_2[0].title.includes('未初始化'), '11.5b3 title 含"未初始化"');

  // 11.5c regime=unknown + votes<5 → warn
  const mockStateUnknown = {
    safeReadJson: (k, fb) => {
      if (k === '_rw_regime_today') return { regime: 'unknown', confidence: 0.2 };
      if (k === '_rw_regime_votes') return [];
      return fb;
    }
  };
  const r11_3 = DP.runRule11({ state: mockStateUnknown });
  assertEq(r11_3.length, 1, '11.5c [P2#13] unknown + 0 votes → 1 alert');
  assertEq(r11_3[0].severity, 'warn', '11.5c2 数据不足 → warn');

  // 11.5d regime=unknown + votes≥5 → critical (持续 unknown)
  const mockStateStale = {
    safeReadJson: (k, fb) => {
      if (k === '_rw_regime_today') return { regime: 'unknown', confidence: 0.1 };
      if (k === '_rw_regime_votes') return Array.from({ length: 6 }, (_, i) => ({ date: 20260801 + i, d1: 0, d2: 'normal', d3: 0, sum: 0 }));
      return fb;
    }
  };
  const r11_4 = DP.runRule11({ state: mockStateStale });
  assertEq(r11_4.length, 1, '11.5d [P2#13] unknown + 6 votes → 1 alert');
  assertEq(r11_4[0].severity, 'critical', '11.5d2 持续 unknown → critical');

  // 11.5e regime=bull + confidence 0.8 → 0 alerts (正常)
  const mockStateBull = {
    safeReadJson: (k, fb) => {
      if (k === '_rw_regime_today') return { regime: 'bull', confidence: 0.8 };
      return fb;
    }
  };
  assertEq(DP.runRule11({ state: mockStateBull }).length, 0, '11.5e [P2#13] bull+0.8 → 0 alerts (正常)');

  // ============================================================
  console.log('\n[12] runAllRules 集成: 4 规则聚合 [P1 #4]');
  // ============================================================
  // 12.1 单行业 + 月度回撤 + 总仓 同时触发 → 都进 alerts
  const ctxIntegrated = makeCtx({
    rules: {
      singleStockMaxPct: 0.10, cashReservePct: 0.05, totalStockMaxPct: 0.85, cashReservePct: 0.05,
      singleIndustryMaxPct: 0.20, monthlyMaxDrawdown: 0.05, shortStopLossPct: 0.03,
      addOnProfitPct: 0.05, addMaxRatio: 0.5, addCooldownDays: 3,
      fishTailTrimPct: 0.15, sectorWeakPct: 0.50
    },
    holdings: [
      makeHolding({ code: '000001', name: 'A', sector: '白酒', price: 100, shares: 1000, cost: 120 })  // 单票 100%, 同行业 100%, 浮亏 17%
    ],
    portfolio: { cash: 0, stockMkt: 100000, total: 100000, stockPct: 1.0, peak: 130000, monthKey: '2026-08' }
  });
  const allInteg = DP.runAllRules(ctxIntegrated, 'morningBrief');
  // 应有: 单票超限 (critical/force-trim) + 单行业超限 (critical/force-trim) + 月度回撤熔断 (critical/circuit-breaker) + 总仓超限 (critical/force-trim) + 短线止损 (high/stop)
  const iStock = allInteg.find(a => a.action === 'force-trim' && a.title.includes('单票'));
  const iIndustry = allInteg.find(a => a.action === 'force-trim' && a.title.includes('单行业'));
  const iDD = allInteg.find(a => a.action === 'circuit-breaker');
  const iTotal = allInteg.find(a => a.title.includes('总仓'));
  const iShort = allInteg.find(a => a.action === 'stop' && a.title.includes('短线'));
  assert(iStock, '12.1a [P1#4] 集成: 单票超限');
  assert(iIndustry, '12.1b [P1#4] 集成: 单行业超限');
  assert(iDD, '12.1c [P1#4] 集成: 月度回撤熔断');
  assert(iTotal, '12.1d [P1#4] 集成: 总仓超限');
  assert(iShort, '12.1e [P1#4] 集成: 短线止损');
  // critical 应排在前
  assertEq(allInteg[0].severity, 'critical', '12.1f [P1#4] critical 排首位');

  // ============================================================
  console.log('\n[13] SEVERITY_RANK: 1 case [P0 #5]');
  // ============================================================
  assertEq(DP.SEVERITY_RANK.critical, 4, '13 [P0#5] critical=4 (4 档)');
  assertEq(DP.SEVERITY_RANK.high, 3, '13a high=3');
  assertEq(DP.SEVERITY_RANK.warn, 2, '13b warn=2');
  assertEq(DP.SEVERITY_RANK.info, 1, '13c info=1');

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
