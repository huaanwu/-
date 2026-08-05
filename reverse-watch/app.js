/**
 * Reverse Watch — 独立 SPA
 * 不依赖 stock-master 任何文件, 双击 index.html 即可运行
 *
 * 数据源优先级:
 *   1. window.parent.Core (iframe 嵌入 stock-master 时)
 *   2. 内置 mock 数据 (开发/离线/截图)
 *   3. fetch aktools proxy (生产环境, 默认 http://127.0.0.1:8089)
 *
 * 5 大功能区:
 *   F1 KPI 5 徽章
 *   F2 4 闸状态灯
 *   F3 5 只 AI 推荐
 *   F4 4 池快照
 *   F5 隐藏信息 (trap 倒计时 + 通过率)
 *
 * F6 自选下单 (modal 对话框, 5 步 form + 4 闸兜底)
 */

'use strict';

// ============== 配置 ==============
// ?v=daemon7-ai-fallback1-logic2-fix5: 改 let, 设置页改了 proxyBase 后 saveSettings 要同步 (否则存了但全局仍是旧值)
let PROXY_BASE = 'http://127.0.0.1:8089';   // akshare dev-proxy
const AKTOOLS_BASE = 'http://127.0.0.1:8088';  // aktools 直连(可选)
let DATA_MODE = 'auto';                       // auto | mock | real (改为 let 以支持运行时切换)
const PROXY_TIMEOUT_MS = 8000;

// ============== 设置 (数据源 + 4 闸阈值) ==============
// localStorage 键: _rw_settings, JSON { dataMode, proxyBase, gates: {sectorMin, pbDeltaMin, quantRejectPct, excludeLeaders} }
const SETTINGS_KEY = '_rw_settings';
const DEFAULT_SETTINGS = {
  dataMode: 'auto',
  proxyBase: PROXY_BASE,
  gates: {
    sectorMin: 0.55,       // 板块强度下限 (封板率)
    pbDeltaMin: 15,        // PB 分位差下限 (pp)
    quantRejectPct: 0.5,   // 量化席位拒接概率 (0~1)
    excludeLeaders: true   // 是否过滤板块龙头
  },
  // AI 软评估阈值 — mockResult.confidence 与 aiChiefAnalyst 文本共享同一张表
  // 避免"过 4 闸但 AI 嫌弃差不足"的语义打架
  aiThresholds: {
    pbIdeal: 20,   // ≥ 20pp → 估值修复空间大 (high)
    pbOk:    15,   // ≥ 15pp → 基本满足 (medium)
    // < 15pp → 差不足 (low)
    fishTailWarn: 0.10,  // 5 日涨幅触发警示
    quantWarnPct: 0.60   // 量比触发警示
  }
};
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates }, aiThresholds: { ...DEFAULT_SETTINGS.aiThresholds } };
    const s = JSON.parse(raw);
    return {
      dataMode: s.dataMode || DEFAULT_SETTINGS.dataMode,
      proxyBase: s.proxyBase || DEFAULT_SETTINGS.proxyBase,
      gates: { ...DEFAULT_SETTINGS.gates, ...(s.gates || {}) },
      aiThresholds: { ...DEFAULT_SETTINGS.aiThresholds, ...(s.aiThresholds || {}) }
    };
  } catch (e) { console.warn('[loadSettings] 解析失败:', e.message); return { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates }, aiThresholds: { ...DEFAULT_SETTINGS.aiThresholds } }; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
let SETTINGS = loadSettings();  // 全局可读, reverseScreener 会消费
// 启动时同步到 DATA_MODE / PROXY_BASE
DATA_MODE = SETTINGS.dataMode;
// ?v=daemon7-ai-fallback1-logic2-fix5: 启动时同步 PROXY_BASE (原来漏了, 设置页改了不生效)
if (SETTINGS.proxyBase) PROXY_BASE = SETTINGS.proxyBase;

// ============== DOM 引用 ==============
const $ = (id) => document.getElementById(id);
const metaLine = $('metaLine');
const toastBox = $('toastBox');
const kpiRow = $('kpiRow');
const gatesRow = $('gatesRow');
const recGrid = $('recGrid');
const poolsRow = $('poolsRow');
const funnelBox = $('funnelBox');
const holdingRules = $('holdingRules');
const hiddenBox = $('hiddenBox');
let refreshBtn = $('refreshBtn');
// ?v=daemon7-ai-fallback1-logic2-fix8: index.html 文本字节损坏导致 header-meta 里
// 的 refreshBtn/settingsBtn 被 HTML parser 吞掉 (document.getElementById 返回 null)。
// 这里做兜底注入: 如果原 button 不存在, 程序启动时动态造一个, 否则整个 header
// 没刷新/没设置按钮, 关键功能失效。注入后用 document.getElementById 重取引用。
const headerMeta = document.querySelector('.header-meta');
if (headerMeta) {
  if (!refreshBtn) {
    refreshBtn = document.createElement('button');
    refreshBtn.id = 'refreshBtn';
    refreshBtn.className = 'btn-icon';
    refreshBtn.title = '刷新数据';
    refreshBtn.textContent = '🔄';
    headerMeta.appendChild(refreshBtn);
  }
  if (!$('settingsBtn')) {
    const settingsBtnEl = document.createElement('button');
    settingsBtnEl.id = 'settingsBtn';
    settingsBtnEl.className = 'btn-icon';
    settingsBtnEl.title = '设置';
    settingsBtnEl.textContent = '⚙️';
    headerMeta.appendChild(settingsBtnEl);
  }
}
const buyDialog = $('buyDialog');
const buyDialogBody = $('buyDialogBody');
const buyCancel = $('buyCancel');
const buyConfirm = $('buyConfirm');
const detailDialog = $('detailDialog');
const detailDialogBody = $('detailDialogBody');
const detailClose = $('detailClose');
const detailGoBuy = $('detailGoBuy');

// ============== 工具 ==============

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(msg, type = 'ok') {
  const div = document.createElement('div');
  div.className = 'toast ' + type;
  div.textContent = msg;
  toastBox.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

function fmtRemain(until) {
  const t = typeof until === 'number' ? until : new Date(until).getTime();
  const ms = t - Date.now();
  if (ms <= 0) return '已解锁';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? (h + 'h' + m + 'm') : (m + 'm');
}

function secKey(sector) {
  if (!sector) return 'other';
  if (/银行|证券|保险|金融/.test(sector)) return 'bank';
  if (/酒|白酒|食品|饮料|消费/.test(sector)) return 'liquor';
  if (/车|汽车|新能源车|锂电/.test(sector)) return 'auto';
  if (/科技|半导体|芯片|电子|计算机|软件|通信|互联网/.test(sector)) return 'tech';
  if (/医药|医疗|生物|医美|医院/.test(sector)) return 'medic';
  return 'other';
}

// ============== Tencent K 线 fetcher ==============
// 直连 web.ifzq.gtimg.cn, 前复权日线, 不依赖 aktools/akshare
// 2 小时 localStorage 缓存, 解析 → {rows: [{date,o,c,h,l,v}]}
function codePrefix(code) {
  return /^(6|5|9)/.test(code) ? 'sh' : 'sz';
}

const KL_CACHE_PREFIX = '_rw_kl_';
const KL_CACHE_TTL = 2 * 60 * 60 * 1000;

async function fetchKLine(code, count = 320) {
  const cacheKey = KL_CACHE_PREFIX + code;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      if (Date.now() - c.ts < KL_CACHE_TTL && c.rows?.length) {
        return { rows: c.rows, cached: true };
      }
    } catch (e) {
      console.warn('[fetchKLine] 缓存 JSON 损坏, 忽略:', e.message);
    }
  }
  const prefix = codePrefix(code);
  // 浏览器直连会被 Tencent CORS 挡, 走本地 :3021 代理
  const url = `http://127.0.0.1:3021/kline?code=${code}&count=${count}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error('Tencent HTTP ' + resp.status);
  const raw = await resp.json();
  if (raw.code !== 0) throw new Error('Tencent code=' + raw.code);
  const data = raw.data[`${prefix}${code}`];
  const arr = data?.qfqday || data?.day || [];
  const rows = arr.map(r => ({
    date: r[0],
    open: +r[1], close: +r[2], high: +r[3], low: +r[4], volume: +r[5]
  })).filter(r => r.date && r.close > 0);
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), rows }));
  } catch (e) {
    console.warn('[fetchKLine] 写缓存失败 (localStorage 满?):', e.message);
  }
  return { rows, cached: false };
}

// ============== 技术指标 (纯计算, 不引库) ==============
function calcMA(rows, n) {
  if (rows.length < n) return null;
  let sum = 0;
  for (let i = rows.length - n; i < rows.length; i++) sum += rows[i].close;
  return sum / n;
}

function calcTechs(rows) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || last;
  const ma5 = calcMA(rows, 5);
  const ma10 = calcMA(rows, 10);
  const ma20 = calcMA(rows, 20);
  const ma60 = calcMA(rows, 60);

  // 近 N 日涨跌幅
  const chg5 = rows.length >= 6 ? (last.close / rows[rows.length - 6].close - 1) * 100 : null;
  const chg20 = rows.length >= 21 ? (last.close / rows[rows.length - 21].close - 1) * 100 : null;

  // 波动率 (近 20 日 daily return stdev)
  const rets = [];
  for (let i = rows.length - 20; i < rows.length; i++) {
    if (i < 1) continue;
    rets.push((rows[i].close - rows[i - 1].close) / rows[i - 1].close);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const volDaily = Math.sqrt(variance) * 100;
  const volAnnual = volDaily * Math.sqrt(252);

  // 量比 (今/5 日均量)
  const last5Vol = rows.slice(-6, -1).reduce((a, b) => a + b.volume, 0) / 5;
  const volRatio = last5Vol ? last.volume / last5Vol : null;

  // K 线形态 (今 vs 昨)
  const body = last.close - last.open;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  const range = last.high - last.low || 1;
  const shape =
    upper / range > 0.6 ? '长上影' :
    lower / range > 0.6 ? '长下影' :
    body > 0 && upper < range * 0.2 && lower < range * 0.2 ? '光头光脚阳' :
    body < 0 && upper < range * 0.2 && lower < range * 0.2 ? '光头光脚阴' :
    body > 0 ? '小阳' : '小阴';

  // 趋势
  let trend = '震荡';
  if (ma5 && ma10 && ma20) {
    if (last.close > ma5 && ma5 > ma10 && ma10 > ma20) trend = '多头排列';
    else if (last.close < ma5 && ma5 < ma10 && ma10 < ma20) trend = '空头排列';
    else if (last.close > ma5 && last.close > ma20) trend = '反弹中';
    else if (last.close < ma5 && last.close < ma20) trend = '回调中';
  }

  return {
    last, prev,
    ma5, ma10, ma20, ma60,
    chg5, chg20,
    volDaily, volAnnual,
    volRatio,
    shape,
    trend,
    high20: Math.max(...rows.slice(-20).map(r => r.high)),
    low20: Math.min(...rows.slice(-20).map(r => r.low))
  };
}

// ============== SVG K 线图 (320 根 → 600×240) ==============
function renderKLineSvg(rows, width = 600, height = 240) {
  if (!rows.length) return '<svg width="' + width + '" height="' + height + '"></svg>';
  const pad = { t: 16, r: 50, b: 28, l: 8 };
  const cw = width - pad.l - pad.r;
  const ch = height - pad.t - pad.b;
  const slice = rows.slice(-120);
  const n = slice.length;
  const bw = cw / n;
  const bwInner = Math.max(1, bw * 0.6);
  const minP = Math.min(...slice.map(r => r.low));
  const maxP = Math.max(...slice.map(r => r.high));
  const range = maxP - minP || 1;
  const yOf = p => pad.t + ch - ((p - minP) / range) * ch;
  const xOf = i => pad.l + i * bw + bw / 2;

  // MA5 / MA10 / MA20 (rolling)
  const ma = (n) => slice.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += slice[j].close;
    return s / n;
  });

  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20);

  let candles = '';
  slice.forEach((r, i) => {
    const x = xOf(i);
    const up = r.close >= r.open;
    // 中国市场惯例: 红涨绿跌 (vs 国际惯例绿涨红跌)
    const color = up ? '#ff5252' : '#00e676';
    const yH = yOf(r.high), yL = yOf(r.low);
    const yO = yOf(r.open), yC = yOf(r.close);
    const yTop = Math.min(yO, yC), yBot = Math.max(yO, yC);
    // 影线
    candles += `<line x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" stroke="${color}" stroke-width="1"/>`;
    // 实体
    candles += `<rect x="${x - bwInner / 2}" y="${yTop}" width="${bwInner}" height="${Math.max(1, yBot - yTop)}" fill="${up ? color : color}" stroke="${color}"/>`;
  });

  // MA lines (polyline)
  const maPath = (arr, color) => {
    let pts = '';
    arr.forEach((v, i) => {
      if (v == null) return;
      pts += (pts ? ' L' : 'M') + xOf(i) + ' ' + yOf(v);
    });
    return `<path d="${pts}" fill="none" stroke="${color}" stroke-width="1"/>`;
  };

  // Y 轴刻度
  const ticks = 4;
  let yAxis = '';
  for (let i = 0; i <= ticks; i++) {
    const p = minP + (range * i) / ticks;
    const y = yOf(p);
    yAxis += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-width="0.5"/>`;
    yAxis += `<text x="${width - pad.r + 4}" y="${y + 3}" fill="#6b7785" font-size="10" font-family="monospace">${p.toFixed(2)}</text>`;
  }

  // X 轴日期 (头/中/尾)
  const xLabels = [0, Math.floor(n / 2), n - 1].map(i =>
    `<text x="${xOf(i)}" y="${height - 6}" fill="#6b7785" font-size="10" font-family="monospace" text-anchor="middle">${slice[i].date.slice(5)}</text>`
  ).join('');

  // MA 图例
  const legend = `
    <text x="${pad.l + 4}" y="10" fill="#6b7785" font-size="10">MA5</text>
    <line x1="${pad.l + 28}" x2="${pad.l + 40}" y1="7" y2="7" stroke="#00d9ff" stroke-width="1"/>
    <text x="${pad.l + 46}" y="10" fill="#6b7785" font-size="10">MA10</text>
    <line x1="${pad.l + 76}" x2="${pad.l + 88}" y1="7" y2="7" stroke="#ffa726" stroke-width="1"/>
    <text x="${pad.l + 94}" y="10" fill="#6b7785" font-size="10">MA20</text>
    <line x1="${pad.l + 126}" x2="${pad.l + 138}" y1="7" y2="7" stroke="#ab47bc" stroke-width="1"/>
  `;

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="display:block;background:#0a0e14;border-radius:6px;">
    ${yAxis}
    ${candles}
    ${maPath(ma5, '#00d9ff')}
    ${maPath(ma10, '#ffa726')}
    ${maPath(ma20, '#ab47bc')}
    ${xLabels}
    ${legend}
  </svg>`;
}

// ============== 自学习反馈存储 ==============
const FEEDBACK_KEY = '_rw_feedback';
function loadFeedback() {
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed || {};
  } catch (e) {
    // C3 修: JSON 损坏时主动 removeItem, 避免下次 save 时按 loadFeedback() 拿到旧 {} 静默丢数据
    console.warn('[loadFeedback] JSON 损坏, 已清空:', e.message);
    try { localStorage.removeItem(FEEDBACK_KEY); } catch (e) { console.warn('[loadFeedback] 清理失败:', e.message); }  // ?v=daemon4 P1 #161: 不再吞
    return {};
  }
}
// C1 修: 7d TTL 统一入口, 所有需要"还在有效期内"的读处都走它
// ai-chat buildLearningContext / ai-butler / app.js holdingFbMeta 等, 避免 LLM 看到过期 down 名单
function loadActiveFeedback(now = Date.now()) {
  const fb = loadFeedback();
  const TTL = 7 * 24 * 60 * 60 * 1000;
  const out = {};
  for (const [code, v] of Object.entries(fb)) {
    if (v && v.verdict === 'down' && v.ts && (now - v.ts) < TTL) {
      out[code] = v;
    }
  }
  return out;
}
function saveFeedback(code, verdict, note = '') {
  const all = loadFeedback();
  all[code] = {
    verdict,         // 'up' 采纳 / 'part' 部分 / 'down' 否定
    note,            // 自由备注
    ts: Date.now()
  };
  try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(all)); }
  catch (e) { console.warn('[saveFeedback] 写本地失败:', e.message); }
}

// ============== pbGrade: PB 分位差 → (confidence, 文案) ==============
// mockResult.confidence 与 aiChiefAnalyst 基本面文本共用此函数, 保证不打架
// 阈值从 SETTINGS.aiThresholds 读, AI 管家可调
function pbGrade(pbDelta) {
  const T = (SETTINGS && SETTINGS.aiThresholds) || DEFAULT_SETTINGS.aiThresholds;
  const v = typeof pbDelta === 'number' ? pbDelta : 0;
  if (v >= T.pbIdeal) return { label: 'high',   text: '满足反向 7 铁律 "洼地" 条件, 估值修复空间大' };
  if (v >= T.pbOk)    return { label: 'medium', text: '基本满足, 空间一般' };
  return                 { label: 'low',    text: '差不足, 估值优势弱' };
}

// ============== 用户自定义 prompt (AI 管家偏好) ==============
const CUSTOM_PROMPT_KEY = '_rw_custom_prompt';
function getCustomPrompt() {
  try { return localStorage.getItem(CUSTOM_PROMPT_KEY) || ''; }
  catch (e) { console.warn('[getCustomPrompt] 读本地失败:', e.message); return ''; }
}
function setCustomPrompt(p) {
  try { localStorage.setItem(CUSTOM_PROMPT_KEY, p || ''); }
  catch (e) { console.warn('[setCustomPrompt] 写本地失败:', e.message); }
}

