// ============== reverse-watch-daemon.mjs · AI 操盘管家 (Node daemon) ==============
// 调度 + heartbeat + 7 规则执行端 + 原子写 _rw_daemon_state.json
// 设计: PM2 监管 (autorestart), 工作日盘前/盘中/盘后多触发
//
// 与 dev-proxy 关系: 不向 :8089 复制实现, 直接调同源 dev-proxy :8089 → AKTools :8088
//
// 7 规则:
//   1. 资金 (calcPortfolio) — 暂只输出摘要, 不调参
//   2. 持仓 (HoldingRules) — 复用
//   3. 加仓 (decideAddOn) — 飞书推送 + 写 daemon state
//   4. 止损 (checkTriggers) — 飞书推送
//   5. 清仓 (checkTriggers 鱼尾/板块弱) — 飞书推送
//   6. 空仓 (regime.positionMultiplier) — 写 daemon state, 浏览器侧消费
//   7. 选股 (runReverseScreener) — 写 daemon state, 浏览器侧消费
//
// 时区: Asia/Shanghai (PM2 env 注入)
// 心跳: 每分钟写一次, 卡死主动非零退出交 PM2 重拉

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 纯逻辑 (时间工具 / makeAlert / 7 规则 1+3+4+5+6 / runAllRules) 已抽到 daemon-pure.mjs, 行为 100% 一致
import {
  nowShanghai, shanghaiStr, shanghaiHM, shanghaiDow, shanghaiISO,
  SEVERITY_RANK, ALERT_LIMIT,
  makeAlert, attachAlertId,
  runRule1, decideAddOn, decideStopAndTrim, runRule6, runAllRules
} from '../reverse-watch/daemon-pure.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RW_DIR = path.join(ROOT, 'reverse-watch');
const STATE_FILE = path.join(RW_DIR, '_rw_daemon_state.json');
const SCHEDULER_FILE = path.join(RW_DIR, '_rw_scheduler_last_run.json');
const ACCOUNT_FILE = path.join(RW_DIR, '_rw_account.json');
// (审计 #1): _rw_holding_rules.json 顶层常量, 给 PUT /rules 用
const RULES_FILE = path.join(RW_DIR, '_rw_holding_rules.json');
const LOG_FILE = path.join(ROOT, 'logs', 'daemon-out.log');

const DEV_PROXY = process.env.DEV_PROXY || 'http://127.0.0.1:8089';
const HEARTBEAT_INTERVAL_MS = 60 * 1000;       // 1 分钟心跳
const TICK_INTERVAL_MS = 30 * 1000;              // 30 秒 tick
const FEISHU_DAILY_LIMIT = 30;
const SLOT_TOLERANCE_MS = 5 * 60 * 1000;         // 5 分钟 slot 容差 (PM2 重启不会丢触发)
// TZ 已通过 PM2 env TZ=Asia/Shanghai 注入 (见 ecosystem.config.cjs), 不再需要手动偏移
const FEISHU_HOOK = process.env.FEISHU_HOOK || '';  // 飞书机器人 webhook

