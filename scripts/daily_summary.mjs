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
 * 5.2 c: 给单条 note 拼对照报告的 prompt (Z2: 升级为强制 JSON 输出)
 * 返回 { systemPrompt, userPrompt } — 让 LLM 注入即可
 *
 * Z2 改动: 不再是自由文本, 强制 LLM 输出结构化 JSON:
 *   { verdict: "对"|"错"|"部分", attribution: 枚举, lesson: 一句话 }
 * 同时仍要 narrative (≤ 200 字, 人类可读), 写进 note.content
 */
function buildVerifyPrompt(note, currentData) {
  const cd = currentData || {};
  const systemPrompt = `你是一个严谨的 A 股个人投资复盘助理, 任务是基于"用户当时的判断"和"当前市场数据"生成一份对照报告。规则:
1. 严禁编造数据, 只能引用下方提供的 "当前市场反馈" 数字
2. 客观描述 "当时判断" 与 "当前市场反馈" 的一致/偏差
3. 输出严格 JSON (会被 schema 校验), 字段:
   - verdict: 必填, 三个值之一: "对" (假设被市场证实) / "错" (假设被证伪) / "部分" (方向对但程度/时点有偏)
   - attribution: 必填, 错/部分时填写 (对的时候填 "无"), 候选值:
     追高 (情绪化入场点位差) / 假设错 (逻辑本身不成立) / 时机早 (逻辑对但市场未到) / 大盘拖累 (个股 OK 但系统性下跌) / 黑天鹅 (突发不可控事件) / 其他
   - lesson: 必填, 1 句话 ≤ 30 字, 总结下次遇到类似情境该怎么调整
   - narrative: 必填, ≤ 200 字 markdown, 3 段: 当时判断 / 当前市场反馈 / 自我反思
4. 不预测, 不推荐买卖
5. 严格 JSON, 严禁多余文字`;

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

【输出 JSON】
{"verdict":"对|错|部分", "attribution":"追高|假设错|时机早|大盘拖累|黑天鹅|其他|无", "lesson":"≤30字", "narrative":"≤200字 markdown"}`;
  return { systemPrompt, userPrompt };
}

/**
 * Z2: 从 LLM 输出里抽 JSON, 校验 + 枚举值归一化
 * 容错: 围栏 ```json, markdown 残留, 字段缺失
 * @returns { ok, result: {verdict, attribution, lesson, narrative}, errors }
 */
const VERDICTS = ['对', '错', '部分'];
const ATTRIBUTIONS = ['追高', '假设错', '时机早', '大盘拖累', '黑天鹅', '其他', '无'];

function parseVerifyJsonOutput(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, result: null, errors: ['empty output'] };
  }
  // 1) 抽 JSON (容错围栏)
  let jsonText = null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) jsonText = fence[1].trim();
  if (!jsonText) {
    const objStart = text.indexOf('{');
    const objEnd = text.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) jsonText = text.slice(objStart, objEnd + 1);
  }
  if (!jsonText) return { ok: false, result: null, errors: ['no JSON object found'] };
  // 2) parse
  let obj;
  try { obj = JSON.parse(jsonText); }
  catch (e) { return { ok: false, result: null, errors: ['JSON parse error: ' + e.message] }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, result: null, errors: ['root not object'] };
  }
  // 3) 字段校验 + 枚举归一化
  const errors = [];
  let verdict = obj.verdict;
  if (!VERDICTS.includes(verdict)) errors.push(`verdict "${verdict}" 不在 ${VERDICTS.join('/')}`);
  let attribution = obj.attribution;
  if (!ATTRIBUTIONS.includes(attribution)) {
    // 自由发挥归 "其他" (而不是直接 reject, 保留 narrative 价值)
    attribution = '其他';
  }
  // verdict=对 → attribution 强制 "无"
  if (verdict === '对' && attribution !== '无') {
    console.warn(`[Verify] verdict=对 但 attribution=${attribution}, 强制归 "无"`);
    attribution = '无';
  }
  const lesson = typeof obj.lesson === 'string' ? obj.lesson.slice(0, 60) : '';
  const narrative = typeof obj.narrative === 'string' ? obj.narrative.slice(0, 200) : '';
  if (!lesson) errors.push('lesson 缺失');
  if (!narrative) errors.push('narrative 缺失');
  return {
    ok: errors.length === 0,
    result: { verdict, attribution, lesson, narrative },
    errors
  };
}

