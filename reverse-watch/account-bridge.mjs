// ============== reverse-watch/account-bridge.mjs ==============
// 浏览器 ↔ daemon 资金额桥接层 (P0 #180)
// 浏览器: localStorage `_rw_account` 缓存 + HTTP PUT /account 推 fs
// daemon (Node): fs 读 `_rw_account.json` → 用于 7 规则 cash / total / stockPct
//
// 数据契约:
//   { cash: number >= 0, ts: number }
// 总资金 = cash + 持仓市值 (持仓由 daemon 端 holdings.json 算, 浏览器不存)
//
// 用法:
//   import { loadAccount, saveAccount } from './account-bridge.mjs'
//   saveAccount({ cash: 52600 })  // 自动落 localStorage + 推 daemon fs
//   loadAccount() -> { cash: 52600, ts: ... } | null

const ACCOUNT_KEY = '_rw_account';
const ACCOUNT_VERSION_KEY = '_rw_account_version';
// 复用 holdings-bridge 的 URL 风格 (:8090/account)
const DEFAULT_SYNC_URL = (typeof window !== 'undefined')
  ? `${window.location.protocol}//${window.location.hostname}:8090/account`
  : '';
const ACCSYNC_URL = (typeof window !== 'undefined' && window.__ACCOUNT_SYNC_URL__) || DEFAULT_SYNC_URL;

function _safeRead() {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj?.cash !== 'number' || !Number.isFinite(obj.cash) || obj.cash < 0) return null;
    return obj;
  } catch (e) {
    console.warn('[account-bridge] 读本地失败:', e.message);
    return null;
  }
}

export function loadAccount() {
  return _safeRead();
}

export function saveAccount({ cash }) {
  const n = Number(cash);
  if (!Number.isFinite(n) || n < 0) {
    console.warn('[account-bridge] saveAccount 拒绝: cash 必须 ≥ 0 数字, 收到', cash);
    return false;
  }
  const obj = { cash: n, ts: Date.now() };
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(obj));
    localStorage.setItem(ACCOUNT_VERSION_KEY, String(obj.ts));
  } catch (e) {
    console.warn('[account-bridge] 写本地失败:', e.message);
    return false;
  }
  // ?v=daemon5 P0 (race #3): 写完派 CustomEvent, 同 tab 内 AI 管家 / AutoTuner / KPI 能感知
  document.dispatchEvent(new CustomEvent('rw:account-changed', { detail: { cash: obj.cash, ts: obj.ts } }));
  syncAccountToFs(obj).catch(e => console.warn('[account-bridge] 后台同步 daemon fs 失败:', e.message));
  return true;
}

// 启动时拉 daemon fs 兜底 (跟 holdings-bridge 一样: daemon 优先, 浏览器 localStorage 兜底)
// ?v=daemon4-logic1: 用 ts 比较, 只在 daemon 的 ts 较新时覆盖本地
// 防止 "用户刚改 cash 但 PUT 还没回包 + 刷新页面" 场景下 daemon 旧值覆盖新值
export async function bootstrapFromDaemon() {
  if (!ACCSYNC_URL) return false;
  try {
    const r = await fetch(ACCSYNC_URL, { method: 'GET', cache: 'no-store' });
    if (!r.ok) return false;
    const body = await r.json();
    if (typeof body.cash !== 'number' || !Number.isFinite(body.cash) || body.cash < 0) return false;
    const local = _safeRead();
    // 本地有值且 ts 更晚 → 不覆盖 (用户刚改完, daemon 还没收到)
    if (local && local.ts > (body.ts || 0)) return false;
    // ?v=daemon4-logic2: 区分 "未初始化" vs "cash=0"
    // daemon 文件不存在时 safeReadJson fallback {cash:0} → body.ts=0 → 不能写入 {cash:0, ts:Date.now()}
    // 那样会吞掉 "未设定" 语义, 新用户首访看到 "¥0" 而不是 "未设定"
    if (!body.ts || body.ts <= 0) return false;
    // daemon 有效值 → 覆盖本地
    try {
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ cash: body.cash, ts: body.ts }));
      localStorage.setItem(ACCOUNT_VERSION_KEY, String(body.ts));
    } catch (e) {
      console.warn('[account-bridge] daemon fs 同步本地失败:', e.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[account-bridge] daemon 拉取失败:', e.message);
    return false;
  }
}

// 同步 cash 到 daemon fs (_rw_account.json)
export async function syncAccountToFs(obj) {
  if (!ACCSYNC_URL) return false;
  try {
    const r = await fetch(ACCSYNC_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cash: obj.cash, ts: obj.ts })
    });
    return r.ok;
  } catch (e) {
    console.warn('[account-bridge] 同步 fs 失败:', e.message);
    return false;
  }
}
