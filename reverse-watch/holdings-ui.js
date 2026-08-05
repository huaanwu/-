// ============== reverse-watch/holdings-ui.js · F4.9 持仓管理 UI ==============
// ?v=daemon3 P0 #150: 极简手动录入, 联动 holdings-bridge 同步到 daemon fs
// ?v=daemon4 P0 #180: 顶部加"可用现金"行 + 编辑按钮 (cash 模型, 总资金 = cash + 持仓市值)
//
// 用法:
//   import { mountHoldingsPanel } from './holdings-ui.js'
//   mountHoldingsPanel()  // 渲染 + 挂载事件
//
// 字段优先级:
//   1. users 输入 (code/shares/price) → 必填
//   2. daemon 端字段 (chg5/belowMA20/sectorStrength/fishTail5d) → daemon 自己从 akshare 拉
//   3. 浏览器侧缺这些字段不会阻塞, daemon 7 规则会跳过该票

import { loadHoldings, saveHoldings, addHolding, removeHolding, seedMockHoldings, bootstrapFromDaemon as bootstrapHoldingsFromDaemon } from './holdings-bridge.mjs';
import { loadAccount, saveAccount, bootstrapFromDaemon as bootstrapAccountFromDaemon } from './account-bridge.mjs';

function _q(sel) { return document.querySelector(sel); }

// 解析 code 输入: 6 位数字 / 5+1 港股 / sh600519 → 600519
function _parseCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim().toLowerCase().replace(/[\s,]/g, '');
  if (/^\d{6}$/.test(raw.trim())) return raw.trim();
  if (/^sh\d{6}$/.test(s)) return s.slice(2);
  if (/^sz\d{6}$/.test(s)) return s.slice(2);
  return raw.trim();
}

// 解析 code → 前缀 (sh/sz)
function _codePrefix(code) {
  return /^(6|9|5)/.test(code) ? 'sh' : 'sz';
}

// 拉单股实时 + K线 (复用 app.js fetchKLine 同样的 :3021 端点)
async function _fetchHoldingQuote(code) {
  const url = `http://127.0.0.1:3021/kline?code=${code}&count=30`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = await resp.json();
  if (raw.code !== 0) throw new Error(`Tencent code=${raw.code}`);
  const prefix = _codePrefix(code);
  const data = raw.data[`${prefix}${code}`];
  const qtArr = raw.data.qt?.[`${prefix}${code}`] || [];
  // qt 字段下标: [0]未知 [1]名称 [2]code [3]现价 [4]昨收 [5]今开 [6]成交量(手) [7]外盘 [8]内盘
  //                  [9]买一价 [10]买一量 [11]买二价 [12]买二量 ... [30]涨跌幅 [31]涨跌额 [32]最高 [33]最低
  const name = qtArr[1] || code;
  const price = parseFloat(qtArr[3]);
  const prevClose = parseFloat(qtArr[4]);
  const chgPct = parseFloat(qtArr[30]);
  const chgAmt = parseFloat(qtArr[31]);
  const high = parseFloat(qtArr[32]);
  const low = parseFloat(qtArr[33]);
  const arr = data?.qfqday || data?.day || [];
  const kline = arr.map(r => ({
    date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4]
  })).filter(r => r.date && r.close > 0);
  return { name, price, prevClose, chgPct, chgAmt, high, low, kline };
}

// 迷你 K 线 SVG (60x20, 30 天走势) — 用 DOM 创建 API 避免 innerHTML XSS
function _renderMiniKLineSvg(rows) {
  if (!rows || rows.length < 2) return null;
  const W = 60, H = 20, PAD = 1;
  const closes = rows.map(r => r.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const stepX = (W - 2 * PAD) / (rows.length - 1);
  const yOf = (v) => H - PAD - ((v - min) / range) * (H - 2 * PAD);
  let d = '';
  for (let i = 0; i < rows.length; i++) {
    const x = PAD + i * stepX;
    const y = yOf(rows[i].close);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
  }
  const last = rows[rows.length - 1].close;
  const first = rows[0].close;
  const color = last >= first ? '#dc2626' : '#16a34a';  // A 股红涨绿跌
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.verticalAlign = 'middle';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '1.2');
  svg.appendChild(path);
  return svg;
}