/**
 * 5.2 c: 把对照报告 + 结构化字段写回 note
 *   - note.content 末尾 append narrative (人类可读)
 *   - note.aiVerified = { verdict, attribution, lesson, ts } (Z2 反馈闭环用)
 *   - note.verify = 'verified'
 */
function applyVerifyReport(note, parsed) {
  if (!note || !parsed) return note;
  const updated = { ...note };
  const separator = '\n\n---\n\n';
  const section = `### 🔁 AI 事后验证 (${new Date().toISOString().slice(0, 10)})
**判定**: ${parsed.verdict} | **归因**: ${parsed.attribution} | **教训**: ${parsed.lesson}

${parsed.narrative}`;
  updated.content = (updated.content || '') + separator + section;
  updated.verify = 'verified';
  updated.verifiedAt = Date.now();
  // Z2: 结构化字段, 反馈闭环 + 历史成绩单的根基
  updated.aiVerified = {
    verdict: parsed.verdict,
    attribution: parsed.attribution,
    lesson: parsed.lesson,
    ts: Date.now()
  };
  return updated;
}

/**
 * Z2: 统计复盘成绩单, 按 (assumption × verdict) 聚合
 * 输出: {
 *   total: 已验证总数,
 *   byAssumption: { '题材催化': { total, hit: 对数, miss: 错数, partial, winRate }, ... },
 *   byAttribution: { '追高': 计数, '假设错': 计数, ... },  // 错/部分时填
 *   lessons: [{ lesson, count, assumption, attribution }, ...],  // 高频教训 (按 lesson 字面分组, >=2 次)
 *   topMissAssumption: 命中率最低的假设 (>= 3 次才有意义),
 *   topHitAssumption: 命中率最高的假设 (>= 3 次)
 * }
 *
 * 这是 AI 升级 #2 的"反馈闭环"核心, 给后续 prompt 注入 "你的历史成绩单" 用.
 */