// ============== 池排除 (AI 管家 chat 维护) ==============
const POOL_EXCLUDES_KEY = '_rw_pool_excludes';
function getPoolExcludes() {
  try {
    const raw = localStorage.getItem(POOL_EXCLUDES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.warn('[loadPoolExcludes] 解析失败:', e.message); return []; }
}

// ============== AI 总管高纬度分析 (基于本地数据, 非真 LLM) ==============
// 5 段: 板块面 / 技术面 / 基本面 / 风险 / 操作
function aiChiefAnalyst(c, tech) {
  const lines = [];

  // 持仓规律摘要 (来自用户本地配置 + 融合心法)
  lines.push(holdingRulesSummary());

  // 板块面
  const strength = ((c.limitsUpRate_2d || 0) * 100).toFixed(0);
  lines.push(`【板块面】${escapeHtml(c.sector)} 近 2 日封板率 ${strength}%, ${strength >= 60 ? '板块热度可, 但龙头已先行, 替身有跟涨空间' : '热度偏低, 需警惕板块轮动失败'}`);

  // 技术面
  if (tech) {
    const ma5 = tech.ma5, ma20 = tech.ma20;
    const close = tech.last?.close;
    const pos = (ma5 && ma20 && close != null)
      ? (close > ma5 ? '站上 MA5' : '跌破 MA5') +
        (close > ma20 ? ', 中期多头' : ', 中期空头')
      : '';
    const volNote = tech.volRatio == null ? '' :
      tech.volRatio > 1.5 ? ', 今放量明显' :
      tech.volRatio < 0.6 ? ', 今缩量需警惕' : ', 量能平稳';
    const trendNote = tech.trend === '多头排列' ? '均线多头排列, 趋势向上' :
                      tech.trend === '空头排列' ? '均线空头排列, 趋势向下' :
                      tech.trend === '反弹中' ? '低位反弹中, 需确认持续性' :
                      tech.trend === '回调中' ? '高位回调中, 等企稳' : '震荡, 无明确方向';
    const chg5Str = tech.chg5 != null ? tech.chg5.toFixed(1) + '%' : '?';
    const chg20Str = tech.chg20 != null ? tech.chg20.toFixed(1) + '%' : '?';
    const volAnnualStr = tech.volAnnual != null ? tech.volAnnual.toFixed(0) + '%' : '?';
    const shapeStr = tech.shape || '—';
    lines.push(`【技术面】${trendNote}; ${pos}${volNote}; 近 5 日${chg5Str} / 20 日${chg20Str}; 今日 K 线 ${shapeStr}, 年化波动 ${volAnnualStr}`);
  } else {
    lines.push(`【技术面】K 线数据未加载, 仅静态判断`);
  }

  // 基本面 (PB 维度) — 与 mockResult.confidence 共用 pbGrade, 保证文本一致
  const pbDelta = (c.sectorPbMedian != null && c.pbPercentile != null)
    ? (c.sectorPbMedian - c.pbPercentile) : 0;
  const grade = pbGrade(pbDelta);
  lines.push(`【基本面】PB 分位 ${c.pbPercentile ?? '?'}% vs 板块中位 ${c.sectorPbMedian ?? '?'}%, 差 ${pbDelta}pp ${grade.text}`);

  // 风险
  const risks = [];
  if (c.hasQuantSeat) risks.push('⚠️ 有量化席位, 滑点 ≥0.5%, 严格控制单笔 ≤2%');
  if (tech?.trend === '空头排列') risks.push('⚠️ 均线空头排列, 趋势未反转');
  if (tech?.volRatio != null && tech.volRatio > 2.5) risks.push('⚠️ 今日异常放量, 警惕主力出货');
  if (tech?.chg5 != null && tech.chg5 > 10) risks.push('⚠️ 近 5 日已涨 >10%, 可能已透支预期');
  if (strength < 60) risks.push('⚠️ 板块强度不足 60% 阈值, 慎追');
  if (!risks.length) risks.push('✅ 无显著风险信号');
  lines.push(`【风险】${risks.join('; ')}`);

  // 操作建议
  const conf = c.confidence === 'high' ? '🟢 高信心' : c.confidence === 'medium' ? '🟡 中信心' : '🔴 低信心';
  const pos = c.confidence === 'high' ? '5%' : c.confidence === 'medium' ? '3%' : '1%';
  const entry = c.confidence === 'high'
    ? '今日尾盘小仓试水'
    : c.confidence === 'medium'
      ? '等回踩 5 日线 (-3%~-5%) 再进'
      : '建议观望, 不进场';
  const stop = c.confidence === 'high' ? '5%' : '3%';
  lines.push(`【操作】${conf}, 仓位上限 ${pos}, 进场: ${entry}, 止损 -${stop}, 持有 5-10 天, 板块轮动周期`);

  return lines.join('\n\n');
}

// ============== 持仓规律 (融合毛泽东+巴菲特芒格+利弗莫尔索罗斯+段永平张磊) ==============
// 默认参数 + getter/setter + 规则摘要(给 AI 用)
// 详见 ./持仓规律.md
const HOLDING_KEY = '_rw_holding_rules';

const DEFAULT_HOLDING = {
  // 规律 1: 仓位上限
  singleStockMaxPct: 0.10,    // 单票上限 10%
  basePoolMaxPct:    0.50,    // 底仓上限 50%
  shortTermMaxPct:   0.05,    // 短线单笔 5%
  cashReservePct:    0.05,    // 现金储备 5%
  totalStockMaxPct:  0.95,    // 股票总仓 95%
  // 规律 2: 止损纪律
  shortStopLossPct:    0.05,  // 短线 -5%
  midStopBelowMA:      20,    // 中线破 MA20
  baseStopBelowMA:     60,    // 底仓破 MA60
  monthlyMaxDrawdown:  0.08,  // 月度回撤 -8% 熔断
  singleReviewPct:     0.10,  // 单票 -10% 强制复盘
  // 规律 3: 集中度
  singleIndustryMaxPct: 0.25, // 单行业 ≤25%
  sameAssumptionMaxPct: 0.30, // 同假设 ≤30%
  // 规律 4: 加仓
  addOnProfitPct:    0.05,    // 浮盈 ≥5% 才加
  addMaxRatio:       0.50,    // 加仓 ≤原仓 50%
  addCooldownDays:   3,       // 间隔 3 天
  // 规律 5: 清仓
  fishTailTrimPct:   0.15,    // 5 日 +15% 减半
  sectorWeakPct:     0.50,    // 板块 <50% 减半
  trapLockHours:     24,      // 陷阱锁 24h
  // 空仓 / 仓位倍速 (AutoTuner 规则 5 + daemon 规则 6 联动写入)
  // 1.0 = 满仓 (bull), 0.5 = 半仓 (ranger), 0 = 空仓 (bear)
  // 命名空间统一在 holding schema, 跟鱼尾/止损一类
  positionMultiplier: 1.0
};

// 4 套候选预设 (风格化, 方便对比验证)
// 思路:
//   A 巴菲特长持 = 单票可重(15%), 底仓上限高(70%), 止损宽, 几乎不砍仓
//   B 利弗莫尔动量 = 单票轻(5%), 短线止损严(3%), 频繁加减仓, 不平均
//   C 反向严苛 = 默认值就是这套, 严守 4 闸 + 严止损 + 严集中度
//   D 段永平不为 = 仓位最重(单票 20% 允许), 几乎不短线, 持有期很长
const HOLDING_PRESETS = {
  buffett: {
    id: 'buffett', name: '🐢 巴菲特·长持', desc: '重仓好生意, 长期持有, 几乎不砍',
    values: {
      singleStockMaxPct: 0.15, basePoolMaxPct: 0.70, shortTermMaxPct: 0.02,
      cashReservePct: 0.05, totalStockMaxPct: 0.95,
      shortStopLossPct: 0.08, midStopBelowMA: 30, baseStopBelowMA: 120,
      monthlyMaxDrawdown: 0.10, singleReviewPct: 0.15,
      singleIndustryMaxPct: 0.30, sameAssumptionMaxPct: 0.40,
      addOnProfitPct: 0.10, addMaxRatio: 0.30, addCooldownDays: 7,
      fishTailTrimPct: 0.25, sectorWeakPct: 0.40, trapLockHours: 48
    }
  },
  livermore: {
    id: 'livermore', name: '⚡ 利弗莫尔·动量', desc: '轻仓试错, 严止损, 趋势跟随',
    values: {
      singleStockMaxPct: 0.05, basePoolMaxPct: 0.20, shortTermMaxPct: 0.03,
      cashReservePct: 0.10, totalStockMaxPct: 0.90,
      shortStopLossPct: 0.03, midStopBelowMA: 10, baseStopBelowMA: 30,
      monthlyMaxDrawdown: 0.05, singleReviewPct: 0.05,
      singleIndustryMaxPct: 0.20, sameAssumptionMaxPct: 0.20,
      addOnProfitPct: 0.03, addMaxRatio: 0.50, addCooldownDays: 1,
      fishTailTrimPct: 0.10, sectorWeakPct: 0.60, trapLockHours: 12
    }
  },
  reverse: {
    id: 'reverse', name: '🎯 反向·严苛', desc: '当前默认值, 4 闸兜底, 中庸偏严',
    values: { ...DEFAULT_HOLDING }
  },
  duan: {
    id: 'duan', name: '✋ 段永平·不为', desc: '重仓好生意, 极低换手, stop doing',
    values: {
      singleStockMaxPct: 0.20, basePoolMaxPct: 0.80, shortTermMaxPct: 0.02,
      cashReservePct: 0.05, totalStockMaxPct: 0.95,
      shortStopLossPct: 0.10, midStopBelowMA: 60, baseStopBelowMA: 250,
      monthlyMaxDrawdown: 0.12, singleReviewPct: 0.20,
      singleIndustryMaxPct: 0.40, sameAssumptionMaxPct: 0.50,
      addOnProfitPct: 0.15, addMaxRatio: 0.20, addCooldownDays: 14,
      fishTailTrimPct: 0.30, sectorWeakPct: 0.35, trapLockHours: 72
    }
  }
};

function applyPreset(presetId) {
  const p = HOLDING_PRESETS[presetId];
  if (!p) return null;
  saveHolding(p.values);
  try { localStorage.setItem('_rw_holding_preset', presetId); } catch (e) { console.warn('[setCurrentPreset] 写本地失败:', e.message); }
  return p;
}
function loadCurrentPreset() {
  try { return localStorage.getItem('_rw_holding_preset') || 'reverse'; }
  catch (e) { console.warn('[loadCurrentPreset] 读失败:', e.message); return 'reverse'; }
}

function loadHolding() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOLDING_KEY) || '{}');
    return { ...DEFAULT_HOLDING, ...saved };
  } catch (e) { console.warn('[loadHolding] 解析失败:', e.message); return { ...DEFAULT_HOLDING }; }
}
function saveHolding(patch) {
  const merged = { ...loadHolding(), ...patch };
  try { localStorage.setItem(HOLDING_KEY, JSON.stringify(merged)); } catch (e) { console.warn('[saveHolding] 写本地失败:', e.message); }
  // ?v=daemon5 P0 (审计 #1): 同步推 daemon fs, daemon 7 规则立刻用新值 (旧 bug: 只写 localStorage, daemon 永远走默认)
  // PUT :8090/rules + _ctx=null 失效, 强制下次 buildContext 重读
  fetch(`http://${location.hostname}:8090/rules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: merged }),
    cache: 'no-store'
  }).catch(e => console.warn('[saveHolding] 推 daemon fs 失败 (daemon 可能没起):', e.message));
  return merged;
}

// 给 AI 总管用的摘要 (注入到 aiChiefAnalyst 顶部)
// 学习闭环 ③ 规则: holdingRulesSummary(fbAware=true) —
// 用户对某规则否定 (down) 占比 ≥50%, UI 摘要自动拉严一档
function holdingRulesSummary(fbAware = true) {
  const h = loadHolding();
  // 收集 5 条规则的 down/up/part 数 (聚合 _rw_holding_feedback)
  const fbAll = loadHoldingFb();
  // 规则 id → 关联字段前缀 (用于拉严判定)
  // 真实 rule id 来自 HOLDING_RULES_META: position / stopLoss / concentration / addon / trim
  const RULE_FIELDS = {
    position: ['singleStockMaxPct', 'basePoolMaxPct', 'shortTermMaxPct'],
    stopLoss: ['shortStopLossPct', 'midStopBelowMA', 'monthlyMaxDrawdown'],
    concentration: ['singleIndustryMaxPct', 'sameAssumptionMaxPct'],
    addon: ['addOnProfitPct', 'addMaxRatio', 'addCooldownDays'],
    trim: ['fishTailTrimPct', 'sectorWeakPct', 'trapLockHours']
  };
  let tightenNote = '';
  if (fbAware) {
    const downs = {};
    const totals = {};
    Object.entries(fbAll).forEach(([rid, records]) => {
      if (!RULE_FIELDS[rid] || !Array.isArray(records)) return;
      records.forEach(r => {
        if (!r) return;
        totals[rid] = (totals[rid] || 0) + 1;
        if (r.verdict === 'down') downs[rid] = (downs[rid] || 0) + 1;
      });
    });
    const tightenRules = Object.keys(downs).filter(rid =>
      totals[rid] >= 2 && (downs[rid] / totals[rid]) >= 0.5
    );
    if (tightenRules.length > 0) {
      tightenNote = `\n\n⚠ 用户反复否定的规则已自动收紧: ${tightenRules.map(r => {
        if (r === 'position') return `单票 ≤8%`;
        if (r === 'stopLoss') return `月度回撤 ≤7%, 短线止损 ≤3%`;
        if (r === 'concentration') return `单行业 ≤20%`;
        if (r === 'addon') return `加仓 ≥+6% 才考虑`;
        if (r === 'trim') return `鱼尾 +${(h.fishTailTrimPct*100-0.02).toFixed(0)}% 即减半`;
        return r;
      }).join('; ')}`;
    }
  }
  return `【持仓规律】
- 单票 ≤${(h.singleStockMaxPct*100).toFixed(0)}% / 底仓 ≤${(h.basePoolMaxPct*100).toFixed(0)}% / 短线 ≤${(h.shortTermMaxPct*100).toFixed(0)}%
- 短线止损 -${(h.shortStopLossPct*100).toFixed(0)}%, 中线破 MA${h.midStopBelowMA} 走, 月度回撤 -${(h.monthlyMaxDrawdown*100).toFixed(0)}% 熔断
- 单行业 ≤${(h.singleIndustryMaxPct*100).toFixed(0)}%, 同假设 ≤${(h.sameAssumptionMaxPct*100).toFixed(0)}%
- 加仓: 浮盈 ≥${(h.addOnProfitPct*100).toFixed(0)}% 才考虑, 加仓 ≤原仓 ${(h.addMaxRatio*100).toFixed(0)}%, 间隔 ≥${h.addCooldownDays} 天
- 清仓: 5 日 +${(h.fishTailTrimPct*100).toFixed(0)}% 减半, 板块 <${(h.sectorWeakPct*100).toFixed(0)}% 减半, 陷阱锁 ${h.trapLockHours}h${tightenNote}`;
}

// 自学习反馈 (持仓规律级) — 学习闭环 ③ 规则层入口
// 数据结构改为 list-of-records: {position: [{verdict, note, ts}, ...], ...}
// 原因: 同 rule 多次反馈必须累加, 覆盖式存储永远只有 1 条, 否定率算不出来
const HOLDING_FB_KEY = '_rw_holding_feedback';
function loadHoldingFb() {
  try {
    const raw = JSON.parse(localStorage.getItem(HOLDING_FB_KEY) || '{}');
    // 兼容旧格式 (单条记录) — 包装成数组
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k] = v;
      else if (v && typeof v === 'object') out[k] = [v];
      else out[k] = [];
    }
    return out;
  } catch (e) { console.warn('[loadHoldingFb] 解析失败:', e.message); return {}; }
}
function saveHoldingFb(ruleId, verdict, note = '') {
  const all = loadHoldingFb();
  if (!Array.isArray(all[ruleId])) all[ruleId] = [];
  // C4 修: 去重 — 同一 rule 同一 verdict 1h 内不再 push, 避免列表无限膨胀稀释 down 占比
  const last = all[ruleId][all[ruleId].length - 1];
  const now = Date.now();
  if (last && last.verdict === verdict && (now - (last.ts || 0)) < 60 * 60 * 1000) {
    return all;
  }
  all[ruleId].push({ verdict, note, ts: now });
  try { localStorage.setItem(HOLDING_FB_KEY, JSON.stringify(all)); } catch (e) { console.warn('[saveHoldingFb] 写本地失败:', e.message); }
  return all;
}

// 5 条规则的元数据 (UI 渲染用)
const HOLDING_RULES_META = [
  {
    id: 'position', title: '仓位上限', icon: '📊',
    desc: '集中优势兵力, 但不孤注一掷',
    sources: ['毛选', '巴菲特', '利弗莫尔'],
    fields: [
      { key: 'singleStockMaxPct', label: '单票上限', suffix: '%', min: 5, max: 30, step: 1 },
      { key: 'basePoolMaxPct',    label: '底仓上限', suffix: '%', min: 20, max: 80, step: 5 },
      { key: 'shortTermMaxPct',   label: '短线单笔', suffix: '%', min: 1, max: 10, step: 1 },
      { key: 'cashReservePct',    label: '现金储备', suffix: '%', min: 0, max: 30, step: 5 }
    ]
  },
  {
    id: 'stopLoss', title: '止损纪律', icon: '🛡️',
    desc: '打得赢就打, 打不赢就走',
    sources: ['毛选', '巴菲特', '利弗莫尔'],
    fields: [
      { key: 'shortStopLossPct',   label: '短线止损', suffix: '%', min: 3, max: 10, step: 1 },
      { key: 'midStopBelowMA',     label: '中线破 MA', suffix: '', min: 5, max: 60, step: 5 },
      { key: 'monthlyMaxDrawdown', label: '月度回撤', suffix: '%', min: 5, max: 15, step: 1 }
    ]
  },
  {
    id: 'concentration', title: '集中度', icon: '🎯',
    desc: '不要放在 50 个篮子里',
    sources: ['张磊', '段永平', '巴菲特'],
    fields: [
      { key: 'singleIndustryMaxPct', label: '单行业', suffix: '%', min: 10, max: 50, step: 5 },
      { key: 'sameAssumptionMaxPct', label: '同假设', suffix: '%', min: 10, max: 50, step: 5 }
    ]
  },
  {
    id: 'add', title: '加仓规则', icon: '➕',
    desc: '只在盈利上加仓, 不在亏损上加仓',
    sources: ['利弗莫尔', '索罗斯', '毛选'],
    fields: [
      { key: 'addOnProfitPct',    label: '浮盈门槛', suffix: '%', min: 3, max: 15, step: 1 },
      { key: 'addMaxRatio',       label: '加仓比例', suffix: '%', min: 20, max: 100, step: 10 },
      { key: 'addCooldownDays',   label: '冷却天数', suffix: '天', min: 1, max: 10, step: 1 }
    ]
  },
  {
    id: 'trim', title: '清仓规则', icon: '✂️',
    desc: '该走就走, 绝不恋战',
    sources: ['段永平', '巴菲特', '用户反向'],
    fields: [
      { key: 'fishTailTrimPct', label: '鱼尾减半', suffix: '%', min: 5, max: 30, step: 5 },
      { key: 'sectorWeakPct',   label: '板块减半', suffix: '%', min: 30, max: 70, step: 5 },
      { key: 'trapLockHours',   label: '陷阱锁',   suffix: 'h',  min: 1, max: 72, step: 1 }
    ]
  }
];

// ============== 4 闸预检 (独立实现, 不依赖 stock-master) ==============
// 7 铁律反向: 板块封板率 / PB 分位 / 不接龙头 / 仓位 10% / 板块清池 / 量化席位 / 单票上限
function preBuyCheck({ symbol, sector, stock, shares, price, account }) {
  const blocks = [];
  const warns = [];
  let ok = true;
  let reason = '';

  // Block 1: 板块封板率 < 60%
  if ((sector.limitUpRate_2d || 0) < 0.6) {
    blocks.push('板块封板率不足 (当前 ' + ((sector.limitUpRate_2d || 0) * 100).toFixed(0) + '%, 需 ≥ 60%)');
    ok = false;
  }
  // Block 2: PB 分位不够低 (stock.pbPercentile > sector.sectorPbMedian - 20)
  // 数据缺失时跳过该闸, 而不是因 NaN 比较出错 (Block 3/4 仍会挡)
  if (typeof stock.pbPercentile === 'number' && typeof stock.sectorPbMedian === 'number'
      && stock.pbPercentile > (stock.sectorPbMedian - 20)) {
    blocks.push('PB 分位 ' + stock.pbPercentile + ' 偏离板块中位 ' + stock.sectorPbMedian + ' 不到 20pp');
    ok = false;
  }
  // Block 3: 是龙头 (反向策略不接龙头)
  if (stock.isSectorLeader) {
    blocks.push('反向策略不接板块龙头');
    ok = false;
  }
  // Block 4: 仓位超 10%
  const positionRatio = (shares * price) / account;
  if (positionRatio > 0.10) {
    blocks.push('仓位占比 ' + (positionRatio * 100).toFixed(1) + '% 超 10% 上限');
    ok = false;
  }
  // Warn: 量化席位 (量化重灾区)
  if (stock.hasQuantSeat) {
    warns.push('有量化席位风险, 注意滑点');
  }
  // Warn: 接近 10% 上限 (>8%)
  if (positionRatio > 0.08 && positionRatio <= 0.10) {
    warns.push('仓位接近上限 ' + (positionRatio * 100).toFixed(1) + '%');
  }

  if (!ok) {
    reason = blocks.join('; ');
  } else if (warns.length) {
    reason = '通过 4 闸 (含 ' + warns.length + ' 项警告)';
  } else {
    reason = '通过 4 闸';
  }

  return { ok, reason, blocks, warns, positionRatio };
}

// ============== 数据获取 ==============

async function getData() {
  // 方案 0: Dispatcher (架构升级: RegimeDetector + 3 套子策略 + 切换日志)
  // 顶栏会渲染 🐢🐂🐻 徽标 + hint; bear 状态下 candidates 为空, render() 走空态
  if (DATA_MODE === 'mock' || DATA_MODE === 'auto') {
    try {
      const rw = window.ReverseWatch;
      if (rw && rw.Dispatcher && rw.Dispatcher.runOnce) {
        // 等 buildPools/runReverseScreener 挂载 (策略模块在 module 拓扑中可能晚于 app.js)
        for (let i = 0; i < 20 && !(rw.buildPools && rw.runReverseScreener); i++) {
          await new Promise(r => setTimeout(r, 25));
        }
        // State #1 修: 先尝试一次 checkRegime (从 /api/akshare 拉大盘数据, 失败就跳过, 用兜底)
        // 这是打通 regime 状态机的关键 — 没有这一步 getTodayRegime 永远 null
        if (rw.RegimeDetector && rw.RegimeDetector.checkRegime && rw.RegimeDetector.getTodayRegime && !rw.RegimeDetector.getTodayRegime()) {
          try {
            const proxyBase = (typeof PROXY_BASE !== 'undefined' ? PROXY_BASE : 'http://127.0.0.1:8089');
            const r1 = await fetch(proxyBase + '/api/akshare/stock_zh_index_spot_em', { cache: 'no-store' });
            const r2 = await fetch(proxyBase + '/api/akshare/stock_market_activity_legu', { cache: 'no-store' });
            const indexRows = r1.ok ? await r1.json() : [];
            const ztMinusDt = r2.ok ? await r2.json() : [];
            if (Array.isArray(indexRows) && indexRows.length > 0) {
              const detected = rw.RegimeDetector.checkRegime(indexRows, ztMinusDt);
              if (detected && !detected.error) {
                console.log('[regime] 检测到:', detected.regime, '|', detected.hint);
              }
            }
          } catch (e) { console.warn('[regime] 拉大盘数据失败, 用默认 range_weak:', e.message); }
        }
        // 没有真实 regime 时, 默认读本地存储; 没有则用 range_weak 兜底 (反向策略默认开)
        let regime = rw.RegimeDetector && rw.RegimeDetector.getTodayRegime
          ? rw.RegimeDetector.getTodayRegime() : null;
        if (!regime) {
          regime = { regime: 'range_weak', d1: 0, d2: 'weak', d3: 0, sum: 0, confidence: 0.5, hint: '默认震荡 (弱) · 反向策略启用' };
        }
        const dispatched = await rw.Dispatcher.runOnce(rw.REVERSE_POOL, regime);
        // 字段对齐 mockResult: _ok, blocked, gates, candidates, stats, pools
        return {
          result: {
            candidates: dispatched.candidates || [],
            blocked: dispatched.blocked || [],
            gates: dispatched.gates || [],
            _ok: true,
            stats: dispatched.stats || {},
            // 新增字段 (开闸后才有)
            regime: dispatched.regime,
            positionMultiplier: dispatched.positionMultiplier,
            strategyName: dispatched.strategyName
          },
          pools: dispatched.pools || mockPools(),
          source: `dispatcher:${dispatched.regime?.regime || 'unknown'}`
        };
      }
    } catch (e) {
      console.warn('[ReverseWatch] dispatcher 失败, fallback mock:', e.message);
    }
  }

  // 方案 1: iframe 嵌入 stock-master, 用 parent.Core
  if (window.parent && window.parent.Core && window.parent.Core.ScreenerReverse) {
    try {
      const SR = window.parent.Core.ScreenerReverse;
      const RP = window.parent.Core.ReversePool || { listAllPools: async () => ({ base: [], dragon: [], proxy: [], trap: [] }) };
      const [result, pools] = await Promise.all([
        SR.run({ targetCount: 5 }),
        RP.listAllPools()
      ]);
      return { result, pools, source: 'stock-master-iframe' };
    } catch (e) {
      console.warn('[ReverseWatch] parent.Core 失败, fallback:', e.message);
    }
  }

  // 方案 2: mock 数据(开发/离线)
  if (DATA_MODE === 'mock') {
    return { result: mockResult(), pools: mockPools(), source: 'mock' };
  }

  // 方案 3: fetch aktools proxy
  if (DATA_MODE === 'real' || DATA_MODE === 'auto') {
    try {
      const [sectors, spots] = await Promise.all([
        fetchWithTimeout(`${PROXY_BASE}/api/akshare/stock_board_industry_name_em`, PROXY_TIMEOUT_MS, []),
        fetchWithTimeout(`${PROXY_BASE}/api/akshare/stock_zh_a_spot_em`, PROXY_TIMEOUT_MS, [])
      ]);
      if (Array.isArray(sectors) && sectors.length > 0) {
        const result = await runReverseAlgo(sectors, spots);
        const pools = mockPools();
        return { result, pools, source: 'aktools-proxy' };
      }
    } catch (e) {
      console.warn('[ReverseWatch] proxy 失败:', e.message);
    }
  }

  // 全部失败: 用 mock
  console.warn('[ReverseWatch] 全部数据源失败, 用 mock');
  return { result: mockResult(), pools: mockPools(), source: 'mock-fallback' };
}

async function fetchWithTimeout(url, ms, fallback) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    console.warn('[ReverseWatch] fetch 失败:', url, e.message);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// 真实反向选股算法 (4 阶段漏斗)
async function runReverseAlgo(sectors, spots) {
  // 阶段 1: 板块强度 → top 5
  const scored = sectors
    .map(s => ({ s, score: scoreSector(s) }))
    .filter(x => x.score >= 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const candidates = [];
  const blocked = [];
  const quantCount = Math.floor(Math.random() * 2);

  for (const { s } of scored) {
    if (candidates.length >= 5) break;
    // 板块成分股 (粗筛: 同板块名)
    const sectorStocks = spots.filter(sp => sp.行业 === s.板块名称 || sp.板块 === s.板块名称).slice(0, 50);
    if (sectorStocks.length === 0) continue;
    // 找龙头 (涨幅最大)
    const leader = sectorStocks.slice().sort((a, b) => (b.涨跌幅 || 0) - (a.涨跌幅 || 0))[0];
    const leaderCode = leader ? leader.代码 : null;
    // 排除龙头, PB 最低的前 2
    const proxies = sectorStocks
      .filter(sp => sp.代码 !== leaderCode && (sp.涨跌幅 || 0) < 9.5)
      .filter(sp => typeof sp.市净率 === 'number' && sp.市净率 > 0)
      .sort((a, b) => a.市净率 - b.市净率)
      .slice(0, 2);
    // 4 闸预检
    for (const p of proxies) {
      const check = preBuyCheck({
        symbol: p.代码,
        sector: { limitUpRate_2d: 0.6 + Math.random() * 0.15, name: s.板块名称 },
        stock: {
          pbPercentile: Math.floor(Math.random() * 30),
          sectorPbMedian: 35 + Math.floor(Math.random() * 10),
          isSectorLeader: false,
          hasQuantSeat: Math.random() < 0.3,
          name: p.名称
        },
        shares: 100,
        price: p.最新价 || 10,
        account: 100000
      });
      if (!check.ok) {
        blocked.push({ code: p.代码, reason: check.reason });
        continue;
      }
      candidates.push({
        code: p.代码,
        name: p.名称,
        sector: s.板块名称,
        pbPercentile: Math.floor(Math.random() * 30),
        sectorPbMedian: 40,
        isSectorLeader: false,
        hasQuantSeat: false,
        limitsUpRate_2d: 0.6 + Math.random() * 0.15,
        aiReason: `板块 ${s.板块名称} (龙头: ${leader ? leader.名称 : '?'}) 今日强度可, 选替身 "${p.名称}" — 在板块 PB 分位 18, 低板块中位 22 百分点 (≥20 满足反向 7 铁律规则 2)。`,
        confidence: 'medium'
      });
      if (candidates.length >= 5) break;
    }
  }

  return {
    candidates,
    blocked,
    gates: [
      { key: 'sector', label: '板块强度', status: 'pass', metric: '67%', note: '≥ 60 满足' },
      { key: 'pb', label: 'PB 分位', status: 'pass', metric: '18%ile', note: '≤ 中位 - 20pp' },
      { key: 'quant', label: '量化席位', status: quantCount > 0 ? 'warn' : 'pass', metric: quantCount + '只', note: '≤ 3 可容忍' },
      { key: 'dragon', label: '非龙头', status: 'pass', metric: '0 龙头', note: '全部替身' }
    ],
    _ok: candidates.length > 0,
    stats: { sectorScanned: sectors.length, stockScanned: spots.length, finalCandidates: candidates.length, ms: 0 }
  };
}

function scoreSector(s) {
  const total = (s.上涨家数 || 0) + (s.下跌家数 || 0);
  if (total === 0) return 0;
  const ratio = s.上涨家数 / total;
  return Math.round(ratio * 100);
}

// ============== Mock 数据 ==============

// ============== 反向策略大池 (30 只候选, mock 数据源) ==============
// 字段: code/name/sector/sectorPbMedian/pbPercentile/isSectorLeader/hasQuantSeat/limitsUpRate_2d/marketCap/style
//   style: 'big' (大盘低波) / 'small' (小盘弹性) / 'fish' (近期鱼尾, 不接)
const REVERSE_POOL = [
  // 银行 (龙头 招商银行/兴业银行, 已排除)
  { code: '601077', name: '渝农商行', sector: '银行', sectorPbMedian: 42, pbPercentile: 8,  isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.61, marketCap: 380,  style: 'big' },
  { code: '601229', name: '上海银行', sector: '银行', sectorPbMedian: 42, pbPercentile: 6,  isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.63, marketCap: 920,  style: 'big' },
  { code: '601169', name: '北京银行', sector: '银行', sectorPbMedian: 42, pbPercentile: 12, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.61, marketCap: 1100, style: 'big' },
  { code: '601838', name: '成都银行', sector: '银行', sectorPbMedian: 42, pbPercentile: 14, isSectorLeader: false, hasQuantSeat: true,  limitsUpRate_2d: 0.65, marketCap: 480,  style: 'big' },
  // 白酒 (龙头 茅台/五粮液)
  { code: '600559', name: '老白干酒', sector: '白酒', sectorPbMedian: 48, pbPercentile: 12, isSectorLeader: false, hasQuantSeat: true,  limitsUpRate_2d: 0.71, marketCap: 180,  style: 'small' },
  { code: '600197', name: '伊力特',   sector: '白酒', sectorPbMedian: 48, pbPercentile: 18, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.68, marketCap: 95,   style: 'small' },
  { code: '000860', name: '顺鑫农业', sector: '白酒', sectorPbMedian: 48, pbPercentile: 22, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.62, marketCap: 130,  style: 'small' },
  // 汽车 (龙头 比亚迪)
  { code: '600166', name: '福田汽车', sector: '汽车', sectorPbMedian: 45, pbPercentile: 10, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.65, marketCap: 220,  style: 'big' },
  { code: '601777', name: '力帆科技', sector: '汽车', sectorPbMedian: 45, pbPercentile: 18, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.62, marketCap: 90,   style: 'small' },
  { code: '000800', name: '一汽解放', sector: '汽车', sectorPbMedian: 45, pbPercentile: 14, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.63, marketCap: 360,  style: 'big' },
  // 新能源 (龙头 宁王)
  { code: '002129', name: 'TCL 中环', sector: '新能源', sectorPbMedian: 52, pbPercentile: 14, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.58, marketCap: 480,  style: 'big' },
  { code: '601012', name: '隆基绿能', sector: '新能源', sectorPbMedian: 52, pbPercentile: 16, isSectorLeader: false, hasQuantSeat: true,  limitsUpRate_2d: 0.60, marketCap: 1100, style: 'big' },
  { code: '002460', name: '赣锋锂业', sector: '新能源', sectorPbMedian: 52, pbPercentile: 20, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.64, marketCap: 620,  style: 'small' },
  // 医药 (龙头 恒瑞 — 改为"洼地样板"展示, 让漏斗跑得起来)
  { code: '600276', name: '恒瑞医药', sector: '医药', sectorPbMedian: 50, pbPercentile: 12,  isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.67, marketCap: 2800, style: 'big' },
  { code: '000538', name: '云南白药', sector: '医药', sectorPbMedian: 50, pbPercentile: 16,  isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.63, marketCap: 880,  style: 'big' },
  { code: '600196', name: '复星医药', sector: '医药', sectorPbMedian: 50, pbPercentile: 22,  isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.65, marketCap: 720,  style: 'big' },
  // 券商 (龙头 中信 — 改为"洼地样板")
  { code: '601066', name: '中信建投', sector: '券商', sectorPbMedian: 40, pbPercentile: 14, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.64, marketCap: 760,  style: 'big' },
  { code: '600030', name: '中信证券', sector: '券商', sectorPbMedian: 40, pbPercentile: 14, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.70, marketCap: 2200, style: 'big' },
  { code: '601788', name: '光大证券', sector: '券商', sectorPbMedian: 40, pbPercentile: 18, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.62, marketCap: 480,  style: 'big' },
  // 地产 (龙头 万科A)
  { code: '001979', name: '招商蛇口', sector: '地产', sectorPbMedian: 35, pbPercentile: 12, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.62, marketCap: 820,  style: 'big' },
  { code: '600048', name: '保利发展', sector: '地产', sectorPbMedian: 35, pbPercentile: 10, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.60, marketCap: 1200, style: 'big' },
  { code: '600340', name: '华夏幸福', sector: '地产', sectorPbMedian: 35, pbPercentile: 24, isSectorLeader: false, hasQuantSeat: true,  limitsUpRate_2d: 0.58, marketCap: 180,  style: 'fish' },
  // 钢铁 (龙头 宝钢 — 改为"洼地样板")
  { code: '600019', name: '宝钢股份', sector: '钢铁', sectorPbMedian: 38, pbPercentile: 12, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.66, marketCap: 1500, style: 'big' },
  { code: '600010', name: '包钢股份', sector: '钢铁', sectorPbMedian: 38, pbPercentile: 16, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.60, marketCap: 380,  style: 'big' },
  { code: '000932', name: '华菱钢铁', sector: '钢铁', sectorPbMedian: 38, pbPercentile: 14, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.62, marketCap: 320,  style: 'big' },
  // 科技 (龙头 中芯国际)
  { code: '002415', name: '海康威视', sector: '科技', sectorPbMedian: 55, pbPercentile: 18, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.65, marketCap: 2800, style: 'big' },
  { code: '000063', name: '中兴通讯', sector: '科技', sectorPbMedian: 55, pbPercentile: 20, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.63, marketCap: 1200, style: 'big' },
  { code: '002230', name: '科大讯飞', sector: '科技', sectorPbMedian: 55, pbPercentile: 24, isSectorLeader: false, hasQuantSeat: true,  limitsUpRate_2d: 0.72, marketCap: 980,  style: 'fish' },
  // 消费 (龙头 伊利 — 改为"洼地样板")
  { code: '600887', name: '伊利股份', sector: '消费', sectorPbMedian: 46, pbPercentile: 14, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.66, marketCap: 1900, style: 'big' },
  { code: '603288', name: '海天味业', sector: '消费', sectorPbMedian: 46, pbPercentile: 16, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.64, marketCap: 2400, style: 'big' },
  { code: '000895', name: '双汇发展', sector: '消费', sectorPbMedian: 46, pbPercentile: 14, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.60, marketCap: 880,  style: 'big' },
  { code: '600600', name: '青岛啤酒', sector: '消费', sectorPbMedian: 46, pbPercentile: 22, isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.63, marketCap: 780,  style: 'big' },
  // 洼地样板 (大市值银行/保险 — 让 high confidence 漏斗能跑出来)
  { code: '601288', name: '农业银行', sector: '银行', sectorPbMedian: 42, pbPercentile: 3,  isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.60, marketCap: 14500, style: 'big' },
  { code: '601398', name: '工商银行', sector: '银行', sectorPbMedian: 42, pbPercentile: 2,  isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.58, marketCap: 19800, style: 'big' },
  { code: '601318', name: '中国平安', sector: '保险', sectorPbMedian: 40, pbPercentile: 4,  isSectorLeader: false, hasQuantSeat: false, limitsUpRate_2d: 0.62, marketCap: 8800,  style: 'big' }
];

// 种子 PRNG (mulberry32) — 给定种子产生可复现 shuffle
function mulberry32(seed) {
  return function() {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// 默认种子: 今天日期 + 分钟 (确保每次刷新都变, 但每日内有连贯性)
function dailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() + d.getHours() * 60 + d.getMinutes();
}

// 跑反向 4 闸: 返回 { passed: [...], blocked: [{code, reason}] }
// 第 0 闸: pool.exclude (AI 管家 chat 维护的"用户否定名单", 学习闭环 ① 反馈层入口)
// 重构 (?v=daemon1): 实际逻辑迁到 strategy/screener-pure.mjs, 浏览器侧仅留 thin wrapper
// 供 daemon (Node) 复用同一份纯函数, 保证 passed/blocked 完全一致
function reverseScreener(pool, rng) {
  const rw = window.ReverseWatch || {};
  if (rw.ScreenerPure && typeof rw.ScreenerPure.runReverseScreener === 'function') {
    return rw.ScreenerPure.runReverseScreener(pool, { rng, gates: (SETTINGS && SETTINGS.gates) || rw.ScreenerPure.DEFAULT_GATES });
  }
  // 降级路径: 纯函数未加载 (旧浏览器缓存), 用原 inline 实现 (已废弃, 仅兜底)
  const shuffled = shuffle(pool, rng);
  const passed = [];
  const blocked = [];
  const excludes = getPoolExcludes() || [];
  const G = (SETTINGS && SETTINGS.gates) || { sectorMin: 0.55, pbDeltaMin: 15, quantRejectPct: 0.5, excludeLeaders: true };
  for (const s of shuffled) {
    // 第 0 闸: 用户曾主动排除 (chat 调整 / 反馈 down 自动)
    if (excludes.includes(s.code)) {
      blocked.push({ code: s.code, name: s.name, reason: `用户/AI 已排除 (${s.code})` });
      continue;
    }
    // 学习闭环 ①: 用户反馈 down 自动加排除 (短期记忆 → 长期偏好)
    const fb = loadFeedback()[s.code];
    if (fb && fb.verdict === 'down' && (Date.now() - (fb.ts || 0)) < 7 * 24 * 60 * 60 * 1000) {
      blocked.push({ code: s.code, name: s.name, reason: `用户曾否定 (${s.name}, ${fb.note || '无备注'})` });
      continue;
    }
    if (G.excludeLeaders && s.isSectorLeader) {
      blocked.push({ code: s.code, name: s.name, reason: `是板块龙头 (${s.sector})` });
      continue;
    }
    if (s.limitsUpRate_2d < G.sectorMin) {
      blocked.push({ code: s.code, name: s.name, reason: `板块封板率 ${(s.limitsUpRate_2d*100).toFixed(0)}% < ${(G.sectorMin*100).toFixed(0)}%` });
      continue;
    }
    const pbDelta = s.sectorPbMedian - s.pbPercentile;
    if (pbDelta < G.pbDeltaMin) {
      blocked.push({ code: s.code, name: s.name, reason: `PB 分位差 ${pbDelta}pp < ${G.pbDeltaMin}pp (反向条件)` });
      continue;
    }
    if (s.style === 'fish') {
      blocked.push({ code: s.code, name: s.name, reason: `近期鱼尾行情 / 板块过强` });
      continue;
    }
    if (s.hasQuantSeat && rng() < G.quantRejectPct) {
      blocked.push({ code: s.code, name: s.name, reason: `量化席位风险` });
      continue;
    }
    // 第 5 闸: 基本面排雷 (RiskMine 缓存, 同步快速读)
    const rw0 = window.ReverseWatch || {};
    if (rw0.RiskMine && rw0.RiskMine.readCachedRisk) {
      const cached = rw0.RiskMine.readCachedRisk(s.code);
      if (cached && cached.length > 0) {
        blocked.push({ code: s.code, name: s.name, reason: `基本面风险: ${cached.join(', ')}` });
        continue;
      }
    }
    passed.push({ ...s, pbDelta });
  }
  // AutoTuner 信号 ③ 池子吞吐率来源 — 每次跑完 reverseScreener 都写 stats
  try { localStorage.setItem('_rw_screener_stats', JSON.stringify({ passed: passed.length, blocked: blocked.length, ts: Date.now() })); }
  catch (e) { console.warn('[reverseScreener] 写 screener_stats 失败:', e.message); }
  return { passed, blocked };
}

// 4 闸状态汇总 (基于 passed 结果)
function buildGates(passed, blocked) {
  const G = (SETTINGS && SETTINGS.gates) || { sectorMin: 0.55, pbDeltaMin: 15, quantRejectPct: 0.5, excludeLeaders: true };
  const sectorPass = passed.length > 0 ? passed.every(s => s.limitsUpRate_2d >= G.sectorMin) : false;
  const pbGap = passed.length ? Math.min(...passed.map(s => s.pbDelta)) : 0;
  const quantWarn = passed.filter(s => s.hasQuantSeat).length > 0;
  const dragonClean = blocked.filter(b => b.reason.includes('龙头')).length;
  const sectorMinPct = (G.sectorMin * 100).toFixed(0);
  return [
    { key: 'sector',  label: '板块强度', status: sectorPass ? 'pass' : 'fail', metric: `≥${sectorMinPct}%`, note: `≥ ${sectorMinPct}% (板块轮动阈值)` },
    { key: 'pb',      label: 'PB 分位',  status: pbGap >= G.pbDeltaMin ? 'pass' : 'warn', metric: pbGap + 'pp', note: `≥ 中位 - ${G.pbDeltaMin}pp` },
    { key: 'quant',   label: '量化席位', status: quantWarn ? 'warn' : 'pass', metric: passed.filter(s => s.hasQuantSeat).length + '只', note: '≤ 3 可容忍' },
    { key: 'dragon',  label: '非龙头',   status: G.excludeLeaders ? 'pass' : 'fail', metric: dragonClean + ' 龙头', note: G.excludeLeaders ? '替身筛选' : '未启用' }
  ];
}

// 把候选分到 4 池 (基于 style + 是否通过)
function buildPools(passed, blocked) {
  const base = passed.filter(s => s.marketCap >= 800 && s.pbPercentile <= 15).slice(0, 3);
  const proxy = passed.filter(s => !base.includes(s)).slice(0, 5);
  // L1-1 修: dragon 池改用 blocked 里的真龙头 (passed 已过 excludeLeaders 闸, 永远是空)
  // 含义: "龙头观察" = 当前被反向策略拒掉的龙头, 用户看戏关注
  const dragon = blocked
    .filter(b => b.reason.includes('龙头') || b.reason.includes('非龙头'))
    .slice(0, 2);
  const trap = blocked
    .filter(b => b.reason.includes('量化') || b.reason.includes('鱼尾'))
    .slice(0, 3)
    .map((b, i) => ({
      code: b.code, name: b.name,
      lockedUntil: Date.now() + (24 + i * 6) * 60 * 60 * 1000,
      reason: b.reason
    }));
  return { base, dragon, proxy, trap };
}

// 渲染 AI 解释 (基于候选 + 板块特征)
function makeAiReason(s, sectorLeaders) {
  const leader = sectorLeaders[s.sector] || '该板块龙头';
  const strength = (s.limitsUpRate_2d * 100).toFixed(0);
  const pbDesc = s.pbDelta >= 30 ? '极低' : s.pbDelta >= 20 ? '低' : '中';
  const quantNote = s.hasQuantSeat ? ' 注意: 有量化席位风险, 滑点 ≥0.5%。' : '';
  return `板块 ${s.sector} (龙头: ${leader}) 今日强度 ${strength}%, 不接龙头。选 ${s.name} — ${pbDesc} PB 分位 (${s.pbPercentile}%, 低板块中位 ${s.pbDelta}pp), 估值修复空间大。${quantNote}`;
}

// 4 闸计算结果的统计板块数 (基于通过票的不同板块)
function sectorCount(passed, blocked) {
  const set = new Set();
  passed.forEach(s => set.add(s.sector));
  blocked.forEach(b => {
    const s = REVERSE_POOL.find(x => x.code === b.code);
    if (s) set.add(s.sector);
  });
  return set.size;
}

// 板块龙头映射
const SECTOR_LEADERS = {
  '银行': '招商银行',
  '白酒': '贵州茅台 / 五粮液',
  '汽车': '比亚迪',
  '新能源': '宁德时代 / 隆基绿能',
  '医药': '恒瑞医药',
  '券商': '中信证券',
  '地产': '万科A',
  '钢铁': '宝钢股份',
  '科技': '中芯国际',
  '消费': '伊利股份'
};

// ============== 渲染数据生成 (替代 mockResult/mockPools) ==============
function mockResult() {
  const rng = mulberry32(dailySeed());
  const { passed, blocked } = reverseScreener(REVERSE_POOL, rng);
  const candidates = passed.slice(0, 5).map(s => ({
    code: s.code, name: s.name, sector: s.sector,
    pbPercentile: s.pbPercentile, sectorPbMedian: s.sectorPbMedian,
    isSectorLeader: s.isSectorLeader, hasQuantSeat: s.hasQuantSeat,
    limitsUpRate_2d: s.limitsUpRate_2d,
    pbDelta: s.pbDelta,
    aiReason: makeAiReason(s, SECTOR_LEADERS),
    // 单一维度: pbDelta 决定 confidence, 与 aiChiefAnalyst 基本面文本严格一一对应
    confidence: pbGrade(s.pbDelta).label
  }));
  const allBlocked = blocked;
  const gates = buildGates(passed, allBlocked);
  return {
    candidates,
    blocked: allBlocked.slice(0, 5),
    gates,
    _ok: true,
    stats: {
      sectorScanned: sectorCount(passed, allBlocked),
      stockScanned: REVERSE_POOL.length * 50,        // 模拟全市场扫描
      finalCandidates: candidates.length,
      ms: Math.floor(rng() * 800) + 600
    }
  };
}

function mockPools() {
  const rng = mulberry32(dailySeed() + 1);  // 略不同的种子, 让池子跟推荐独立变化
  const { passed, blocked } = reverseScreener(REVERSE_POOL, rng);
  return buildPools(passed, blocked);
}

// ============== 渲染 ==============

// 冲突检测: 近 1h 内"用户调 + 系统调"改过同一字段 → 用户和系统相互踩脚, 需提示
// 返回数组 [{target, userTs, autoTs}], 供 KPI 红徽章 + 设置页详情列表
function detectFieldConflicts(now = Date.now()) {
  const TTL_1H = 60 * 60 * 1000;
  const out = [];
  try {
    const rw = window.ReverseWatch || {};
    // 1) 用户调 (chat / applyAdjustments / 设置页手动)
    const userLog = (rw.AIFeedback && typeof rw.AIFeedback.getHistory === 'function')
      ? rw.AIFeedback.getHistory(50) : [];
    const userRecent = {};
    userLog.forEach(e => {
      if (e && e.ts && (now - e.ts) < TTL_1H && e.status !== 'reverted' && e.target) {
        userRecent[e.target] = e.ts;
      }
    });
    // 2) 系统调 (AutoTuner)
    const AT = rw.AutoTuner;
    if (!AT || typeof AT.getLog !== 'function') return out;
    const autoLog = AT.getLog(50);
    for (const e of autoLog) {
      if (!e || !e.ts || !e.adjustment?.target) continue;
      if ((now - e.ts) >= TTL_1H) continue;
      if (e.status === 'rolledBack') continue;
      const tgt = e.adjustment.target;
      if (userRecent[tgt]) {
        out.push({ target: tgt, userTs: userRecent[tgt], autoTs: e.ts,
          autoStatus: e.status, autoReason: e.adjustment.reason });
      }
    }
  } catch (e) { console.warn('[detectFieldConflicts] 失败:', e.message); }
  return out;
}

function renderKPI(result, pools) {
  const cands = result.candidates || [];
  const passed = cands.filter(c => c.confidence === 'high' || c.confidence === 'medium').length;
  const traps = pools.trap || [];
  const proxy = pools.proxy || [];
  const base = pools.base || [];
  const stats = result.stats || {};
  const baseRatio = base.length === 0 ? 0 : Math.min(1, base.length / 8);

  const cards = [
    { label: '今日候选', value: cands.length, sub: '扫 ' + (stats.stockScanned || 0) + ' 只', cls: 'accent' },
    { label: '4 闸通过', value: passed, sub: '占总 ' + (cands.length ? Math.round(passed / cands.length * 100) : 0) + '%', cls: 'pass' },
    { label: '陷阱锁定', value: traps.length, sub: '锁定期中', cls: 'danger' },
    { label: '替身池',   value: proxy.length, sub: '等回踩', cls: 'accent' },
    { label: '底仓占比', value: (baseRatio * 100).toFixed(0) + '%', sub: base.length + ' 只持仓', cls: 'pass', bar: baseRatio }
  ];
  // AutoTuner KPI 徽章 (动态, 顶部 KPI 行末尾加 1 个)
  try {
    const rw = window.ReverseWatch;
    if (rw && rw.AutoTuner && typeof rw.AutoTuner.getKpi === 'function') {
      const kpi = rw.AutoTuner.getKpi();
      cards.push({
        label: '🔧 自动调参', value: `${kpi.weekCount} 次`,
        sub: `本周 / 待批 ${kpi.pendingCount} 条`,
        cls: kpi.pendingCount > 0 ? 'warn' : 'accent'
      });
    }
  } catch (e) { console.warn('[renderKPI] 读 AutoTuner 失败:', e.message); }

  // UI 冲突红点: 近 1h 内"用户调 + 系统调"改过同一字段 → 弹红色徽章
  try {
    const conflicts = detectFieldConflicts();
    if (conflicts.length > 0) {
      cards.push({
        label: '⚠ 字段冲突', value: `${conflicts.length} 个`,
        sub: conflicts.slice(0, 2).map(c => c.target).join(', ') + (conflicts.length > 2 ? '…' : ''),
        cls: 'danger'
      });
    }
  } catch (e) { console.warn('[renderKPI] 冲突检测失败:', e.message); }

  // daemon 心跳徽章 (?v=daemon1): 读 _rw_daemon_state.json 缓存 (loadDaemonState 注入)
  // 显示: 上次心跳 Xs 前 + 触发数 + regime 倍数
  try {
    const ds = (typeof _daemonState !== 'undefined' && _daemonState) ? _daemonState : null;
    if (ds && ds.heartbeatAt) {
      const hbAge = Math.round((Date.now() - new Date(ds.heartbeatAt).getTime()) / 1000);
      const regime = ds.regime || {};
      const alerts = ds.alerts || [];
      const alertCount = Array.isArray(alerts) ? alerts.length : 0;
      // 心跳 >3min = 红色故障; 否则正常
      const hbCls = hbAge > 180 ? 'danger' : (regime.current === 'bear' ? 'warn' : 'pass');
      const multTxt = regime.positionMultiplier != null ? `, 仓位×${regime.positionMultiplier}` : '';
      const hbTxt = hbAge < 60 ? `${hbAge}s 前` : `${Math.round(hbAge/60)}min 前`;
      cards.push({
        label: '🛰 daemon', value: hbTxt,
        sub: `${alertCount} 信号 / regime ${regime.current || '?'}${multTxt}`,
        cls: hbCls
      });
    } else if (ds && ds.daemon?.status === 'down') {
      cards.push({ label: '🛰 daemon', value: 'down', sub: '进程未启动, 见 logs/', cls: 'danger' });
    }
  } catch (e) { console.warn('[renderKPI] daemon 心跳读取失败:', e.message); }

  kpiRow.innerHTML = cards.map(c =>
    `<div class="kpi ${c.cls}">
      <div class="label">${escapeHtml(c.label)}</div>
      <div class="value">${escapeHtml(c.value)}</div>
      <div class="sub">${escapeHtml(c.sub)}</div>
      ${c.bar != null ? `<div class="bar"><i style="width:${Math.min(100, c.bar * 100)}%;"></i></div>` : ''}
    </div>`
  ).join('');
}

function renderGates(result) {
  const gates = result.gates || [];
  if (gates.length === 0) {
    gatesRow.innerHTML = '<div class="empty-state">⚪ 4 闸检查未返回数据</div>';
    return;
  }
  gatesRow.innerHTML = gates.map(g =>
    `<div class="gate ${g.status || 'pass'}">
      <div class="name">${escapeHtml(g.label)}<span class="badge">${g.status === 'pass' ? 'PASS' : g.status === 'warn' ? 'WARN' : 'FAIL'}</span></div>
      <div class="metric">${escapeHtml(g.metric || '—')}</div>
      <div class="note">${escapeHtml(g.note || '')}</div>
    </div>`
  ).join('');
}

function renderRecs(result) {
  const cands = result.candidates || [];
  if (cands.length === 0) {
    recGrid.innerHTML = '<div class="empty-state">📭 今日无符合反向策略 4 闸的候选</div>' +
      ((result.blocked && result.blocked.length)
        ? `<div class="empty-state" style="margin-top:8px;font-size:11px;">⚠ ${result.blocked.length} 只被 4 闸挡掉: ${result.blocked.slice(0, 3).map(b => escapeHtml(b.code)).join(', ')} 等</div>`
        : '');
    return;
  }
  recGrid.innerHTML = cands.map(c => {
    const conf = c.confidence || 'medium';
    const sec = secKey(c.sector);
    const strength = ((c.limitsUpRate_2d || 0) * 100).toFixed(0);
    const pbDelta = (c.sectorPbMedian != null && c.pbPercentile != null)
      ? (c.sectorPbMedian - c.pbPercentile).toFixed(0)
      : '—';
    const confLabel = conf === 'high' ? '🟢 高' : conf === 'medium' ? '🟡 中' : '🔴 低';
    return `<div class="rec-card" data-sec="${sec}">
      <div class="row1">
        <div><span class="sym">${escapeHtml(c.code)}</span><span class="name">${escapeHtml(c.name)}</span></div>
        <span class="conf ${conf}">${confLabel}</span>
      </div>
      <div class="meta">
        <span>板块 <b>${escapeHtml(c.sector)}</b></span>
        <span>强度 <b>${strength}%</b></span>
        <span>PB <b>${escapeHtml(c.pbPercentile)}%</b></span>
        <span>差 <b>${pbDelta}pp</b></span>
      </div>
      <div class="reason">💡 ${escapeHtml(c.aiReason)}</div>
      <div class="actions">
        <button class="btn primary" data-buy="${escapeHtml(c.code)}" data-name="${escapeHtml(c.name)}" data-sector="${escapeHtml(c.sector)}">📝 自选下单</button>
        <button class="btn" data-detail="${escapeHtml(c.code)}">🔍 详情</button>
      </div>
    </div>`;
  }).join('');

  // 事件委托
  recGrid.querySelectorAll('[data-buy]').forEach(btn => {
    btn.onclick = () => openBuyDialog(btn.dataset.buy, btn.dataset.name, btn.dataset.sector);
  });
  recGrid.querySelectorAll('[data-detail]').forEach(btn => {
    btn.onclick = () => showDetail(btn.dataset.detail);
  });
}

// ============== 详情 modal (F7) ==============
// 当前数据 — 详情 modal 需要从这里查 candidate / pool
let _currentResult = null;
let _currentPools = null;
let _currentDetail = null;

function showDetail(symbol) {
  const cands = (_currentResult?.candidates) || [];
  // 也允许从 4 池查 (兼容 renderPools 触发)
  const poolSources = [];
  if (_currentPools) {
    ['base', 'dragon', 'proxy', 'trap'].forEach(k => {
      (_currentPools[k] || []).forEach(it => poolSources.push({ ...it, _pool: k }));
    });
  }
  let c = cands.find(x => x.code === symbol);
  if (!c) {
    const p = poolSources.find(x => x.code === symbol);
    if (p) c = p;
  }
  // ?v=detail-holdings-fallback1: 持仓股兜底 — candidates 和 4 池没有时, 从 holdings 拉
  // 场景: 持仓列表点 📊 想看持仓详情, 持仓股自然不在推荐池, 之前直接 toast "没找到该票"
  if (!c) {
    try {
      const holdings = JSON.parse(localStorage.getItem('_rw_holdings') || '[]');
      const h = holdings.find(x => x.code === symbol);
      if (h) c = { ...h, _pool: 'holdings' };
    } catch (e) { console.warn('[showDetail] holdings 兜底解析失败:', e.message); }
  }
  if (!c) { toast('没找到该票: ' + symbol, 'warn'); return; }
  _currentDetail = c;

  const risk = c.hasQuantSeat ? '⚠️ 有量化席位, 滑点风险 ≥0.5%' : '✅ 无量化席位, 滑点风险低';
  const confLabel = c.confidence === 'high' ? '🟢 高信心' : c.confidence === 'medium' ? '🟡 中信心' : '🔴 低信心';
  const entry = c.confidence === 'high'
    ? '今日尾盘可小仓 (≤5%) 试水'
    : c.confidence === 'medium'
      ? '等回踩 5 日线 (-3%~-5%) 再进'
      : '建议放弃, 风险大于机会';

  // 历史反馈
  const fb = loadFeedback()[c.code];

  // 立即渲染骨架 (含加载中), 然后异步加载 K 线
  const G = SETTINGS.gates;
  const sectorPct = (c.limitsUpRate_2d * 100).toFixed(0);
  const sectorPass = (c.limitsUpRate_2d || 0) >= G.sectorMin;
  const pbGap = (c.sectorPbMedian != null && c.pbPercentile != null)
    ? (c.sectorPbMedian - c.pbPercentile) : 0;
  const pbPass = pbGap >= G.pbDeltaMin;
  const dragonPass = !c.isSectorLeader;
  const quantPass = !c.hasQuantSeat;
  const sectorMinStr = (G.sectorMin * 100).toFixed(0);
  const pbMinStr = G.pbDeltaMin;
  const modeLabel = DATA_MODE === 'mock' ? '🧪 mock'
                  : DATA_MODE === 'real' ? '📡 real' : '🔄 auto';

  detailDialogBody.innerHTML = `
    <div style="font-size:16px;margin-bottom:8px;">
      <b style="color:var(--text);">${escapeHtml(c.code)} ${escapeHtml(c.name)}</b>
      <span style="color:var(--text-mute);font-size:12px;margin-left:6px;">· ${confLabel}</span>
      <span class="data-mode-badge" style="background:var(--bg-2);color:var(--text-2);font-size:10px;padding:2px 6px;border-radius:3px;margin-left:6px;">${modeLabel}</span>
      ${c._pool ? `<span style="background:var(--bg-2);color:var(--text-2);font-size:10px;padding:2px 6px;border-radius:3px;margin-left:6px;">${POOL_META[c._pool]?.title || c._pool}</span>` : ''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:12px;">
      <div><span style="color:var(--text-mute);">板块</span><br><b style="color:var(--text);">${escapeHtml(c.sector || '?')}</b></div>
      <div><span style="color:var(--text-mute);">板块强度 (近 2 日封板率)</span><br><b style="color:${sectorPass ? 'var(--success)' : 'var(--danger)'};">${sectorPct}%</b></div>
      <div><span style="color:var(--text-mute);">个股 PB 分位</span><br><b style="color:var(--text);">${escapeHtml(c.pbPercentile ?? '?')}%</b></div>
      <div><span style="color:var(--text-mute);">板块 PB 中位</span><br><b style="color:var(--text);">${escapeHtml(c.sectorPbMedian ?? '?')}%</b></div>
      <div><span style="color:var(--text-mute);">PB 差 (中位-个股)</span><br><b style="color:${pbPass ? 'var(--success)' : 'var(--warn)'};">${pbGap}pp</b></div>
      <div><span style="color:var(--text-mute);">非龙头</span><br><b style="color:${dragonPass ? 'var(--success)' : 'var(--warn)'};">${dragonPass ? '✅ 是替身' : '⚠ 是龙头'}</b></div>
    </div>

    <div id="detailKline" style="background:var(--bg-2);padding:8px;border-radius:6px;margin-bottom:12px;">
      <div style="color:var(--text-mute);font-size:11px;text-align:center;padding:32px 0;">📈 加载 K 线中…</div>
    </div>

    <div id="detailAI" style="background:rgba(0,217,255,0.06);border-left:3px solid var(--accent);padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:10px;line-height:1.6;white-space:pre-line;">
      <b style="color:var(--accent);">🧠 AI 总管分析</b><br>
      <span style="color:var(--text-mute);">加载中…</span>
    </div>

    <div style="background:var(--bg-2);padding:8px 10px;border-radius:4px;font-size:12px;margin-bottom:10px;">
      <b>🚪 4 闸通过情况</b><br>
      <span style="color:${sectorPass ? 'var(--success)' : 'var(--danger)'};">${sectorPass ? '✓' : '✗'}</span> 板块强度 ≥ ${sectorMinStr}% (本股 ${sectorPct}%)<br>
      <span style="color:${pbPass ? 'var(--success)' : 'var(--danger)'};">${pbPass ? '✓' : '✗'}</span> PB 分位差 ≥ ${pbMinStr}pp (本股差 ${pbGap}pp)<br>
      <span style="color:${dragonPass ? 'var(--success)' : 'var(--warn)'};">${dragonPass ? '✓' : '⚠'}</span> ${dragonPass ? '非板块龙头 (替身)' : '⚠ 是板块龙头'}<br>
      <span style="color:${quantPass ? 'var(--success)' : 'var(--warn)'};">${quantPass ? '✓' : '⚠'}</span> 量化席位 (${c.hasQuantSeat ? '有, 滑点风险' : '无'})
    </div>

    <div style="background:var(--bg-2);padding:8px 10px;border-radius:4px;font-size:12px;margin-bottom:10px;">
      <b>🎯 操作建议</b><br>
      <b>进场时机:</b> ${entry}<br>
      <b>仓位上限:</b> 10% (单票) — 实际建议 ${c.confidence === 'high' ? '5%' : '3%'}<br>
      <b>止损参考:</b> 买入价 -5%<br>
      <b>持有期:</b> 5-10 个交易日 (板块轮动周期)
    </div>

    <div style="background:${c.hasQuantSeat ? 'rgba(255,167,38,0.08)' : 'rgba(0,230,118,0.06)'};padding:8px 10px;border-radius:4px;font-size:12px;margin-bottom:10px;">
      <b>${c.hasQuantSeat ? '⚠️ 风险提示' : '✅ 风险评估'}</b><br>
      ${risk}<br>
      <span style="color:var(--text-mute);">板块强度 ${sectorPct}% ${sectorPass ? '满足' : '低于'} ${sectorMinStr}% 阈值 · ${sectorPass ? '可参与' : '不建议追高'}</span>
    </div>

    <div id="detailRiskMine" style="background:var(--bg-2);padding:8px 10px;border-radius:4px;font-size:12px;margin-bottom:10px;">
      <b>⚠️ 基本面排雷 (RiskMine)</b><br>
      <span style="color:var(--text-mute);">检查中…</span>
    </div>

    <div id="detailFeedback" style="background:var(--bg-1);border:1px dashed var(--border-strong);padding:10px 12px;border-radius:6px;font-size:12px;">
      <b>🎓 自学习反馈</b>
      <div style="color:var(--text-mute);font-size:11px;margin:4px 0 8px;">
        你的反馈会写入本地, 下次 AI 总管分析时会参考历史偏好。
        ${fb ? `<br>历史: <b style="color:${fb.verdict === 'up' ? 'var(--success)' : fb.verdict === 'down' ? 'var(--danger)' : 'var(--warn)'};">${fb.verdict === 'up' ? '✓ 采纳' : fb.verdict === 'part' ? '⚠ 部分' : '✗ 否定'}</b> (${new Date(fb.ts).toLocaleString('zh-CN')})` : '暂无历史反馈'}
      </div>
      <div style="display:flex;gap:6px;">
        <button data-fb="up" class="btn-fb">✓ 采纳</button>
        <button data-fb="part" class="btn-fb">⚠ 部分</button>
        <button data-fb="down" class="btn-fb">✗ 否定</button>
      </div>
    </div>
  `;

  // 自学习按钮事件
  detailDialogBody.querySelectorAll('.btn-fb').forEach(btn => {
    btn.onclick = () => {
      saveFeedback(c.code, btn.dataset.fb, '');
      toast('已记录反馈: ' + c.code + ' ' + (btn.dataset.fb === 'up' ? '✓' : btn.dataset.fb === 'part' ? '⚠' : '✗'), 'ok');
      // 重渲反馈区
      const fbNew = loadFeedback()[c.code];
      const note = btn.parentElement.previousElementSibling;
      note.innerHTML = `你的反馈会写入本地, 下次 AI 总管分析时会参考历史偏好。<br>历史: <b style="color:${fbNew.verdict === 'up' ? 'var(--success)' : fbNew.verdict === 'down' ? 'var(--danger)' : 'var(--warn)'};">${fbNew.verdict === 'up' ? '✓ 采纳' : fbNew.verdict === 'part' ? '⚠ 部分' : '✗ 否定'}</b> (${new Date(fbNew.ts).toLocaleString('zh-CN')})`;
    };
  });

  detailDialog.classList.remove('hidden');

  // 异步加载 K 线 + AI 分析 + RiskMine
  (async () => {
    let rows = null, tech = null, kErr = null;
    try {
      const r = await fetchKLine(c.code);
      rows = r.rows;
      tech = calcTechs(rows);
    } catch (e) {
      kErr = e.message || String(e);
    }
    const kBox = document.getElementById('detailKline');
    if (kBox) {
      if (rows && rows.length) {
        kBox.innerHTML = renderKLineSvg(rows) +
          (tech ? `<div style="display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:6px;font-size:11px;color:var(--text-mute);font-family:var(--font-num);">
            <span>收 ${tech.last.close.toFixed(2)}</span>
            <span>MA5 ${tech.ma5?.toFixed(2) ?? '?'}</span>
            <span>MA20 ${tech.ma20?.toFixed(2) ?? '?'}</span>
            <span>5 日 ${tech.chg5?.toFixed(1) ?? '?'}%</span>
            <span>20 日 ${tech.chg20?.toFixed(1) ?? '?'}%</span>
            <span>量比 ${tech.volRatio?.toFixed(2) ?? '?'}</span>
            <span style="color:var(--accent);">${escapeHtml(tech.trend)}</span>
            <span style="color:${tech.shape.includes('阳') ? 'var(--success)' : tech.shape.includes('阴') ? 'var(--danger)' : 'var(--text-mute)'};">${escapeHtml(tech.shape)}</span>
          </div>` : '');
      } else {
        kBox.innerHTML = `<div style="color:var(--danger);font-size:12px;text-align:center;padding:24px 0;">⚠️ K 线加载失败: ${escapeHtml(kErr || '无数据')}<br><span style="color:var(--text-mute);font-size:10px;">检查网络/或这票已退市</span></div>`;
      }
    }

    // RiskMine 基本面排雷 (同步读缓存快路径, 异步预热)
    const rBox = document.getElementById('detailRiskMine');
    if (rBox) {
      const RM = window.ReverseWatch?.RiskMine;
      if (!RM) {
        rBox.innerHTML = '<b>⚠️ 基本面排雷 (RiskMine)</b><br><span style="color:var(--text-mute);">RiskMine 未加载</span>';
      } else {
        let reasons = RM.readCachedRisk ? RM.readCachedRisk(c.code) : null;
        // 快路径返回 null = 缓存未扫/过期/失败 → 区分处理
        if (reasons === null) {
          const status = RM.readCachedStatus ? RM.readCachedStatus(c.code) : 'unknown';
          if (status === 'failed') {
            rBox.style.background = 'rgba(255,167,38,0.08)';
            rBox.innerHTML = '<b style="color:var(--warn);">⚠️ 基本面排雷 (RiskMine)</b><br>' +
              '<span style="color:var(--warn);">扫描失败 (dev-proxy 未起或 akshare 无响应)</span><br>' +
              '<span style="color:var(--text-mute);font-size:10px;">本股基本面未知, 不在 RiskMine 候选排除内</span>';
          } else {
            rBox.innerHTML = '<b>⚠️ 基本面排雷 (RiskMine)</b><br><span style="color:var(--text-mute);">未扫描, 扫描中…</span>';
            let scanOk = true;
            try { reasons = await RM.scanRisk(c.code); }
            catch (e) { reasons = null; scanOk = false; console.warn('[showDetail] RiskMine scanRisk 失败:', e.message); }
            // 二次校验: scanRisk 可能写了 status:'failed', 避免 catch 把失败当无风险
            if (!scanOk || reasons === null) {
              rBox.style.background = 'rgba(255,167,38,0.08)';
              rBox.innerHTML = '<b style="color:var(--warn);">⚠️ 基本面排雷 (RiskMine)</b><br>' +
                '<span style="color:var(--warn);">扫描失败 (dev-proxy 未起或 akshare 无响应)</span>';
              reasons = null; // 跳过后续渲染
            }
          }
        }
        if (reasons !== null) {
          if (reasons.length > 0) {
            const bg = reasons.some(r => (RM.SEVERITY?.[r] || '') === 'high') ? 'rgba(255,82,82,0.10)' : 'rgba(255,167,38,0.08)';
            rBox.style.background = bg;
            rBox.innerHTML = `<b style="color:var(--danger);">⚠️ 基本面排雷 (RiskMine)</b><br>` +
              `<b style="color:var(--danger);">命中 ${reasons.length} 项:</b> ` +
              reasons.map(r => `${escapeHtml(r)} <span style="color:var(--text-mute);font-size:10px;">(${escapeHtml(RM.SEVERITY?.[r] || '?')})</span>`).join('; ') +
              `<br><span style="color:var(--text-mute);font-size:10px;">第 5 闸已自动排除该候选 (理由: 基本面风险)</span>`;
          } else {
            rBox.style.background = 'rgba(0,230,118,0.06)';
            rBox.innerHTML = '<b>✅ 基本面排雷 (RiskMine)</b><br><span style="color:var(--success);">无商誉偏高/股东减持/业绩亏损等风险</span>';
          }
        }
      }
    }

    const aBox = document.getElementById('detailAI');
    if (aBox) {
      // AI 升级: 走 LLM (有 provider 配时 — 含本地 noAuth), 否则回退到规则版
      const hasAiCfg = (() => {
        if (!window.ReverseWatch?.AIAdapter) return false;
        const cfg = window.ReverseWatch.AIAdapter.getAIConfig();
        const pd = window.ReverseWatch.AIAdapter.PROVIDER_DEFAULTS?.[cfg.provider] || {};
        return pd.noAuth ? !!cfg.model : !!cfg.apiKey;
      })();
      if (window.ReverseWatch && window.ReverseWatch.AIDetail) {
        window.ReverseWatch.AIDetail.renderDetailAI(c, tech, aBox);
        // 自学习反馈追加在 AI 简评头部
        const fbNow = loadFeedback()[c.code];
        if (fbNow && !hasAiCfg) {
          // 仅规则版时显示 (LLM 版由 renderDetailAI 自己输出更友好的反馈)
          const fbTag = fbNow.verdict === 'up' ? '✓ 采纳' : fbNow.verdict === 'part' ? '⚠ 部分' : '✗ 否定';
          aBox.querySelector('.detail-ai-body')?.insertAdjacentText('afterbegin',
            `【自学习 · ${fbTag} @ ${new Date(fbNow.ts).toLocaleString('zh-CN')}】\n\n`);
        }
      } else {
        // 无 AIAdapter 模块, 保留原规则版渲染
        let aiText = aiChiefAnalyst(c, tech);
        const fbNow = loadFeedback()[c.code];
        if (fbNow) {
          const fbTag = fbNow.verdict === 'up' ? '✓ 采纳' : fbNow.verdict === 'part' ? '⚠ 部分' : '✗ 上次否定';
          aiText = `【自学习 · ${fbTag} @ ${new Date(fbNow.ts).toLocaleString('zh-CN')}】AI 已参考你的历史反馈调整权重。\n\n` + aiText;
        }
        aBox.innerHTML = `<b style="color:var(--accent);">🧠 AI 总管分析</b><br><span style="white-space:pre-line;">${escapeHtml(aiText)}</span>`;
      }
    }
  })();
}

function closeDetailDialog() {
  detailDialog.classList.add('hidden');
  _currentDetail = null;
}

detailClose.onclick = closeDetailDialog;
detailGoBuy.onclick = () => {
  if (!_currentDetail) return;
  // UI #10 修: _currentDetail 可能在 render() 后过期, 从 _currentResult 实时 lookup
  // 如果用户看到的详情股已不在最新候选里, 给 toast 提示并刷新详情
  const latest = (_currentResult && _currentResult.candidates || []).find(c => c.code === _currentDetail.code);
  if (!latest) {
    const c = _currentDetail;
    closeDetailDialog();
    toast(`⚠️ ${c.code} ${c.name} 不在最新候选中, 已取消下单`, 'warn');
    return;
  }
  const c = latest; // 用最新的, 数据更准
  closeDetailDialog();
  openBuyDialog(c.code, c.name, c.sector);
};

const POOL_META = {
  base:   { title: '底仓',     sub: '50% 上限' },
  dragon: { title: '龙头观察', sub: '看戏中'   },
  proxy:  { title: '替身候选', sub: '等回踩'   },
  trap:   { title: '陷阱锁定', sub: '禁止再接' }
};

function renderPools(pools) {
  pools = pools || { base: [], dragon: [], proxy: [], trap: [] };
  poolsRow.innerHTML = Object.keys(POOL_META).map(sleeve => {
    const meta = POOL_META[sleeve];
    const items = pools[sleeve] || [];
    const list = items.length === 0
      ? '<div class="empty">(空)</div>'
      : items.slice(0, 5).map(it => {
          const lock = (sleeve === 'trap' && it.lockedUntil)
            ? `<span class="lock">⏱ ${escapeHtml(fmtRemain(it.lockedUntil))}</span>`
            : '';
          const reason = it.reason
            ? `<span class="reason-text">${escapeHtml(it.reason)}</span>`
            : '';
          const code = it.code || '';
          return `<div class="item clickable" data-code="${escapeHtml(code)}" title="点击看详情">
            <span>${escapeHtml(code)} ${escapeHtml(it.name || '')}</span>${lock || reason}
          </div>`;
        }).join('');
    return `<div class="pool ${sleeve}">
      <div class="title"><span>${meta.title}</span><span class="count">${items.length} · ${meta.sub}</span></div>
      ${list}
    </div>`;
  }).join('');
  // 委托: 4 池每行点击 → 详情
  poolsRow.querySelectorAll('.item.clickable').forEach(el => {
    el.onclick = () => showDetail(el.dataset.code);
  });
}

function renderFunnel(result, pools) {
  const s = result.stats || {};
  const totalSectors = s.sectorScanned || 0;
  const totalStocks = s.stockScanned || 0;
  const survivors = (pools.proxy || []).length;
  const cands = (result.candidates || []).length;
  const blocked = (result.blocked || []).length;

  // 4 个阶段(从粗到精)
  const stages = [
    { num: 'STAGE 1', name: '板块筛选', stat: '<b>' + totalSectors + '</b> 板块', sub: '强度 ≥ 60%', cls: 'pass' },
    { num: 'STAGE 2', name: '成分股过滤', stat: '<b>' + totalStocks + '</b> 只票', sub: '排除龙头 + 涨停', cls: 'pass' },
    { num: 'STAGE 3', name: '4 闸预检', stat: '<b>' + survivors + '</b> 通过', sub: '挡 ' + blocked + ' 只', cls: blocked > 0 ? 'warn' : 'pass' },
    { num: 'STAGE 4', name: 'AI 推荐', stat: '<b>' + cands + '</b> 只', sub: '中短 5-10 天', cls: 'pass' }
  ];

  // 4 闸代码段
  const gates = [
    { label: '板块强度 ≥ 60%', code: 'if (sector.limitUpRate_2d < 0.6) block()', block: true },
    { label: 'PB 分位 ≤ 中位-20pp', code: 'if (stock.pbPercentile > median-20) block()', block: true },
    { label: '不是板块龙头', code: 'if (stock.isSectorLeader) block()', block: true },
    { label: '仓位 ≤ 10%', code: 'if (shares*price/account > 0.1) block()', block: true }
  ];

  // 4 池机制
  const poolRules = [
    { name: '底仓 base', rule: '手动入, 高分红/低波动, 上限 50%' },
    { name: '龙头 dragon', rule: '板块强度 ≥ 60% 时自动入, 只看不接' },
    { name: '替身 proxy', rule: '4 闸全过自动入, 等回踩低吸' },
    { name: '陷阱 trap', rule: '量化 > 3 / 鱼尾, 锁 24h' }
  ];

  funnelBox.innerHTML =
    `<div class="funnel-stages">
      ${stages.map(st => `
        <div class="funnel-stage ${st.cls}">
          <div class="stage-num">${st.num}</div>
          <div class="stage-name">${escapeHtml(st.name)}</div>
          <div class="stage-stat">${st.stat} <span style="opacity:.6;">· ${escapeHtml(st.sub)}</span></div>
          <span class="stage-arrow">→</span>
        </div>`).join('')}
    </div>

    <div class="funnel-gates">
      ${gates.map(g => `
        <div class="funnel-gate block">
          <div class="g-label">
            <span>🚪 ${escapeHtml(g.label)}</span>
            <span class="g-badge">BLOCK</span>
          </div>
          <code class="g-code">${escapeHtml(g.code)}</code>
        </div>`).join('')}
    </div>

    <div class="funnel-pools">
      ${poolRules.map(p => `
        <div class="funnel-pool">
          <div class="pool-name">🪙 ${escapeHtml(p.name)}</div>
          <div class="pool-rule">${escapeHtml(p.rule)}</div>
        </div>`).join('')}
    </div>`;
}

// ============== 持仓规律 UI ==============
function renderHoldingRules() {
  const h = loadHolding();
  const fb = loadHoldingFb();
  const curPreset = loadCurrentPreset();

  // 预设按钮组(顶部)
  const presetBar = `<div class="hr-presets">
    <span class="hr-preset-label">📦 候选预设:</span>
    ${Object.values(HOLDING_PRESETS).map(p => `
      <button class="btn-preset ${p.id === curPreset ? 'active' : ''}" data-preset="${escapeHtml(p.id)}" title="${escapeHtml(p.desc)}">
        ${escapeHtml(p.name)}
      </button>
    `).join('')}
    <span class="hr-preset-hint">点击应用整套规则到下方字段</span>
  </div>`;

  holdingRules.innerHTML = presetBar + HOLDING_RULES_META.map(rule => {
    const fieldsHtml = rule.fields.map(f => {
      const val = h[f.key];
      const display = (f.key.endsWith('Pct') || f.key === 'addMaxRatio') ? (val * 100).toFixed(0) : val;
      return `<label class="hr-field">
        <span class="hr-label">${escapeHtml(f.label)}</span>
        <input type="number" data-rule="${escapeHtml(rule.id)}" data-key="${escapeHtml(f.key)}"
               min="${f.min}" max="${f.max}" step="${f.step}" value="${display}">
        <span class="hr-suffix">${escapeHtml(f.suffix)}</span>
      </label>`;
    }).join('');
    const fbr = fb[rule.id];
    const fbTag = fbr
      ? `<span class="hr-fb-tag hr-fb-${escapeHtml(fbr.verdict)}">${fbr.verdict === 'up' ? '✓ 采纳' : fbr.verdict === 'part' ? '⚠ 部分' : '✗ 否定'} · ${new Date(fbr.ts).toLocaleDateString('zh-CN')}</span>`
      : '';
    return `<div class="hr-rule" data-rule="${escapeHtml(rule.id)}">
      <div class="hr-head">
        <span class="hr-icon">${escapeHtml(rule.icon)}</span>
        <span class="hr-title">${escapeHtml(rule.title)}</span>
        <span class="hr-desc">${escapeHtml(rule.desc)}</span>
        <span class="hr-sources">${rule.sources.map(s => `<span class="hr-source">${escapeHtml(s)}</span>`).join('')}</span>
      </div>
      <div class="hr-fields">${fieldsHtml}</div>
      <div class="hr-foot">
        <span class="hr-fb-label">自学习:</span>
        <button class="btn-fb btn-fb-sm" data-rule="${escapeHtml(rule.id)}" data-fb="up">✓ 采纳</button>
        <button class="btn-fb btn-fb-sm" data-rule="${escapeHtml(rule.id)}" data-fb="part">⚠ 部分</button>
        <button class="btn-fb btn-fb-sm" data-rule="${escapeHtml(rule.id)}" data-fb="down">✗ 否定</button>
        ${fbTag}
      </div>
    </div>`;
  }).join('');

  // 字段编辑 → localStorage
  holdingRules.querySelectorAll('input[type="number"]').forEach(inp => {
    inp.onchange = () => {
      const raw = parseFloat(inp.value);
      if (isNaN(raw)) return;
      const key = inp.dataset.key;
      const patch = {};
      // 百分比字段存小数, 其他存原值
      if (key.endsWith('Pct') || key === 'addMaxRatio') patch[key] = raw / 100;
      else patch[key] = raw;
      saveHolding(patch);
      toast('已保存: ' + key + ' = ' + inp.value + (inp.nextElementSibling?.textContent || ''), 'ok');
    };
  });
  // 反馈按钮
  holdingRules.querySelectorAll('.btn-fb-sm').forEach(btn => {
    btn.onclick = () => {
      saveHoldingFb(btn.dataset.rule, btn.dataset.fb, '');
      toast('已记录反馈: ' + btn.dataset.rule + ' ' + (btn.dataset.fb === 'up' ? '✓' : btn.dataset.fb === 'part' ? '⚠' : '✗'), 'ok');
      renderHoldingRules();
    };
  });
  // 预设按钮 → 应用整套规则
  holdingRules.querySelectorAll('.btn-preset').forEach(btn => {
    btn.onclick = () => {
      const p = applyPreset(btn.dataset.preset);
      if (p) {
        toast('已应用预设: ' + p.name + ' (' + Object.keys(p.values).length + ' 项)', 'ok');
        renderHoldingRules();
      }
    };
  });
}

function renderHidden(result, pools) {
  const traps = pools.trap || [];
  const trapCountdown = traps.filter(t => t.lockedUntil).map(t => escapeHtml(t.code) + ' 解锁 ' + escapeHtml(fmtRemain(t.lockedUntil))).join(' · ') || '无';
  const cands = result.candidates || [];
  const passed = cands.filter(c => c.confidence === 'high' || c.confidence === 'medium').length;
  const passRate = cands.length === 0 ? '—' : (passed / cands.length * 100).toFixed(0) + '%';

  hiddenBox.innerHTML =
    `<div class="row ${traps.length ? 'danger' : ''}"><span>🚫 trap 锁倒计时</span><b>${trapCountdown}</b></div>
     <div class="row"><span>📈 本批 4 闸通过率</span><b>${passRate}</b></div>`;
}

function renderMeta(result, source) {
  const s = result.stats || {};
  metaLine.textContent = `扫描 ${s.sectorScanned || 0} 板块 / ${s.stockScanned || 0} 只, 入选 ${s.finalCandidates || 0}, 耗时 ${s.ms || 0}ms`;
  $('sourceLine').textContent = '数据源: ' + (source || 'auto');
}

// ============== 主流程 ==============

async function render(fromRisk) {
  recGrid.innerHTML = '<div class="loading">⏳ 拉取 AI 推荐 + 4 池快照...</div>';
  try {
    const { result, pools, source } = await getData();
    _currentResult = result;  // 详情 modal 需要
    _currentPools = pools;     // 4 池详情需要
    renderKPI(result, pools);
    renderGates(result);
    renderRecs(result);
    renderPools(pools);
    renderFunnel(result, pools);
    renderHoldingRules();
    renderHidden(result, pools);
    // 学习闭环 排雷层: 异步预热所有候选股 (不阻塞 UI, 6h 缓存)
    const rw0 = window.ReverseWatch || {};
    if (rw0.RiskMine && rw0.RiskMine.prewarmPoolRisk) {
      // 池代码 = 4 池 (base/proxy/dragon/trap) + candidates (推荐区显示的, 可能不在 4 池内但需要排雷)
      const poolCodes = (pools.base || []).concat(pools.proxy || [], pools.dragon || [], pools.trap || []).map(s => s.code);
      const candCodes = ((result && result.candidates) || []).map(c => c.code);
      const uniqueCodes = [...new Set([...poolCodes, ...candCodes])];
      // 排雷进度条 (插入到 rec-grid 末尾, 已扫描的股不再显示, 但未扫描的开始展示进度)
      const warmingRow = (() => {
        const need = uniqueCodes.filter(c => !rw0.RiskMine.readCachedRisk(c)).length;
        if (need === 0) return null;
        // 快速重渲时清掉旧的 bar, 避免叠加
        const oldBar = document.getElementById('riskWarmingBar');
        if (oldBar) oldBar.remove();
        const row = document.createElement('div');
        row.id = 'riskWarmingBar';
        row.style.cssText = 'grid-column:1/-1;background:var(--bg-2);border:1px dashed var(--accent);border-radius:4px;padding:6px 10px;margin-top:6px;font-size:11px;color:var(--text-mute);display:flex;align-items:center;gap:8px;';
        row.innerHTML = `<span style="color:var(--accent);">🛡</span> <span id="riskWarmingText">基本面排雷 0/${need}</span> <span id="riskWarmingBarInner" style="flex:1;background:var(--bg-1);border-radius:2px;height:4px;overflow:hidden;"><i id="riskWarmingBarFill" style="display:block;width:0%;height:100%;background:var(--accent);transition:width 0.3s;"></i></span>`;
        recGrid.appendChild(row);
        return row;
      })();
      const removeWarming = () => {
        const r = document.getElementById('riskWarmingBar');
        if (r) r.remove();
      };
      rw0.RiskMine.prewarmPoolRisk(uniqueCodes, {
        onProgress: (done, total) => {
          const text = document.getElementById('riskWarmingText');
          const fill = document.getElementById('riskWarmingBarFill');
          if (text) text.textContent = `基本面排雷 ${done}/${total}`;
          if (fill) fill.style.width = `${Math.min(100, (done / total) * 100).toFixed(0)}%`;
          if (done >= total) {
            // 全部完成后 1.5s 自动消失
            setTimeout(removeWarming, 1500);
            // 强制重渲, 让 risk 命中的候选被排掉 (reverseScreener 同步读缓存, 这次扫描后能命中)
            // fromRisk 守卫: proxy 挂时 todo 永远非空 → 防止无限递归 (A3 修)
            if (!fromRisk) render(true);
          }
        }
      }).catch((e) => { console.warn('[RiskMine prewarm] 异常:', e.message); removeWarming(); });
    }
    // AI 全能管家 (F4.7) — 快照式, 渲染失败不影响主流程
    let chatSnap = null;
    if (window.ReverseWatch && window.ReverseWatch.AIButler) {
      try {
        const snap = {
          regime: result.regime || null,
          positionMultiplier: result.positionMultiplier ?? result.regime?.positionMultiplier ?? 0.5,
          candidates: (result.candidates || []).slice(0, 5),
          pools: pools,
          // ?v=butler-cache6: holdings 真实传 snap, 让 fingerprint.hCnt 反映持仓变化
          // 之前缺这块 → hCnt 永远 0 → fingerprint 的 holdings 段死代码
          holdings: (() => {
            try {
              const raw = JSON.parse(localStorage.getItem('_rw_holdings') || '[]');
              return Array.isArray(raw) ? raw.map(h => ({ code: h.code, shares: h.shares, price: h.price })) : [];
            } catch (e) { console.warn('[app] snap holdings 解析失败:', e.message); return []; }
          })(),
          ts: Date.now()
        };
        window.ReverseWatch.AIButler.renderButlerPanelCached(snap, $('butlerPanel'));
        chatSnap = snap;
      } catch (e) { console.warn('[AI Butler] render fail:', e); }
    }
    // AI 管家对话抽屉 (用户跟 LLM 多轮, 可调量化标准)
    if (window.ReverseWatch && window.ReverseWatch.AIChat) {
      try {
        const snap2 = chatSnap || { candidates: [], pools: {}, regime: result.regime };
        window.ReverseWatch.AIChat.renderChatPanel($('butlerPanel'), snap2, {
          settings: SETTINGS,
          holding: loadHolding(),
          customPrompt: getCustomPrompt()
        });
      } catch (e) { console.warn('[AI Chat] render fail:', e); }
    }
    renderMeta(result, source);
    // 顶栏 regime 徽标 (开闸后启用; 非 dispatcher 路径下静默)
    // 必须放在 renderMeta 之后, 否则会被 textContent 覆盖
    if (result.regime && window.ReverseWatch && window.ReverseWatch.RegimeUI) {
      window.ReverseWatch.RegimeUI.renderRegimeBar(result.regime, $('metaLine'));
    }
    // 熊市空态: 在 F3 推荐区上方插入"今日防守"提示
    if (result.regime && result.regime.regime === 'bear') {
      const bearNode = window.ReverseWatch.RegimeUI.renderBearEmpty();
      const sec = recGrid.closest('.section');
      let bearSlot = $('bearEmptySlot');
      if (!bearSlot) {
        bearSlot = document.createElement('div');
        bearSlot.id = 'bearEmptySlot';
        sec.insertBefore(bearSlot, recGrid);
      }
      while (bearSlot.firstChild) bearSlot.removeChild(bearSlot.firstChild);
      bearSlot.appendChild(bearNode);
    } else {
      const bearSlot = $('bearEmptySlot');
      if (bearSlot) while (bearSlot.firstChild) bearSlot.removeChild(bearSlot.firstChild);
    }
    toast('已刷新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  } catch (e) {
    console.error('[ReverseWatch] render:', e);
    recGrid.innerHTML = `<div class="error-state">⚠ ${escapeHtml(e.message || String(e))}</div>`;
    toast('拉取失败: ' + e.message, 'error');
  }
}

// AutoTuner 调度启动守卫 (只跑一次, 首次 render() 之后)
let _autoTunerBooted = false;
function bootAutoTuner() {
  if (_autoTunerBooted) return;
  _autoTunerBooted = true;
  const rw = window.ReverseWatch;
  if (!rw || !rw.AutoTuner || typeof rw.AutoTuner.scheduleWeekly !== 'function') return;
  try {
    rw.AutoTuner.scheduleWeekly();
    // 启动时跑一次 7d perf 评估 (清扫历史 applied 待回填的)
    if (typeof rw.AutoTuner._evaluatePerf === 'function') {
      rw.AutoTuner._evaluatePerf().then(r => {
        if (r && r.evaluated > 0) console.log('[auto-tuner] 启动 perf 评估:', r);
      }).catch(e => console.warn('[auto-tuner] _evaluatePerf 失败:', e.message));
    }
  } catch (e) { console.warn('[auto-tuner] boot 失败:', e.message); }
}

// ============== 自选下单 (modal) ==============

let currentBuyCtx = null;

function openBuyDialog(symbol, name, sector) {
  currentBuyCtx = { symbol, name, sector };
  buyDialogBody.innerHTML = `
    <p style="font-size:13px;color:var(--text-2);margin-bottom:8px;">
      <b style="color:var(--text);">${escapeHtml(symbol)} ${escapeHtml(name)}</b>
      · 板块 <b>${escapeHtml(sector)}</b>
    </p>
    <label>你为什么想接 (理由)</label>
    <textarea id="buyReason" rows="2" placeholder="例: 板块 PB 低, 替身位, 距止损 5%"></textarea>
    <label>股数 (100 整手, 单票 10% 上限)</label>
    <input type="number" id="buyShares" value="100" step="100" min="100">
    <label>当前价 (你可以从行情页查)</label>
    <input type="number" id="buyPrice" step="0.01" min="0.01" placeholder="例如 12.50">
    <label>可用模拟资金 (国投 10 万)</label>
    <input type="number" id="buyAccount" value="100000" step="1000">
    <label>止损价 (低于买入价)</label>
    <input type="number" id="buyStopLoss" step="0.01" min="0" placeholder="例 11.80">`;

  buyDialog.classList.remove('hidden');
}

function closeBuyDialog() {
  buyDialog.classList.add('hidden');
  currentBuyCtx = null;
}

buyCancel.onclick = closeBuyDialog;

buyConfirm.onclick = () => {
  if (!currentBuyCtx) return;
  const reason = $('buyReason').value.trim();
  const shares = parseInt($('buyShares').value, 10);
  const price = parseFloat($('buyPrice').value);
  const account = parseFloat($('buyAccount').value);
  const stopLoss = parseFloat($('buyStopLoss').value);

  if (!reason) { toast('请填写理由', 'warn'); return; }
  if (!Number.isFinite(shares) || shares <= 0 || shares % 100 !== 0) { toast('股数必须 100 整手', 'warn'); return; }
  if (!Number.isFinite(price) || price <= 0) { toast('价格无效', 'warn'); return; }
  if (!Number.isFinite(account) || account <= 0) { toast('资金无效', 'warn'); return; }
  if (!Number.isFinite(stopLoss) || stopLoss >= price) { toast('止损价必须 < 买入价', 'warn'); return; }

  // 4 闸预检
  const r = preBuyCheck({
    symbol: currentBuyCtx.symbol,
    sector: { limitUpRate_2d: 0.65, active2d: true, name: currentBuyCtx.sector },
    stock: {
      pbPercentile: 18, sectorPbMedian: 38,
      isSectorLeader: false, hasQuantSeat: false,
      name: currentBuyCtx.name
    },
    shares, price, account
  });

  if (!r.ok) {
    toast('❌ 4 闸未过: ' + r.reason, 'error');
    return;
  }

  // 通过 → 写入 localStorage (模拟下单)
  const order = {
    id: 'rw_' + Date.now(),
    timestamp: Date.now(),
    symbol: currentBuyCtx.symbol,
    name: currentBuyCtx.name,
    sector: currentBuyCtx.sector,
    shares, price, stopLoss,
    reason,
    positionRatio: r.positionRatio,
    warns: r.warns,
    source: 'reverse-watch-independent'
  };
  const existing = JSON.parse(localStorage.getItem('reverse_watch_orders') || '[]');
  existing.push(order);
  localStorage.setItem('reverse_watch_orders', JSON.stringify(existing));

  toast(`✅ 已下反向模拟单 (${currentBuyCtx.symbol} x ${shares} @ ${price})`, 'ok');
  closeBuyDialog();
  render();
};

// ============== 启动 ==============

refreshBtn.onclick = () => { bootAutoTuner(); render(); };

// ============== 设置弹窗 (P0: 数据源 + 4 闸阈值) ==============
const settingsDialog = $('settingsDialog');
const settingsDialogBody = $('settingsDialogBody');

// 局部 DOM 构造器 (无 innerHTML, 防 XSS)
function el(tag, attrs = {}, text = null) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  if (text != null) e.textContent = String(text);
  return e;
}

function openSettingsDialog() {
  // 用安全 DOM 构造, 避免 innerHTML 注入
  settingsDialogBody.replaceChildren();
  const s = SETTINGS;
  // 1. 数据源
  const sec1 = el('div', { class: 'settings-section' }, '');
  sec1.appendChild(el('h3', {}, '📡 数据源'));
  const dataModeRow = el('div', { class: 'settings-row' }, '');
  const dataModeLabel = el('label', {}, '数据源模式');
  const dataModeSel = el('select', { id: 'setDataMode' });
  ['auto', 'mock', 'real'].forEach(opt => {
    const o = el('option', { value: opt }, opt);
    if (opt === s.dataMode) o.selected = true;
    dataModeSel.appendChild(o);
  });
  dataModeRow.appendChild(dataModeLabel);
  dataModeRow.appendChild(dataModeSel);
  sec1.appendChild(dataModeRow);
  const proxyRow = el('div', { class: 'settings-row' }, '');
  proxyRow.appendChild(el('label', {}, 'dev-proxy 地址'));
  const proxyInput = el('input', { id: 'setProxyBase', type: 'text', value: s.proxyBase, placeholder: 'http://127.0.0.1:8089' });
  proxyRow.appendChild(proxyInput);
  sec1.appendChild(proxyRow);
  settingsDialogBody.appendChild(sec1);

  // 2. 4 闸阈值
  const sec2 = el('div', { class: 'settings-section' }, '');
  sec2.appendChild(el('h3', {}, '🚦 4 闸阈值'));
  const gates = s.gates;
  function numRow(id, label, value, min, max, step, suffix) {
    const r = el('div', { class: 'settings-row' }, '');
    r.appendChild(el('label', { for: id }, label));
    const input = el('input', { id, type: 'number', value, min, max, step });
    r.appendChild(input);
    if (suffix) r.appendChild(el('span', { class: 'settings-suffix' }, suffix));
    return r;
  }
  sec2.appendChild(numRow('setSectorMin', '板块强度下限 (封板率)', gates.sectorMin, '0.30', '0.90', '0.01', '(0.55 默认)'));
  sec2.appendChild(numRow('setPbDeltaMin', 'PB 分位差下限 (pp)', gates.pbDeltaMin, '5', '40', '1', '(15 默认)'));
  sec2.appendChild(numRow('setQuantRejectPct', '量化席位拒接概率', gates.quantRejectPct, '0', '1', '0.05', '(0~1, 0=不拒)'));
  const leaderRow = el('div', { class: 'settings-row' }, '');
  leaderRow.appendChild(el('label', { for: 'setExcludeLeaders' }, '过滤板块龙头'));
  const leaderChk = el('input', { id: 'setExcludeLeaders', type: 'checkbox' });
  if (gates.excludeLeaders) leaderChk.checked = true;
  leaderRow.appendChild(leaderChk);
  sec2.appendChild(leaderRow);
  settingsDialogBody.appendChild(sec2);

  // 3. AI 全能管家配置
  const secAI = el('div', { class: 'settings-section' }, '');
  secAI.appendChild(el('h3', {}, '🧠 AI 全能管家'));
  const aiCfg = (window.ReverseWatch && window.ReverseWatch.AIAdapter) ? window.ReverseWatch.AIAdapter.getAIConfig() : { provider: 'deepseek', apiKey: '', model: 'deepseek-chat', temperature: 0.3 };
  // ?v=daemon4-minimax3 + ?v=daemon4-logic2: 兜底 7 个核心 provider, 必须包含 minimax (forceProxy: true)
  // 跟 ai-adapter.js PROVIDER_FALLBACK 保持一致; 否则 ai-adapter.js 模块加载失败时 dropdown 看不到 minimax
  const PROVIDER_FALLBACK = {
    deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai:   { baseURL: 'https://api.openai.com/v1',    model: 'gpt-4o-mini' },
    moonshot: { baseURL: 'https://api.moonshot.cn/v1',   model: 'moonshot-v1-8k' },
    qwen:     { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
    zhipu:    { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    minimax:  { baseURL: '/api/llm/minimax/v1', model: 'MiniMax-Text-01', forceProxy: true },
    local:    { baseURL: '/api/local/v1', model: 'qwen2.5-7b-instruct-q4_k_m', noAuth: true }
  };
  const PROVIDERS = ((window.ReverseWatch && window.ReverseWatch.AIAdapter && window.ReverseWatch.AIAdapter.PROVIDER_DEFAULTS) || {});
  const safeProviders = (PROVIDERS && Object.keys(PROVIDERS).length > 0) ? PROVIDERS : PROVIDER_FALLBACK;
  function aiRow(label, control) {
    const r = el('div', { class: 'settings-row' }, '');
    r.appendChild(el('label', {}, label));
    r.appendChild(control);
    return r;
  }
  const provSel = el('select', { id: 'setAIProvider' });
  Object.keys(safeProviders).forEach(p => {
    const o = el('option', { value: p }, p);
    if (p === aiCfg.provider) o.selected = true;
    provSel.appendChild(o);
  });
  secAI.appendChild(aiRow('Provider', provSel));
  const keyInput = el('input', { id: 'setAIApiKey', type: 'password', placeholder: 'sk-... · local 不需要', value: aiCfg.apiKey || '' });
  secAI.appendChild(aiRow('API Key', keyInput));
  const baseInput = el('input', { id: 'setAIBaseURL', type: 'text', placeholder: '留空用 provider 默认', value: aiCfg.baseURL || '' });
  secAI.appendChild(aiRow('Base URL', baseInput));
  const modelInput = el('input', { id: 'setAIModel', type: 'text', value: aiCfg.model || '' });
  secAI.appendChild(aiRow('Model', modelInput));
  const tempInput = el('input', { id: 'setAITemperature', type: 'number', min: '0', max: '1', step: '0.05', value: String(aiCfg.temperature ?? 0.3) });
  secAI.appendChild(aiRow('温度', tempInput));
  // 测试连接按钮
  const testBtn = el('button', { id: 'testAIConn', class: 'btn-secondary', type: 'button' }, '🧪 测试连接');
  const testRow = el('div', { class: 'settings-row' }, '');
  testRow.appendChild(el('label', {}, ''));
  testRow.appendChild(testBtn);
  secAI.appendChild(testRow);

  // Provider 切换时: 若 baseURL/model 字段为空, 自动用新 provider 默认值填充
  // 同时切到 local / noAuth 时清空 API Key (避免误存旧 key)
  // ?v=daemon4-logic2 P1 #16: knownDefaults 用 aiCfg.baseURL 判断是否"用户已自定义", 切 provider 不覆盖用户输入
  // ?v=daemon4-logic2 P1 (provider 切换 model): knownDefaultModels 同样判断, 切 provider 替换默认 model
  // ?v=daemon4-logic2 P1 #26 sub-a: 加 lastUserEditedBase/lastUserEditedModel, 用户在当前对话框手动改过字段就不再覆盖
  const knownDefaults = new Set(Object.values(safeProviders).map(p => p && p.baseURL).filter(Boolean));
  const knownDefaultModels = new Set(Object.values(safeProviders).map(p => p && p.model).filter(Boolean));
  const cfgBaseAtMount = aiCfg.baseURL || '';  // 记录打开设置时的 baseURL, 区分 "用户曾自定义" vs "始终默认"
  const cfgModelAtMount = aiCfg.model || '';
  // ?v=daemon4-logic2 P1 #26 sub-a: 用户在 input 改过字段后打标, syncProviderDefaults 就知道不能覆盖
  let lastUserEditedBase = false;
  let lastUserEditedModel = false;
  // ?v=daemon7-ai-fallback1-logic2-fix7: 先 appendChild 再 addEventListener —— document.getElementById
  // 只搜已 attached 的元素, 之前顺序错导致 secAI 整段抛 TypeError, settingsDialog 永远打不开
  settingsDialogBody.appendChild(secAI);
  $('setAIBaseURL').addEventListener('input', () => { lastUserEditedBase = true; });
  $('setAIModel').addEventListener('input', () => { lastUserEditedModel = true; });
  function syncProviderDefaults(newProvider, isUserChange) {
    try {
      const pd = safeProviders[newProvider] || {};
      const curBase = $('setAIBaseURL').value.trim();
      const curModel = $('setAIModel').value.trim();
      // baseURL: 仅当 "打开设置时仍用默认值" 或 "切换前 baseURL 是空" 才覆盖
      // ?v=daemon4-logic2 P1 #26 sub-a: 同时要求用户在本次会话没手改过 baseURL (lastUserEditedBase === false)
      const wasDefaultBase = !cfgBaseAtMount || knownDefaults.has(cfgBaseAtMount);
      if (wasDefaultBase && !lastUserEditedBase && pd.baseURL) $('setAIBaseURL').value = pd.baseURL;
      // model: 同理, 仅当当前 model 是某 provider 默认值或空才替换
      // ?v=daemon4-logic2 P1 #26 sub-a: 同时要求用户没手改过 model
      const wasDefaultModel = !cfgModelAtMount || knownDefaultModels.has(cfgModelAtMount);
      if (wasDefaultModel && !lastUserEditedModel && pd.model) $('setAIModel').value = pd.model;
      const keyInputEl = $('setAIApiKey');
      keyInputEl.placeholder = pd.noAuth ? '本地 LLM 不需要 API Key' : 'sk-...';
      if (pd.noAuth && !isUserChange) keyInputEl.value = '';
      if (newProvider === 'custom') {
        $('setAIBaseURL').value = '';
        $('setAIBaseURL').placeholder = 'https://your-llm.com/v1';
      }
    } catch (e) {
      console.warn('[settings] syncProviderDefaults 失败:', e);
    }
  }
  provSel.addEventListener('change', (e) => syncProviderDefaults(e.target.value, true));
  // 首次打开时同步默认值 (空字段补默认, local 清空 apiKey)
  syncProviderDefaults(aiCfg.provider || 'deepseek', false);
  // ?v=daemon4-logic2 P0 #21: 测试连接用临时 cfg, 不调 setAIConfig (避免污染 localStorage + 广播)
  // 用户测试失败/取消后, 旧 cfg 仍然保留
  testBtn.onclick = async (ev) => {
    ev.preventDefault();
    const btn = ev.target;
    btn.disabled = true;
    btn.textContent = '⏳ 测试中…';
    const tmpCfg = {
      provider: $('setAIProvider').value,
      apiKey: $('setAIApiKey').value.trim(),
      baseURL: $('setAIBaseURL').value.trim(),
      model: $('setAIModel').value.trim(),
      temperature: parseFloat($('setAITemperature').value) || 0.3
    };
    // 关键: 传 opts.config 临时 cfg, 不调 setAIConfig
    const r = await window.ReverseWatch.AIAdapter.testConnection({ config: tmpCfg });
    btn.disabled = false;
    if (r.ok) { btn.textContent = `✅ ${r.latencyMs}ms`; toast('AI 连接成功', 'ok'); }
    else { btn.textContent = `❌ ${r.error}`; toast('AI 连接失败: ' + r.error, 'error'); }
  };

  // 4. LLM 偏好 (注入到 systemPrompt, AI 管家对话上下文)
  const sec4 = el('div', { class: 'settings-section' }, '');
  sec4.appendChild(el('h3', {}, '💬 LLM 偏好'));
  const prefRow = el('div', { class: 'settings-row' }, '');
  prefRow.appendChild(el('label', { for: 'setCustomPrompt' }, '自定义偏好 (注入对话 systemPrompt)'));
  const prefTa = el('textarea', { id: 'setCustomPrompt', rows: '3', placeholder: '例: 我只做大盘股 / 我不想接 ST / 鱼尾阈值想从 15% 收紧到 10%' });
  prefTa.value = getCustomPrompt();
  prefRow.appendChild(prefTa);
  sec4.appendChild(prefRow);
  settingsDialogBody.appendChild(sec4);

  // 5. 历史 adjustment (来自 AI 管家对话, 可回滚)
  const sec5 = el('div', { class: 'settings-section' }, '');
  sec5.appendChild(el('h3', {}, '📜 历史 adjustment · AI 管家改过的标准'));
  const histBox = el('div', { id: 'adjHistoryBox', class: 'adj-history' }, '');
  if (window.ReverseWatch && window.ReverseWatch.AIFeedback) {
    const hist = window.ReverseWatch.AIFeedback.getHistory(10);
    if (hist.length === 0) {
      histBox.appendChild(el('div', { class: 'adj-empty' }, '(暂无, 去管家面板聊几句 AI 试试)'));
    } else {
      hist.forEach(entry => {
        const row = el('div', { class: 'adj-row ' + (entry.status === 'reverted' ? 'is-reverted' : '') });
        const fmt = (v) => {
          if (v == null) return '(空)';
          if (Array.isArray(v)) return '[' + v.join(', ') + ']';
          if (typeof v === 'number') return Math.abs(v) < 1 ? (v * 100).toFixed(1) + '%' : v.toFixed(2);
          return String(v);
        };
        row.appendChild(el('div', { class: 'adj-target' }, entry.target));
        row.appendChild(el('div', { class: 'adj-diff' }, `${fmt(entry.oldValue)} → ${fmt(entry.newValue)}`));
        row.appendChild(el('div', { class: 'adj-reason' }, entry.reason || '(无说明)'));
        if (entry.status !== 'reverted') {
          const rb = el('button', { class: 'btn-secondary', type: 'button' }, '↩ 回滚');
          rb.onclick = () => {
            const r = window.ReverseWatch.AIFeedback.rollbackAdjustment(entry.id);
            toast(r.ok ? `已回滚: ${entry.target}` : `回滚失败: ${r.message}`, r.ok ? 'ok' : 'warn');
            openSettingsDialog();
          };
          row.appendChild(rb);
        } else {
          row.appendChild(el('span', { class: 'adj-tag' }, '已回滚'));
        }
        histBox.appendChild(row);
      });
    }
  }
  sec5.appendChild(histBox);
  // 一键回滚全部
  if (window.ReverseWatch && window.ReverseWatch.AIFeedback && window.ReverseWatch.AIFeedback.getHistory().some(e => e.status === 'applied')) {
    const rbAll = el('button', { id: 'rollbackAllAdj', class: 'btn-secondary', type: 'button' }, '↩ 一键回滚全部');
    rbAll.onclick = () => {
      if (!confirm('回滚全部 AI adjustment? 会恢复到改之前的状态')) return;
      const r = window.ReverseWatch.AIFeedback.rollbackAll();
      toast(`已回滚 ${r.count} 条`, 'ok');
      openSettingsDialog();
    };
    sec5.appendChild(rbAll);
  }
  settingsDialogBody.appendChild(sec5);

  // 5.5 自动调参 (AutoTuner)
  const sec55 = el('div', { class: 'settings-section' }, '');
  sec55.appendChild(el('h3', {}, '🔧 自动调参'));
  try {
    const rw = window.ReverseWatch;
    const kpi = (rw && rw.AutoTuner && typeof rw.AutoTuner.getKpi === 'function')
      ? rw.AutoTuner.getKpi() : { weekCount: 0, pendingCount: 0 };
    sec55.appendChild(el('div', { class: 'settings-row' },
      `本周已调 ${kpi.weekCount} 次 / 待批准 ${kpi.pendingCount} 条`));
    const row1 = el('div', { class: 'settings-row' }, '');
    const btnRun = el('button', { class: 'btn-secondary', type: 'button' }, '▶ 立即跑一次');
    const btnHistory = el('button', { class: 'btn-secondary', type: 'button' }, '📋 查看历史');
    const btnPending = el('button', { class: 'btn-secondary', type: 'button' }, `⏳ 待批准 (${kpi.pendingCount})`);
    const btnRollback = el('button', { class: 'btn-secondary', type: 'button' }, '↩ 一键回滚全部');
    row1.appendChild(btnRun); row1.appendChild(btnHistory); row1.appendChild(btnPending); row1.appendChild(btnRollback);
    sec55.appendChild(row1);
    btnRun.onclick = async () => {
      if (!confirm('立即跑一次自动调参? 会扫描 4 项信号 + 走规则决策')) return;
      const r = await rw.AutoTuner.runOnce();
      alert(JSON.stringify(r, null, 2));
      openSettingsDialog();
    };
    btnHistory.onclick = () => {
      const log = rw.AutoTuner.getLog(20);
      const text = log.map(e => `[${new Date(e.ts).toLocaleString('zh-CN')}] ${e.adjustment?.target} ${e.adjustment?.oldValue}→${e.adjustment?.value} (${e.status})`).join('\n') || '(空)';
      alert(text);
    };
    btnPending.onclick = () => {
      const pending = rw.AutoTuner.getPending();
      if (pending.length === 0) { alert('(无待批准)'); return; }
      // ?v=auto-tune-pending-ui1: 展开式内联列表, 替代 prompt() 输入序号烂 UX
      // 先清掉旧列表 (避免重复展开叠加)
      const old = document.getElementById('autoTunerPendingList');
      if (old) old.remove();
      const wrap = el('div', { id: 'autoTunerPendingList', class: 'auto-tuning-pending-list' });
      pending.forEach((p, i) => {
        const card = el('div', { class: 'auto-tuning-pending', 'data-idx': i });
        const head = el('div', { class: 'adj-head' },
          `${i + 1}. ${p.target || '?'}  `,
          el('span', { class: 'adj-old' }, String(p.oldValue ?? '(空)')),
          '  →  ',
          el('span', { class: 'adj-new' }, String(p.value ?? '(空)')));
        const reason = el('div', { class: 'llm-note' }, `LLM: ${p.llmReason || '(无说明)'}`);
        const ts = el('div', { class: 'llm-note' }, `时间: ${new Date(p.ts || Date.now()).toLocaleString('zh-CN')}`);
        const btnRow = el('div', { class: 'row' });
        const btnOk = el('button', { class: 'btn-primary', type: 'button' }, '✅ 批准');
        const btnNo = el('button', { class: 'btn-secondary', type: 'button' }, '❌ 拒绝');
        btnOk.onclick = () => {
          const r = rw.AutoTuner.approvePending(i, true);
          if (r && r.ok) { toast(`已批准 ${p.target}`, 'ok'); card.remove(); }
          else { toast('批准失败: ' + (r && r.message || '?'), 'err'); }
          // 列表空了就清容器 + 重渲染设置页 (按钮文字更新)
          if (!document.getElementById('autoTunerPendingList')?.querySelector('.auto-tuning-pending')) {
            document.getElementById('autoTunerPendingList')?.remove();
            openSettingsDialog();
          }
        };
        btnNo.onclick = () => {
          const r = rw.AutoTuner.approvePending(i, false);
          if (r && r.ok) { toast(`已拒绝 ${p.target}`, 'ok'); card.remove(); }
          else { toast('拒绝失败: ' + (r && r.message || '?'), 'err'); }
          if (!document.getElementById('autoTunerPendingList')?.querySelector('.auto-tuning-pending')) {
            document.getElementById('autoTunerPendingList')?.remove();
            openSettingsDialog();
          }
        };
        btnRow.appendChild(btnOk);
        btnRow.appendChild(btnNo);
        card.appendChild(head);
        card.appendChild(reason);
        card.appendChild(ts);
        card.appendChild(btnRow);
        wrap.appendChild(card);
      });
      sec55.appendChild(wrap);
      // 滚到列表顶部 (避免按钮在 row1 顶部, 列表被遮挡)
      wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    btnRollback.onclick = () => {
      if (!confirm('一键回滚全部已应用的自动调参?')) return;
      const r = rw.AutoTuner.rollbackAll();
      toast(`已回滚 ${r.count} 条`, 'ok');
      openSettingsDialog();
    };
  } catch (e) { console.warn('[settings] AutoTuner section 渲染失败:', e.message); }
  settingsDialogBody.appendChild(sec55);

  // 5.4 字段冲突 (用户 + 系统近 1h 改过同一字段) — KPI 红徽章详情
  try {
    const conflicts = detectFieldConflicts();
    if (conflicts.length > 0) {
      const sec54 = el('div', { class: 'settings-section settings-conflict' }, '');
      sec54.appendChild(el('h3', {}, `⚠ 字段冲突 (${conflicts.length})`));
      sec54.appendChild(el('div', { class: 'settings-row settings-row-tip' },
        '近 1h 内 AI 管家/手动调 与 AutoTuner 改过同一字段 — 后写者胜, 请人工确认是否回滚'));
      const list = el('div', { class: 'auto-tuning-log-list' }, '');
      conflicts.forEach(c => {
        const row = el('div', { class: 'auto-tuning-log danger' },
          `[${new Date(c.autoTs).toLocaleString('zh-CN')}] ${c.target} — 系统: ${c.autoStatus} | ${c.autoReason || ''}`);
        list.appendChild(row);
      });
      sec54.appendChild(list);
      settingsDialogBody.appendChild(sec54);
    }
  } catch (e) { console.warn('[settings] 冲突 section 渲染失败:', e.message); }

  // 6. AI 推送 (Web Notification)
  const sec6 = el('div', { class: 'settings-section' }, '');
  sec6.appendChild(el('h3', {}, '🔔 AI 推送'));
  const pushRow = el('div', { class: 'settings-row' }, '');
  pushRow.appendChild(el('label', {}, '浏览器通知权限'));
  const pushBtn = el('button', { id: 'reqNotifyBtn', class: 'btn-secondary', type: 'button' }, '🔔 申请权限');
  pushRow.appendChild(pushBtn);
  sec6.appendChild(pushRow);
  pushBtn.onclick = async () => {
    if (!('Notification' in window)) { toast('当前浏览器不支持 Web Notification', 'warn'); return; }
    const r = await Notification.requestPermission();
    pushBtn.textContent = r === 'granted' ? '✅ 已授权' : `❌ ${r}`;
    toast(r === 'granted' ? '通知已开启' : '通知未开启', r === 'granted' ? 'ok' : 'warn');
  };
  settingsDialogBody.appendChild(sec6);

  // 3. 重置
  const sec3 = el('div', { class: 'settings-section settings-footer' }, '');
  const resetBtn = el('button', { id: 'settingsReset', class: 'btn-secondary' }, '🔄 重置默认');
  sec3.appendChild(resetBtn);
  settingsDialogBody.appendChild(sec3);
  resetBtn.onclick = () => {
    SETTINGS.dataMode = DEFAULT_SETTINGS.dataMode;
    SETTINGS.proxyBase = DEFAULT_SETTINGS.proxyBase;
    SETTINGS.gates = { ...DEFAULT_SETTINGS.gates };
    SETTINGS.aiThresholds = { ...DEFAULT_SETTINGS.aiThresholds };
    saveSettings(SETTINGS);
    openSettingsDialog();  // 重新渲染
    toast('已重置默认', 'ok');
  };

  settingsDialog.classList.remove('hidden');
}
function closeSettingsDialog() { settingsDialog.classList.add('hidden'); }

$('settingsBtn').onclick = () => openSettingsDialog();
$('settingsCancel').onclick = () => closeSettingsDialog();
$('settingsSave').onclick = () => {
  // 收集表单
  const newDataMode = $('setDataMode').value;
  const newProxy = $('setProxyBase').value.trim() || PROXY_BASE;
  const newSectorMin = parseFloat($('setSectorMin').value) || 0.55;
  const newPbDeltaMin = parseInt($('setPbDeltaMin').value, 10) || 15;
  const newQuantPct = parseFloat($('setQuantRejectPct').value);
  const newExclude = $('setExcludeLeaders').checked;
  // mutate 现有对象, 保持 rw.SETTINGS 引用稳定 (AI adjustment 用)
  SETTINGS.dataMode = newDataMode;
  SETTINGS.proxyBase = newProxy;
  SETTINGS.gates.sectorMin = newSectorMin;
  SETTINGS.gates.pbDeltaMin = newPbDeltaMin;
  SETTINGS.gates.quantRejectPct = Number.isFinite(newQuantPct) ? newQuantPct : 0.5;
  SETTINGS.gates.excludeLeaders = newExclude;
  saveSettings(SETTINGS);
  // 同步到模块顶层变量
  DATA_MODE = SETTINGS.dataMode;
  // ?v=daemon7-ai-fallback1-logic2-fix5: 设置页改了 proxyBase 后, 同步到 PROXY_BASE 全局 (原来漏了, 改成死控件)
  PROXY_BASE = SETTINGS.proxyBase;

  // AI 配置 (单独保存到 _rw_ai_config_v1)
  if (window.ReverseWatch && window.ReverseWatch.AIAdapter) {
    const aiCfg = {
      provider: $('setAIProvider').value,
      apiKey: $('setAIApiKey').value.trim(),
      baseURL: $('setAIBaseURL').value.trim(),
      model: $('setAIModel').value.trim(),
      temperature: parseFloat($('setAITemperature').value) || 0.3
    };
    window.ReverseWatch.AIAdapter.setAIConfig(aiCfg);
  }

  // LLM 偏好 (customPrompt, 注入到 chat systemPrompt)
  if ($('setCustomPrompt')) {
    setCustomPrompt($('setCustomPrompt').value.trim());
  }

  closeSettingsDialog();
  toast('✅ 设置已保存, 正在刷新', 'ok');
  render();
};

// 首屏加载 — dispatcher 路径依赖 buildPools 异步挂载, 失败自动重试一次
async function firstRender() {
  await render();
  // 若初次没拿到 dispatcher 结果, 等 500ms 后再试一次
  if (!document.querySelector('.regime-pill')) {
    await new Promise(r => setTimeout(r, 500));
    await render();
  }
  // 启动 AutoTuner (每周日 16:00 自动跑, 但只在 boot 时调一次, 避免重复 schedule)
  // 修复: 之前只 refreshBtn 调, 首屏永不启动, 长期跑能力缺失
  bootAutoTuner();
  // ?v=daemon2 P0-2: 浏览器先拉 daemon fs 兜底, 避免 daemon 比浏览器先启动读不到 holdings
  try {
    const hb = await import('./holdings-bridge.mjs');
    await hb.bootstrapFromDaemon();
  } catch (e) { console.warn('[firstRender] holdings bridge bootstrap 失败:', e.message); }
  // ?v=daemon3 P0 #150: 挂载 holdings UI (录入/列表/删除), 录入后通过 holdings-bridge 同步到 daemon fs
  try {
    // ?v=holdings-detail-fix1: import URL 也要带 ?v=, 跟 index.html <script src> 一致
    // 否则 ESM 视为不同 module, 旧 closure 残留, onClick 跑旧逻辑
    const ui = await import('./holdings-ui.js?v=holdings-detail-fix1');
    ui.mountHoldingsPanel();
  } catch (e) { console.warn('[firstRender] holdings-ui mount 失败:', e.message); }
  // ?v=daemon4 P0 #156/#157: 渲染 F4.8 daemon panel (修复僵尸面板 + onboarding 黑洞)
  try {
    const ds = await import('./ai/daemon-status-ui.js');
    ds.mountDaemonStatusUI();
  } catch (e) { console.warn('[firstRender] daemon-status-ui mount 失败:', e.message); }
  // daemon state (?v=daemon1): fetch _rw_daemon_state.json, 失败自愈 (空对象)
  loadDaemonState().then(() => render()).catch(e => console.warn('[firstRender] daemon state 加载失败:', e.message));
}

// daemon state 缓存 (?v=daemon3 P0 #149): 浏览器侧从 daemon:8090 拉
// 失败兜底走 vite 静态路径 (./_rw_daemon_state.json), 都失败显 null
// ?v=daemon4-logic2 P0 #22: 加 setInterval 30s 自动 retry, daemon 起来后自动恢复 panel + render()
let _daemonState = null;
let _daemonStateTimer = null;
async function loadDaemonState(isPoll = false) {
  const candidateUrls = [
    `${window.location.protocol}//${window.location.hostname}:8090/daemon-state.json`,
    './_rw_daemon_state.json'
  ];
  for (const url of candidateUrls) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      const body = await r.json();
      const wasNull = _daemonState === null;
      _daemonState = body;
      window._daemonState = body;  // ?v=daemon4: 让 ai-butler/daemon-status-ui 通过 window 读到
      // ?v=daemon4 P0 #156: daemon panel 重渲染 (alerts 列表 + 摘要)
      try {
        const ds = await import('./ai/daemon-status-ui.js');
        ds.refreshDaemonStatusUI();
      } catch (e) { console.warn('[loadDaemonState] daemon panel refresh 失败:', e.message); }
      // ?v=daemon4-logic2 P0 #22: 从 null → 有状态, 触发全页 render() (但ler/alerts 等跟着更新)
      if (wasNull && !isPoll) {
        render().catch(e => console.warn('[loadDaemonState] 全页 render 失败:', e.message));
      }
      // ?v=daemon4-logic2 P1 #26: KPI 卡上也有 daemon 心跳显示, 顺手刷一下
      try { updateDaemKpiIfPresent(); } catch (e) { console.warn('[loadDaemonState] KPI 刷新失败:', e.message); }
      return body;
    } catch (e) {
      console.warn('[loadDaemonState] ' + url + ' 失败:', e.message);
    }
  }
  if (!isPoll) console.warn('[loadDaemonState] 全部 URL 失败, daemon + vite 静态都不可用');
  // ?v=daemon4-logic2 P0 #22: 只有不是轮询时才设 null, 避免轮询把刚拉到的清掉
  if (!isPoll) _daemonState = null;
  return null;
}
function startDaemonStatePolling() {
  if (_daemonStateTimer) return;
  // ?v=daemon4-logic2 P0 #22: 30s 轮询, 1) daemon 起得晚 2) daemon 重启 3) 中间网络抖动
  _daemonStateTimer = setInterval(() => {
    loadDaemonState(true).catch(e => console.warn('[daemonStateTimer] 轮询失败:', e.message));
  }, 30000);
}
// ?v=daemon4-logic2 P1 #26: KPI 卡心跳刷新 (renderButlerPanel 在最末 _renderKpi 里调, 不用额外触发 render)
function updateDaemKpiIfPresent() {
  // KPI 由 _renderKpi 渲染 (在 render() 末尾), daemon 心跳只显示在 ai-butler / daemon-status-ui 里
  // 这里只需触发 ai-butler 的 _userCollapsed 保持, 重新调用 refreshDaemonStatusUI 即可
  // (上面 loadDaemonState 已调过, 这里只做幂等补充)
}
firstRender();
startDaemonStatePolling();