// 格式化价格
function _fmtPrice(p) {
  if (typeof p !== 'number' || isNaN(p) || p <= 0) return '—';
  return p.toFixed(2);
}

// 单只持股的数据加载 + 行渲染
// ?v=daemon4-logic2 P0 #24 (b): myGen + row.isConnected 防御
// 场景: 用户连点 _renderList() 多次, 旧 _renderRow 内 await _fetchHoldingQuote 完成后, 该 row 已被新 _renderList replaceChildren 卸掉
// 不防御会: 旧 row.appendChild() → 节点已被 GC → "Cannot read properties of null" + 内存泄漏
async function _renderRow(h, row, myGen) {
  let q = null;
  try {
    q = await _fetchHoldingQuote(h.code);
  } catch (e) {
    console.warn('[holdings-ui] 拉实时数据失败:', h.code, e.message);
  }

  // ?v=daemon4-logic2 P0 #24 (b): await 完成后, 检查 row 还在不在 DOM + generation 一致
  if (!row.isConnected || myGen !== _renderGen) return;

  // 用拉到的真名覆盖 + 缓存实时价 (供 _renderCashBar 汇总用, ?v=daemon4-logic2)
  if (q?.name) h._displayName = q.name;
  if (q && typeof q.price === 'number' && q.price > 0) {
    _quoteCache.set(h.code, { price: q.price, ts: Date.now() });
  }
  // quote 拉完后重算 cash bar (市值已变化) — 但 generation 已变就不必了 (新 _renderList 会自己算)
  // ?v=daemon4-logic2 P1 #26 sub-c: rAF debounce, 10 只持仓连续拉 quote 时不再每只触发一次完整重渲染
  if (q && myGen === _renderGen) _renderCashBarRaf();

  const code = document.createElement('span');
  code.className = 'holdings-code';
  code.textContent = h.code || '?';

  const name = document.createElement('span');
  name.className = 'holdings-name';
  name.textContent = q?.name || h.name || '(待拉)';

  const shares = document.createElement('span');
  shares.className = 'holdings-meta';
  shares.textContent = `${h.shares || 0} 股 × ¥${h.price || 0}`;

  // 现价 + 涨跌幅 (数字 + 硬编码颜色, 无 XSS)
  const price = document.createElement('span');
  price.className = 'holdings-price';
  if (q) {
    price.appendChild(document.createTextNode(_fmtPrice(q.price) + ' '));
    const pct = document.createElement('span');
    if (typeof q.chgPct === 'number' && !isNaN(q.chgPct)) {
      const color = q.chgPct > 0 ? '#dc2626' : q.chgPct < 0 ? '#16a34a' : '#64748b';
      const sign = q.chgPct > 0 ? '+' : '';
      pct.style.color = color;
      pct.style.fontWeight = '600';
      pct.textContent = `${sign}${q.chgPct.toFixed(2)}%`;
    } else {
      pct.className = 'holdings-na';
      pct.textContent = '—';
    }
    price.appendChild(pct);
  } else {
    const na = document.createElement('span');
    na.className = 'holdings-na';
    na.textContent = '—';
    price.appendChild(na);
  }

  // 迷你 K 线 (DOM API 创建, 无 XSS)
  const kline = document.createElement('span');
  kline.className = 'holdings-mini-kline';
  if (q) {
    const svg = _renderMiniKLineSvg(q.kline);
    if (svg) kline.appendChild(svg);
  }

  // 风险标签 (数字 + 硬编码 class, 无 XSS)
  const risk = document.createElement('span');
  risk.className = 'holdings-risk-tags';
  if (q) {
    const tags = [];
    const profit = (q.price - (h.price || 0)) / (h.price || 1);
    if (profit > 0.10) tags.push({ cls: 'profit', text: `+${(profit * 100).toFixed(1)}%` });
    else if (profit < -0.05) tags.push({ cls: 'loss', text: `${(profit * 100).toFixed(1)}%` });
    if (q.chgPct > 5) tags.push({ cls: 'hot', text: `涨${q.chgPct.toFixed(1)}%` });
    else if (q.chgPct < -5) tags.push({ cls: 'dump', text: `跌${Math.abs(q.chgPct).toFixed(1)}%` });
    for (const t of tags) {
      const span = document.createElement('span');
      span.className = `holdings-risk ${t.cls}`;
      span.textContent = t.text;
      risk.appendChild(span);
    }
  }

  // 市值 = 股数 × 现价（或成本价如果实时拉不到）
  const mkt = document.createElement('span');
  mkt.className = 'holdings-meta';
  const mktPrice = q?.price || h.price || 0;
  const mktVal = (h.shares || 0) * mktPrice;
  mkt.textContent = `市值 ${mktVal.toLocaleString('zh-CN')}`;

  // 详情按钮
  const detail = document.createElement('button');
  detail.className = 'holdings-detail';
  detail.textContent = '📊';
  detail.title = `查看 ${h.code} 详情`;
  detail.onclick = (e) => {
    e.stopPropagation();
    if (window.ReverseWatch?.showDetail) {
      // ?v=holdings-detail-fix1: 传 code 字符串, 不是对象 (与 app.js showDetail 签名一致)
      window.ReverseWatch.showDetail(h.code);
    } else {
      _toast('详情 modal 还没加载');
    }
  };

  const del = document.createElement('button');
  del.className = 'holdings-del';
  del.textContent = '×';
  del.title = `删除 ${h.code}`;
  del.onclick = (e) => {
    e.stopPropagation();
    // ?v=daemon4-logic2 P0 #24 (c): 删除 holdings 时清 quote cache, 否则市值会包含已删股的最后价
    _quoteCache.delete(h.code);
    removeHolding(h.code);
    _renderList();
    _toast(`已删除 ${h.code}`);
  };

  row.appendChild(code);
  row.appendChild(name);
  row.appendChild(shares);
  row.appendChild(price);
  row.appendChild(kline);
  row.appendChild(risk);
  row.appendChild(mkt);
  row.appendChild(detail);
  row.appendChild(del);
}

