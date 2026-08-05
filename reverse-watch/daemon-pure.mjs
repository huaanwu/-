// ============== reverse-watch-daemon-pure.mjs · 操盘管家纯逻辑 ==============
// 从 scripts/reverse-watch-daemon.mjs 抽出可注入测试的纯函数, 行为 100% 一致
//
// 内容:
//   - 时间工具: shanghaiStr / shanghaiHM / shanghaiDow / shanghaiISO / nowShanghai
//   - alert 工厂: makeAlert / attachAlertId
//   - 7 规则 (runRule7 在 daemon.mjs, 需 fetchAkshare + import screener-pure, 不抽)
//     - runRule1: 资金 (单票超限/仓位偏重/现金储备不足)
//     - decideAddOn: 加仓 (浮盈 + 板块强 + 冷却 + 闸门)
//     - decideStopAndTrim: 止损 + 清仓 (跌破 MA20 / 鱼尾 / 板块弱)
//     - runRule6: 空仓 (regime.positionMultiplier 透传)
//   - runAllRules: 4 规则聚合 + 幂等去重 + severity 排序
//
// 上下文契约 (ctx):
//   { holdings, rules, portfolio, lastAddTsMap, regime, signals }
//   - holdings:    Array<{ code, name, price, shares, chg5, belowMA20, sectorStrength, fishTail5d }>
//   - rules:       { singleStockMaxPct, stockOverPct, cashReservePct, addOnProfitPct, addMaxRatio,
//                    addCooldownDays, fishTailTrimPct, sectorWeakPct, basePoolMaxPct }
//   - portfolio:   { cash, stockMkt, total, stockPct }
//   - lastAddTsMap:{ [code]: msTimestamp }
//   - regime:      { current: 'bull'|'range_weak'|'range_strong'|'bear'|'unknown', positionMultiplier: number }
//
// ?v=daemon3: severity 排序 (3 档 high > warn > info)
// ?v=daemon5 (TZ #3): ts 用 shanghaiISO (带 +08:00), 跟 alerts.dayKey (shanghaiStr) 一致

