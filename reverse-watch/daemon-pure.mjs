// ============== reverse-watch-daemon-pure.mjs · 操盘管家纯逻辑 ==============
// 从 scripts/reverse-watch-daemon.mjs 抽出可注入测试的纯函数, 行为 100% 一致
//
// 内容:
//   - 时间工具: shanghaiStr / shanghaiHM / shanghaiDow / shanghaiISO / nowShanghai
//   - alert 工厂: makeAlert / attachAlertId
//   - 10 规则 (覆盖持仓规律.md 12 条细则的硬约束部分)
//     - runRule1:   资金 (单票超限 / 仓位偏重 / 现金储备不足) + force-trim 分级
//     - decideAddOn: 加仓 (浮盈 + 板块强 + 冷却 + 闸门) [P0 #1#2: 公式 + 加后再校验]
//     - decideStopAndTrim: 止损 + 清仓 (跌破 MA20 / 鱼尾 / 板块弱) [P1 #6: bear 不再产 sectorWeak]
//     - runRule6:   空仓 (regime.positionMultiplier 透传) [保留为兼容接口]
//     - runRule7:   集中度 (单行业 ≤singleIndustryMaxPct) [P1 #4: 之前完全没实现]
//     - runRule8:   月度回撤熔断 (monthlyMaxDrawdown, 月初 portfolio peak 维护) [P1 #4]
//     - runRule9:   股票总仓 (totalStockMaxPct) [P1 #4]
//     - runRule10:  短线止损 (shortStopLossPct, 浮亏 ≥) [P1 #4]
//   - runAllRules: 10 规则聚合 + 幂等去重 + severity 排序
//
// 上下文契约 (ctx):
//   { holdings, rules, portfolio, lastAddTsMap, regime, signals, monthlyPeak }
//   - holdings:    Array<{ code, name, price, shares, cost, chg5, belowMA20, sectorStrength, sector }>
//                  cost 字段 (runRule10 短线止损用) [P1 #4: 之前完全没实现]
//                  sector 字段 (runRule7 单行业用)
//   - rules:       { singleStockMaxPct, stockOverPct, cashReservePct, totalStockMaxPct,
//                    singleIndustryMaxPct, monthlyMaxDrawdown, shortStopLossPct,
//                    addOnProfitPct, addMaxRatio, addCooldownDays,
//                    fishTailTrimPct, sectorWeakPct, basePoolMaxPct }
//   - portfolio:   { cash, stockMkt, total, stockPct, peak (runRule8 月度回撤用) }
//   - lastAddTsMap:{ [code]: msTimestamp }
//   - regime:      { current: 'bull'|'range_weak'|'range_strong'|'bear'|'unknown', positionMultiplier: number }
//   - monthlyPeak: { peakTotal, monthKey } (runRule8 维护) - 可选, 无则用 portfolio.peak
//
// severity 排序 (4 档 critical > high > warn > info)
// (TZ #3): ts 用 shanghaiISO (带 +08:00), 跟 alerts.dayKey (shanghaiStr) 一致

// ---------- 时间工具 ( 本地时区, TZ=Asia/Shanghai 由 PM2 注入) ----------
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

// ---------- 严重度排序 (4 档: critical > high > warn > info) ----------
// [P0 #5] 加 critical 档: 单票超限 5x / 月度回撤超阈 / 股票总仓超阈 → critical, UI 红字 + 建议强制清仓
const SEVERITY_RANK = { critical: 4, high: 3, warn: 2, info: 1 };
const ALERT_LIMIT = 100;  // [P2 #19] 30→100: 牛市 10 持仓下 3 天就滚, 加 archive 空间