function _renderList() {
  const list = _q('#holdingsList');
  if (!list) return;
  // ?v=daemon4-logic2 P0 #24 (a): generation counter 自增, 让上一轮 _renderRow 写污染失败
  const myGen = ++_renderGen;
  // ?v=daemon4-logic2 P0 #24 (c): 先清过期 quote, 避免 stockMkt 用陈旧价
  _quoteCachePrune();
  const holdings = loadHoldings();
  list.replaceChildren();
  if (holdings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'holdings-empty';
    empty.textContent = '暂无持仓 · 添加后会同步到 daemon fs, 触发 7 规则联动';
    list.appendChild(empty);
    return;
  }
  // 先骨架渲染 (无数据), 再异步补实时数据
  for (const h of holdings) {
    const row = document.createElement('div');
    row.className = 'holdings-row';
    row.dataset.code = h.code;
    list.appendChild(row);
    _renderRow(h, row, myGen);  // 不 await, 并行加载
  }
}

function _toast(msg) {
  if (window.__rwToast) { window.__rwToast(msg); return; }
  // 兜底: 用 alert (但只在用户没接入 toast 时)
  console.log('[holdings]', msg);
}

// ?v=daemon4 P0 #180: 现金摘要计算
// 输入: cash (number), stockMkt (number, 持仓市值)
// 输出: { cash, stockMkt, total, stockPct, cashPct, level }
//   level: 'empty' (未设) | 'healthy' (cash>=5%) | 'low' (cash<5%) | 'over' (cash>95% 几乎全空仓)
function _computeCashSummary(cash, stockMkt) {
  const safeCash = Number.isFinite(cash) && cash >= 0 ? cash : 0;
  const safeStock = Number.isFinite(stockMkt) && stockMkt >= 0 ? stockMkt : 0;
  const total = safeCash + safeStock;
  const stockPct = total > 0 ? safeStock / total : 0;
  const cashPct = total > 0 ? safeCash / total : 0;
  let level = 'healthy';
  if (safeCash === 0 && safeStock === 0) level = 'empty';
  else if (cashPct < 0.05) level = 'low';  // 现金 < 5% 触发 daemon 规则 1 警告
  else if (cashPct > 0.95) level = 'over'; // 几乎空仓
  return { cash: safeCash, stockMkt: safeStock, total, stockPct, cashPct, level };
}

