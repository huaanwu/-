// ============== reverse-watch/holdings-bridge.mjs ==============
// 浏览器 ↔ daemon holdings 桥接层
// 浏览器: localStorage `_rw_holdings` 序列化为 JSON 字符串
// daemon (Node): fs.readFile `_rw_holdings.json`
//
// holdings schema (字段全 optional, daemon 兜底):
//   { code, name, shares, price, cost,
//     chg5, belowMA20, sectorStrength, fishTail5d, sector }
// `chg5 / belowMA20 / sectorStrength / fishTail5d` 是 daemon 加仓/止损规则依赖
//
// 用法:
//   import { syncHoldings, loadHoldings, saveHoldings } from './holdings-bridge.mjs'
//   saveHoldings(holdingsArr)
//   loadHoldings() -> [{...}, ...]
//   syncHoldings() -> 写 fs (开发环境走 :8089 的 PUT 接口, 生产走 indexedDB 同步队列)

const HOLDINGS_KEY = '_rw_holdings';
const HOLDINGS_VERSION_KEY = '_rw_holdings_version';
// ?v=daemon2: 默认指向 daemon HTTP :8090
// 浏览器侧可通过 window.__HOLDINGS_SYNC_URL__ 覆盖
const DEFAULT_SYNC_URL = (typeof window !== 'undefined')
  ? `${window.location.protocol}//${window.location.hostname}:8090/holdings`
  : '';
const HOLDSYNC_URL = (typeof window !== 'undefined' && window.__HOLDINGS_SYNC_URL__) || DEFAULT_SYNC_URL;

// 启动时拉 daemon fs 兜底 (避免 daemon 比浏览器先启动时读不到 holdings)
// ?v=daemon4-logic1: 用 ts 比较, 只在 daemon 的 ts 较新时覆盖本地
// 防止 "用户刚录 holdings 但 PUT 还没回包 + 刷新页面" 场景下 daemon 旧值覆盖新值
// (跟 account-bridge.bootstrapFromDaemon 同 pattern, 保证两个 bridge 行为一致)
export async function bootstrapFromDaemon() {
  if (!HOLDSYNC_URL) return false;
  try {
    const base = HOLDSYNC_URL.replace(/\/holdings$/, '');
    const r = await fetch(`${base}/holdings`, { method: 'GET', cache: 'no-store' });
    if (!r.ok) return false;
    const body = await r.json();
    if (Array.isArray(body.holdings)) {
      // 本地 ts 较新 → 不覆盖 (用户刚改完, daemon 还没收到)
      const localTs = parseInt(localStorage.getItem(HOLDINGS_VERSION_KEY) || '0', 10);
      if (localTs > (body.ts || 0)) return false;
      try {
        localStorage.setItem(HOLDINGS_KEY, JSON.stringify(body.holdings));
        localStorage.setItem(HOLDINGS_VERSION_KEY, String(body.ts || Date.now()));
      } catch (e) {
        console.warn('[holdings-bridge] daemon fs 同步本地失败:', e.message);
        return false;
      }
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[holdings-bridge] daemon 拉取失败:', e.message);
    return false;
  }
}

function _safeRead() {
  try {
    const raw = localStorage.getItem(HOLDINGS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[holdings-bridge] 读本地失败:', e.message);
    return [];
  }
}

export function loadHoldings() {
  return _safeRead();
}

export function saveHoldings(holdings) {
  const arr = Array.isArray(holdings) ? holdings : [];
  try {
    localStorage.setItem(HOLDINGS_KEY, JSON.stringify(arr));
    localStorage.setItem(HOLDINGS_VERSION_KEY, String(Date.now()));
  } catch (e) {
    console.warn('[holdings-bridge] 写本地失败:', e.message);
    return false;
  }
  // ?v=daemon5 P0 (race #3): 写完派 CustomEvent, 同 tab 内 AI 管家 / AutoTuner / 候选池也能感知
  document.dispatchEvent(new CustomEvent('rw:holdings-changed', { detail: { count: arr.length, ts: Date.now() } }));
  // 后台异步推 fs (给 daemon 读), 失败不阻塞
  syncHoldingsToFs(arr).catch(e => console.warn('[holdings-bridge] 后台同步 daemon fs 失败:', e.message))  // ?v=daemon4 P1 #161: 不再吞;
  return true;
}

export function addHolding(holding) {
  if (!holding || !holding.code) return false;
  const arr = _safeRead();
  const idx = arr.findIndex(h => h.code === holding.code);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...holding };
  else arr.push(holding);
  return saveHoldings(arr);
}

export function removeHolding(code) {
  const arr = _safeRead().filter(h => h.code !== code);
  return saveHoldings(arr);
}

// 同步 holdings 到 daemon fs (_rw_holdings.json)
// 开发模式: 通过 dev-proxy :8089 暴露的 PUT /_rw/holdings 写入 fs
// 生产/无代理: 仅写 localStorage, daemon 不会读到 (设计取舍: 不阻塞 UI)
export async function syncHoldingsToFs(arr) {
  if (!HOLDSYNC_URL) return false;
  try {
    const r = await fetch(HOLDSYNC_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdings: arr, ts: Date.now() })
    });
    return r.ok;
  } catch (e) {
    console.warn('[holdings-bridge] 同步 fs 失败:', e.message);
    return false;
  }
}

// 兜底: 浏览器 + daemon 都缺数据时, 给定一组 mock holdings (纸面交易 / 用户手动录入占位)
export function seedMockHoldings() {
  const mock = [
    { code: '600519', name: '贵州茅台', shares: 100, price: 1680, cost: 1500,
      chg5: 0.06, belowMA20: false, sectorStrength: 0.72, fishTail5d: 0.04, sector: '白酒' },
    { code: '300750', name: '宁德时代', shares: 200, price: 220, cost: 240,
      chg5: -0.03, belowMA20: true, sectorStrength: 0.45, fishTail5d: 0.18, sector: '新能源' },
    { code: '000858', name: '五粮液', shares: 300, price: 158, cost: 165,
      chg5: 0.08, belowMA20: false, sectorStrength: 0.68, fishTail5d: 0.06, sector: '白酒' }
  ];
  saveHoldings(mock);
  return mock;
}