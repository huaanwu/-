#!/usr/bin/env node
/**
 * 每日盘后 AI 总结 + 飞书推送 + 5.2 事后验证自动回看
 *
 * 用法:
 *   1. app 里点 "📤 导出" → 生成 daily_snapshot_2026-07-26.json
 *   2. 把 JSON 路径作为参数传入:
 *      node scripts/daily_summary.mjs ./daily_snapshot_2026-07-26.json
 *   3. 自动:
 *      - 拉 AKShare 大盘指数
 *      - 调 DeepSeek 生成总结
 *      - 输出 ./daily_summary_2026-07-26.md
 *      - 推飞书 (如果 FEISHU_WEBHOOK 环境变量存在)
 *
 * 5.2 事后验证 (5.2 c):
 *   node scripts/daily_summary.mjs --verify <journals.json>
 *   - 读 journals export
 *   - 找 verify=1w/1m/3m/pending 且时间到了的笔记
 *   - 拉当前行情 + 调 LLM 生成"当时判断 vs 当前市场反馈"对照报告
 *   - 写回 verified_journals.json (app 端可导入更新)
 *
 * Phase C 盘前简报 (--premarket):
 *   node scripts/daily_summary.mjs --premarket
 *   - 三块内容 (每块拉取失败独立降级为"本节数据不可用", 不中断整体):
 *     1. 隔夜外盘 (aktools index_us_stock_sina, 同 www/core/data.js 已验证接口)
 *     2. 今日财经日历 (本地静态规则: LPR/MLF/PMI/CPI/季报密集期, 公开统计规律, 非编造)
 *     3. 财新要闻 (aktools stock_news_main_cx, 同 www/core/news.js 已验证接口)
 *   - LLM 生成 ≤300 字简报; LLM 失败时降级推送原始数据罗列版 (不推送失败)
 *   - 不含用户持仓数据 (Node 脚本读不到浏览器 IndexedDB), 只做全市场维度
 *   - Windows 计划任务建议: 交易日 08:30 跑 (盘前 30 分钟, 隔夜美股已收盘)
 *     schtasks /create /tn "StockMaster盘前简报" /tr "node D:\get\stock-master\scripts\daily_summary.mjs --premarket" /sc weekly /d MON,TUE,WED,THU,FRI /st 08:30
 *
 * 配置 (环境变量):
 *   DEEPSEEK_API_KEY   必须
 *   DEEPSEEK_BASE_URL  可选, 默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL     可选, 默认 deepseek-v4-flash
 *   FEISHU_WEBHOOK     可选, 飞书机器人 webhook URL
 *   AKTOOLS_BASE       可选, 默认 http://127.0.0.1:8088
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const AKTOOLS = process.env.AKTOOLS_BASE || 'http://127.0.0.1:8088';
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const FEISHU = process.env.FEISHU_WEBHOOK || '';

// ==================== 工具 ====================
function log(...args) { console.log('[daily_summary]', ...args); }
function err(...args) { console.error('[daily_summary]', ...args); }

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    err('用法:');
    err('  盘后总结:  node scripts/daily_summary.mjs <snapshot.json>');
    err('  事后验证:  node scripts/daily_summary.mjs --verify <journals.json> [--dry-run]');
    err('  盘前简报:  node scripts/daily_summary.mjs --premarket');
    process.exit(1);
  }
  if (args[0] === '--premarket') {
    return { mode: 'premarket' };
  }
  if (args[0] === '--verify' || args[0] === '--verify-dry-run') {
    const dryRun = args[0] === '--verify-dry-run';
    if (args.length < 2) {
      err('verify 模式需要 journals JSON 路径');
      process.exit(1);
    }
    return { mode: 'verify', dryRun, journalsPath: path.resolve(args[1]) };
  }
  return { mode: 'summary', snapshotPath: path.resolve(args[0]) };
}

// ==================== 拉大盘 ====================
async function fetchIndices() {
  const url = `${AKTOOLS}/api/public/stock_zh_index_spot?symbol=${encodeURIComponent('上证指数,深证成指,创业板指,沪深300,中证500')}`;
  try {
    const resp = await fetch(url, { timeout: 10000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data || []).map(it => ({
      name: it.名称 || it.name,
      code: it.代码 || it.code,
      price: parseFloat(it.最新价 ?? it.price ?? 0),
      change: parseFloat(it.涨跌幅 ?? it.change_pct ?? 0)
    })).filter(x => x.code && !isNaN(x.price));
  } catch (e) {
    err('拉大盘失败:', e.message);
    return [];
  }
}

// ==================== 调 LLM ====================
async function callLLM(prompt, systemPrompt) {
  if (!DEEPSEEK_KEY) {
    err('DEEPSEEK_API_KEY 未设置, 跳过 LLM 调用');
    return null;
  }
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        max_tokens: 4000,
        temperature: 0.5
      })
    });
    if (!resp.ok) {
      err(`LLM HTTP ${resp.status}: ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) {
    err('LLM 调用失败:', e.message);
    return null;
  }
}

// ==================== 推飞书 ====================
async function pushFeishu(text) {
  if (!FEISHU) {
    log('FEISHU_WEBHOOK 未设置, 跳过推送, 内容打印到 stdout:');
    console.log(text);
    return false;
  }
  try {
    const resp = await fetch(FEISHU, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text }
      })
    });
    if (!resp.ok) {
      err(`飞书 HTTP ${resp.status}: ${await resp.text()}`);
      return false;
    }
    const data = await resp.json();
    if (data.StatusCode === 0 || data.code === 0) {
      log('飞书推送成功');
      return true;
    } else {
      err('飞书返回:', JSON.stringify(data));
      return false;
    }
  } catch (e) {
    err('飞书推送失败:', e.message);
    return false;
  }
}

// ==================== 盘前简报 (Phase C --premarket) ====================
// 只读全市场维度数据 (Node 脚本读不到浏览器 IndexedDB, 不含用户持仓)
// 数据接口全部照抄 www/core/data.js / www/core/news.js 已验证的 aktools 接口, 不发明新接口

/**
 * 隔夜外盘: 美股 3 大指数 (道琼斯/纳斯达克/标普500)
 * aktools: index_us_stock_sina (同 data.js _fetchUsIndices) → 字段 (名称/最新价/涨跌幅/日期)
 * 失败返 null (调用方降级 "本节数据不可用")
 */