// 顶级格式化 (¥1,234,567)
function _fmtCash(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  return '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

// 渲染顶部 "💰 现金 ¥X · 持仓 ¥Y · 总 ¥Z" 行 + 改按钮
// ?v=daemon4-logic2: 持仓市值用实时价汇总 (用 _renderRow 拉到的 quote price), 不用 h.price 成本价
// 跟 daemon.mjs:294 enrichHolding 市价保持一致, 避免 "UI ¥168k / daemon 7 规则按 ¥170k 跑" 漂移
// 实现: 维护 _quoteCache (code -> price), _renderRow resolve 后写, _renderCashBar 读 + 合并 holdings
// ?v=daemon4-logic2 P0 #24 sub-bug (a) + (b): 顶层模块单例 storage handler + generation counter
// 之前 storage 监听在 mountHoldingsPanel 内, 每次调用都 addEventListener 一遍 → 雪崩
// 改成模块顶层只挂一次 (singleton), 用 _storageInstalled 防重挂
let _storageInstalled = false;
let _renderGen = 0;          // 每次 _renderList 自增, 旧 _renderRow 写污染检查用
let _cashEditing = false;    // ?v=daemon4-logic2 P1 #4: 编辑 cash 时锁住 storage 重渲染
let _bootstrapInFlight = false;  // ?v=daemon4-logic2 P1 #26 sub-b: bootstrap 期间禁止录入
const _quoteCache = new Map();  // code -> {price, ts}
const QUOTE_TTL_MS = 60000;  // ?v=daemon4-logic2 P0 #24 (c): 1 分钟过期, 防 daemon 重启/价格跳变后显示陈旧价格
// ?v=daemon4-logic2 P1 #26 sub-c: rAF debounce cash bar, 防 _renderRow 内 _renderCashBar 多次触发视觉抖动
let _cashBarRaf = null;
function _renderCashBarRaf() {
  if (_cashBarRaf !== null) return;
  _cashBarRaf = requestAnimationFrame(() => {
    _cashBarRaf = null;
    _renderCashBar();
  });
}

function _installStorageHandler() {
  if (_storageInstalled) return;
  _storageInstalled = true;
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith('_rw_')) return;
    if (e.key === '_rw_holdings') {
      if (_cashEditing) return;
      _renderList();
      _renderCashBar();
    } else if (e.key === '_rw_account') {
      if (_cashEditing) {
        _toast('另一标签改了现金, 当前编辑已暂停保存');
        return;
      }
      _renderCashBar();
    }
  });
}

function _quoteCachePrune() {
  // ?v=daemon4-logic2 P0 #24 (c): 清理过期 quote, 避免股票已删除 / 价格长时间陈旧
  const now = Date.now();
  for (const [code, v] of _quoteCache) {
    if (!v || !v.ts || now - v.ts > QUOTE_TTL_MS) _quoteCache.delete(code);
  }
}

function _stockMktFromQuotes(holdings) {
  let total = 0;
  for (const h of holdings) {
    const q = _quoteCache.get(h.code);
    const price = (q && typeof q.price === 'number' && q.price > 0) ? q.price : (h.price || 0);
    total += (h.shares || 0) * price;
  }
  return total;
}