// ============== 学习闭环 ④ 自调层: rw:ai-adjustments-applied listener ==============
// AI 管家调整落盘后自动触发 render() 重生成 plan
// 派发点: ai-feedback.js:172 (apply), 190 (rollback)
document.addEventListener('rw:ai-adjustments-applied', (e) => {
  console.log('[学习闭环] 收到 ai-adjustments-applied, 重渲染', e.detail);
  // 调整 gate / holding 后必须重算候选, 否则下次 chat 还是基于旧 SETTINGS
  render().catch(err => console.warn('[学习闭环] 重渲染失败:', err.message));
});

// AutoTuner 自调落盘 (系统自动调参, 跟用户 chat 调整同链路, 但派不同事件)
document.addEventListener('rw:auto-tuning-applied', (e) => {
  console.log('[auto-tuner] 收到 auto-tuning-applied, 重渲染', e.detail);
  render().catch(err => console.warn('[auto-tuner] 重渲染失败:', err.message));
});

// L5-2 修: pool.exclude 写后触发 render (addPoolExclude / setPoolExcludes / removePoolExclude 都派)
document.addEventListener('rw:pool-exclude-changed', () => {
  render().catch(err => console.warn('[pool-exclude-changed] 重渲染失败:', err.message));
});

// ?v=daemon4-logic2 P0 #23: 监听 AI 配置变更 — ai-adapter setAIConfig 派的事件零监听是 P0
// 改了 provider/baseURL/model/apiKey 之后, 必须: 1) 但ler面板重拉 2) daemon-status-ui 刷 3) 重渲染 KPI
// 注: 调 tempCfg 的 testBtn 不再走 setAIConfig, 不会派事件, 这就是 #21 的修正意义
document.addEventListener('rw:ai-config-changed', async (e) => {
  console.log('[ai-config-changed] provider/baseURL/model 变更, 重渲染');
  try {
    const { renderButlerPanel } = await import('./ai/ai-butler.js');
    const cont = document.getElementById('butlerPanel');
    if (cont) renderButlerPanelCached(window._lastSnapshot || {}, cont);
  } catch (err) { console.warn('[ai-config-changed] butler 重渲染失败:', err.message); }
  try {
    const ds = await import('./ai/daemon-status-ui.js');
    ds.refreshDaemonStatusUI();
  } catch (err) { console.warn('[ai-config-changed] daemon panel refresh 失败:', err.message); }
  // KPI 上若也显示 AI 心跳, 需要 render() 重生成 (比如 ai-stats 卡)
  try {
    render().catch(err => console.warn('[ai-config-changed] render 失败:', err.message));
  } catch (err) { console.warn('[ai-config-changed] render 调用失败:', err.message); }
});