async function fetchUsIndices() {
  try {
    const url = `${AKTOOLS}/api/public/index_us_stock_sina`;
    const resp = await fetch(url, { timeout: 10000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data)) return null;
    const wanted = ['道琼斯', '纳斯达克', '标普500'];
    const out = [];
    for (const row of data) {
      const name = (row.名称 || row.name || '').trim();
      if (!wanted.some(w => name.includes(w))) continue;
      const price = parseFloat(row.最新价 ?? row.price);
      if (isNaN(price)) continue;
      const changePct = parseFloat(row.涨跌幅 ?? row.change_pct);
      out.push({
        name,
        price,
        changePct: isNaN(changePct) ? null : changePct,
        date: row.日期 || row.date || ''
      });
    }
    return out.length > 0 ? out : null;
  } catch (e) {
    err('隔夜外盘拉取失败:', e.message);
    return null;
  }
}

/**
 * 今日财经日历 (本地静态规则) - 基于公开统计规律, 不预测实际事件
 * 同 data.js _fetchEconomicCalendar 的规则集, 只取"今天"这一天:
 *   - LPR 报价: 每月 20 号 (央行公开)
 *   - MLF 续作/到期: 每月 15 号 (央行公开)
 *   - PMI: 每月最后一天 (统计局公开)
 *   - CPI/PPI: 每月 10-12 号 (统计局公开, 估计窗口)
 *   - 季报披露密集期: 1/4/7/10 月下旬 (交易所规则)
 * 没有命中事件 → 返 [] (调用方输出"今日无已知日历事件", 不编造)
 */