function getVerifyStats(notes, opts = {}) {
  const minSamples = opts.minSamples || 3;
  const arr = Array.isArray(notes) ? notes.filter(n => n && n.aiVerified) : [];
  const byAssumption = {};
  const byAttribution = {};
  const lessonMap = new Map();
  let total = 0;

  for (const n of arr) {
    const v = n.aiVerified;
    const a = n.assumption || '其他';
    if (!byAssumption[a]) byAssumption[a] = { total: 0, hit: 0, miss: 0, partial: 0, winRate: 0 };
    byAssumption[a].total++;
    if (v.verdict === '对') byAssumption[a].hit++;
    else if (v.verdict === '错') byAssumption[a].miss++;
    else if (v.verdict === '部分') byAssumption[a].partial++;

    if (v.attribution && v.attribution !== '无') {
      byAttribution[v.attribution] = (byAttribution[v.attribution] || 0) + 1;
    }

    if (v.lesson) {
      const key = v.lesson.trim();
      if (key) {
        const cur = lessonMap.get(key) || { lesson: key, count: 0, assumption: a, attribution: v.attribution };
        cur.count++;
        lessonMap.set(key, cur);
      }
    }
    total++;
  }

  // 算 winRate + 找 topHit / topMiss
  let topHit = null, topMiss = null;
  for (const a of Object.keys(byAssumption)) {
    const x = byAssumption[a];
    x.winRate = x.total > 0 ? +(x.hit / x.total * 100).toFixed(1) : 0;
    if (x.total >= minSamples) {
      if (!topHit || x.winRate > topHit.winRate) topHit = { assumption: a, ...x };
      if (!topMiss || x.winRate < topMiss.winRate) topMiss = { assumption: a, ...x };
    }
  }

  // 高频教训 (count >= 2)
  const lessons = Array.from(lessonMap.values())
    .filter(l => l.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { total, byAssumption, byAttribution, lessons, topHit, topMiss };
}

/**
 * Z2: 把成绩单渲染为 AI prompt 友好中文 (注入到 system prompt 用)
 * @returns {string} 多行中文, 数据不足时返 '⚠ ...'
 */
function formatVerifyStatsForPrompt(stats) {
  if (!stats || stats.total === 0) {
    return '⚠ 暂无已验证的复盘数据, 无法提供历史成绩单 (先跑 `daily_summary.mjs --verify` 累积数据)';
  }
  const lines = [`- **复盘历史 (${stats.total} 条已验证)**`];
  if (stats.topHit) {
    lines.push(`- **最准假设**: ${stats.topHit.assumption} (${stats.topHit.winRate}%, ${stats.topHit.total} 次)`);
  }
  if (stats.topMiss) {
    lines.push(`- **最差假设**: ${stats.topMiss.assumption} (${stats.topMiss.winRate}%, ${stats.topMiss.total} 次)`);
  }
  if (stats.lessons.length > 0) {
    lines.push(`- **高频教训**: ${stats.lessons.map(l => `${l.lesson} (${l.count}次)`).join('; ')}`);
  }
  // 错误归因分布
  const attEntries = Object.entries(stats.byAttribution).sort((a, b) => b[1] - a[1]);
  if (attEntries.length > 0) {
    lines.push(`- **错误归因分布**: ${attEntries.map(([k, v]) => `${k} ${v}次`).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Z3: 概率校准
 * 数据要求: 每条 note.aiVerified 同时有 confidence (0-1) 和 verdict (对/错/部分)
 *  - confidence: AI 在出具 verify 时填的"我猜对概率"
 *  - verdict: '对' → outcome=1, '错' → outcome=0, '部分' → outcome=0.5 (部分对算 0.5 信用)
 *
 * 输出:
 *   brierScore: 标量, BS = mean((p - o)^2), 越小越好, 完美=0, 全错=1
 *   baselineBs: 0.25 (全猜 0.5 的无信息基线, 方便对比)
 *   skillScore: 1 - brierScore/baselineBs, > 0 表示比瞎猜强, < 0 表示反向指标
 *   samples: 有效样本数
 *   buckets: [{ range: [lo, hi], predicted, actual, n, gap }]  // 10 桶
 *   overconfidencePct: predicted > actual 的桶数占比
 *   underconfidencePct: predicted < actual 的桶数占比
 */
function computeCalibration(notes, opts = {}) {
  const bucketSize = opts.bucketSize || 0.1;
  const samples = [];
  for (const n of notes) {
    if (!n || !n.aiVerified) continue;
    const conf = typeof n.aiVerified.confidence === 'number' && Number.isFinite(n.aiVerified.confidence) ? n.aiVerified.confidence : null;
    if (conf == null || conf < 0 || conf > 1) continue;
    let outcome = null;
    if (n.aiVerified.verdict === '对') outcome = 1;
    else if (n.aiVerified.verdict === '错') outcome = 0;
    else if (n.aiVerified.verdict === '部分') outcome = 0.5;
    if (outcome == null) continue;
    samples.push({ conf, outcome });
  }

  if (samples.length === 0) {
    return {
      brierScore: null, baselineBs: 0.25, skillScore: null,
      samples: 0, buckets: [], overconfidencePct: 0, underconfidencePct: 0
    };
  }

  // 1) Brier Score
  let ss = 0;
  for (const s of samples) ss += (s.conf - s.outcome) ** 2;
  const brierScore = ss / samples.length;
  const baselineBs = 0.25;
  const skillScore = 1 - brierScore / baselineBs;

  // 2) 10 桶 (0-0.1, 0.1-0.2, ...)
  const buckets = [];
  for (let lo = 0; lo < 1.0; lo += bucketSize) {
    const hi = lo + bucketSize;
    const inBucket = samples.filter(s => s.conf >= lo && s.conf < hi);
    if (inBucket.length === 0) continue;
    const meanConf = inBucket.reduce((a, b) => a + b.conf, 0) / inBucket.length;
    const meanActual = inBucket.reduce((a, b) => a + b.outcome, 0) / inBucket.length;
    buckets.push({
      range: [lo, hi],
      label: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`,
      predicted: +meanConf.toFixed(3),
      actual: +meanActual.toFixed(3),
      n: inBucket.length,
      gap: +(meanConf - meanActual).toFixed(3)  // 正=过度自信, 负=过度保守
    });
  }

  // 3) 整体偏向
  let overC = 0, underC = 0;
  for (const b of buckets) {
    if (b.gap > 0.05) overC++;
    else if (b.gap < -0.05) underC++;
  }
  const total = buckets.length || 1;
  return {
    brierScore: +brierScore.toFixed(4),
    baselineBs,
    skillScore: +skillScore.toFixed(3),
    samples: samples.length,
    buckets,
    overconfidencePct: +(overC / total * 100).toFixed(0),
    underconfidencePct: +(underC / total * 100).toFixed(0)
  };
}