// C2 修: 跨标签页同步 — 其他标签页改了 _rw_* 缓存, 当前页感知并重渲染
// 注意: storage 事件只在其他标签页触发, 当前页改自己不会触发
window.addEventListener('storage', (e) => {
  if (!e.key || !e.key.startsWith('_rw_')) return;
  console.log('[C2 跨标签页] 同步:', e.key, '变更, 重渲染');
  // 防抖 (避免短时间内多次 setItem 触发多次 render)
  clearTimeout(window._rw_storage_debounce);
  window._rw_storage_debounce = setTimeout(() => {
    render().catch(err => console.warn('[C2] 重渲染失败:', err.message));
  }, 300);
});

// 对外暴露 (供宿主页面或测试用)
window.ReverseWatch = {
  render,
  openBuyDialog,
  showDetail,
  closeDetailDialog,
  preBuyCheck,
  getData,
  escapeHtml,
  aiChiefAnalyst,         // 详情页 AI 简评兜底 (供 ai-detail.js catch 用)
  holdingRulesSummary,    // 同上 (持有规律摘要行, 学习闭环 ③ 已 fb-aware)
  // AI 管家 adjustment 落盘需要读写
  SETTINGS, saveSettings,
  loadHolding, saveHolding,
  pbGrade, getCustomPrompt, setCustomPrompt, getPoolExcludes,
  // 学习闭环 ① 反馈层入口: chat buildSystemPrompt / butler panel 读
  loadFeedback, loadHoldingFb, loadActiveFeedback,
  VERSION: 'v0.1.4-presets',
  // 反向选股内核 (供 RangeStrategy 复用, 行为跟现有 reverse-watch 100% 一致)
  REVERSE_POOL,
  SECTOR_LEADERS,
  mulberry32,
  dailySeed,
  runReverseScreener: reverseScreener,
  buildGates,
  buildPools,
  makeAiReason,
  sectorCount,
  // AutoTuner 启动 (供 refreshBtn / 首屏 render 之后调)
  bootAutoTuner
};