// ---------- alert 工厂 ----------
// F1 修: makeAlert 不在内部算 id, 改成返回无 id 对象, 让 runAllRules 注入 slot 后再算 id
// 原 bug: runRule1/decideAddOn/decideStopAndTrim 内部调 makeAlert 时都没传 slot, id 字符串已生成 = "unknown-*"
// runAllRules 后续 .map({ ...a, slot }) 只覆盖 slot 字段, 不重算 id, 导致所有 alerts.id 都是 unknown-* 前缀
// 幂等去重对真实 slot 名彻底失效. 现在把 id 计算挪到 runAllRules.
function makeAlert({ severity, action, rule, code, name, title, body, linked_rules, context }) {
  // ?v=daemon5 P0 (TZ #3): ts 用 shanghaiISO (带 +08:00 时区), 跟 alerts.dayKey (shanghaiStr) 一致
  // ?v=daemon7: 加 rule 字段 (鱼尾/板块走弱/MA20 等), 给 attachAlertId 用作 id 维度
  return { severity, action, rule, code, name, title, body, linked_rules, context, ts: shanghaiISO() };
}
// ?v=daemon4: id 计算从 makeAlert 抽出, runAllRules 注入 slot + dayKey 后再算
// ?v=daemon7: id 格式加 rule 维度 `{slot}-{action}-{rule}-{code}-{dayKey}`
//   原因: 同 code+同 action 不同规则 (如鱼尾 vs 板块走弱 都是 trim) 之前会被幂等去重覆盖
//   板块走弱 (info) 被鱼尾 (warn) 静默吞掉, 这是 P0 设计 bug (7.2c)
//   加 rule 字段后不同规则 id 不同, 都保留
//   兼容: 未传 rule 时省去, 旧 id 格式不变 (linked_rules 不参与 id, 避免误判)
function attachAlertId(alert, slot, dayKey) {
  const id = alert.rule
    ? `${slot}-${alert.action}-${alert.rule}-${alert.code || '*'}-${dayKey}`
    : `${slot}-${alert.action}-${alert.code || '*'}-${dayKey}`;
  return { ...alert, id, slot };
}