// ---------- 时间工具 (?v=daemon5: 本地时区, TZ=Asia/Shanghai 由 PM2 注入) ----------
function nowShanghai() {
  return new Date();
}
// YYYY-MM-DD HH:MM:SS (上海 TZ)
function shanghaiStr(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
// HH:MM
function shanghaiHM(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// 0=Sun ... 6=Sat (本地时区)
function shanghaiDow(date = new Date()) {
  return date.getDay();
}
// ISO 字符串: 用于 alerts.ts, daemon state 的 ts 字段等需要时区无关时间戳的场合
function shanghaiISO(date = new Date()) {
  // 本地日期 + 时区偏移 → 等价于 UTC ISO 串, 但时区固定 +08:00
  const tzOffset = -date.getTimezoneOffset();  // 分钟, 上海 +480
  const sign = tzOffset >= 0 ? '+' : '-';
  const absMin = Math.abs(tzOffset);
  const tzHH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const tzMM = String(absMin % 60).padStart(2, '0');
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}${sign}${tzHH}:${tzMM}`;
}

// ---------- 严重度排序 (?v=daemon3) ----------
const SEVERITY_RANK = { high: 3, warn: 2, info: 1 };
const ALERT_LIMIT = 30;  // 跑出 alerts[] 最多保留 30 条 (避免 panel 爆栈)

// ---------- alert 工厂 ----------
// ?v=daemon4 P0 F1 修: makeAlert 不在内部算 id, 改成返回无 id 对象, 让 runAllRules 注入 slot 后再算 id
// 原 bug: runRule1/decideAddOn/decideStopAndTrim 内部调 makeAlert 时都没传 slot, id 字符串已生成 = "unknown-*"
// runAllRules 后续 .map({ ...a, slot }) 只覆盖 slot 字段, 不重算 id, 导致所有 alerts.id 都是 unknown-* 前缀
// 幂等去重对真实 slot 名彻底失效. 现在把 id 计算挪到 runAllRules.
function makeAlert({ severity, action, code, name, title, body, linked_rules, context }) {
  // ?v=daemon5 P0 (TZ #3): ts 用 shanghaiISO (带 +08:00 时区), 跟 alerts.dayKey (shanghaiStr) 一致
  return { severity, action, code, name, title, body, linked_rules, context, ts: shanghaiISO() };
}
// ?v=daemon4: id 计算从 makeAlert 抽出, runAllRules 注入 slot + dayKey 后再算
function attachAlertId(alert, slot, dayKey) {
  const id = `${slot}-${alert.action}-${alert.code || '*'}-${dayKey}`;
  return { ...alert, id, slot };
}

// ---------- 规则 1: 资金 (?v=daemon3 拆 3 类: singleStockOverMax / stockOverPct / cashLow) ----------
function runRule1(ctx) {
  const alerts = [];
  const { holdings, rules, portfolio } = ctx;
  const { total } = portfolio;
  if (total <= 0) return alerts;
  for (const h of holdings) {
    const hMkt = (h.price || 0) * (h.shares || 0);
    const hPct = hMkt / total;
    if (hPct > rules.singleStockMaxPct) {
      alerts.push(makeAlert({
        severity: 'high', action: 'alert', code: h.code, name: h.name,
        title: `${h.name} 单票超限 (${(hPct*100).toFixed(1)}%)`,
        body: `> ${(rules.singleStockMaxPct*100).toFixed(0)}% 阈值`,
        linked_rules: [1, 4],
        context: { hPct, threshold: rules.singleStockMaxPct }
      }));
    // ?v=daemon5 P0 (审计 #2): stockOverPct 是预警档, 必须低于硬上限 singleStockMaxPct
    // 旧 bug: stockOverPct=0.30 > singleStockMaxPct=0.10, 30% 分支数学上不可达
    // 新语义: 预警阈值 = 硬上限的 80% (但允许 ui 自己改 stockOverPct)
    } else {
      const warnThreshold = Math.min((rules.stockOverPct || 0.30), rules.singleStockMaxPct);
      if (hPct > warnThreshold) {
        alerts.push(makeAlert({
          severity: 'warn', action: 'alert', code: h.code, name: h.name,
          title: `${h.name} 仓位偏重`,
          body: `${(hPct*100).toFixed(1)}% 接近警戒线 ${(warnThreshold*100).toFixed(0)}%`,
          linked_rules: [1, 3],
          context: { hPct, threshold: warnThreshold }
        }));
      }
    }
  }
  const cashPct = portfolio.cash / total;
  if (cashPct < rules.cashReservePct) {
    alerts.push(makeAlert({
      severity: 'warn', action: 'alert', code: '*', name: '总资产',
      title: '现金储备不足',
      body: `现金 ${(cashPct*100).toFixed(1)}% < 阈值 ${(rules.cashReservePct*100).toFixed(0)}%`,
      linked_rules: [1, 3],
      context: { cashPct, threshold: rules.cashReservePct }
    }));
  }
  return alerts;
}

// ---------- 规则 3: 加仓 (?v=daemon3: bear 直接拒 multiplier=0, 联动规则 6) ----------
// bear 阈值: 加仓上浮 (浮盈要求 +2%, cooldown +2 天)
function decideAddOn(ctx) {
  const now = Date.now();
  const suggestions = [];
  const { holdings, rules, lastAddTsMap, regime } = ctx;
  const mult = regime.positionMultiplier;
  const isBear = regime.current === 'bear';
  // 联动规则 6: 空仓时 (mult=0) 加仓直接拒
  if (mult <= 0) {
    return [{
      severity: 'info', action: 'add-blocked', code: '*', name: '仓位闸门',
      title: `空仓闸门关闭 (${regime.current})`,
      body: `positionMultiplier=${mult}, 加仓全部跳过`,
      linked_rules: [3, 6],
      context: { regime: regime.current, multiplier: mult }
    }];
  }
  const addonProfitPct = isBear ? rules.addOnProfitPct + 0.02 : rules.addOnProfitPct;
  const addonCooldownDays = isBear ? rules.addCooldownDays + 2 : rules.addCooldownDays;
  // ?v=daemon5 P0 (审计 #7): addBudget 减去 cashReserve 留底
  // 旧 bug: total*mult - stockMkt 在 bull (mult=1.0) 下 = cash, 100% 可用 → 规则 1 立刻报"现金储备不足"
  // 修法: 再减 total*cashReservePct, 强制保留 cashReserve 比例
  const cashReserveAbs = (ctx.portfolio.total || 0) * (rules.cashReservePct || 0.05);
  const addBudget = (ctx.portfolio.total || 0) * mult - (ctx.portfolio.stockMkt || 0) - cashReserveAbs;
  if (addBudget <= 0) {
    return [{
      severity: 'warn', action: 'add-veto', code: '*', name: '资金闸门',
      title: '加仓预算耗尽',
      body: `可加预算 ≈ ${addBudget.toFixed(0)} 元 (total ${Math.round(ctx.portfolio.total)} × mult ${mult} − stockMkt ${Math.round(ctx.portfolio.stockMkt)} − 现金留底 ${Math.round(cashReserveAbs)})`,
      linked_rules: [1, 3, 6],
      context: { mult, addBudget, total: ctx.portfolio.total, stockMkt: ctx.portfolio.stockMkt, cashReserveAbs }
    }];
  }
  // 联动规则 4/5: 本轮已出 stop/trim 的票, 加仓直接 add-veto (止损永远先于加仓)
  const stopTrimCodes = new Set();
  for (const s of decideStopAndTrim(ctx)) {
    if (s.code && s.action !== 'add' && s.action !== 'add-skip' && s.action !== 'add-veto' && s.action !== 'add-blocked') {
      stopTrimCodes.add(s.code);
    }
  }
  for (const h of holdings) {
    if (stopTrimCodes.has(h.code)) {
      suggestions.push({
        severity: 'info', action: 'add-veto', code: h.code, name: h.name,
        title: `${h.name} 加仓被否 (本轮已出止损/清仓信号)`,
        body: '该票本轮触发 stop/trim, 加仓顺序在止损后面',
        linked_rules: [3, 4, 5],
        context: { harnessRule: '3-after-4/5' }
      });
      continue;
    }
    if (h.chg5 == null || h.chg5 < addonProfitPct) continue;
    if (h.belowMA20) continue;
    if (h.sectorStrength == null || h.sectorStrength < 0.6) continue;
    const lastAdd = lastAddTsMap[h.code] || 0;
    if (now - lastAdd < addonCooldownDays * 86400e3) continue;
    // 单票占比上限: 加完后不能超 rules.singleStockMaxPct
    const hMkt = (h.price || 0) * (h.shares || 0);
    const hPct = ctx.portfolio.total > 0 ? hMkt / ctx.portfolio.total : 0;
    if (hPct >= rules.singleStockMaxPct) {
      suggestions.push(makeAlert({
        severity: 'info', action: 'add-skip', code: h.code, name: h.name,
        title: `${h.name} 加仓跳过 (单票已达上限)`,
        body: `现 ${(hPct*100).toFixed(1)}% ≥ 阈值 ${(rules.singleStockMaxPct*100).toFixed(0)}%`,
        linked_rules: [1, 3],
        context: { hPct, threshold: rules.singleStockMaxPct }
      }));
      continue;
    }
    const newShares = Math.floor((h.shares * rules.addMaxRatio) / 100) * 100;
    if (newShares <= 0) continue;
    suggestions.push(makeAlert({
      severity: isBear ? 'warn' : 'info', action: 'add', code: h.code, name: h.name,
      title: `${h.name} 加仓信号${isBear ? ' (bear 上浮)' : ''}`,
      body: `浮盈 +${(h.chg5*100).toFixed(1)}%, 板块 ${(h.sectorStrength*100).toFixed(0)}%, 建议加 ${newShares} 股`,
      linked_rules: [3, 6],
      context: { mult, isBear, newShares }
    }));
  }
  return suggestions;
}

// ---------- 规则 4 + 5: 止损 + 清仓 (?v=daemon3: bear 下阈值严 50%) ----------
// 字段: {code, name, change5d, sectorStrength, belowMA20, fishTail5d}
function decideStopAndTrim(ctx) {
  const notifs = [];
  const { holdings, rules, regime } = ctx;
  const isBear = regime.current === 'bear';
  // ?v=daemon5 P0 (审计 #3): bear 收严方向修正
  // trimPct 用 `>` 比较 → bear ×0.5 = 阈值下调 = 更难涨到 = 实际放松 (❌ 错向, 但原作者注释"bear 严"是反着的)
  //   修法: bear 应 ×1.5 (阈值上调 = 涨更少就触发)
  // weakPct 用 `<` 比较 → bear ×0.5 = 阈值下调 = 板块强更容易"弱" = 实际放松 (❌ 错向)
  //   修法: bear 应 ×1.5 (阈值上调 = 板块烂一点就触发)
  // 两个方向都改为: bear 下阈值上调 1.5x (clamp 到 0.95 上限, 防止 > 1 触发所有)
  const trimPct = isBear ? Math.min(0.95, rules.fishTailTrimPct * 1.5) : rules.fishTailTrimPct;
  const weakPct = isBear ? Math.min(0.95, rules.sectorWeakPct * 1.5) : rules.sectorWeakPct;
  for (const h of holdings) {
    if (h.belowMA20) {
      notifs.push(makeAlert({
        severity: 'high', action: 'stop', code: h.code, name: h.name,
        title: `${h.name} 跌破 MA20`,
        body: '触发中线止损复盘, 建议检查买入假设',
        linked_rules: [4, 6],
        context: { isBear }
      }));
    }
    if (h.chg5 != null && h.chg5 > trimPct) {
      notifs.push(makeAlert({
        severity: 'warn', action: 'trim', code: h.code, name: h.name,
        title: `${h.name} 鱼尾行情${isBear ? ' (bear 严)' : ''}`,
        // ?v=daemon5 P0 (审计 #4): 鱼尾行情 = 5日累计涨幅 (冲高乏力), 用 chg5 而不是 fishTail5d
        // 旧 bug: fishTail5d 算的是累计跌幅, 跟"鱼尾冲高减仓"语义完全相反
        body: `5日累计涨幅 ${(h.chg5*100).toFixed(1)}% ≥ ${(trimPct*100).toFixed(0)}%, 强制减半`,
        linked_rules: [5, 6],
        context: { chg5: h.chg5, trimPct }
      }));
    }
    if (h.sectorStrength != null && h.sectorStrength < weakPct) {
      notifs.push(makeAlert({
        severity: 'info', action: 'trim', code: h.code, name: h.name,
        title: `${h.name} 板块走弱${isBear ? ' (bear 严)' : ''}`,
        body: `板块强度 ${(h.sectorStrength*100).toFixed(0)}% < ${(weakPct*100).toFixed(0)}%, 该板块持仓减半`,
        linked_rules: [5, 6],
        context: { sectorStrength: h.sectorStrength, weakPct }
      }));
    }
  }
  return notifs;
}

// ---------- 规则 6: 空仓 (regime.positionMultiplier 透传) ----------
function runRule6(ctx) {
  return ctx.regime;
}

// ---------- runAllRules (?v=daemon3): 共享 ctx, 幂等去重 + severity 排序 ----------
// 规则 1+3+4+5 共用 pipeline, 不重复跑
// ?v=daemon3 (P1 #146): 按 id 幂等去重, 同 id 保留更高 severity
// ?v=daemon4 (P0 F1 修): makeAlert 已不产 id, 由 attachAlertId 统一在注入 slot 后计算
function runAllRules(ctx, slot = 'unknown') {
  const dayKey = shanghaiStr().slice(0, 10);
  const raw = [
    ...runRule1(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...decideAddOn(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...decideStopAndTrim(ctx).map(a => attachAlertId(a, slot, dayKey))
  ];
  // 按 id 幂等: 同 id 保留 severity 最高的
  const byId = new Map();
  for (const a of raw) {
    const prev = byId.get(a.id);
    if (!prev || (SEVERITY_RANK[a.severity] || 0) > (SEVERITY_RANK[prev.severity] || 0)) {
      byId.set(a.id, a);
    }
  }
  const deduped = Array.from(byId.values());
  // 按 severity 降序 + 同级按 code 稳定排序
  deduped.sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] || 0;
    const sb = SEVERITY_RANK[b.severity] || 0;
    if (sa !== sb) return sb - sa;
    return String(a.code).localeCompare(String(b.code));
  });
  return deduped.slice(0, ALERT_LIMIT);
}

export {
  nowShanghai, shanghaiStr, shanghaiHM, shanghaiDow, shanghaiISO,
  SEVERITY_RANK, ALERT_LIMIT,
  makeAlert, attachAlertId,
  runRule1, decideAddOn, decideStopAndTrim, runRule6, runAllRules
};