function buildEconomicCalendar(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (isNaN(d.getTime())) return [];
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const md = `${month}-${day}`;
  const events = [];
  if (day === 20) events.push(`${md} LPR 报价 (1Y/5Y)`);
  if (day === 15) events.push(`${md} MLF 续作/到期`);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (day === lastDay) events.push(`${md} 官方 PMI 公布`);
  if (day >= 10 && day <= 12) events.push(`${md} CPI / PPI 同比 (估计窗口)`);
  if ([1, 4, 7, 10].includes(month) && day >= 20 && day <= 30) {
    events.push(`${md} 季报披露密集期 (年报/一季报/中报/三季报)`);
  }
  return events;
}

/**
 * 财新要闻
 * aktools: stock_news_main_cx (同 news.js _fetchCaixin) → 字段 (tag/summary/url)
 * 失败返 null (调用方降级 "本节数据不可用")
 */
async function fetchCaixinNews(limit = 10) {
  try {
    const url = `${AKTOOLS}/api/public/stock_news_main_cx`;
    const resp = await fetch(url, { timeout: 10000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data)) return null;
    const items = data.slice(0, limit).map(d => ({
      tag: d.tag || '',
      summary: d.summary || '',
      url: d.url || ''
    })).filter(x => x.summary);
    return items.length > 0 ? items : null;
  } catch (e) {
    err('财新要闻拉取失败:', e.message);
    return null;
  }
}

/**
 * 原始数据罗列版 (LLM 失败时的降级输出, 保证不推送失败)
 * data = { date, us, calendar, news } (us/news 可能为 null)
 */
function formatPremarketRaw(data) {
  const lines = [`🌅 盘前简报 ${data.date}`, ''];
  lines.push('【隔夜外盘】');
  if (data.us && data.us.length > 0) {
    for (const it of data.us) {
      const pct = it.changePct === null ? 'N/A' : `${it.changePct > 0 ? '+' : ''}${it.changePct.toFixed(2)}%`;
      lines.push(`- ${it.name}: ${it.price} (${pct})`);
    }
  } else {
    lines.push('- 本节数据不可用');
  }
  lines.push('');
  lines.push('【今日财经日历】');
  if (data.calendar && data.calendar.length > 0) {
    for (const ev of data.calendar) lines.push(`- ${ev}`);
  } else {
    lines.push('- 今日无已知日历事件 (仅含公开日期规则: LPR/MLF/PMI/CPI/季报密集期)');
  }
  lines.push('');
  lines.push('【财新要闻】');
  if (data.news && data.news.length > 0) {
    data.news.forEach((n, i) => lines.push(`- [${i + 1}] [${n.tag}] ${n.summary}`));
  } else {
    lines.push('- 本节数据不可用');
  }
  return lines.join('\n');
}

/**
 * 拼盘前简报 prompt (≤300 字, 保守严谨, 不预测不推荐)
 */
function buildPremarketPrompt(data) {
  const systemPrompt = `你是一个严谨的 A 股个人投资助理, 任务是基于提供的盘前数据生成一段"盘前简报"。规则:
1. 严禁编造数据, 只能引用下方提供的数字和新闻标题
2. 保守严谨, 不预测涨跌, 不推荐买卖
3. ≤ 300 字, 3 段结构:
   - 隔夜外盘: 1-2 句
   - 今日日历: 1 句 (无事件就说无)
   - 要闻提要: 挑 2-3 条最重要的, 各 1 句
4. 某节标注"本节数据不可用"时如实说明, 不要编造
5. 纯文本, 不用 markdown 标题`;

  const userPrompt = `日期: ${data.date}

${formatPremarketRaw(data)}

请生成盘前简报 (≤300 字, 不含上面的 emoji 小标题格式, 直接行文)。`;
  return { systemPrompt, userPrompt };
}

/**
 * 盘前简报主流程
 * 三块数据独立拉取, 单块失败降级 "本节数据不可用", 不中断整体;
 * LLM 失败降级推送原始数据罗列版 (不推送失败)
 * @param {object} [deps] 注入依赖便于测试: { now, fetchUs, fetchNews, callLLM, pushFeishu }
 */