// ---------- 规则 1: 资金 (?v=daemon3 拆 3 类: singleStockOverMax / stockOverPct / cashLow) ----------
// [P0 #5] 单票超限分级: 5x 以上 critical + action=force-trim (UI 强提示强制减仓)
//         2x-5x  high + action=trim
//         1x-2x  high + action=alert
function runRule1(ctx) {
  const alerts = [];
  const { holdings, rules, portfolio } = ctx;
  const { total } = portfolio;
  if (total <= 0) return alerts;
  for (const h of holdings) {
    const hMkt = (h.price || 0) * (h.shares || 0);
    const hPct = hMkt / total;
    if (hPct > rules.singleStockMaxPct) {
      const overMult = hPct / rules.singleStockMaxPct;
      // 浮点容差: 0.15/0.10 实际是 1.4999999..., round 到 1 位小数避开精度问题
      const overMultR = Math.round(overMult * 10) / 10;
      let severity, action, body;
      if (overMultR >= 5) {
        severity = 'critical';
        action = 'force-trim';
        body = `单票占比 ${(hPct*100).toFixed(1)}% 是阈值 ${(rules.singleStockMaxPct*100).toFixed(0)}% 的 ${overMultR.toFixed(1)} 倍, 强烈建议立即清仓`;
      } else if (overMultR >= 1.5) {
        // 1.5x-5x 区间: high + trim (建议减半, 跟 ma20 区分严重程度)
        severity = 'high';
        action = 'trim';
        body = `单票占比 ${(hPct*100).toFixed(1)}% 远超阈值 ${(rules.singleStockMaxPct*100).toFixed(0)}% (${overMultR.toFixed(1)}x), 建议减半`;
      } else {
        // 1x-1.5x 区间: high + alert (刚超线, 提醒复盘)
        severity = 'high';
        action = 'alert';
        body = `> ${(rules.singleStockMaxPct*100).toFixed(0)}% 阈值`;
      }
      alerts.push(makeAlert({
        severity, action, code: h.code, name: h.name,
        title: `${h.name} 单票超限 (${(hPct*100).toFixed(1)}%)`,
        body,
        linked_rules: [1, 4],
        context: { hPct, threshold: rules.singleStockMaxPct, overMult: overMultR }
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
// [P0 #1] addMaxRatio 解读: 持仓纪律.md "加仓 ≤原仓 50%" → addMaxRatio=0.5 表示 50%
//         公式: newShares = floor(shares * addMaxRatio) → 100 股单位取整
//         (旧代码 `floor(shares * addMaxRatio / 100) * 100` 把 0.5 当 0.5%, 得 100 股; 正确应得 shares*0.5)
// [P0 #2] 加完后再校验单票上限: 算出 newSharesRaw 后, 若 hPct_after ≥ singleStockMaxPct,
//         按"剩余预算"重算 maxShares, 既守 50% 上限又不超 5% 单票
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
    // [P0 #1] 公式: addMaxRatio 解读为百分比小数 (0.5 = 50%), shares=300 → 150 股
    // [P0 #2] 加完后单票上限: 算出后若超阈值, 按剩余预算缩
    const price = h.price || 0;
    const maxByRule = Math.floor((h.shares * rules.addMaxRatio) / 100) * 100;  // 50% of 300 = 150
    // 加完后占比 = (hMkt + maxByRule*price) / total, 不超 singleStockMaxPct
    const maxBySinglePct = price > 0 && ctx.portfolio.total > 0
      ? Math.floor(((rules.singleStockMaxPct * ctx.portfolio.total - hMkt) / price) / 100) * 100
      : 0;
    const newShares = Math.max(0, Math.min(maxByRule, maxBySinglePct));
    if (newShares <= 0) {
      suggestions.push(makeAlert({
        severity: 'info', action: 'add-skip', code: h.code, name: h.name,
        title: `${h.name} 加仓跳过 (加完即超单票上限)`,
        body: `按 50% 加仓会超 singleStockMaxPct, 剩余预算 0 股`,
        linked_rules: [1, 3],
        context: { hPct, threshold: rules.singleStockMaxPct, maxByRule, maxBySinglePct }
      }));
      continue;
    }
    suggestions.push(makeAlert({
      severity: isBear ? 'warn' : 'info', action: 'add', code: h.code, name: h.name,
      title: `${h.name} 加仓信号${isBear ? ' (bear 上浮)' : ''}`,
      body: `浮盈 +${(h.chg5*100).toFixed(1)}%, 板块 ${(h.sectorStrength*100).toFixed(0)}%, 建议加 ${newShares} 股 (50% 上限 ${maxByRule} · 单票上限截断后 ${newShares})`,
      linked_rules: [3, 6],
      context: { mult, isBear, newShares, maxByRule, maxBySinglePct }
    }));
  }
  return suggestions;
}

// ---------- 规则 4 + 5: 止损 + 清仓 (?v=daemon3: bear 下阈值严 50%) ----------
// 字段: {code, name, chg5, sectorStrength, belowMA20, sector (runRule7)}
// [P1 #6] bear 不再产 sectorWeak: bear 已经"空仓合法", sectorWeak 叠加是双重信号混乱
//         bear 下转 stop 信号 (跟 ma20 一样优先级, 一律清仓)
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
        severity: isBear ? 'critical' : 'high',
        action: isBear ? 'force-trim' : 'stop',
        rule: 'ma20', code: h.code, name: h.name,
        title: `${h.name} 跌破 MA20${isBear ? ' (bear 强清)' : ''}`,
        body: isBear
          ? 'bear 模式下任何破位一律强清, 立即减仓至 ≤2% 单票上限'
          : '触发中线止损复盘, 建议检查买入假设',
        linked_rules: [4, 6],
        context: { isBear }
      }));
    }
    if (h.chg5 != null && h.chg5 > trimPct) {
      notifs.push(makeAlert({
        severity: 'warn', action: 'trim', rule: 'fishTail', code: h.code, name: h.name,
        title: `${h.name} 鱼尾行情${isBear ? ' (bear 严)' : ''}`,
        // ?v=daemon5 P0 (审计 #4): 鱼尾行情 = 5日累计涨幅 (冲高乏力), 用 chg5 而不是 fishTail5d
        // 旧 bug: fishTail5d 算的是累计跌幅, 跟"鱼尾冲高减仓"语义完全相反
        body: `5日累计涨幅 ${(h.chg5*100).toFixed(1)}% ≥ ${(trimPct*100).toFixed(0)}%, 强制减半`,
        linked_rules: [5, 6],
        context: { chg5: h.chg5, trimPct }
      }));
    }
    // [P1 #6] bear 不再产 sectorWeak, 避免双重信号
    if (!isBear && h.sectorStrength != null && h.sectorStrength < weakPct) {
      notifs.push(makeAlert({
        severity: 'info', action: 'trim', rule: 'sectorWeak', code: h.code, name: h.name,
        title: `${h.name} 板块走弱`,
        body: `板块强度 ${(h.sectorStrength*100).toFixed(0)}% < ${(weakPct*100).toFixed(0)}%, 该板块持仓减半`,
        linked_rules: [5, 6],
        context: { sectorStrength: h.sectorStrength, weakPct }
      }));
    }
  }
  return notifs;
}