function _renderCashBar() {
  const bar = _q('#holdingsCashBar');
  if (!bar) return;
  const acc = loadAccount();
  const cash = acc?.cash ?? 0;
  const holdings = loadHoldings();
  const stockMkt = _stockMktFromQuotes(holdings);
  const sum = _computeCashSummary(cash, stockMkt);

  bar.replaceChildren();

  // 左侧: 现金 + 持仓 + 总 汇总
  const summary = document.createElement('div');
  summary.className = 'cash-summary';

  const cashEl = document.createElement('div');
  cashEl.className = 'cash-cell cash-main';
  const cashLabel = document.createElement('span');
  cashLabel.className = 'cash-label';
  cashLabel.textContent = '💰 可用现金';
  const cashVal = document.createElement('span');
  cashVal.className = 'cash-val';
  cashVal.textContent = acc ? _fmtCash(sum.cash) : '未设定';
  cashVal.classList.add(`cash-level-${sum.level}`);
  cashEl.appendChild(cashLabel);
  cashEl.appendChild(cashVal);

  const stockEl = document.createElement('div');
  stockEl.className = 'cash-cell';
  stockEl.appendChild(document.createTextNode('持仓 ¥' + (sum.stockMkt || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })));

  const totalEl = document.createElement('div');
  totalEl.className = 'cash-cell';
  totalEl.appendChild(document.createTextNode('总 ¥' + (sum.total || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })));

  const pctEl = document.createElement('div');
  pctEl.className = 'cash-cell';
  pctEl.appendChild(document.createTextNode('仓位 ' + (sum.stockPct * 100).toFixed(0) + '%'));

  summary.appendChild(cashEl);
  summary.appendChild(stockEl);
  summary.appendChild(totalEl);
  summary.appendChild(pctEl);
  bar.appendChild(summary);

  // 右侧: 改按钮
  const editBtn = document.createElement('button');
  editBtn.className = 'cash-edit-btn';
  editBtn.id = 'holdingsCashEditBtn';
  editBtn.textContent = acc ? '✏️ 改现金' : '➕ 设定现金';
  editBtn.onclick = () => _openCashEditor(cash);
  bar.appendChild(editBtn);
}

function _openCashEditor(currentCash) {
  // 复用 buyDialog 风格的内联编辑 (inline prompt, 不另开 modal)
  const bar = _q('#holdingsCashBar');
  if (!bar) return;
  _cashEditing = true;  // ?v=daemon4-logic2 P1 #4: 锁住 storage 事件重渲染
  bar.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'cash-editor';

  const lbl = document.createElement('label');
  lbl.textContent = '可用现金 (¥)';
  lbl.className = 'cash-editor-label';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '1000';
  input.value = String(currentCash ?? '');
  input.placeholder = '例: 100000';
  input.className = 'cash-editor-input';
  input.id = 'holdingsCashInput';

  const okBtn = document.createElement('button');
  okBtn.textContent = '💾 保存';
  okBtn.className = 'btn-primary';
  okBtn.onclick = () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v) || v < 0) {
      _toast('现金必须 ≥ 0');
      return;
    }
    saveAccount({ cash: v });
    _cashEditing = false;
    _toast(`已保存现金 ¥${v.toLocaleString('zh-CN')}`);
    _renderCashBar();
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.className = 'btn-secondary';
  cancelBtn.onclick = () => { _cashEditing = false; _renderCashBar(); };

  const delBtn = document.createElement('button');
  delBtn.textContent = '🗑️ 清零';
  delBtn.className = 'btn-secondary holdings-clear-cash';
  delBtn.title = '清零现金 (持仓市值仍在, 总资金 = 持仓市值)';
  delBtn.onclick = () => {
    saveAccount({ cash: 0 });
    _cashEditing = false;
    _toast('已清零现金');
    _renderCashBar();
  };

  wrap.appendChild(lbl);
  wrap.appendChild(input);
  wrap.appendChild(okBtn);
  wrap.appendChild(cancelBtn);
  wrap.appendChild(delBtn);
  bar.appendChild(wrap);
  // 自动 focus
  setTimeout(() => input.focus(), 50);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') okBtn.click();
    else if (e.key === 'Escape') { _cashEditing = false; _renderCashBar(); }
  };
}