async function runPremarket(deps = {}) {
  const now = deps.now || new Date();
  const fetchUs = deps.fetchUs || fetchUsIndices;
  const fetchNews = deps.fetchNews || fetchCaixinNews;
  const llmCaller = deps.callLLM || callLLM;
  const pusher = deps.pushFeishu || pushFeishu;

  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  log('生成盘前简报:', date);

  // 1) 三块独立拉取 (日历是本地纯函数, 不会失败)
  const [us, news] = await Promise.all([
    Promise.resolve().then(() => fetchUs()).catch(e => { err('外盘异常:', e.message); return null; }),
    Promise.resolve().then(() => fetchNews()).catch(e => { err('要闻异常:', e.message); return null; })
  ]);
  const calendar = buildEconomicCalendar(now);
  const data = { date, us, calendar, news };
  log(`外盘: ${us ? us.length + ' 条' : '不可用'} / 日历: ${calendar.length} 条 / 要闻: ${news ? news.length + ' 条' : '不可用'}`);

  // 2) LLM 生成简报, 失败降级原始罗列
  const { systemPrompt, userPrompt } = buildPremarketPrompt(data);
  const summary = await llmCaller(userPrompt, systemPrompt);
  if (!summary) log('LLM 未返回, 降级为原始数据罗列版');
  const text = summary || formatPremarketRaw(data);

  // 3) 推飞书 (未配置 FEISHU_WEBHOOK 时 pushFeishu 自己打印到 stdout)
  await pusher(text);
  log('✅ 盘前简报完成');
  return { data, summary, text };
}

// ==================== 事后验证 (5.2 c) ====================

/**
 * 5.2 c: 找出"该回看"的复盘笔记
 * 输入: journals 数组 (含 assumption/emotion/verify/createdAt/code), now 时间戳
 * 输出: 数组 [{ note, due: true/false, daysSinceCreate: N, thresholdDays }]
 *
 * 规则:
 *   - verify === 'verified' → 永远不再回看
 *   - verify === 'pending' → 7 天后回看 (待回看的默认周期)
 *   - verify === '1w'     → 7 天后回看
 *   - verify === '1m'     → 30 天后回看
 *   - verify === '3m'     → 90 天后回看
 *   - 没有 code 的笔记 → 永远不需要回看 (没行情可对比)
 */
const VERIFY_THRESHOLD_DAYS = {
  pending: 7,
  '1w': 7,
  '1m': 30,
  '3m': 90
};

function pickJournalsForVerify(journals, now = Date.now()) {
  if (!Array.isArray(journals)) return [];
  const out = [];
  for (const j of journals) {
    if (!j || j.verify === 'verified') continue;
    const threshold = VERIFY_THRESHOLD_DAYS[j.verify || 'pending'];
    if (threshold === undefined) continue;
    if (!j.code) continue;  // 没关联股票, 没法对比行情
    const created = j.createdAt || (j.date ? new Date(j.date).getTime() : 0);
    if (!created) continue;
    const daysSinceCreate = Math.floor((now - created) / 86400000);
    out.push({
      note: j,
      due: daysSinceCreate >= threshold,
      daysSinceCreate,
      thresholdDays: threshold
    });
  }
  return out;
}

/**
 * 5.2 c: 给单条 note 拼对照报告的 prompt
 * 返回 { systemPrompt, userPrompt } — 让 LLM 注入即可
 */