// ---------- 规则 6: 空仓 (regime.positionMultiplier 透传) ----------
// 保留为兼容接口: 测试和外部代码可能仍 import / call 它, runAllRules 暂不调
// 真"空仓"判断已落到 decideAddOn (mult<=0 → add-blocked)
function runRule6(ctx) {
  return ctx.regime;
}

// ---------- 规则 7: 单行业集中度 (P1 #4, 之前完全没实现) ----------
// 持仓纪律.md 规律 3: "单行业 ≤25%" (默认), 用户实际 0.20
// 字段依赖: holdings[].sector
// 聚合逻辑: 同 sector 持仓市值加总 / total > threshold → 报警
// 分级: 2x 以上 critical (force-trim), 1.2-2x high (trim)
function runRule7(ctx) {
  const alerts = [];
  const { holdings, portfolio, rules } = ctx;
  const total = portfolio.total;
  if (total <= 0) return alerts;
  const threshold = rules.singleIndustryMaxPct;
  if (typeof threshold !== 'number' || threshold <= 0) return alerts;  // 未配置则跳过
  const bySector = new Map();
  for (const h of holdings) {
    const s = h.sector || '(未分类)';
    const m = (h.price || 0) * (h.shares || 0);
    bySector.set(s, (bySector.get(s) || 0) + m);
  }
  for (const [sector, mkt] of bySector) {
    if (mkt <= 0) continue;
    const pct = mkt / total;
    if (pct > threshold) {
      const overMult = pct / threshold;
      // 浮点容差 (跟 runRule1 一致)
      const overMultR = Math.round(overMult * 10) / 10;
      const members = holdings.filter(h => (h.sector || '(未分类)') === sector).map(h => h.name);
      // 跟 runRule1 一致: 5x+ critical/force-trim, 1.5x-5x high/trim, 1x-1.5x high/alert
      let severity, action, body;
      if (overMultR >= 5) {
        severity = 'critical';
        action = 'force-trim';
        body = `单行业占比 ${(pct*100).toFixed(1)}% 是阈值 ${(threshold*100).toFixed(0)}% 的 ${overMultR.toFixed(1)} 倍, 强清至 ≤1 只`;
      } else if (overMultR >= 1.5) {
        severity = 'high';
        action = 'trim';
        body = `单行业占比 ${(pct*100).toFixed(1)}% > 阈值 ${(threshold*100).toFixed(0)}% (${overMultR.toFixed(1)}x), 建议减半`;
      } else {
        severity = 'high';
        action = 'alert';
        body = `单行业占比 ${(pct*100).toFixed(1)}% > 阈值 ${(threshold*100).toFixed(0)}%, 触发复盘`;
      }
      alerts.push(makeAlert({
        severity, action, rule: 'industry',
        code: '*', name: sector,
        title: `单行业超限: ${sector} (${(pct*100).toFixed(1)}%, 持有: ${members.join('+')})`,
        body,
        linked_rules: [3, 5],
        context: { sector, pct, threshold, overMult: overMultR, members }
      }));
    }
  }
  return alerts;
}