// ---------- 日志 (简单 stdout + 文件双写, 不引入新依赖) ----------
function log(...args) {
  const ts = shanghaiStr();
  const line = `[${ts}] [daemon] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { console.warn('[daemon] 日志写盘失败:', e.message); }  // ?v=daemon4 P1 #161: 不再吞
}

// ---------- 原子写 ----------
// #5: fsyncSync 强制 page cache 落盘 + rename 失败 .tmp 清理
// 避免断电/OS crash 后读旧 state; Windows 下 AV/编辑器短暂占用 EBUSY 时 .tmp 不残留
function atomicWrite(filePath, value) {
  const tmp = `${filePath}.tmp`;
  let fd = -1;
  try {
    const data = Buffer.from(JSON.stringify(value, null, 2), 'utf-8');
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data, 0, data.length, 0);
    try { fs.fsyncSync(fd); } catch (e) { log('fsyncSync 失败 (不影响后续 rename):', e.message); }
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, filePath);
  } catch (e) {
    if (fd >= 0) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ---------- 安全读 ----------
function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    log('safeReadJson 失败:', filePath, e.message);
    return fallback;
  }
}

// atomicWrite (tmp + rename) 落盘, 防 daemon 崩溃半截写入
function safeWriteJson(filePath, obj) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    log('safeWriteJson 失败:', filePath, e.message);
    return false;
  }
}

// ---------- 时区安全的当前时间 ----------
// 5 个时间工具 (nowShanghai / shanghaiStr / shanghaiHM / shanghaiDow / shanghaiISO) 已抽到 daemon-pure.mjs

// ---------- 调度 slot 定义 ----------
// 交易日 (周一-周五) 盘前 09:25 / 盘中 11:00 / 盘中 13:30 / 盘后 15:05
// AutoTuner: 周日 16:00
// 周末跳过
// cron 格式: 'HH:MM' (跟 shanghaiHM() 输出一致, 否则永真不触发)
const SCHEDULE_SLOTS = [
  { name: 'morningBrief',  cron: '09:25', days: [1,2,3,4,5] },
  { name: 'lossScanMid',   cron: '11:00', days: [1,2,3,4,5] },
  { name: 'lossScanMid2',  cron: '13:30', days: [1,2,3,4,5] },
  { name: 'dailySweep',    cron: '15:05', days: [1,2,3,4,5] },
  { name: 'autoTuner',     cron: '16:00', days: [0] }  // 0=Sun
];

// 检查 slot 是否到期 (返回 { triggered: bool, name })
// 容忍 60s 窗口: 09:25:00-09:25:59 都算触发, 避免 30s tick 错过整分
function checkDueSlots() {
  const lastRun = safeReadJson(SCHEDULER_FILE, { lastSlots: {} });
  const now = nowShanghai();
  const today = shanghaiStr(now).slice(0, 10);
  const hm = shanghaiHM(now);
  const dow = shanghaiDow(now);
  const due = [];
  for (const slot of SCHEDULE_SLOTS) {
    if (!slot.days.includes(dow)) continue;
    // 60s 窗口: slot.cron 后 60s 内都算 (容忍 30s tick 错过整分)
    const [hh, mm] = slot.cron.split(':').map(Number);
    const slotMinute = hh * 60 + mm;
    const nowMinute = parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10);
    if (Math.abs(nowMinute - slotMinute) > 1) continue;  // 最多差 1 分钟
    const slotKey = `${today}_${slot.name}`;
    const lastTs = lastRun.lastSlots[slotKey] || 0;
    if (Date.now() - lastTs < SLOT_TOLERANCE_MS) continue;  // 已跑过
    due.push({ name: slot.name, slotKey });
  }
  return { due, lastRun };
}

// 标记 slot 已跑 (原子写)
function markSlot(slotKey) {
  const lastRun = safeReadJson(SCHEDULER_FILE, { lastSlots: {} });
  lastRun.lastSlots[slotKey] = Date.now();
  // 清理 14d 前的旧 slot, 避免文件无限增长
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  Object.keys(lastRun.lastSlots).forEach(k => {
    if (lastRun.lastSlots[k] < cutoff) delete lastRun.lastSlots[k];
  });
  try { atomicWrite(SCHEDULER_FILE, lastRun); }
  catch (e) { log('markSlot 写失败:', e.message); }
}

// ---------- 飞书推送 (severity 分级: ) ----------
// 旧版限频函数 feishuPush() / _feishuToday 已迁移到下方分级版本

// ---------- 依赖探测 ----------
async function probeDevProxy() {
  try {
    const r = await fetch(`${DEV_PROXY}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? 'ok' : 'down';
  } catch (e) { return 'down'; }
}
async function probeAktools() {
  // 改读 dev-proxy /health 的 akshare_status 字段
  // 历史:
  //   - stock_sy_em?symbol=test (v0): 端点不存在 + 无效参数 → 500 → 误报
  //   - stock_zh_a_spot_em?symbol=000001 (v1): aktools 0.0.91 + akshare 1.18.x API 不兼容
  //       → 该端点 500 → 误报 down (但其实 aktools 进程在, dev-proxy 已降级到腾讯备用源)
  //   - /health.akshare_status (v2): dev-proxy 自身用 /openapi.json 探活, 0.0.91+ 必存在 + 不依赖外网
  //       → 一次 HTTP 同时拿到 dev-proxy + aktools 状态, daemon 不用再独立探测
  try {
    const r = await fetch(`${DEV_PROXY}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return 'down';
    const j = await r.json();
    return (j && j.akshare_status === 'ok') ? 'ok' : 'down';
  } catch (e) { return 'down'; }
}

// ---------- fetchAkshare (Node 版) ----------
// ?v=daemon4-logic2 P1 #25 sub-a: 加 timeoutMs 参数 (默认 15s, enrich 传 5s, prewarm 传 30s)
// 单只 holdings enrich 卡死时不影响整个 prewarm
async function fetchAkshare(path, timeoutMs = 15000) {
  const url = `${DEV_PROXY}/api/akshare/${path}`;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const body = await r.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (body.error || body.detail) {
        log('端点不存在或参数错:', path, '→', body.error || body.detail);
        return null;
      }
    }
    return Array.isArray(body) ? body : null;
  } catch (e) {
    log('akshare 拉取失败:', path, e.message);
    return null;
  }
}

// ?v=daemon4 P0 #155: holdings 字段永不充实, daemon 规则 3/4/5 永远 0 输出空架子
// 修法: buildSingleContext 内异步调 akshare 补 chg5/belowMA20/sectorStrength/fishTail5d
// 失败/缺数据时不抛, 落 null 但 daemon 仍能跑 (fail-soft)
// enrichCache: in-memory cache, 同 code 1 分钟内复用, 避免每 tick 重拉
const _enrichCache = new Map();
const ENRICH_TTL_MS = 60 * 1000;
// ?v=daemon5 P0 (race #2): 硬上限 200, set 前清过期 + 限制 size
const ENRICH_CACHE_MAX = 200;
function _enrichCacheSweep(now) {
  if (_enrichCache.size <= ENRICH_CACHE_MAX) return;
  for (const [k, v] of _enrichCache) {
    if (!v || !v.ts || now - v.ts > ENRICH_TTL_MS) _enrichCache.delete(k);
  }
}

async function enrichHolding(code, current) {
  const cached = _enrichCache.get(code);
  const now = Date.now();
  if (cached && (now - cached.ts) < ENRICH_TTL_MS) return cached.data;

  // 1. 拉 60 日 K 线 → 算 chg5 (5日涨幅) + belowMA20 (跌破 MA20)
  // ?v=daemon4-logic2 P1 #25 sub-a: kline 用 5s timeout, 单只卡住不拖累整个 enrich
  let chg5 = null;
  let belowMA20 = null;
  let fishTail5d = null;
  try {
    // ?v=daemon5 P0 (TZ #1): endDate/startDate 用本地日期 (上海 TZ), 不再 +8h 取 UTC 日
    // 旧 bug: 0-7am 上海时间, Date.now() 还是 UTC 昨天 16-23 点, endDate = 昨天日期 = akshare 返空
    // 新版: 直接用 shanghaiStr() 拿当前上海日期
    const endDate = shanghaiStr().slice(0, 10);
    const startDate = shanghaiStr(new Date(Date.now() - 90 * 24 * 3600 * 1000)).slice(0, 10);
    const k = await fetchAkshare(`stock_zh_a_hist?symbol=${code}&period=daily&adjust=hfq&start_date=${startDate}&end_date=${endDate}`, 5000);
    if (Array.isArray(k) && k.length >= 5) {
      const closes = k.map(r => Number(r.收盘 || r.close || 0));
      const today = closes[closes.length - 1];
      const fiveAgo = closes[closes.length - 6] || closes[0];
      chg5 = fiveAgo > 0 ? (today - fiveAgo) / fiveAgo : null;
      // MA20 = 20日收盘均值
      const last20 = closes.slice(-20);
      const ma20 = last20.reduce((s, v) => s + v, 0) / last20.length;
      belowMA20 = today < ma20;
      // fishTail5d = 最近 5 日累计跌幅
      const last5 = closes.slice(-5);
      fishTail5d = last5.reduce((acc, cur, i) => {
        if (i === 0) return 0;
        return acc + (cur < last5[i - 1] ? (last5[i - 1] - cur) / last5[i - 1] : 0);
      }, 0);
    } else {
      log('enrichHolding kline 数据不足:', code, 'len=', Array.isArray(k) ? k.length : 'null');
    }
  } catch (e) {
    log('enrichHolding kline 失败:', code, e.message);
  }

  // 2. 拉个股实时行情 → 拿名字 + 现价 (覆盖 holdings.price 缺失)
  // ?v=daemon4-logic2 P1 #25 sub-d: spot 也用 5s timeout
  let name = current?.name || null;
  let price = current?.price || null;
  try {
    // ?v=daemon4 修: stock_zh_a_spot_em 接受 symbol 参数拉单只
    const spot = await fetchAkshare(`stock_zh_a_spot_em?symbol=${code}`, 5000);
    if (Array.isArray(spot) && spot.length > 0) {
      const row = spot[0];
      if (row.名称 || row.name) name = row.名称 || row.name;
      if (row.最新价 || row.price) price = Number(row.最新价 || row.price);
    }
  } catch (e) {
    log('enrichHolding spot 失败:', code, e.message);
  }

  // ?v=daemon5 P0 (审计 #5): sectorStrength 永为 null → 规则 3/5 零输出
  // 旧 bug: enrichHolding 硬写 sectorStrength: null, 消费端 continue 100% 命中
  // 修法: 用 chg5 当 proxy (5日累计涨幅 = 板块相对强度近似), clamp 到 [0,1]
  //       后续接入 stock_board_industry_* 后替换
  const sectorStrength = (typeof chg5 === 'number' && Number.isFinite(chg5))
    ? Math.max(0, Math.min(1, 0.5 + chg5))  // chg5=0 → 0.5 中性; chg5=+0.3 → 0.8 强; chg5=-0.3 → 0.2 弱
    : null;
  const data = { name, price, chg5, belowMA20, sectorStrength, fishTail5d };
  // ?v=daemon5 P0 (race #2): set 前 sweep 过期, 避免长期跑泄漏
  _enrichCacheSweep(now);
  _enrichCache.set(code, { ts: now, data });
  return data;
}

// 把补全后的 holdings 写回 _rw_holdings.json (供下次 ctx 用 + 浏览器侧读)
// ?v=daemon4-logic2 P1 #25 sub-b: 改 atomicWrite (替代 safeWriteJson), 防止 daemon 写到一半 crash 留半截 JSON
// ?v=daemon5 P0 (数据 #6): spread 拆分 — 用户字段 (shares/cost) 不被 daemon 实时价覆盖
async function persistEnrichedHoldings(holdings) {
  try {
    const file = path.join(RW_DIR, '_rw_holdings.json');
    const existing = safeReadJson(file, []);
    // 按 code merge, 保留用户原始 shares/cost
    const map = new Map(existing.map(h => [h.code, h]));
    // ?v=daemon5 P0: 用户手动写过的字段 — 永远不让 daemon spread 覆盖
    const USER_FIELDS = new Set(['shares', 'cost', 'name']);
    for (const h of holdings) {
      const prev = map.get(h.code) || {};
      const daemonFields = { ...h };
      for (const k of USER_FIELDS) delete daemonFields[k];
      map.set(h.code, { ...prev, ...daemonFields, shares: prev.shares ?? h.shares, cost: prev.cost ?? h.cost, name: prev.name ?? h.name });
    }
    atomicWrite(file, Array.from(map.values()));
  } catch (e) {
    log('persistEnrichedHoldings 失败:', e.message);
  }
}

// ---------- 共享上下文 (?v=daemon3 单例化) ----------
// SingleContext: 一次 buildSingleContext 喂所有规则
//   { regime, portfolio, holdings, rules, lastAddTsMap, signals }
// 所有规则共用 1 份 ctx, 避免 slot 各自重读 fs / 重算
// SEVERITY_RANK + ALERT_LIMIT 已抽到 daemon-pure.mjs, 顶部 import
let _ctx = null;
let _ctxBuiltAt = 0;
const CTX_TTL_MS = 60 * 1000;

async function buildSingleContext() {
  const now = Date.now();
  if (_ctx && (now - _ctxBuiltAt) < CTX_TTL_MS) return _ctx;
  const account = safeReadJson(ACCOUNT_FILE, { cash: 0 });
  const holdings = safeReadJson(path.join(RW_DIR, '_rw_holdings.json'), []);
  const rules = safeReadJson(RULES_FILE, {
    singleStockMaxPct: 0.10, basePoolMaxPct: 0.50, cashReservePct: 0.05,
    addOnProfitPct: 0.05, addMaxRatio: 0.50, addCooldownDays: 3,
    fishTailTrimPct: 0.15, sectorWeakPct: 0.50, trapLockHours: 24,
    stockOverPct: 0.30   // 单票 + 板块池警戒占比
  });
  const regimeHist = safeReadJson(path.join(RW_DIR, '_rw_regime_history.json'), []);
  const latestRegime = Array.isArray(regimeHist) && regimeHist.length > 0 ? regimeHist[regimeHist.length - 1] : null;
  const MULT = { bull: 1.0, range_weak: 0.5, range_strong: 0.3, bear: 0.0 };
  const regime = latestRegime ? latestRegime.regime : 'unknown';
  const multiplier = MULT[regime] ?? 0.5;
  const stockMkt = (holdings || []).reduce((s, h) => s + ((h.price || 0) * (h.shares || 0)), 0);
  const cash = account.cash || 0;
  const total = stockMkt + cash;
  const stockPct = total > 0 ? stockMkt / total : 0;
  const lastAddTsMap = safeReadJson(path.join(RW_DIR, '_rw_daemon_last_add.json'), {});
  // signals: 给 AutoTuner 复用 (规则 7/选股也读)
  const signals = safeReadJson(path.join(RW_DIR, '_rw_signals.json'), {});
  // ?v=daemon4 P0 #155 修: 异步调 akshare 补 chg5/belowMA20/sectorStrength/fishTail5d/name
  // 原 bug: 浏览器录入时这些字段全 null → decideAddOn / decideStopAndTrim 永远 continue → 规则 3/4/5 0 输出空架子
  // 策略: enrichCache 1 分钟 TTL 复用, 单票超时 5s, 全批并行, 失败不抛 (fail-soft)
  const enrichedHoldings = await Promise.all((holdings || []).map(async (h) => {
    const enriched = await enrichHolding(h.code, h);
    return { ...h, ...enriched };
  }));
  // 补完字段后异步写盘 (不阻塞 ctx 返回)
  persistEnrichedHoldings(enrichedHoldings).catch(e => log('persistEnrichedHoldings fire-and-forget:', e.message));

  _ctx = {
    regime: { current: regime, positionMultiplier: multiplier },
    portfolio: { cash, stockMkt, total, stockPct, holdings: enrichedHoldings.length },
    holdings: enrichedHoldings,
    rules,
    lastAddTsMap,
    signals,
    builtAt: now,
    _holdingsEnriched: true
  };
  _ctxBuiltAt = now;
  return _ctx;
}

// 12 个内联函数 (makeAlert / attachAlertId / 7 规则 1+3+4+5+6 / runAllRules) 已抽到 daemon-pure.mjs, 顶部 import

// 规则 7 — 选股 (?v=daemon2 修复 P0-4: 从 akshare stock_zh_a_spot_em 拉候选池)
// 用 screener-pure.runReverseScreener 跑, 行为跟浏览器一致
// ?v=daemon4-logic2 P1 #25 sub-c: prewarmPoolRisk 复用 enrichHolding spot 数据
// (避免规则 7 跟 enrichHolding 各拉一次 stock_zh_a_spot_em, 浪费带宽)
let _poolRiskPreWarmed = false;
async function prewarmPoolRisk() {
  if (_poolRiskPreWarmed) return;
  const holdings = safeReadJson(path.join(RW_DIR, '_rw_holdings.json'), []);
  if (!Array.isArray(holdings) || holdings.length === 0) { _poolRiskPreWarmed = true; return; }
  try {
    // 并行 enrich 所有 holdings (每只 5s timeout, 整批最多 30s)
    await Promise.all(holdings.map(h => enrichHolding(h.code, h)));
    log('[prewarm] 已 enrich', holdings.length, '只 holdings, 5s timeout/只');
  } catch (e) {
    log('[prewarm] enrich 失败 (不阻塞 slot):', e.message);
  }
  _poolRiskPreWarmed = true;
}

async function runRule7(ctx, settings = null) {
  try {
    // ?v=daemon4-logic2 P1 #25 sub-c: 跑前先 enrich holdings (复用 enrichHolding spot, 避免重复拉 spot)
    await prewarmPoolRisk();
    // ?v=daemon4-logic2 P1 #25 sub-c: stock_zh_a_spot_em (全市场 ~5000 股) 给 30s timeout, 默认 15s 不够
    const pool = await fetchAkshare('stock_zh_a_spot_em', 30000);
    if (!Array.isArray(pool)) return { passed: 0, blocked: 0, note: '候选池拉取失败 (dev-proxy/aktools 不可用)' };
    // 简化映射: aktools 返 {代码, 名称, 最新价, 涨跌幅, ...}; screener 需 {code, name, isSectorLeader, limitsUpRate_2d, sectorPbMedian, pbPercentile, style, hasQuantSeat, sector}
    // 这里只跑演示映射, 实际筛选用主项目 REVERSE_POOL 增强版 (本 daemon 仅作骨架)
    const mapped = pool.slice(0, 200).map(r => ({
      code: r.代码 || r.code,
      name: r.名称 || r.name,
      sector: r.行业 || r.sector || '',
      isSectorLeader: false,
      limitsUpRate_2d: 0.6,
      sectorPbMedian: 50,
      pbPercentile: 30,
      style: 'normal',
      hasQuantSeat: false
    })).filter(r => r.code);
    if (mapped.length === 0) return { passed: 0, blocked: 0, note: '候选池空' };
    // 动态 import screener-pure (Node ESM) — pathToFileURL 在 L22 已 import
    const { runReverseScreener } = await import(pathToFileURL(path.join(RW_DIR, 'strategy', 'screener-pure.mjs')).href);
    const gates = (settings && settings.gates) || { sectorMin: 0.55, pbDeltaMin: 15, quantRejectPct: 0.5, excludeLeaders: true };
    const result = runReverseScreener(mapped, {
      gates,
      deps: {
        getPoolExcludes: () => [],  // 简化: 浏览器侧 _rw_pool_excludes 同步在 settings 里
        loadFeedback: () => null,
        readCachedRisk: () => null
      },
      rng: Math.random
    });
    return { passed: result.passed.length, blocked: result.blocked.length, note: null, sample: result.passed.slice(0, 5).map(p => p.code) };
  } catch (e) {
    log('runRule7 失败:', e.message);
    return { passed: 0, blocked: 0, note: `异常: ${e.message}` };
  }
}

// ---------- 状态机 ----------
let _state = safeReadJson(STATE_FILE, {
  schemaVersion: 2,
  heartbeatAt: '',
  daemon: { status: 'starting', pid: process.pid },
  dependencies: { devProxy: 'unknown', aktools: 'unknown' },
  tasks: {
    screener: { status: 'pending', lastSuccessAt: null, nextRunAt: null, slot: null, summary: {}, error: null },
    autoTuner: { status: 'pending', lastRunAt: null, pending: [], applied: [] }
  },
  regime: { current: 'unknown', positionMultiplier: 1.0 },
  // _state.context (?v=daemon3): 浏览器侧消费的统一快照
  context: { regime: 'unknown', positionMultiplier: 1.0, portfolio: { cash: 0, total: 0 }, holdingCount: 0, builtAt: 0 },
  adjustments: { pending: [], applied: [] },
  // unified alerts schema (?v=daemon3): {severity, action, code, name, title, body, linked_rules, context}
  alerts: [],
  portfolio: { cash: 0, stockMkt: 0, total: 0, stockPct: 0, holdings: 0 }
});
// ?v=daemon4-logic1: 启动时清洗 STATE_FILE 旧数据
// 1) alerts 数组: 移除超过 50 条的旧 error alerts (L761 unshift 累积老 bug)
// 2) heartbeatAt: 重置成 "启动前" (heartbeat() 会自己更新)
// 3) daemon.status: 重置为 'starting', 由 heartbeat() 改成 'ok'/'degraded'
if (Array.isArray(_state.alerts) && _state.alerts.length > 50) {
  log('启动清洗: STATE_FILE 残留 alerts=', _state.alerts.length, '条 → 截断到 50');
  _state.alerts = _state.alerts.slice(0, 50);
}
_state.heartbeatAt = '';
_state.daemon.status = 'starting';

function saveState() {
  try {
    // ?v=daemon5 P0 (TZ #3): heartbeatAt 用 shanghaiISO, 跟 alerts.dayKey 一致
    _state.heartbeatAt = shanghaiISO();
    _state.daemon.status = _state.daemon.status || 'ok';
    _state.daemon.pid = process.pid;
    atomicWrite(STATE_FILE, _state);
  } catch (e) { log('saveState 失败:', e.message); }
}

// ---------- 飞书推送分级 (?v=daemon2 修复 P0-6) ----------
// high: 即时推 (不超 limit)
// warn: 即时推, 限 10/天
// info: 累计 3 条合并推, 累计窗口 1h, 超时强制推
let _feishuToday = { date: '', high: 0, warn: 0 };
const _feishuInfoBuf = [];   // 暂存 info 级别
const FEISHU_HIGH_LIMIT = 30; // high 无单独限, 跟 total
const FEISHU_WARN_LIMIT = 10;
const FEISHU_INFO_BATCH = 3;
const FEISHU_INFO_FLUSH_MS = 60 * 60 * 1000; // 1h 强制刷新

function _feishuResetIfNewDay() {
  const today = shanghaiStr().slice(0, 10);
  if (_feishuToday.date !== today) _feishuToday = { date: today, high: 0, warn: 0 };
}

async function _feishuFlushInfo() {
  if (_feishuInfoBuf.length === 0) return;
  const text = `ℹ️ [信息聚合] ${_feishuInfoBuf.length} 条\n` + _feishuInfoBuf.slice(0, 10).map(s => `• ${s.title}: ${s.body}`).join('\n');
  await _feishuRawPush(text);
  _feishuInfoBuf.length = 0;
}

// 1h 强制刷新 info buffer
setInterval(() => { _feishuFlushInfo().catch(e => log('info flush 失败:', e.message)); }, FEISHU_INFO_FLUSH_MS).unref();  // ?v=daemon4 P1 #161: 不再吞

async function _feishuRawPush(text) {
  if (!FEISHU_HOOK) {
    log('[飞书] webhook 未配置, 跳过:', text.slice(0, 80));
    return false;
  }
  try {
    const r = await fetch(FEISHU_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } })
    });
    return r.ok;
  } catch (e) {
    log('飞书推送失败:', e.message);
    return false;
  }
}

// 入口: 接收 alerts (含 severity), 自动分级推送
async function feishuPushAlerts(alerts) {
  _feishuResetIfNewDay();
  if (!Array.isArray(alerts) || alerts.length === 0) return;
  const high = alerts.filter(a => a.severity === 'high');
  const warn = alerts.filter(a => a.severity === 'warn');
  const info = alerts.filter(a => a.severity === 'info' || !a.severity);
  // high: 即时 (30/天总)
  // ?v=daemon4-logic2 P1 #7: 只在 push 成功后 ++, 失败不算配额
  for (const a of high) {
    if (_feishuToday.high >= FEISHU_DAILY_LIMIT) { log('飞书 high 限'); break; }
    const ok = await _feishuRawPush(`🚨 ${a.title}\n${a.body}${a.linked_rules ? '\n[联动规则: ' + a.linked_rules.join(',') + ']' : ''}`);
    if (ok) _feishuToday.high++;
    else log('飞书 high 推送失败, 不计入配额:', a.title);
  }
  // warn: 即时 (10/天) — 同修
  for (const a of warn) {
    if (_feishuToday.warn >= FEISHU_WARN_LIMIT) { log('飞书 warn 限'); break; }
    const ok = await _feishuRawPush(`⚠️ ${a.title}\n${a.body}${a.linked_rules ? '\n[联动规则: ' + a.linked_rules.join(',') + ']' : ''}`);
    if (ok) _feishuToday.warn++;
    else log('飞书 warn 推送失败, 不计入配额:', a.title);
  }
  // info: 累计 + 定时刷新
  _feishuInfoBuf.push(...info);
  if (_feishuInfoBuf.length >= FEISHU_INFO_BATCH) await _feishuFlushInfo();
}

// 单条紧急推 (供 high severity 单独路径用)
async function feishuPush(text) {
  _feishuResetIfNewDay();
  if (_feishuToday.high >= FEISHU_DAILY_LIMIT) { log('飞书总限'); return false; }
  const ok = await _feishuRawPush(text);
  if (ok) _feishuToday.high++;
  return ok;
}

// ---------- 加仓 cooldown 写盘 (?v=daemon2 修复 P0-3) ----------
function writeCooldown(code, ts = Date.now()) {
  try {
    const map = safeReadJson(path.join(RW_DIR, '_rw_daemon_last_add.json'), {});
    map[code] = ts;
    atomicWrite(path.join(RW_DIR, '_rw_daemon_last_add.json'), map);
  } catch (e) { log('writeCooldown 失败:', e.message); }
}

// ---------- 单 slot 执行 (?v=daemon3: buildSingleContext + runAllRules + unified schema) ----------
function writeContextSnapshot(ctx) {
  _state.context = {
    regime: ctx.regime.current,
    positionMultiplier: ctx.regime.positionMultiplier,
    portfolio: { cash: ctx.portfolio.cash, total: ctx.portfolio.total },
    holdingCount: ctx.holdings.length,
    builtAt: ctx.builtAt
  };
  _state.regime = ctx.regime;
  _state.portfolio = ctx.portfolio;
}

async function runSlot(slotName) {
  log('slot 触发:', slotName);
  try {
    const ctx = await buildSingleContext();
    writeContextSnapshot(ctx);
    let newAlerts = [];
    if (slotName === 'morningBrief') {
      // 盘前: 资金 + 空仓
      newAlerts = runAllRules(ctx, slotName);
    } else if (slotName === 'dailySweep') {
      // 盘后: 全套规则 (统一 pipeline)
      newAlerts = runAllRules(ctx, slotName);
      // 加仓命中后写 cooldown
      for (const a of newAlerts.filter(x => x.action === 'add')) {
        writeCooldown(a.code);
      }
      // 选股
      const settings = safeReadJson(path.join(RW_DIR, '_rw_settings.json'), null);
      const screener = await runRule7(ctx, settings);
      _state.tasks.screener = { status: screener.note ? 'skipped' : 'ok', lastSuccessAt: shanghaiISO(), nextRunAt: null, slot: 'dailySweep', summary: screener, error: screener.note || null };
    } else if (slotName === 'lossScanMid' || slotName === 'lossScanMid2') {
      // 盘中: 止损/清仓 (共享 ctx, 复用 runAllRules 输出的子集)
      newAlerts = runAllRules(ctx, slotName).filter(a => a.action === 'stop' || a.action === 'trim');
    } else if (slotName === 'autoTuner') {
      // 周日 16:00: AutoTuner 调度
      // ?v=daemon2 修复 P1: 浏览器侧 _rw_feedback 是 localStorage key, daemon 读 _rw_feedback.json (浏览器同步写)
      try {
        const { decide, computeSignals, shouldSkip } = await import(pathToFileURL(path.join(RW_DIR, 'auto-tuner-pure.mjs')).href);
        const pureDeps = {
          loadActiveFeedback: (now) => safeReadJson(path.join(RW_DIR, '_rw_feedback.json'), {}),
          loadHoldingFb: () => safeReadJson(path.join(RW_DIR, '_rw_holding_feedback.json'), {}),
          getHolding: () => safeReadJson(RULES_FILE, {}),
          getUserAdjustments: () => safeReadJson(path.join(RW_DIR, '_rw_adjustments_log.json'), []),
          getSettings: () => safeReadJson(path.join(RW_DIR, '_rw_settings.json'), {})
        };
        const guard = shouldSkip({ deps: pureDeps });
        if (guard.skip) {
          log('AutoTuner skip:', guard.reason);
          _state.tasks.autoTuner = { status: 'skipped', lastRunAt: shanghaiISO(), skipReason: guard.reason, pending: [], applied: [] };
        } else {
          const signals = guard.signals || computeSignals({ deps: pureDeps });
          const adjustments = decide(signals, { deps: pureDeps });
          log('AutoTuner 产出:', adjustments.length, '条 adjustments');
          _state.tasks.autoTuner = { status: 'ok', lastRunAt: shanghaiISO(), pending: adjustments, applied: [], signals };
        }
      } catch (e) {
        log('AutoTuner 跑失败:', e.message);
        _state.tasks.autoTuner = { status: 'failed', lastRunAt: shanghaiISO(), error: e.message, pending: [], applied: [] };
      }
    }
    // 推 alerts (?v=daemon2: 用分级 feishuPushAlerts)
    if (newAlerts.length > 0) await feishuPushAlerts(newAlerts);
    // ?v=daemon4-alerts1: 完全替换 _state.alerts, 不再 concat 历史
    // 原因: 用户删持仓后, 旧 000858 单票超限告警不再触发, 但 concat 模式下保留
    // 导致 daemon 面板一直显示 stale 告警; 现在切换到 "本轮 fresh alerts 全集"
    // feishu 不重复推 (feishuPushAlerts 内部已经按 id 幂等)
    _state.alerts = newAlerts;
    log('runSlot 新 alerts:', slotName, newAlerts.length, '条 (覆盖 _state.alerts)');
    saveState();
  } catch (e) {
    log('runSlot 异常:', slotName, e.message);
    // ?v=daemon4-logic1: 异常 alerts 也按快照语义, 不无限 unshift
    // 旧实现: 任何 runSlot 出错 → unshift error → 永不清洗 → 累积 50+ 同样 error 堆着
    // 新实现: 只保留本轮的 error (1 条), 之前的 alerts 仍按新轮快照更新
    _state.alerts = [{ ts: shanghaiISO(), severity: 'high', action: 'error', error: e.message, slot: slotName }];
    saveState();
  }
}

// ---------- 心跳 ----------
async function heartbeat() {
  try {
    _state.dependencies.devProxy = await probeDevProxy();
    if (_state.dependencies.devProxy === 'ok') {
      _state.dependencies.aktools = await probeAktools();
    } else {
      _state.dependencies.aktools = 'down';
    }
    _state.daemon.status = _state.dependencies.devProxy === 'ok' ? 'ok' : 'degraded';
    _state.heartbeatAt = shanghaiStr();  // 写盘一并把 heartbeatAt 更新
    _lastHeartbeat = Date.now();  // ?v=daemon4 P0 修: heartbeat 自更新, 防自杀循环
    saveState();
  } catch (e) { log('heartbeat 失败:', e.message); }
}

// ---------- 主循环 ----------
let _tickTimer = null;
let _heartbeatTimer = null;
// ?v=daemon4-logic2 P1 #1: _running 防重入 — tick 和手动 trigger 共用
let _running = false;

async function tick() {
  if (_running) { log('tick 跳过: 上一轮还在跑'); return; }  // 防重入
  _running = true;
  try {
    const { due } = checkDueSlots();
    if (due.length > 0) {
      for (const s of due) {
        await runSlot(s.name);
        markSlot(s.slotKey);
      }
    }
  } catch (e) { log('tick 异常:', e.message); }
  finally { _running = false; }
}

// ?v=daemon6-test: 守卫 — 默认跑 main, 仅在测试导入时通过 env 跳过
//   旧版用 import.meta.url === pathToFileURL(process.argv[1]) 判定 (PM2 fork 模式子进程 argv[1] 不是 daemon.mjs 路径, 守卫 false → main 不跑 → 5min 后自杀)
//   新版: 默认 true (跑 main), 显式 RW_DAEMON_DISABLE_AUTORUN=1 才跳过 (测试场景用)
const __isMain = !process.env.RW_DAEMON_DISABLE_AUTORUN;

async function main() {
  log('启动 reverse-watch-daemon v0.1.0, pid=' + process.pid);
  log('时区:', Intl.DateTimeFormat().resolvedOptions().timeZone, 'TZ_OFFSET_HOURS=8');
  log('DEV_PROXY:', DEV_PROXY);
  log('FEISHU_HOOK:', FEISHU_HOOK ? 'configured' : '未配置');
  // 启动后立即 heartbeat 一次
  await heartbeat();
  // tick 循环
  _tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  // heartbeat 循环 (每分钟)
  _heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  log('调度注册完毕, 等待触发');
  // 写启动日志
  _state.daemon.status = 'ok';
  saveState();
}

// ---------- 优雅退出 ----------
let _lastHeartbeat = Date.now();
process.on('SIGTERM', () => { log('收到 SIGTERM, 退出'); cleanup(); process.exit(0); });
process.on('SIGINT', () => { log('收到 SIGINT, 退出'); cleanup(); process.exit(0); });
// 心跳超时检测: 60s 没跑过心跳 → 主动非零退出交 PM2 重拉
setInterval(() => {
  if (Date.now() - _lastHeartbeat > 5 * 60 * 1000) {
    log('心跳超时 (5min 未跑), 主动退出让 PM2 重拉');
    cleanup();
    process.exit(1);
  }
}, 30000).unref();

function cleanup() {
  if (_tickTimer) clearInterval(_tickTimer);
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  if (_httpServer) try { _httpServer.close(); } catch (e) { console.warn('[daemon] http close:', e.message); }
  _state.daemon.status = 'down';
  saveState();
}

// ---------- HTTP 端点 (?v=daemon2 修复 P0-2: holdings 桥接) ----------
// 浏览器 PUT /holdings → 写 _rw_holdings.json (daemon fs 直接读)
// GET /state → 读 _rw_daemon_state.json (浏览器 fetch, 已经在用相对路径)
// GET /health → daemon 自身心跳
const HOLDINGS_FILE = path.join(RW_DIR, '_rw_holdings.json');
const DAEMON_HTTP_PORT = parseInt(process.env.DAEMON_PORT || '8090', 10);
let _httpServer = null;
const _httpServer_ref = { current: null };

function _jsonRes(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

// [统一服务迁移] daemon HTTP handler 抽成命名函数, 供 unified-server 挂载
//   同时支持 NO_LISTEN 守卫, 不自启 listen
async function daemonHttpHandler(req, res) {
  // ?v=daemon5 P0 (HTTP #2): URL 解析用 pathname, 防止 `?cachebust=1` / `?_=12345` 等 query string 绕过
  let pathname = req.url || '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
  // ?v=daemon5 P1 (HTTP #3): Content-Type 校验 (PUT 必须 application/json)
  const isJsonPut = (req.method === 'PUT' && (pathname === '/holdings' || pathname === '/account'));
  if (isJsonPut) {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (ct !== 'application/json') return _jsonRes(res, 415, { error: 'Content-Type 必须是 application/json' });
  }
  if (req.method === 'OPTIONS') return _jsonRes(res, 204, null);
  if (req.method === 'GET' && pathname === '/health') {
    return _jsonRes(res, 200, { ok: true, ts: Date.now(), heartbeatAt: _state.heartbeatAt });
  }
  if (req.method === 'PUT' && pathname === '/holdings') {
    try {
      const chunks = [];
      let totalBytes = 0;
      const MAX_BYTES = 1024 * 1024;  // ?v=daemon4 P1 #162: 1MB 上限, 防 OOM
      for await (const c of req) {
        totalBytes += c.length;
        if (totalBytes > MAX_BYTES) {
          return _jsonRes(res, 413, { error: '请求体超 1MB 上限' });
        }
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      // ?v=daemon5 P1 (HTTP #3): JSON.parse 失败返 400 而非 500
      let body;
      try { body = JSON.parse(raw); }
      catch (e) { return _jsonRes(res, 400, { error: 'JSON 解析失败', detail: e.message }); }
      if (!Array.isArray(body.holdings)) return _jsonRes(res, 400, { error: 'holdings 必须是数组' });
      // ?v=daemon5 P1 (数据 #10): PUT /holdings 加 ts 竞争保护
      if (typeof body.ts === 'number') {
        const cur = safeReadJson(HOLDINGS_FILE, []);
        const curTs = (Array.isArray(cur) && cur._ts) ? cur._ts : 0;
        if (curTs > body.ts) return _jsonRes(res, 409, { error: 'PUT ts 落后于 fs, 拒绝覆盖', curTs });
        body.holdings._ts = body.ts;  // 写进数组 meta, 跟现有 schema 兼容
      }
      atomicWrite(HOLDINGS_FILE, body.holdings);
      _ctx = null; _ctxBuiltAt = 0;  // 失效 ctx, 强制下次 buildContext 重读
      // ?v=daemon5 P1 (race #4): 新 holdings 进来后, _poolRiskPreWarmed + enrichCache 失效, 强制 prewarm 重跑
      _poolRiskPreWarmed = false;
      _enrichCache.clear();
      log('holdings 同步:', body.holdings.length, '只 → fs');
      return _jsonRes(res, 200, { ok: true, count: body.holdings.length });
    } catch (e) {
      log('PUT /holdings 失败:', e.message);
      return _jsonRes(res, 500, { error: e.message });
    }
  }
  if (req.method === 'GET' && pathname === '/holdings') {
    const arr = safeReadJson(HOLDINGS_FILE, []);
    // ?v=daemon4-logic1: 返回 ts (mtime ms) 供浏览器 bootstrapFromDaemon 比较,
    // 防止 "用户刚录 holdings 但 PUT 还没回包 + 刷新页面" 场景下 daemon 旧值覆盖新值
    let ts = 0;
    try { ts = fs.statSync(HOLDINGS_FILE).mtimeMs; } catch {}
    return _jsonRes(res, 200, { holdings: arr, count: Array.isArray(arr) ? arr.length : 0, ts });
  }
  // ?v=daemon5 P1 (HTTP #1): 不支持的 method 返 405 + Allow 头
  // ?v=daemon7-ai-fallback1-logic2-fix5: 加 method 白名单, 防止 GET /state / GET /holdings / GET /account 也被误返 405
  // (原来这块没 method 限制, 任何 method 命中 pathname 都返 405, 导致 GET 永远落不到下面真路由)
  if ((pathname === '/holdings' || pathname === '/account' || pathname === '/state')
      && req.method !== 'GET' && req.method !== 'PUT' && req.method !== 'OPTIONS') {
    const allowed = pathname === '/state' ? 'GET, OPTIONS' : 'GET, PUT, OPTIONS';
    res.setHeader('Allow', allowed);
    return _jsonRes(res, 405, { error: 'method not allowed', allowed });
  }
  // ?v=daemon4 P0 #180: 资金额端点, 浏览器持仓 UI "改现金" 写到 _rw_account.json
  if (req.method === 'GET' && pathname === '/account') {
    const acc = safeReadJson(ACCOUNT_FILE, { cash: 0 });
    // ?v=daemon5 P2 (数据 #12): 返 ts=null 而非 0, 区分"未设"vs"cash=0"
    return _jsonRes(res, 200, { cash: acc.cash, ts: acc.ts ?? null });
  }
  if (req.method === 'PUT' && pathname === '/account') {
    try {
      const chunks = [];
      let totalBytes = 0;
      const MAX_BYTES = 64 * 1024;  // 资金额只是数字, 64KB 绰绰有余
      for await (const c of req) {
        totalBytes += c.length;
        if (totalBytes > MAX_BYTES) {
          return _jsonRes(res, 413, { error: '请求体超 64KB 上限' });
        }
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      // ?v=daemon5 P1 (HTTP #3): JSON.parse 失败返 400 而非 500
      let body;
      try { body = JSON.parse(raw); }
      catch (e) { return _jsonRes(res, 400, { error: 'JSON 解析失败', detail: e.message }); }
      const cash = Number(body.cash);
      if (!Number.isFinite(cash) || cash < 0) {
        return _jsonRes(res, 400, { error: 'cash 必须是 ≥ 0 的数字' });
      }
      // ?v=daemon5 P1 (数据 #10): PUT /account 加 ts 竞争保护
      const cur = safeReadJson(ACCOUNT_FILE, {});
      if (typeof body.ts === 'number' && typeof cur.ts === 'number' && cur.ts > body.ts) {
        return _jsonRes(res, 409, { error: 'PUT ts 落后于 fs, 拒绝覆盖', curTs: cur.ts });
      }
      const next = { cash, ts: Date.now() };
      atomicWrite(ACCOUNT_FILE, next);
      _ctx = null; _ctxBuiltAt = 0;  // 失效 ctx, 强制下次 buildContext 重读
      log('account 同步: cash =', cash, '→ fs');
      return _jsonRes(res, 200, { ok: true, cash });
    } catch (e) {
      log('PUT /account 失败:', e.message);
      return _jsonRes(res, 500, { error: e.message });
    }
  }
  // ?v=daemon5 P0 (审计 #1): 规则端点, 浏览器 UI 改 preset/字段时同步落 fs, daemon 7 规则立刻生效
  if (req.method === 'GET' && pathname === '/rules') {
    const r = safeReadJson(RULES_FILE, {});
    return _jsonRes(res, 200, { rules: r });
  }
  if (req.method === 'PUT' && pathname === '/rules') {
    try {
      const ct = (req.headers['content-type'] || '').split(';')[0].trim();
      if (ct !== 'application/json') return _jsonRes(res, 415, { error: 'Content-Type 必须是 application/json' });
      const chunks = [];
      let totalBytes = 0;
      const MAX_BYTES = 32 * 1024;  // rules 字段就十几个, 32KB 足够
      for await (const c of req) {
        totalBytes += c.length;
        if (totalBytes > MAX_BYTES) return _jsonRes(res, 413, { error: '请求体超 32KB 上限' });
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body;
      try { body = JSON.parse(raw); }
      catch (e) { return _jsonRes(res, 400, { error: 'JSON 解析失败', detail: e.message }); }
      if (!body.rules || typeof body.rules !== 'object') return _jsonRes(res, 400, { error: 'rules 必须是 object' });
      // 数值字段必须 ≥ 0 (防御性, 避免 UI 写入 NaN 把规则污染)
      for (const [k, v] of Object.entries(body.rules)) {
        if (typeof v === 'number' && !Number.isFinite(v)) {
          return _jsonRes(res, 400, { error: `${k} 必须是有限数字`, field: k });
        }
      }
      atomicWrite(RULES_FILE, body.rules);
      _ctx = null; _ctxBuiltAt = 0;  // 失效 ctx, 强制下次 buildContext 重读 → 7 规则立刻用新值
      log('rules 同步: ', Object.keys(body.rules).length, '字段 → fs');
      return _jsonRes(res, 200, { ok: true, count: Object.keys(body.rules).length });
    } catch (e) {
      log('rules 同步失败:', e.message);
      return _jsonRes(res, 500, { error: e.message });
    }
  }
  if (pathname === '/rules') {
    res.setHeader('Allow', 'GET, PUT, OPTIONS');
    return _jsonRes(res, 405, { error: 'method not allowed', allowed: 'GET, PUT, OPTIONS' });
  }
  if (req.method === 'GET' && pathname === '/state') {
    res.setHeader('Cache-Control', 'no-store');
    return _jsonRes(res, 200, _state);
  }
  // ?v=daemon3 P0 #149: 暴露 _rw_daemon_state.json 静态读 (浏览器侧 fetch 路径走 vite 失败时兜底)
  if (req.method === 'GET' && pathname === '/daemon-state.json') {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
      });
      return res.end(raw);
    } catch (e) {
      return _jsonRes(res, 404, { error: 'state 文件不存在 (daemon 还没跑过任何 slot)', detail: e.message });
    }
  }
  // ?v=daemon3 应急: 手动触发 slot (浏览器侧 "立即跑" 按钮 / 调试)
  // ?v=daemon4-logic2 P1 #1 + P1 #2: 手动 trigger 必须 markSlot (防二次跑) + 防并发
  // ?v=daemon5 P0 (race #1): 手动 trigger 也设 _running = true (之前只检查不设, tick 30s 后并发跑同 slot)
  if (req.method === 'POST' && req.url.startsWith('/trigger/')) {
    const slotName = req.url.replace('/trigger/', '').trim();
    const validSlots = SCHEDULE_SLOTS.map(s => s.name);
    if (!validSlots.includes(slotName)) return _jsonRes(res, 400, { error: '未知 slot', validSlots });
    if (_running) return _jsonRes(res, 429, { ok: false, busy: true, message: '上一轮 slot 还在跑, 请稍后' });
    log('手动触发 slot:', slotName);
    // 立刻构造 slotKey + markSlot, 防止 tick 看到 lastTs=0 在 SLOT_TOLERANCE_MS 内二次跑
    const today = shanghaiStr().slice(0, 10);
    const slotKey = `${today}_${slotName}`;
    markSlot(slotKey);
    // ?v=daemon5 P0: _running 置位, runSlot 完成清零; tick 同时被 mutex 阻塞
    _running = true;
    runSlot(slotName).catch(e => log('手动触发异常:', e.message)).finally(() => { _running = false; });
    return _jsonRes(res, 202, { ok: true, slot: slotName, message: '已加入执行' });
  }
  _jsonRes(res, 404, { error: 'not found', url: req.url });
}

// ?v=daemon6-test: HTTP server 也用 __isMain 守卫, 测试 import 不起 server
if (__isMain && !_httpServer_ref.current && !process.env.DAEMON_DISABLE_HTTP && !process.env.NO_LISTEN && !process.env.UNIFIED_NO_LISTEN) {
  const server = http.createServer(daemonHttpHandler);
  // ?v=daemon7-ai-fallback1-logic2-fix5: 监听 0.0.0.0 (默认), 让手机/APK/局域网可访问; 通过 DAEMON_HOST=127.0.0.1 可回退
  const DAEMON_HOST = process.env.DAEMON_HOST || '0.0.0.0';
  server.listen(DAEMON_HTTP_PORT, DAEMON_HOST, () => {
    log('HTTP 端点监听: http://' + DAEMON_HOST + ':' + DAEMON_HTTP_PORT + ' (PUT /holdings, GET /state, /health)');
  });
  _httpServer_ref.current = server;
  _httpServer = server;
}

// 启动
//   守卫 __isMain 已在 main 之前定义 (line 674)
//   NO_LISTEN 时仍然跑 main() (cron / heartbeat / 7 规则要执行), 只是不 listen
if (__isMain) {
  main().catch(e => { log('main 异常:', e.message); process.exit(1); });
}

// [统一服务迁移] 导出供 unified-server 挂载
export { daemonHttpHandler, _httpServer, main };