function buildVerifyPrompt(note, currentData) {
  const cd = currentData || {};
  const systemPrompt = `你是一个严谨的 A 股个人投资复盘助理, 任务是基于"用户当时的判断"和"当前市场数据"生成一份对照报告。规则:
1. 严禁编造数据, 只能引用下方提供的 "当前市场反馈" 数字
2. 客观描述 "当时判断" 与 "当前市场反馈" 的一致/偏差
3. 3 段简短结构 (≤ 200 字):
   - 当时判断: 引用 assumption + emotion
   - 当前市场反馈: 列出 code/价格/涨跌幅/相关新闻
   - 自我反思: 1-2 句 (是否验证, 偏差原因)
4. 不预测, 不推荐买卖
5. 严格 markdown 格式, 用 ### 标题`;

  const dataLine = cd.error
    ? `(行情拉取失败: ${cd.error})`
    : `${note.code} 当前价 ${cd.price?.toFixed(2) ?? '?'} (${(cd.changePct >= 0 ? '+' : '') + (cd.changePct?.toFixed(2) ?? '?')}%)
相关新闻: ${(cd.news || []).slice(0, 3).join(' | ') || '(无)'}`;

  const userPrompt = `【复盘笔记】(${note.date || '?'} 写下, 距今 ${cd.daysSince ?? '?'} 天)
标题: ${note.title || '(无)'}
买入假设: ${note.assumption || '(未选)'}
情绪标签: ${note.emotion || '(未选)'}
事后验证: ${note.verify || 'pending'}
正文: ${(note.content || '').slice(0, 500)}

【当前市场反馈】
${dataLine}

请生成对照报告。`;
  return { systemPrompt, userPrompt };
}

/**
 * 5.2 c: 把对照报告 append 到 note.content, 标记 verify='verified'
 */
function applyVerifyReport(note, report) {
  if (!note || !report) return note;
  const updated = { ...note };
  const separator = '\n\n---\n\n';
  const section = `### 🔁 AI 事后验证 (${new Date().toISOString().slice(0, 10)})\n${report}`;
  updated.content = (updated.content || '') + separator + section;
  updated.verify = 'verified';
  updated.verifiedAt = Date.now();
  return updated;
}

// ==================== 拉个股行情 (事后验证用) ====================
/**
 * Y7: 改用 stock_zh_a_hist (K 线接口, 接受 symbol), 取最后一根日线的收盘价 = 当前价
 * 之前用 stock_zh_a_spot_em 是全市场接口, 不接受 symbol, data[0] 永远是按字典序第一只股票
 */