// ---------- 规则 8: 月度回撤熔断 (P1 #4, 之前完全没实现) ----------
// 持仓纪律.md 规律 2: "月度总回撤 -8% 触发熔断, 本月不再开新仓" (默认), 用户实际 0.05
// 字段依赖: portfolio.peak (本月 portfolio 历史高点), portfolio.monthKey
// 逻辑: (total - peak) / peak < -monthlyMaxDrawdown → critical
// 维护: 调用方 (daemon) 每日把 portfolio.total 跟 peak 比较, 创新高就更新 peak + 重置 monthKey
// 本函数是"判定"+"建议"分离: 判定纯函数, 维护在 daemon
function runRule8(ctx) {
  const alerts = [];
  const { portfolio, rules } = ctx;
  const total = portfolio.total;
  const peak = portfolio.peak;
  const monthKey = portfolio.monthKey;
  if (total <= 0) return alerts;
  if (typeof peak !== 'number' || peak <= 0) return alerts;  // 无 peak 数据, 跳过
  const threshold = rules.monthlyMaxDrawdown;
  if (typeof threshold !== 'number' || threshold <= 0) return alerts;
  const drawdown = (total - peak) / peak;  // 负数表示回撤
  if (drawdown < -threshold) {
    alerts.push(makeAlert({
      severity: 'critical', action: 'circuit-breaker', rule: 'monthly-dd',
      code: '*', name: '月度回撤',
      title: `月度回撤熔断 (${(drawdown*100).toFixed(1)}%, 阈值 ${(threshold*100).toFixed(0)}%)`,
      body: `本月 ${monthKey || '(未设)'} portfolio 从峰值 ${Math.round(peak)} → ${Math.round(total)}, 回撤 ${(drawdown*100).toFixed(1)}%, 触发熔断, 本月不再开新仓, 现有持仓只卖不买`,
      linked_rules: [1, 2, 6],
      context: { drawdown, threshold, peak, total, monthKey }
    }));
  }
  return alerts;
}

// ---------- 规则 9: 股票总仓 (P1 #4, 之前完全没实现) ----------
// 持仓纪律.md 规律 1: "股票总仓 ≤95%" (默认), 用户实际 0.90
// 字段依赖: portfolio.stockPct
// 逻辑: stockPct > totalStockMaxPct → critical (留出 5%+ 给现金)
// 注意: totalStockMaxPct + cashReservePct 应 ≤ 1, 否则数学上同时触发
function runRule9(ctx) {
  const alerts = [];
  const { portfolio, rules } = ctx;
  const total = portfolio.total;
  if (total <= 0) return alerts;
  const threshold = rules.totalStockMaxPct;
  if (typeof threshold !== 'number' || threshold <= 0) return alerts;
  const stockPct = (portfolio.stockMkt || 0) / total;
  if (stockPct > threshold) {
    const cashReserve = rules.cashReservePct || 0.05;
    // 跟现金储备冲突检测: 两者加起来 > 1 → 阈值设置有误
    const conflict = (threshold + cashReserve) > 1.0;
    alerts.push(makeAlert({
      severity: 'critical', action: 'force-trim', rule: 'total-stock',
      code: '*', name: '总仓',
      title: `股票总仓超限 (${(stockPct*100).toFixed(1)}% > ${(threshold*100).toFixed(0)}%)`,
      body: conflict
        ? `总仓阈值 (${(threshold*100).toFixed(0)}%) + 现金储备 (${(cashReserve*100).toFixed(0)}%) > 100%, 阈值设置冲突, 调低其一`
        : `股票总仓 ${(stockPct*100).toFixed(1)}% 超过 ${(threshold*100).toFixed(0)}% 阈值, 需减仓 (留 ${(cashReserve*100).toFixed(0)}%+ 现金)`,
      linked_rules: [1, 2],
      context: { stockPct, threshold, cashReserve, conflict }
    }));
  }
  return alerts;
}

// ---------- 规则 10: 短线止损 (P1 #4, 之前完全没实现) ----------
// 持仓纪律.md 规律 2: "短线试水: 买入价 -5% 强制离场" (默认), 用户实际 0.03
// 字段依赖: holdings[].cost + price
// 逻辑: (price - cost) / cost < -shortStopLossPct → stop
// 注意: 只对"已实现买入"生效, 浮亏达阈值就触发
function runRule10(ctx) {
  const alerts = [];
  const { holdings, rules } = ctx;
  const threshold = rules.shortStopLossPct;
  if (typeof threshold !== 'number' || threshold <= 0) return alerts;
  for (const h of holdings) {
    const cost = h.cost;
    const price = h.price;
    if (cost == null || price == null || cost <= 0) continue;  // 无成本价数据跳过
    const ret = (price - cost) / cost;  // 负数表示亏损
    if (ret < -threshold) {
      alerts.push(makeAlert({
        severity: 'high', action: 'stop', rule: 'shortStop',
        code: h.code, name: h.name,
        title: `${h.name} 短线止损 (浮亏 ${(ret*100).toFixed(1)}%)`,
        body: `买入价 ${cost} → 现价 ${price}, 浮亏 ${(ret*100).toFixed(1)}% ≥ 阈值 -${(threshold*100).toFixed(0)}%, 强制离场`,
        linked_rules: [2, 4],
        context: { ret, threshold, cost, price }
      }));
    }
  }
  return alerts;
}

