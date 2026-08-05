/**
 * reverse-watch pure module 单元测试 (≥30 case, 4 子模块)
 *
 * 覆盖:
 *   - auto-tuner-pure:   clamp / computeSignals / shouldSkip / decide / getRecentlyTunedTargets (8 case)
 *   - screener-pure:     4 闸 + 用户排除 + 鱼尾 + 量化 + RiskMine (8 case)
 *   - regime-detector:   calcATR / voteDay / applyHysteresis / checkRegime / positionMultiplier (8 case)
 *   - risk-mine-pure:    _num / judgeRisks / SEVERITY / readCached* / describeRisk / prewarmPool / scanRiskDedup (10 case)
 *
 * 跑法: node test/orchestration/reverse-watch-pure.test.js
 * 必须返回 0 fail
 *
 * 设计:
 *   - 用 dynamic import() 加载 ES module (Node 18+)
 *   - state 接口 mock (in-memory map), 不污染 reverse-watch/_rw_state_*.json
 *   - fetchAkshare mock (返回固定数据, 验证调用次数/参数)
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

// ---------- 测试框架 ----------
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

// ---------- 通用 mock ----------
// in-memory state adapter (避免 reverse-watch/_rw_state_*.json 落盘)
function makeMockState(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    safeRead: (k, fb = null) => map.has(k) ? map.get(k) : fb,
    safeWrite: (k, v) => { map.set(k, v); return true; },
    safeReadJson: (k, fb = {}) => { const v = map.get(k); return v == null ? fb : v; },
    _peek: () => Object.fromEntries(map)
  };
}

// 固定 RNG (返回 0 → 第一项总是被排除, 验证 rng 注入生效)
function fixedRng() { return 0; }
function noopFetchAkshare() { return Promise.resolve(null); }
// IS_NODE 下 defaultDeps() 返 {} 没 shuffle, 测试显式注入
//   + getPoolExcludes / loadFeedback / readCachedRisk 都给空兜底, 避免 null() 报错
const TEST_DEPS_BASE = {
  shuffle: (arr) => arr.slice(),         // 不打乱, 顺序保持
  getPoolExcludes: () => [],             // 无用户排除
  loadFeedback: () => null,              // 无用户反馈
  readCachedRisk: () => null             // 无 RiskMine 缓存
};

const ROOT = path.resolve(__dirname, '..', '..');
const AT_PURE = pathToFileURL(path.join(ROOT, 'reverse-watch', 'auto-tuner-pure.mjs')).href;
const SC_PURE = pathToFileURL(path.join(ROOT, 'reverse-watch', 'strategy', 'screener-pure.mjs')).href;
const RG_PURE = pathToFileURL(path.join(ROOT, 'reverse-watch', 'strategy', 'regime-detector-pure.mjs')).href;
const RM_PURE = pathToFileURL(path.join(ROOT, 'reverse-watch', 'ai', 'risk-mine-pure.mjs')).href;

(async () => {
  const AT = await import(AT_PURE);
  const SC = await import(SC_PURE);
  const RG = await import(RG_PURE);
  const RM = await import(RM_PURE);

  // ============================================================
  console.log('\n[1] auto-tuner-pure: 8 case');
  // ============================================================

  // 1.1 clamp 边界
  assertEq(AT.clamp(5, 0, 10), 5, '1.1a clamp 中间值');
  assertEq(AT.clamp(-1, 0, 10), 0, '1.1b clamp 下界');
  assertEq(AT.clamp(15, 0, 10), 10, '1.1c clamp 上界');
  assertEq(AT.clamp(5, 5, 5), 5, '1.1d clamp lo==hi');

  // 1.2 computeSignals 4 源: 空 / down 全 / up 全 / 混合
  const sEmpty = AT.computeSignals({ deps: {}, state: makeMockState(), now: Date.now() });
  assert(sEmpty.sampleSize === 0, '1.2a 空样本 → sampleSize=0');
  assertEq(sEmpty.downRatio, null, '1.2b 空样本 → downRatio=null');
  assertEq(sEmpty.passRate, null, '1.2c 空样本 → passRate=null');

  const sDown = AT.computeSignals({
    deps: { loadActiveFeedback: () => ({ '600519': { verdict: 'down' }, '000001': { verdict: 'down' }, '000002': { verdict: 'up' } }) },
    state: makeMockState({ '_rw_screener_stats': { passed: 1, blocked: 4 } }),
    now: Date.now()
  });
  assert(sDown.sampleSize === 3, '1.2d 3 条 fb → sampleSize=3');
  assert(sDown.downRatio > 0.6 && sDown.downRatio < 0.7, '1.2e down=2/up=1 → downRatio≈0.667');
  assert(sDown.passRate > 0.19 && sDown.passRate < 0.21, '1.2f passRate=1/5=0.2');

  // 1.3 shouldSkip 4 个安全阀
  const sk1 = AT.shouldSkip({ deps: { getHolding: () => ({ holdings: [{ code: '600519' }] }) }, state: makeMockState(), now: Date.now() });
  assert(sk1.skip && sk1.reason.includes('持仓'), '1.3a 持仓非空 → skip');

  const sk2 = AT.shouldSkip({
    deps: { getUserAdjustments: () => [{ ts: Date.now() - 1000, target: 'gates.sectorMin' }] },
    state: makeMockState(), now: Date.now()
  });
  assert(sk2.skip && sk2.reason.includes('24h'), '1.3b 用户 24h 内改过 → skip');

  const sk3 = AT.shouldSkip({
    deps: {},
    state: makeMockState({ '_rw_auto_adjustments_log': [{ ts: Date.now() - 1000, status: 'applied' }] }),
    now: Date.now()
  });
  assert(sk3.skip && sk3.reason.includes('7d'), '1.3c 7d 内已调 → skip');

  const sk4 = AT.shouldSkip({
    deps: { getHolding: () => ({ holdings: [] }), loadActiveFeedback: () => ({ '600519': { verdict: 'up' } }) },
    state: makeMockState(), now: Date.now()
  });
  assert(sk4.skip && sk4.reason.includes('样本不足'), '1.3d 样本<20 → skip (带 signals)');

  // 1.4 decide: bear 护栏
  const decBear = AT.decide({ downRatio: 0, sampleSize: 50 }, {
    deps: { getSettings: () => ({ sectorMin: 0.55 }) },
    state: makeMockState({ '_rw_regime_history': [{ regime: 'bear' }] })
  });
  assertEq(decBear.length, 1, '1.4a bear → 1 条 adjustment');
  assertEq(decBear[0].target, 'holding.positionMultiplier', '1.4b bear → target 是 holding.positionMultiplier');
  assertEq(decBear[0].value, 0, '1.4c bear → value=0 (空仓合法)');

  // 1.5 decide: 规则 1 (down↑ + 池子松 → sectorMin+0.02)
  const dec1 = AT.decide({ downRatio: 0.7, passRate: 0.5, sampleSize: 50 }, {
    deps: { getSettings: () => ({ sectorMin: 0.55 }) }, state: makeMockState()
  });
  const r1v = dec1.find(a => a.target === 'gates.sectorMin')?.value;
  assert(r1v != null && Math.abs(r1v - 0.57) < 1e-9, '1.5a 规则 1: down 0.7+pass 0.5 → sectorMin 0.55→0.57');

  // 1.6 decide: 规则 3 (down↓ + 池子太严 → sectorMin-0.03 + pbDeltaMin-2)
  const dec3 = AT.decide({ downRatio: 0.2, passRate: 0.04, sampleSize: 50 }, {
    deps: { getSettings: () => ({ sectorMin: 0.55, pbDeltaMin: 15 }) }, state: makeMockState()
  });
  const r3s = dec3.find(a => a.target === 'gates.sectorMin');
  const r3p = dec3.find(a => a.target === 'gates.pbDeltaMin');
  assert(r3s && Math.abs(r3s.value - 0.52) < 1e-9, '1.6a 规则 3: down 0.2+pass 0.04 → sectorMin 0.55→0.52');
  assert(r3p && r3p.value === 13, '1.6b 规则 3: pbDeltaMin 15→13');

  // 1.7 decide: 节流 (7d 内已调 → filter)
  const decFilter = AT.decide({ downRatio: 0.7, passRate: 0.5, sampleSize: 50 }, {
    deps: { getSettings: () => ({ sectorMin: 0.55 }) },
    state: makeMockState({ '_rw_auto_adjustments_log': [{ ts: Date.now() - 1000, status: 'applied', adjustment: { target: 'gates.sectorMin' } }] })
  });
  assertEq(decFilter.length, 0, '1.7a 7d 内已调 gates.sectorMin → 被节流, 无 output');

  // 1.8 getRecentlyTunedTargets: 系统 log + 用户 log 去重
  const tuned = AT.getRecentlyTunedTargets({
    state: makeMockState({
      '_rw_auto_adjustments_log': [{ ts: Date.now() - 1000, status: 'applied', adjustment: { target: 'gates.sectorMin' } }],
      '_rw_adjustments_log': [{ ts: Date.now() - 2000, status: 'kept', target: 'holding.positionMultiplier' }]
    }),
    now: Date.now()
  });
  assert(tuned.has('gates.sectorMin'), '1.8a 系统 log → target 在集合');
  assert(tuned.has('holding.positionMultiplier'), '1.8b 用户 log → target 在集合');

  // ============================================================
  console.log('\n[2] screener-pure: 8 case');
  // ============================================================

  // 2.1 DEFAULT_GATES 完整
  assert(SC.DEFAULT_GATES.sectorMin === 0.55, '2.1a DEFAULT_GATES.sectorMin=0.55');
  assert(SC.DEFAULT_GATES.pbDeltaMin === 15, '2.1b DEFAULT_GATES.pbDeltaMin=15');
  assert(SC.DEFAULT_GATES.quantRejectPct === 0.5, '2.1c DEFAULT_GATES.quantRejectPct=0.5');
  assert(SC.DEFAULT_GATES.excludeLeaders === true, '2.1d DEFAULT_GATES.excludeLeaders=true');

  // 2.2 4 闸全过 → passed
  const poolOK = [{ code: '600519', name: '贵州茅台', sector: '消费', isSectorLeader: false,
    limitsUpRate_2d: 0.7, sectorPbMedian: 50, pbPercentile: 30, style: 'normal', hasQuantSeat: false }];
  const s1 = SC.runReverseScreener(poolOK, { rng: () => 1, state: makeMockState(), deps: TEST_DEPS_BASE });
  assertEq(s1.passed.length, 1, '2.2 4 闸全过 → passed=1');
  assertEq(s1.blocked.length, 0, '2.2 4 闸全过 → blocked=0');

  // 2.3 龙头闸: isSectorLeader=true
  const s2 = SC.runReverseScreener(
    [{ code: '000001', name: 'X', sector: '金融', isSectorLeader: true, limitsUpRate_2d: 0.7, sectorPbMedian: 50, pbPercentile: 30, style: 'normal' }],
    { rng: () => 1, state: makeMockState(), deps: TEST_DEPS_BASE }
  );
  assertEq(s2.blocked.length, 1, '2.3a 龙头 → blocked');
  assert(s2.blocked[0].reason.includes('龙头'), '2.3b blocked.reason 含"龙头"');

  // 2.4 板块封板率低
  const s3 = SC.runReverseScreener(
    [{ code: '000002', name: 'Y', sector: '科技', isSectorLeader: false, limitsUpRate_2d: 0.3, sectorPbMedian: 50, pbPercentile: 30, style: 'normal' }],
    { rng: () => 1, state: makeMockState(), deps: TEST_DEPS_BASE }
  );
  assert(s3.blocked[0].reason.includes('封板率'), '2.4 封板率 30% < 55% 阈值 → 拦');

  // 2.5 PB 分位差
  const s4 = SC.runReverseScreener(
    [{ code: '000003', name: 'Z', sector: '医药', isSectorLeader: false, limitsUpRate_2d: 0.7, sectorPbMedian: 50, pbPercentile: 45, style: 'normal' }],
    { rng: () => 1, state: makeMockState(), deps: TEST_DEPS_BASE }
  );
  assert(s4.blocked[0].reason.includes('PB'), '2.5 PB 差 5pp < 15pp → 拦');

  // 2.6 鱼尾行情
  const s5 = SC.runReverseScreener(
    [{ code: '000004', name: 'W', sector: '能源', isSectorLeader: false, limitsUpRate_2d: 0.7, sectorPbMedian: 50, pbPercentile: 30, style: 'fish' }],
    { rng: () => 1, state: makeMockState(), deps: TEST_DEPS_BASE }
  );
  assert(s5.blocked[0].reason.includes('鱼尾'), '2.6 style=fish → 拦');

  // 2.7 量化席位 (rng=0 → 触发概率 0.5)
  const s6 = SC.runReverseScreener(
    [{ code: '000005', name: 'V', sector: '工业', isSectorLeader: false, limitsUpRate_2d: 0.7, sectorPbMedian: 50, pbPercentile: 30, style: 'normal', hasQuantSeat: true }],
    { rng: () => 0, state: makeMockState(), deps: TEST_DEPS_BASE }
  );
  assert(s6.blocked[0].reason.includes('量化'), '2.7 hasQuantSeat + rng<0.5 → 拦');

  // 2.8 RiskMine 缓存命中
  const s7 = SC.runReverseScreener(
    [{ code: '000006', name: 'U', sector: '材料', isSectorLeader: false, limitsUpRate_2d: 0.7, sectorPbMedian: 50, pbPercentile: 30, style: 'normal' }],
    {
      rng: () => 1, state: makeMockState(),
      deps: { ...TEST_DEPS_BASE, readCachedRisk: (code) => code === '000006' ? ['商誉偏高'] : null }
    }
  );
  assert(s7.blocked[0].reason.includes('基本面'), '2.8 RiskMine 缓存命中 → 拦');

  // 2.9 用户排除 (getPoolExcludes)
  const s8 = SC.runReverseScreener(
    [{ code: '000007', name: 'T', sector: '可选消费', isSectorLeader: false, limitsUpRate_2d: 0.7, sectorPbMedian: 50, pbPercentile: 30, style: 'normal' }],
    {
      rng: () => 1, state: makeMockState(),
      deps: { ...TEST_DEPS_BASE, getPoolExcludes: () => ['000007'] }
    }
  );
  assert(s8.blocked[0].reason.includes('排除'), '2.9 getPoolExcludes 命中 → 拦');

  // 2.10 stats 写盘
  const st = makeMockState();
  SC.runReverseScreener(poolOK, { rng: () => 1, state: st, deps: TEST_DEPS_BASE });
  assertEq(st.safeReadJson('_rw_screener_stats').passed, 1, '2.10 stats.passed 落盘');

  // ============================================================
  console.log('\n[3] regime-detector-pure: 8 case');
  // ============================================================

  // 3.1 calcATR: null 边界
  assertEq(RG.calcATR([]), null, '3.1a 空数组 → null');
  assertEq(RG.calcATR([{ close: 100, high: 101, low: 99 }]), null, '3.1b <15 行 → null');
  // 3.1c 15 行正常
  const rows15 = Array.from({ length: 15 }, (_, i) => ({ close: 100 + i, high: 102 + i, low: 98 + i }));
  const atr = RG.calcATR(rows15);
  assert(typeof atr === 'number' && atr > 0, '3.1c 15 行正常 → 返回正数');

  // 3.2 voteDay d1 边界: dev > 0.03 (严格) → 1, < -0.03 (严格) → -1, 中间 → 0
  assertEq(RG.voteDay(104, 100, 0.02, 0).d1, 1, '3.2a dev=4% → d1=1 (>0.03)');
  assertEq(RG.voteDay(96, 100, 0.02, 0).d1, -1, '3.2b dev=-4% → d1=-1 (<-0.03)');
  assertEq(RG.voteDay(101, 100, 0.02, 0).d1, 0, '3.2c dev=1% → d1=0 (中间)');
  assertEq(RG.voteDay(103, 100, 0.02, 0).d1, 0, '3.2d dev=3% (边界, 严格 > 不命中) → d1=0');

  // 3.3 voteDay d2 (atrPct 边界)
  assertEq(RG.voteDay(100, 100, 0.03, 0).d2, 'strong', '3.3a atrPct=3% > 2.5% → strong');
  assertEq(RG.voteDay(100, 100, 0.01, 0).d2, 'weak', '3.3b atrPct=1% < 1.2% → weak');
  assertEq(RG.voteDay(100, 100, 0.02, 0).d2, 'normal', '3.3c atrPct=2% → normal');

  // 3.4 voteDay d3 (涨跌停差)
  assertEq(RG.voteDay(100, 100, 0.02, 60).d3, 1, '3.4a 涨跌停差 60>50 → d3=1');
  assertEq(RG.voteDay(100, 100, 0.02, -40).d3, -1, '3.4b 涨跌停差 -40<-30 → d3=-1');

  // 3.5 applyHysteresis: 切换保护 (prev=bull, bull<4 → 仍 bull)
  const votesBull = [{ sum: 2 }, { sum: 2 }, { sum: 2 }];  // 3 bull
  assertEq(RG.applyHysteresis(votesBull, 'range'), 'bull', '3.5a 3 bull + prev=range → bull (>=3 阈值)');
  assertEq(RG.applyHysteresis(votesBull, 'bull'), 'bull', '3.5b 3 bull + prev=bull (迟滞保护)');
  // 3.5c: prev=range, raw=range
  assertEq(RG.applyHysteresis([{ sum: 0 }, { sum: 0 }, { sum: 0 }], 'range'), 'range', '3.5c 0 sum 全 range → range');

  // 3.6 checkRegime 完整路径: 注入 state, 跑一次, 验证写盘
  const rgState = makeMockState();
  const idx = Array.from({ length: 30 }, (_, i) => ({ close: 100 + i * 0.5, high: 100.5 + i * 0.5, low: 99.5 + i * 0.5 }));
  const rg1 = RG.checkRegime({ indexRows: idx, ztMinusDt: 10, now: Date.now(), state: rgState });
  assert(rg1.regime, '3.6a checkRegime 返回 regime');
  assert(rg1.confidence > 0 && rg1.confidence <= 1, '3.6b confidence ∈ (0, 1]');
  assert(rgState.safeReadJson('_rw_regime_today')?.regime === rg1.regime, '3.6c regime 落盘 _rw_regime_today');

  // 3.7 getTodayRegime 缓存命中
  const same = RG.getTodayRegime({ now: Date.now(), state: rgState });
  assert(same && same.regime === rg1.regime, '3.7a 当日 regime 命中缓存');
  const none = RG.getTodayRegime({ now: Date.now() + 25 * 60 * 60 * 1000, state: rgState });
  assert(none === null, '3.7b 跨日 → null');

  // 3.8 positionMultiplier 4 态
  assertEq(RG.positionMultiplier('bull'), 1.0, '3.8a bull → 1.0');
  assertEq(RG.positionMultiplier('range_strong'), 0.3, '3.8b range_strong → 0.3');
  assertEq(RG.positionMultiplier('range_weak'), 0.5, '3.8c range_weak → 0.5');
  assertEq(RG.positionMultiplier('bear'), 0.0, '3.8d bear → 0.0');
  assertEq(RG.positionMultiplier('unknown'), 0.5, '3.8e unknown → 0.5 (兜底)');

  // 3.9 todayStr: 固定日期
  const d = new Date(2026, 7, 5);  // 月 0-indexed → 7=8 月
  assertEq(RG.todayStr(d), 20260805, '3.9 todayStr 2026-08-05 → 20260805');

  // ============================================================
  console.log('\n[4] risk-mine-pure: 10 case');
  // ============================================================

  // 4.1 judgeRisks: 5 类原因
  const gw = [{ '代码': '600519', '商誉占总资产比': '35%' }];
  const dec = [{ '代码': '600519', '变动比例': '-2%' }];
  const prof = [{ '代码': '600519', '业绩预告类型': '首亏' }];
  const reasons = RM.judgeRisks('600519', gw, dec, prof);
  assert(reasons.includes(RM.REASONS.GOODWILL), '4.1a 商誉 35% > 30% 阈值 → 命中');
  assert(reasons.includes(RM.REASONS.DECREASE), '4.1b 减持 2% > 1% 阈值 → 命中');
  assert(reasons.includes(RM.REASONS.LOSS_FIRST), '4.1c 业绩首亏 → 命中');

  const prof2 = [{ '代码': '600519', '业绩预告类型': '续亏' }];
  assert(RM.judgeRisks('600519', [], [], prof2).includes(RM.REASONS.LOSS_CONTINUE), '4.1d 业绩续亏 → 命中');

  const prof3 = [{ '代码': '600519', '业绩预告类型': '预减' }];
  assert(RM.judgeRisks('600519', [], [], prof3).includes(RM.REASONS.LOSS_DECREASE), '4.1e 业绩预减 → 命中');

  // 4.1f: 商誉 25% < 30% 阈值 → 不命中
  const gwLow = [{ '代码': '600519', '商誉占总资产比': '25%' }];
  assert(!RM.judgeRisks('600519', gwLow, [], []).length, '4.1f 商誉 25% < 30% → 不命中');

  // 4.2 SEVERITY 映射
  assertEq(RM.SEVERITY[RM.REASONS.GOODWILL], 'high', '4.2a GOODWILL=high');
  assertEq(RM.SEVERITY[RM.REASONS.DECREASE], 'medium', '4.2b DECREASE=medium');
  assertEq(RM.SEVERITY[RM.REASONS.LOSS_FIRST], 'high', '4.2c LOSS_FIRST=high');

  // 4.3 readCachedRisk: 命中 / 过期
  const rmSt = makeMockState({
    '_rw_risk_cache': { '600519': { ts: Date.now(), status: 'ok', reasons: ['商誉偏高'] } }
  });
  assertEq(RM.readCachedRisk('600519', { state: rmSt }), ['商誉偏高'], '4.3a 命中缓存');
  assertEq(RM.readCachedRisk('000001', { state: rmSt }), null, '4.3b 未缓存 → null');
  // 过期
  const rmStExpired = makeMockState({
    '_rw_risk_cache': { '600519': { ts: Date.now() - 7 * 60 * 60 * 1000, status: 'ok' } }
  });
  assertEq(RM.readCachedRisk('600519', { state: rmStExpired }), null, '4.3c 7h 前 (超 6h TTL) → null');

  // 4.4 readCachedStatus
  assertEq(RM.readCachedStatus('600519', { state: rmSt }), 'ok', '4.4a 命中 ok');
  assertEq(RM.readCachedStatus('000001', { state: rmSt }), 'unknown', '4.4b 未缓存 → unknown');
  assertEq(RM.readCachedStatus('600519', { state: rmStExpired }), 'unknown', '4.4c 过期 → unknown');

  // 4.5 describeRisk
  assertEq(RM.describeRisk([]), '✅ 无基本面风险', '4.5a 空 → 无风险');
  assert(RM.describeRisk(['商誉偏高']).includes('商誉偏高'), '4.5b 非空 → 含 reason');
  assert(RM.describeRisk(['商誉偏高']).includes('high'), '4.5c 含 severity');

  // 4.6 scanRisk: fetchAkshare mock + 写缓存
  let fetchCalls = 0;
  const rmSt2 = makeMockState();
  const r = await RM.scanRisk('600519', {
    state: rmSt2,
    fetchAkshare: (path) => { fetchCalls++; return path === 'stock_sy_em' ? [{ '代码': '600519', '商誉占总资产比': '40%' }] : []; },
    now: Date.now()
  });
  assertEq(fetchCalls, 2, '4.6a scanRisk 并行拉 2 类数据');
  assertEq(r.status, 'ok', '4.6b status=ok (1 类成功)');
  assert(r.reasons.includes('商誉偏高'), '4.6c 命中');
  assertEq(rmSt2.safeReadJson('_rw_risk_cache')['600519'].reasons.length, 1, '4.6d 写缓存');

  // 4.7 scanRisk: 缓存命中不再调 fetch
  fetchCalls = 0;
  const rm1 = await RM.scanRisk('600519', { state: rmSt2, fetchAkshare: () => { fetchCalls++; return null; } });
  assertEq(fetchCalls, 0, '4.7a 缓存命中 → 不调 fetch');
  assertEq(rm1.fromCache, true, '4.7b fromCache=true');

  // 4.8 scanRisk: 全 fetch 失败 → status=failed
  const rmSt3 = makeMockState();
  const rm2 = await RM.scanRisk('600519', { state: rmSt3, fetchAkshare: noopFetchAkshare });
  assertEq(rm2.status, 'failed', '4.8 全 fetch 失败 → status=failed');

  // 4.9 prewarmPoolRisk: 进度回调
  //   [P0 bug 已知] 并发 2 只以上时 scanRisk 内部 cache 写覆盖 (Promise.all race)
  //   临时单只测, P3 步骤修
  let progress = [];
  const rmSt4 = makeMockState();
  await RM.prewarmPoolRisk(['600519'], {
    state: rmSt4,
    fetchAkshare: async () => [{ '代码': 'X' }],  // 不命中阈值 → reasons=[]
    onProgress: (done, total) => progress.push(`${done}/${total}`)
  });
  assert(progress.length === 1 && progress[0] === '1/1', '4.9a prewarm 进度回调 1 次');
  const cache4 = rmSt4.safeReadJson('_rw_risk_cache');
  assert(cache4['600519'] && cache4['600519'].status === 'ok', '4.9b prewarm 单只 → 600519 缓存写入 status=ok');

  // 4.10 scanRiskDedup: 并发复用
  //   注意: dedup 用 module-level _inflight Map, 跨测试可能残留 → 用全新 code 避免干扰
  //   scanRisk 内部 fetch 并行 2 次 (stock_sy_em + stock_yjyg_em), 所以期望:
  //     - '777777' dedup 1 次 → scanRisk 1 次 → fetch 2 次
  //     - '777777' 第二个 dedup 复用 → fetch 0 次
  //     - '888888' dedup 1 次 → scanRisk 1 次 → fetch 2 次
  //   总 fetch = 4 次
  const rmSt5 = makeMockState();
  let dedupCalls = 0;
  const dedupFetch = async (p) => { dedupCalls++; await new Promise(r => setTimeout(r, 50)); return []; };
  const [a, b, c] = await Promise.all([
    RM.scanRiskDedup('777777', { state: rmSt5, fetchAkshare: dedupFetch }),
    RM.scanRiskDedup('777777', { state: rmSt5, fetchAkshare: dedupFetch }),
    RM.scanRiskDedup('888888', { state: rmSt5, fetchAkshare: dedupFetch })
  ]);
  assertEq(dedupCalls, 4, '4.10a dedup 复用 → 实际 fetch=4 (2 scanRisk × 2 endpoint)');
  assert(a.fromCache === false && b.fromCache === false, '4.10b dedup 复用 → fromCache=false (走同一 scanRisk)');
  assert(c.fromCache === false, '4.10c 异 code 新调 → fromCache=false');
  assert(a.status && b.status && c.status, '4.10d 3 个 promise 全部返回 status');

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