/**
 * Z3: 把校准报告渲染为 AI prompt 友好中文
 * 数据不足时返 '⚠ ...', 否则 3 段: 综合 BS / 偏向警告 / 桶级明细 (前 3 桶)
 */
function formatCalibrationForPrompt(report) {
  if (!report || report.samples === 0) {
    return '⚠ 暂无含 confidence 的 verify 数据, 无法做概率校准 (从下次起, AI 出具 verify 时填 confidence 字段)';
  }
  const lines = [`- **校准样本 (${report.samples} 条)**`];
  if (report.brierScore != null) {
    const skillDesc = report.skillScore > 0.2 ? '良好' : report.skillScore > 0 ? '略胜瞎猜' : '反向指标';
    lines.push(`- **Brier Score**: ${report.brierScore} (基线 0.25, 越小越好, Skill Score ${report.skillScore}, ${skillDesc})`);
  }
  if (report.overconfidencePct > 30) {
    lines.push(`- ⚠ **过度自信警告**: ${report.overconfidencePct}% 的桶 predicted>actual, 后续判断时建议 confidence -10%`);
  }
  if (report.underconfidencePct > 30) {
    lines.push(`- ⚠ **过度保守警告**: ${report.underconfidencePct}% 的桶 predicted<actual, 后续判断时建议 confidence +10%`);
  }
  if (report.buckets.length > 0) {
    const top3 = report.buckets.slice(0, 3);
    const txt = top3.map(b => `${b.label} → 预测 ${(b.predicted * 100).toFixed(0)}% / 实际 ${(b.actual * 100).toFixed(0)}% (n=${b.n})`).join('; ');
    lines.push(`- **桶级明细 (前 3)**: ${txt}`);
  }
  return lines.join('\n');
}

/**
 * Z5: 从所有已验证的 notes 提炼"结构化教训"
 * 每条教训: {
 *   situation: { assumption, attribution, regimeHint }  // 情境指纹 (用于检索)
 *   lesson: 教训文本 (≤60 字)
 *   verdict: 对/错/部分
 *   count: 出现次数
 *   examples: [{ noteId, ts }]  // 来源追溯
 *   ts: 最近一次时间戳
 * }
 * 输出: { lessons: [...], total }
 *
 * 设计: FINCON (arXiv:2311.10759) 主张把投资经验编码为"情境→教训"映射, 检索比 append 有效.
 *   此处用 assumption + attribution 当"情境指纹"近似, 比纯字符串聚合更结构化.
 */
function buildStructuredLessons(notes, opts = {}) {
  const minCount = opts.minCount || 2;  // 至少出现 2 次才入教训
  const maxLessons = opts.maxLessons || 50;
  const arr = Array.isArray(notes) ? notes.filter(n => n && n.aiVerified && n.aiVerified.lesson) : [];
  // key: lesson 文本 (归一化)
  const map = new Map();
  for (const n of arr) {
    const v = n.aiVerified;
    const key = (v.lesson || '').trim();
    if (!key) continue;
    const situation = {
      assumption: n.assumption || '其他',
      attribution: v.attribution || '无'
    };
    if (!map.has(key)) {
      map.set(key, {
        situation,
        lesson: key,
        verdict: v.verdict,
        count: 0,
        examples: [],
        ts: 0
      });
    }
    const item = map.get(key);
    item.count++;
    if ((v.ts || 0) > item.ts) {
      item.ts = v.ts || 0;
      item.verdict = v.verdict;  // 用最新的 verdict
    }
    if (item.examples.length < 3) {
      item.examples.push({ noteId: n.id, ts: v.ts || 0 });
    }
  }
  const lessons = Array.from(map.values())
    .filter(l => l.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxLessons);
  return { lessons, total: arr.length };
}