async function fetchStockQuote(code) {
  if (!code) return { error: 'no code' };
  try {
    // 取近 5 个交易日的 K 线 (足够拿到最新一根)
    const end = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const startDate = new Date(); startDate.setDate(startDate.getDate() - 7);
    const start = startDate.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `${AKTOOLS}/api/public/stock_zh_a_hist?symbol=${encodeURIComponent(code)}&period=daily&start_date=${start}&end_date=${end}&adjust=qfq`;
    const resp = await fetch(url, { timeout: 8000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return { error: 'no data' };
    // 取最后一根 (最新交易日)
    const row = data[data.length - 1];
    // 字段名容错: 收盘价/close, 涨跌幅/change_pct
    const close = parseFloat(row['收盘价'] ?? row.收盘价 ?? row.close ?? row['最新价'] ?? 0);
    // 涨跌幅: K 线不一定带, 用 (close - 昨收) / 昨收 算 (fallback)
    let changePct = parseFloat(row['涨跌幅'] ?? row.涨跌幅 ?? row.change_pct ?? NaN);
    if (isNaN(changePct) && data.length >= 2) {
      const prevClose = parseFloat(data[data.length - 2]['收盘价'] ?? data[data.length - 2].收盘价 ?? 0);
      if (prevClose > 0) changePct = ((close - prevClose) / prevClose) * 100;
    }
    return { price: close, changePct: isNaN(changePct) ? 0 : changePct };
  } catch (e) {
    return { error: e.message };
  }
}

// ==================== 事后验证主流程 (5.2 c) ====================
/**
 * @param {string} journalsPath  app 导出的 journals JSON 路径
 * @param {boolean} dryRun        只扫描不写入
 * @param {object} [deps]         注入依赖便于测试: { fetchQuote, callLLM }
 */
async function runVerify(journalsPath, dryRun = false, deps = {}) {
  if (!fs.existsSync(journalsPath)) {
    err('找不到 journals 文件:', journalsPath);
    process.exit(1);
  }
  const journals = JSON.parse(fs.readFileSync(journalsPath, 'utf-8'));
  if (!Array.isArray(journals)) {
    err('journals JSON 格式不对 (期望数组)');
    process.exit(1);
  }
  const fetcher = deps.fetchQuote || fetchStockQuote;
  const llmCaller = deps.callLLM || callLLM;

  const picked = pickJournalsForVerify(journals);
  const dueItems = picked.filter(p => p.due);
  log(`共 ${journals.length} 条复盘, 命中 ${picked.length} 条可验证, 其中 ${dueItems.length} 条到期`);

  if (dryRun) {
    log('=== dry-run 模式: 列出到期条目 ===');
    for (const p of dueItems) {
      log(`  - ${p.note.date} ${p.note.code} ${p.note.title || '(无标题)'} (${p.daysSinceCreate} 天, 阈值 ${p.thresholdDays} 天, 假设: ${p.note.assumption || '?'})`);
    }
    return { picked, dueItems, updated: [] };
  }

  const updated = [];
  for (const p of dueItems) {
    const note = p.note;
    log(`处理: ${note.date} ${note.code} ${note.title || '(无标题)'}`);

    // 1) 拉当前行情
    const quote = await fetcher(note.code);
    const currentData = {
      price: quote.price,
      changePct: quote.changePct,
      error: quote.error,
      daysSince: p.daysSinceCreate
    };

    // 2) 拼 prompt + 调 LLM
    const { systemPrompt, userPrompt } = buildVerifyPrompt(note, currentData);
    const report = await llmCaller(userPrompt, systemPrompt);
    if (!report) {
      log(`  跳过 (LLM 未返回)`);
      continue;
    }

    // 3) 写回 note
    const newNote = applyVerifyReport(note, report);
    updated.push(newNote);
  }

  if (updated.length > 0) {
    const outPath = journalsPath.replace(/\.json$/i, '') + '.verified.json';
    fs.writeFileSync(outPath, JSON.stringify(updated, null, 2), 'utf-8');
    log(`✅ 写回 ${updated.length} 条到 ${outPath}`);
  } else {
    log('没有需要更新的笔记');
  }
  return { picked, dueItems, updated };
}

// ==================== 主流程 (dispatch summary/verify) ====================
async function main() {
  const args = parseArgs();

  // 5.2 c: --verify 模式
  if (args.mode === 'verify') {
    return runVerify(args.journalsPath, args.dryRun);
  }

  // Phase C: --premarket 盘前简报模式
  if (args.mode === 'premarket') {
    return runPremarket();
  }

  // 盘后总结模式 (原逻辑)
  const { snapshotPath } = args;

  // 1. 读 snapshot
  if (!fs.existsSync(snapshotPath)) {
    err('找不到快照文件:', snapshotPath);
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  log('已读快照:', snapshotPath);
  log('日期:', snap.date || '?');
  log('持仓:', (snap.holdings || []).length, '只');
  log('基金:', (snap.funds || []).length, '只');

  // 2. 拉大盘
  log('拉大盘...');
  const indices = await fetchIndices();
  log('大盘:', indices.length, '个指数');

  // 3. 拼 prompt
  const idxText = indices.length > 0
    ? indices.map(i => {
      const sign = i.change > 0 ? '+' : '';
      return `${i.name} ${i.price.toFixed(2)} (${sign}${i.change.toFixed(2)}%)`;
    }).join(', ')
    : '⚠ 拉取失败';

  const stockText = (snap.holdings || []).map(h => {
    const pl = h.profitLoss != null ? h.profitLoss.toFixed(2) : '?';
    const plPct = h.profitLossPct != null ? (h.profitLossPct * 100).toFixed(2) : '?';
    return `${h.code} ${h.name || ''} ${h.shares}股 @${h.cost} 市值${h.marketValue?.toFixed(0)} 盈亏${pl}(${plPct}%)`;
  }).join('\n') || '(无股票持仓)';

  const fundText = (snap.funds || []).map(f => {
    const nav = f.currentNav?.toFixed(4) || '?';
    const pl = f.profitLoss != null ? f.profitLoss.toFixed(2) : '?';
    return `${f.code} ${f.name || ''} ${f.shares}份 @${nav} 盈亏${pl}`;
  }).join('\n') || '(无基金持仓)';

  const cashflowText = (snap.cashflow || []).map(c => {
    return `${c.date} ${c.type} ${c.amount} ${c.target || ''} ${c.note || ''}`;
  }).join('\n') || '(无操作)';

  const systemPrompt = `你是一个严谨的 A 股投资助理。基于用户的持仓 + 当日大盘 + 当日操作, 生成一段"盘后总结"。
要求:
1. **保守严谨**, 不预测, 不推荐买卖
2. 引用具体数据 (大盘点位、持仓盈亏、操作金额)
3. 简短 (200-400 字), 3 段:
   - 大盘情况: 1-2 句
   - 持仓表现: 1-2 句 (哪些涨了, 哪些跌了)
   - 明日关注: 1-2 句 (基于今日数据有什么需要留意的)
4. 不使用绝对化语言 ("一定""必然")
5. 用 markdown 格式`;

  const userPrompt = `日期: ${snap.date || '今日'}

🌐 **大盘**: ${idxText}

💼 **股票持仓**:
${stockText}

🏦 **基金持仓**:
${fundText}

💸 **今日操作**:
${cashflowText}

💰 **总资产**: ${snap.totalValue?.toFixed(2) || '?'} 元 (现金 ${snap.cash?.toFixed(2) || '?'} / 股票 ${snap.stockValue?.toFixed(2) || '?'} / 基金 ${snap.fundValue?.toFixed(2) || '?'})

请生成盘后总结。`;

  // 4. 调 LLM
  log('调 LLM...');
  const summary = await callLLM(userPrompt, systemPrompt);

  // 5. 拼 markdown 报告
  const date = snap.date || new Date().toISOString().slice(0, 10);
  const report = `# 📊 盘后总结 ${date}

## 🌐 大盘
${idxText}

## 💼 持仓
### 股票
${stockText}

### 基金
${fundText}

## 💸 今日操作
${cashflowText}

## 🤖 AI 总结
${summary || '⚠ LLM 未调用 (检查 DEEPSEEK_API_KEY)'}

---
*生成于 ${new Date().toISOString()}*
`;

  // 6. 写文件
  const outPath = path.join(ROOT, `daily_summary_${date.replace(/-/g, '')}.md`);
  fs.writeFileSync(outPath, report, 'utf-8');
  log('已写报告:', outPath);

  // 7. 推飞书 (短摘要)
  const feishuText = `📊 盘后总结 ${date}\n\n` +
    `🌐 ${idxText}\n\n` +
    `💰 总资产: ${snap.totalValue?.toFixed(0) || '?'} 元\n` +
    `📈 持仓 ${(snap.holdings || []).length} 只 / 🏦 基金 ${(snap.funds || []).length} 只\n` +
    `💸 今日 ${(snap.cashflow || []).length} 笔操作\n\n` +
    `📝 AI 总结:\n${summary || '(未生成)'}\n\n` +
    `详细: ${path.relative(ROOT, outPath)}`;
  await pushFeishu(feishuText);

  log('✅ 全部完成');
}

// 仅当直接执行时跑 (Windows 下 argv[1] 是反斜杠路径, 用 pathToFileURL 归一化再比较)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => {
    err('未捕获错误:', e);
    process.exit(1);
  });
}

// 导出供测试
export {
  parseArgs,
  fetchIndices,
  fetchStockQuote,
  callLLM,
  pushFeishu,
  pickJournalsForVerify,
  buildVerifyPrompt,
  applyVerifyReport,
  runVerify,
  fetchUsIndices,
  buildEconomicCalendar,
  fetchCaixinNews,
  formatPremarketRaw,
  buildPremarketPrompt,
  runPremarket,
  main
};