function _addFromInputs() {
  // ?v=daemon4-logic2 P1 #26 sub-b: bootstrap 期间禁止录入 (浏览器打开页面 ~200ms 内 holdings-bridge 拉 daemon fs)
  // 场景: 用户打开页面立刻敲 600519 → addHolding → 50ms 后 bootstrap 拉 daemon 覆盖本地 → 用户输入丢失
  if (_bootstrapInFlight) {
    _toast('正在从 daemon 同步, 录入已暂存, 等同步完成再添加');
    return;
  }
  const codeRaw = _q('#holdingsCodeInput').value;
  const shares = parseInt(_q('#holdingsSharesInput').value, 10);
  const price = parseFloat(_q('#holdingsPriceInput').value);
  const code = _parseCode(codeRaw);
  if (!code || !/^\d{6}$/.test(code)) {
    _toast('代码格式错 (需 6 位数字, 如 600519)');
    return;
  }
  if (!shares || shares < 100) {
    _toast('股数必须 ≥ 100 (1 手)');
    return;
  }
  if (!price || price <= 0) {
    _toast('成本价必须 > 0');
    return;
  }
  const ok = addHolding({
    code,
    name: code,  // 客户端先显示 code, daemon 端会从 akshare 拉真名 (或者用代码前缀粗略映射)
    shares,
    price,
    cost: price,
    // daemon 字段先空, daemon 端 context-builder / runRule7 自行从 akshare 拉
    chg5: null,
    belowMA20: null,
    sectorStrength: null,
    fishTail5d: null,
    sector: ''
  });
  if (ok) {
    _q('#holdingsCodeInput').value = '';
    _q('#holdingsSharesInput').value = '';
    _q('#holdingsPriceInput').value = '';
    _renderList();
    _toast(`已添加 ${code} (${shares} 股 × ¥${price})`);
  } else {
    _toast('添加失败');
  }
}

function _seedMock() {
  const mock = seedMockHoldings();
  _renderList();
  _toast(`已写入 ${mock.length} 只 mock holdings → daemon fs`);
}

export function mountHoldingsPanel() {
  // ?v=daemon4-logic2 P0 #24 (a): 装 storage handler 单例 (移到顶层, mount 只触发不挂)
  _installStorageHandler();
  // ?v=daemon4 P0 #180: 先从 daemon fs 拉 cash 兜底 (daemon 优先, 浏览器 localStorage 兜底)
  // ?v=daemon4-logic2 P1 #3: 同步拉 holdings (跨设备同步), 之前只 bootstrap cash 漏了 holdings
  // ?v=daemon4-logic2 P1 #26 sub-b: bootstrap 期间 _bootstrapInFlight=true, 禁止用户录入, 防被覆盖
  _bootstrapInFlight = true;
  Promise.all([bootstrapAccountFromDaemon(), bootstrapHoldingsFromDaemon()])
    .finally(() => {
      _bootstrapInFlight = false;
      _renderList();
      _renderCashBar();
    });
  // 渲染初始列表 (乐观渲染, bootstrap 完成后再渲染一次确保 fs 覆盖本地)
  _renderList();
  // 挂事件
  const addBtn = _q('#holdingsAddBtn');
  if (addBtn) addBtn.onclick = _addFromInputs;
  const seedBtn = _q('#holdingsSeedBtn');
  if (seedBtn) seedBtn.onclick = _seedMock;
  // 输入框回车提交
  for (const id of ['holdingsCodeInput', 'holdingsSharesInput', 'holdingsPriceInput']) {
    const el = _q('#' + id);
    if (el) el.onkeydown = (e) => { if (e.key === 'Enter') _addFromInputs(); };
  }
}

export function refreshHoldingsPanel() { _renderList(); _renderCashBar(); }