/**
 * Z5: 按当前情境检索最相关的历史教训 (FINCON 检索模拟)
 * @param ctx { assumption?, attribution? } 当前复盘的假设/初步归因
 * @param lessons 上一步 buildStructuredLessons 的输出
 * @param opts { topK=3, sameAssumptionBoost=2 }
 * @returns 命中的 lessons (按相关性排序), 限 topK 条
 *
 * 评分 (无 embedding 时的简化版):
 *   +3 if same assumption
 *   +2 if same attribution
 *   +1 per count (高频加权)
 */
function recallLessons(ctx, lessonsObj, opts = {}) {
  const topK = opts.topK || 3;
  const sameAssumptionBoost = opts.sameAssumptionBoost || 3;
  const sameAttributionBoost = opts.sameAttributionBoost || 2;
  const arr = (lessonsObj && lessonsObj.lessons) || [];
  const scored = arr.map(l => {
    let score = l.count;  // baseline
    if (ctx && ctx.assumption && l.situation.assumption === ctx.assumption) {
      score += sameAssumptionBoost;
    }
    if (ctx && ctx.attribution && l.situation.attribution === ctx.attribution) {
      score += sameAttributionBoost;
    }
    return { ...l, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Z5: 把检索结果渲染为中文 (注入 AI prompt 用)
 */
function formatRecalledLessonsForPrompt(recalled) {
  if (!Array.isArray(recalled) || recalled.length === 0) {
    return '⚠ 无相关历史教训 (先跑 `daily_summary.mjs --verify` 累积 2+ 条同类教训)';
  }
  const lines = [`- **📚 相关历史教训 (${recalled.length} 条, 按相似度)**`];
  for (const r of recalled) {
    const tag = r.verdict === '错' ? '⚠️' : r.verdict === '部分' ? '⚡' : '✅';
    lines.push(`- ${tag} ${r.lesson} _(假设:${r.situation.assumption} 归因:${r.situation.attribution}, ${r.count}次)_`);
  }
  return lines.join('\n');
}

/**
 * Z7: 月度教训提炼 - 把当月所有已验证复盘浓缩成一份报告
 * @param notes Array 已过滤好当月的笔记
 * @returns {
 *   month: 'YYYY-MM',
 *   total, hitRate,             // 总数 + 命中率 (对+部分×0.5 / 总)
 *   topAssumption,              // 命中率最高/最低的假设 (>=3 样本)
 *   topLessons: string[],       // Top 3 高频教训
 *   topAttribution: string,     // 最常见的错因
 *   oneThing: string,           // 一句话总结: "本月最该改的一件事"
 *   calibration: { brierScore, samples }  // 月度校准 (样本少时可能 null)
 * }
 */
function summarizeMonth(notes, opts = {}) {
  const arr = Array.isArray(notes) ? notes.filter(n => n && n.aiVerified) : [];
  if (arr.length === 0) {
    return {
      month: opts.month || new Date().toISOString().slice(0, 7),
      total: 0,
      hitRate: 0,
      topAssumption: null,
      topLessons: [],
      topAttribution: null,
      oneThing: '本月暂无已验证的复盘数据, 多写日记并跑 verify 即可累积',
      calibration: { brierScore: null, samples: 0 }
    };
  }

  // 1) 命中率
  let hits = 0;
  for (const n of arr) {
    if (n.aiVerified.verdict === '对') hits += 1;
    else if (n.aiVerified.verdict === '部分') hits += 0.5;
  }
  const hitRate = +(hits / arr.length * 100).toFixed(1);

  // 2) Top assumption (复用 getVerifyStats)
  const stats = getVerifyStats(arr);
  let topHit = null, topMiss = null;
  for (const a of Object.keys(stats.byAssumption)) {
    const x = stats.byAssumption[a];
    if (x.total >= 3) {
      if (!topHit || x.winRate > topHit.winRate) topHit = { assumption: a, ...x };
      if (!topMiss || x.winRate < topMiss.winRate) topMiss = { assumption: a, ...x };
    }
  }
  const topAssumption = {
    best: topHit ? { assumption: topHit.assumption, winRate: topHit.winRate, total: topHit.total } : null,
    worst: topMiss ? { assumption: topMiss.assumption, winRate: topMiss.winRate, total: topMiss.total } : null
  };

  // 3) Top 3 lessons (复用 buildStructuredLessons)
  const lessonsObj = buildStructuredLessons(arr, { minCount: 1, maxLessons: 3 });
  const topLessons = lessonsObj.lessons.map(l => `${l.lesson} (${l.count}次)`);

  // 4) Top attribution
  const attEntries = Object.entries(stats.byAttribution).sort((a, b) => b[1] - a[1]);
  const topAttribution = attEntries.length > 0 ? attEntries[0][0] : null;

  // 5) 一句话: 优先 worst assumption → fallback top attribution → fallback total
  let oneThing;
  if (topMiss) {
    oneThing = `${topMiss.assumption} 假设本月命中率仅 ${topMiss.winRate}% (${topMiss.total} 次), 下月考虑放弃或加更严的入场条件`;
  } else if (topAttribution) {
    oneThing = `本月最常见的错因是 "${topAttribution}", 建议复盘入场流程`;
  } else if (arr.length >= 3) {
    oneThing = `本月命中率 ${hitRate}%, ${hits} 对 / ${arr.length} 总, 保持节奏`;
  } else {
    oneThing = `数据积累中 (本月 ${arr.length} 条), 多写日记跑 verify`;
  }

  // 6) 月度校准
  const cal = computeCalibration(arr);

  return {
    month: opts.month || new Date().toISOString().slice(0, 7),
    total: arr.length,
    hitRate,
    topAssumption,
    topLessons,
    topAttribution,
    oneThing,
    calibration: { brierScore: cal.brierScore, samples: cal.samples }
  };
}

/**
 * Z7: 把月度报告渲染为中文 (适合直接 push 给用户的格式)
 */
function formatMonthReportForPrompt(report) {
  if (!report || report.total === 0) {
    return '⚠ 本月暂无已验证的复盘, 建议先写几条日记并在到期时跑 verify';
  }
  const lines = [`📅 **${report.month} 月度复盘** (${report.total} 条已验证)`];
  lines.push(`- **命中率**: ${report.hitRate}% (${report.hitRate >= 60 ? '良好 ✅' : report.hitRate >= 40 ? '中等 ⚡' : '偏低 ⚠️'})`);
  if (report.topAssumption.best) {
    lines.push(`- **最准假设**: ${report.topAssumption.best.assumption} (${report.topAssumption.best.winRate}%, ${report.topAssumption.best.total} 次)`);
  }
  if (report.topAssumption.worst) {
    lines.push(`- **最差假设**: ${report.topAssumption.worst.assumption} (${report.topAssumption.worst.winRate}%, ${report.topAssumption.worst.total} 次)`);
  }
  if (report.topAttribution) {
    lines.push(`- **最常见错因**: ${report.topAttribution}`);
  }
  if (report.topLessons.length > 0) {
    lines.push(`- **本月教训 Top ${report.topLessons.length}**:`);
    report.topLessons.forEach(l => lines.push(`  - ${l}`));
  }
  if (report.calibration.samples > 0 && report.calibration.brierScore != null) {
    lines.push(`- **校准**: Brier ${report.calibration.brierScore} (n=${report.calibration.samples})`);
  }
  lines.push(`- **🎯 下月重点**: ${report.oneThing}`);
  return lines.join('\n');
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

    // 3) 解析结构化 JSON (Z2 反馈闭环)
    const parsed = parseVerifyJsonOutput(report);
    if (!parsed.ok) {
      log(`  跳过 (JSON 解析失败: ${parsed.errors.join('; ')})`);
      continue;
    }
    if (parsed.result.verdict === '对') {
      log(`  ✅ 验证: ${parsed.result.verdict} | 归因: ${parsed.result.attribution} | 教训: ${parsed.result.lesson}`);
    } else {
      log(`  ⚠ 验证: ${parsed.result.verdict} | 归因: ${parsed.result.attribution} | 教训: ${parsed.result.lesson}`);
    }

    // 4) 写回 note (含 aiVerified 结构化字段)
    const newNote = applyVerifyReport(note, parsed.result);
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
  parseVerifyJsonOutput,
  applyVerifyReport,
  getVerifyStats,
  formatVerifyStatsForPrompt,
  computeCalibration,
  formatCalibrationForPrompt,
  buildStructuredLessons,
  recallLessons,
  formatRecalledLessonsForPrompt,
  summarizeMonth,
  formatMonthReportForPrompt,
  runVerify,
  fetchUsIndices,
  buildEconomicCalendar,
  fetchCaixinNews,
  formatPremarketRaw,
  buildPremarketPrompt,
  runPremarket,
  main
};