// ---------- 规则 11: regime 持续性告警 (P2 #13) ----------
// 检查 _rw_regime_today + 持续天数: regime='unknown' 或 confidence < 0.3 持续多天 → critical
//   "我们其实在盲飞" — 提醒用户手动判断市场状态, 不要按默认 mult 0.5 行动
// 字段依赖: ctx.state (state-adapter), 读 _rw_regime_today + _rw_regime_votes
// 行为: 
//   - regime=unknown → critical "regime 未知" 持续 N 天 (默认 1 天就告, 但 weekly 内 daily 告)
//   - confidence < 0.3 → warn "数据不足, 判定置信度低"
//   - vote 流数据 < 5 天 → warn "迟滞期数据不足"
function runRule11(ctx) {
  const alerts = [];
  // ctx.state 可选注入; daemon 端从 window.ReverseWatch 传 state
  const state = ctx.state;
  if (!state || typeof state.safeReadJson !== 'function') return alerts;
  const today = state.safeReadJson('_rw_regime_today', null);
  if (!today) {
    // 还没跑过 regime 检测
    alerts.push(makeAlert({
      severity: 'warn', action: 'info', rule: 'regime-stale',
      code: '*', name: 'regime',
      title: 'regime 未初始化',
      body: '今日还没跑过 regime 检测, 仓位倍数用 0.5 fallback, 建议手动判定市场状态',
      linked_rules: [6],
      context: { reason: 'no_today' }
    }));
    return alerts;
  }
  if (today.regime === 'unknown' || (typeof today.confidence === 'number' && today.confidence < 0.3)) {
    // 持续多少天 (看 _rw_regime_votes 长度)
    const votes = state.safeReadJson('_rw_regime_votes', []);
    const hasData = Array.isArray(votes) && votes.length >= 5;
    const severity = hasData ? 'critical' : 'warn';
    alerts.push(makeAlert({
      severity, action: 'info', rule: 'regime-stale',
      code: '*', name: 'regime',
      title: `regime 数据不足 (${today.regime}, confidence ${today.confidence ?? '?'})`,
      body: hasData
        ? `regime 持续 unknown 超过 5 天迟滞期, 仓位倍数 fallback 0.5 在用, 建议手动判定 bull/bear/range`
        : `regime 还没积累 5 天迟滞数据, 暂时无法判定, 仓位倍数 fallback 0.5 在用`,
      linked_rules: [6],
      context: { regime: today.regime, confidence: today.confidence, votesCount: votes.length }
    }));
  }
  return alerts;
}

// ---------- runAllRules (?v=daemon3 + 7/8/9/10/11): 共享 ctx, 幂等去重 + severity 排序 ----------
// 规则 1+3+4+5+7+8+9+10+11 共用 pipeline, 不重复跑
// 规则 6 (空仓透传) 不再直接产 alert, 已合并到 decideAddOn 的 add-blocked
// 规则 11 (regime-stale) 需要 ctx.state 注入 (可选), 没传就跳过
// ?v=daemon3 (P1 #146): 按 id 幂等去重, 同 id 保留更高 severity
// ?v=daemon4 (P0 F1 修): makeAlert 已不产 id, 由 attachAlertId 统一在注入 slot 后计算
function runAllRules(ctx, slot = 'unknown') {
  const dayKey = shanghaiStr().slice(0, 10);
  const raw = [
    ...runRule1(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...decideAddOn(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...decideStopAndTrim(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...runRule7(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...runRule8(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...runRule9(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...runRule10(ctx).map(a => attachAlertId(a, slot, dayKey)),
    ...runRule11(ctx).map(a => attachAlertId(a, slot, dayKey))
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
  runRule1, decideAddOn, decideStopAndTrim, runRule6, runAllRules,
  // [P1 #4] 新增 4 规则
  runRule7, runRule8, runRule9, runRule10,
  // [P2 #13] regime-stale 告警
  runRule11
};
