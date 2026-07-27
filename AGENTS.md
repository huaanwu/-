# StockMaster — AI Agent 工作守则

> 任何 AI agent (Mavis / Claude / Codex / Kimi) 在这个项目工作时,先读完这份。
> 本文面向对项目一无所知的接手者,只写经过核实的实际内容。

## 项目概览

- **StockMaster**:自用投资工具 (A股 + 基金),功能:行情看板 / 持仓管理 / 复盘笔记 / 选股筛选 / 资金账户 / 基金专项 / 策略回测 / 提醒监控。
- **只服务开发者本人**,不公开,不商业化,**零合规要求**:不接真实交易接口,只做行情/持仓/复盘/选股/回测/提醒,不做代客理财/荐股。
- **跨端**:Web 浏览器 (SPA) + Android APK (Capacitor 8 打包,一份 Web 代码两端用)。
- 数据全部本地化 (IndexedDB via Dexie),可选 Supabase 自托管云同步 (用户主动登录后才用,不同步 API Key)。
- 工程骨架沿用同作者的 zhanbu (AI 占卜大师) 项目:Capacitor + Vite + 原生 JS,不复用其业务代码。

## 技术栈(硬性)

| 层 | 选型 | 备注 |
|----|------|------|
| 跨端壳 | Capacitor 8 (`androidScheme: http`,允许明文 HTTP) | `webDir: www`,`appId: com.stock.master` |
| 构建 | Vite 5 (`root=www`, `outDir=www/dist`) | CSS 不切分;域脚本 external 不打包 |
| UI | 原生 JS + HTML + CSS | **禁止换 Vue/React/TS** |
| 图表 | ECharts 5 (UMD,`www/lib/echarts.min.js`) | K线/分时/收益曲线 |
| 存储 | Dexie 4 (UMD,`www/lib/dexie.min.js`) | IndexedDB 封装 |
| Markdown | marked 15 | 复盘笔记渲染 |
| 数据源 | AKShare → Python aktools HTTP 服务 → Node dev-proxy | 另有腾讯财经直连备用源 |
| LLM | DeepSeek / OpenAI / Moonshot / Qwen / Zhipu / Custom | SSE 流式,浏览器经 dev-proxy 转发 (CORS) |
| 提醒 | @capacitor/local-notifications | Android 本地推送 |
| Android | minSdk 24 / compileSdk 36 / targetSdk 36 | `android/variables.gradle` |

## 常用命令

### 开发

```bash
npm install                 # 装依赖
pip install aktools         # 前置: AKShare HTTP 服务
python -m aktools http --host 127.0.0.1 --port 8088   # AKShare 后端 :8088
npm run dev                 # 一条龙: Vite :3003 + dev-proxy :8089 (concurrently)
npm run dev:vite            # 只起 Vite
npm run dev:proxy           # 只起 dev-proxy (scripts/dev-proxy.mjs)
```

- Vite 端口固定 **3003**。dev-proxy 健康检查: `http://127.0.0.1:8089/health`。
- Vite proxy: `/api/akshare → 127.0.0.1:8088` (rewrite 成 `/api/public/{item_id}`,匹配 aktools 0.0.91+),`/api/llm → 127.0.0.1:8089` (dev-proxy 自己再转 DeepSeek/OpenAI/...)。
- **生产/APK 不走 vite proxy**,APK 通过局域网 IP 访问本机 dev-proxy;`proxyBase` 设置项可切换后端地址。

### 构建与发布(硬性流程)

```bash
npm run build               # 一条龙: copy-libs + vite build + build-web
#   等价于:
#   node scripts/copy-libs.mjs   # node_modules/{echarts,dexie} UMD → www/lib/
#   vite build                   # → www/dist/
#   node scripts/build-web.mjs   # dist/ 合并回 www/(覆盖 index.html + assets/,styles.css 用 Vite 优化版,public/ 里 PWA 资源拷到 www/ 根)
npm run sync                # build + npx cap sync android
cd android && ./gradlew assembleDebug   # 产物: android/app/build/outputs/apk/debug/app-debug.apk
```

- **严禁**只跑 `vite build` 而不跑 `build-web.mjs`,否则 `cap sync` 复制的还是源码,`assets/` 进不去 APK。
- `android/` 是 Capacitor sync 出来的原生工程,手改会**被下次 sync 覆盖**。
- 升级 ECharts / Dexie:改 `package.json` 版本 → `npm install` → `npm run build:libs`。

### 测试与类型检查

```bash
npm test                    # = node test/test_runtime.js && node test/test_all.js,纯 Node 无浏览器,26 节 600+ 断言
npm run typecheck           # tsc --noEmit
node scripts/e2e.mjs        # 端到端冒烟:Chrome headless + CDP(不依赖 puppeteer),9 项断言 + 截图到 e2e_screenshots/
node scripts/daily_summary.mjs --verify-dry-run ./journals.json   # 事后验证 dry-run
node scripts/daily_summary.mjs --premarket   # Phase C 盘前简报 (隔夜外盘+日历+财新要闻 → LLM → 飞书; 建议 Windows 计划任务 交易日 08:30)
```

`test/test_all.js` 36 节:JS 语法、域脚本接口完备性 (`DOMAINS` 字典)、Core 命名空间导出、index.html script 引用对账、Worker 结构、关键文件存在、Data 层方法签名、回测引擎 vm 沙箱实测、Vite external 对账、journal/market/fund/alerts 纯函数实测、daily_summary 单测 (含 --premarket 盘前简报)、5.1/5.2/5.3 互通闭环实测、数据源限流、Paper 模拟盘纯函数实测 (含 Phase C EOD 日终小结 + 23b T1 sleeve 分账户: 双账户独立现金/过滤/重置/快照 shortTotal/纪律锚点分 sleeve/向后兼容)、Discipline 纪律引擎实测、Phase D1 pre-mortem + 个股公告实测、Phase D2 回测前置 + 双模型实测、Phase E 待确认交易实测 (Pending 去重/上限/过期/状态机/建议仓位 + 接线)、Phase W 中长线盯盘实测 (horizon 打标/短线定时器起停注入断言/交易时段守卫/通知冷却/事件驱动接线/业绩预告 filter+lastNotifiedKeys 去重/regime 三态迁移/估值判定+进出阈值区去重/nextCheck 门控)、ShortTrader T2 盘前计划实测 (39 节: 交易日边界/prompt 要素/校验管线全分支/丢弃留痕/空仓合法/整手换算/regime 缩放/当日防重复/addCondOrder 接线)。**改完域脚本或新增域方法必须先 `npm test`,并同步更新该文件的 `DOMAINS` 字典。**

`scripts/e2e.mjs` 注意:Chrome 路径硬编码 `C:\Program Files\Google\Chrome\Application\chrome.exe`,需要 Vite 已在 3003 端口跑着。

## 目录结构

```
www/                        # Web 根 (= Capacitor webDir,Vite root)
├── index.html              # SPA 入口:全部 <section class="page"> + <script src> 引用
├── styles.css              # 全局样式(CSS 变量主题;build 后被 Vite 优化版覆盖)
├── app.js                  # 入口:APP_VERSION、全局兼容层(Core.X → window fn alias)、init() 启动序列、设置页渲染
├── core/                   # 通用模块,每个文件 IIFE 挂 window.Core.{Module}
│   ├── util.js             # escapeHtml/safeHTML、fmtNum/fmtPct/fmtMoney/pctClass/fmtDate/parseStockInput/uuid/debounce
│   ├── storage.js          # Dexie 4:9 表 + cacheGet/cacheSet(TTL 默认 5 分钟)+ kv + clearAll
│   ├── constants.js        # Core.Constants:跨模块阈值常量(LOT_SIZE=100、STOP_LOSS_RATIO_AUTO=0.92、单票上限/行业上限/月度回撤、纸盘/待确认建仓比例、再平衡漂移阈值 0.05、盯盘分层频率/业绩预告负面名单/估值分位阈值 80、MODULE_TAG)
│   ├── portfolio.js        # Core.Portfolio:getAssets({paper}) 单一资产口径(cash+stockMkt+fundMkt,paper 不含基金),实盘/模拟盘纪律检查共用
│   ├── data.js             # Core.Data:fetchWithCache + getStockSpot/getStockQuote/getStockKLine/getFundSpot/getIndexSpot;腾讯财经备用源(GBK 解码)
│   ├── discipline.js       # Core.Discipline:交易纪律引擎(Phase B),买入前硬校验(假设/止损必填、单票/总仓位、月度回撤熔断、追高/重复错误警告),实盘模拟盘共用;资产口径走 Core.Portfolio(@deprecated _getRealAssets/_getPaperAssets)
│   ├── pending.js          # Core.Pending:实盘待确认交易(Phase E),AI 建议卡片 kv 存储 + 状态机(pending/confirmed/ignored) + _suggestPosition 建议仓位,确认走 holdings 原流程不绕过纪律
│   ├── premortem.js        # Core.Premortem:AI 建议 pre-mortem 工具(Phase D1),PROMPT_SPEC 字段说明 + checkPick/checkPicks 校验 + renderBlock 四象限渲染
│   ├── prebacktest.js      # Core.PreBacktest:AI 建议"回测前置"(Phase D2),pickStrategy/judgeVerdict 纯函数 + runForPick(近2年日K→worker回测,15s超时,失败返null) + renderResultHtml 徽章
│   ├── crosscheck.js       # Core.CrossCheck:双模型交叉验证(Phase D2),pickSecondProvider(state.apiKeys.llm map)/resolveSecondOpinion/buildComparePrompt
│   ├── regime.js           # Core.Regime:大盘状态机 gate(Z1, Kimi 代做),gateMultipliers 根据估值/趋势/情绪输出建仓/调仓乘数
│   ├── market-width.js     # Core.MarketWidth:市场宽度信号(Z1b),涨跌家数/成交量分布等替代维度,接入 AI prompt
│   ├── kb.js               # Core.KB:投资百科(Y10 重构),高手版 AI 顾问 KB 索引
│   ├── state.js            # 持久化全局状态(proxyBase/apiKeys/ai/sync/currentPage/marketOpen)
│   ├── toast.js / router.js# 吐司提示;hash 路由(switchPage 触发 window._onShow_{pageId})
│   ├── ai-service.js       # Core.AI:6 provider + resolveEndpoint({local}) 本地 LLM 优先降级 + callWithTimeout
│   ├── ai-call-log.js      # Core.AICallLog:Z6 trace + audit,记录每次 AI 调用(prompt/provider/latency/tokens/error),满 200 条滚动截断
│   ├── self-consistency.js # Core.SelfConsistency:Z4 替代多空辩论,多模型同 prompt 投票取一致答案
│   ├── macro.js / news.js / market.js   # 宏观新闻分析 / 新闻筛选 / 市场状态指数
│   ├── sync.js             # Core.Sync:Supabase REST (signUp/signIn/fullSync/pushAIMemory/pullAIMemory)
│   └── agents.js           # Core.Agents:多智能体 observer/analyst/coach + 5 intent orchestrator
├── app/                    # 按域拆分的页面脚本,每个挂 window.{Domain}(首字母大写)
│   ├── watchlist.js        # 行情看板:自选股 + K线 + 行情
│   ├── holdings.js         # 持仓管理:持仓 + 交易流水 + 持仓天数/浮盈
│   ├── paper.js            # 模拟盘:虚拟资金 + isPaper 隔离持仓 + T1 分账户 sleeve (long/short) + AI 自动成交 + 每日快照曲线
│   ├── short-trader.js     # ShortTrader:AI 短线操盘手 T2 盘前计划 (自动生成 + 校验管线 + 自动转条件单; 与 paper.js 内 T2 盘前计划手动流并存)
│   ├── journal.js          # 复盘笔记:结构化标签 + 持仓上下文 + AI 助手 (874 行)
│   ├── screener.js         # 选股筛选:条件筛选 + AI 选股 + 一键加自选 (待确认卡片走 Core.Portfolio.getAssets)
│   ├── stock-advisor.js    # 单股 💡 AI 简评 + 历史验证 + 双模型交叉验证
│   ├── fund.js             # 基金专项主文件:7 个 DOMAINS 公共方法(init/render/addDialog/save/remove/showChart/closeModal)+ _typeLabel + _renderChart (~400 行)
│   ├── fund/               # fund 子模块 (Phase F 拆分,各子文件挂方法到 window.Fund)
│   │   ├── macro-bar.js    # _renderMacroBar / _refreshMacroBar
│   │   ├── news-bar.js     # _renderNewsBar / _refreshNewsBar
│   │   ├── ai-advisor.js   # aiAdvisorDialog / aiAdvisorRun / _aiRefreshMacro / _aiRefreshNews
│   │   ├── portfolio-risk.js  # portfolioRiskDialog / _computePortfolioMetrics / _renderPortfolioRisk
│   │   ├── news-impact.js  # newsImpactDialog / _analyzeNewsImpact / _renderNewsImpact
│   │   ├── rebalance.js    # rebalanceDialog / _computeRebalanceAdvice / _renderRebalanceHTML / _openRebalanceLinks / _aiExplain (Phase H.1 AI 讲解)
│   │   ├── buy-import.js   # buyDialog / _renderBuyDialog / quickImport / _bindQuickImportCalc / quickImportSave / seedRecommended
│   │   ├── seed.js         # seedRecommended / 基金 seed 数据
│   │   └── weekly-report.js  # weeklyReportDialog (Phase H.2 AI 周报) / _wrCopy
│   ├── backtest.js         # 策略回测 UI
│   ├── alerts.js           # 提醒监控:中长线/短线双模式(短线 1 分钟定时器按需起停+交易时段守卫 / 中长线事件驱动: app启动+页面展示触发 runLongChecks, nextCheck 门控) + 业绩预告异动/大盘趋势/估值偏离 + 复盘联动
│   ├── account.js          # 资金账户:现金 + 资金流水 + 总览
│   └── market-bar.js       # 顶部市场条
├── workers/backtest.worker.js  # 回测 Web Worker(双均线/突破/海龟;vite worker.format='es')
├── lib/                    # echarts.min.js / dexie.min.js(copy-libs.mjs 产物,勿手改)
├── public/                 # PWA 源:manifest.webmanifest、sw.js、icons/(build-web 拷到 www/ 根)
├── kb_data/                # (约定目录) 知识库/参考 JSON
└── assets/                 # Vite 产物(gitignore,勿手改)

scripts/
├── dev-proxy.mjs           # Express 代理 :8089:/api/akshare→aktools,:8088;/api/llm/{provider}→LLM
├── copy-libs.mjs           # UMD 库复制
├── build-web.mjs           # dist/ 合并回 www/
├── daily_summary.mjs       # 盘后 AI 总结 + 飞书推送 + --verify 事后验证 + --premarket 盘前简报 (Phase C; 环境变量:DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL/DEEPSEEK_MODEL/FEISHU_WEBHOOK/AKTOOLS_BASE)
├── e2e.mjs / e2e_local_llm.mjs  # 端到端测试
├── supabase_schema.sql     # 可选云同步的 Postgres schema
└── *.py                    # 离线数据采集/AI seed 工具(宏观/新闻/基金筛选等)

test/test_all.js            # 全量自动化测试(见上)
android/                    # Capacitor 原生工程(sync 覆盖,勿手改)
capacitor.config.json       # webDir=www, androidScheme=http
vite.config.js              # root=www,域脚本 external 列表,dev proxy
```

## 关键架构约定

- **Core 命名空间**:每个 `core/*.js` 用 IIFE `(function(){ 'use strict'; ... window.Core = window.Core || {}; window.Core.X = {...}; })()`,对外只暴露 `window.Core.{Module}.{method}`。
- **域脚本暴露**:`www/app/*.js` 同样 IIFE 挂 `window.{Domain}`。`app.js` 的全局兼容层把常用方法 `var x = Domain.method` 拉平,供 index.html 的 `onclick=` 内联调用。
- **script 加载顺序**(index.html):lib (echarts/dexie) → core/*.js (util→storage→data→state→toast→ai-service→macro→news→market→sync→agents→router) → app/*.js → app.js。**新增文件插在对应分组内,app.js 永远最后。**
- **Vite external**:`vite.config.js` 的 `rollupOptions.external` 列出全部 `core/*.js` 和 `app/*.js` — 它们由 index.html `<script src>` 直接加载,不参与 bundling。**新增域脚本必须同步加进 external**,否则 Vite 尝试打包导致运行时报错。
- **启动序列**(app.js `init()` IIFE):版本升级清缓存 → Storage.init → State.init → 市场状态(每分钟刷新)→ Data.health(异步,失败不弹 toast)→ 各域 `X.init()` → switchPage('pageWatchlist') → _renderSettings → 注册 Service Worker。
- **数据流**:域脚本 → `Core.Data.fetchWithCache(cacheKey, path, params, ttl)` → IndexedDB 缓存命中则返回 → 否则 dev-proxy → aktools (Python :8088)。缓存 TTL:行情 1 分钟,K线 1 天,基金净值 1 小时,季度持仓 30 天,默认 5 分钟。**所有外部数据必须走 Core.Data.fetch,禁止直接 fetch。**
- **版本号**:`www/app.js` 顶部 `APP_VERSION`(当前 v0.1.0),改值触发 `Core.Storage.cacheClear()`。
- **PWA**:`www/public/sw.js` cache-first 静态资源 / network-only API(build-web 拷到 www/ 根);`www/manifest.webmanifest` 同理由 public/ 拷出。

## 编码规范(硬性)

| 项 | 规则 |
|---|---|
| **API Key / Token** | 运行时 UI 输入,**禁止**任何形式的硬编码(含 AKShare 默认 token、Tushare token、LLM key);脚本用环境变量 |
| **innerHTML** | 所有用户/AI 输出必须经 `Core.Util.escapeHtml()` 转义(XSS 防护) |
| **eval** | **禁止** `eval()`,动态加载改用 ES Module `import()` |
| **catch 空块** | 空 `catch {}` 必须加 `console.warn('[模块名] 错误:', e)` |
| **新增域脚本** | 1) 放 `www/app/<name>.js` 2) 加进 `vite.config.js` external 3) 加进 `index.html` `<script src>` 4) 在 `app.js` 的 `init()` 调 `X.init()` 5) 在 `test/test_all.js` 的 `DOMAINS` 列方法 |
| **缓存** | 任何 fetch 走 `Core.Data.fetchWithCache(key, path, params, ttl)`,TTL 与数据时效匹配 |
| **新增依赖** | 必须有充分理由,优先复用现有库;升级 echarts/dexie 后跑 `npm run build:libs` |
| **语言** | 代码注释、文档用中文;标识符用英文 |

## 数据合规

- AKShare 数据**仅供学习研究**,不公开、不分发。
- 不接券商交易接口,不做任何形式的代客理财。
- 数据仅本地存储 (Dexie/IndexedDB),不上传云端;Supabase 云同步**用户主动登录后**才用,不同步 API Key / 个人身份信息。

## 当前能力清单 (v0.1.0)

> 这是项目截至 v0.1.0 已实现的功能集。后人/AI agent 接手时**先看这里**,知道什么有、什么没有。

### 5.1 互通闭环

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| 5.1.1 复盘↔持仓 | `www/app/journal.js` | `_buildHoldingsContext` / `_renderHoldingBadge` |
| 5.1.2 告警↔复盘 | `www/app/alerts.js` | `_fetchJournalContext(code)` (30 天内最近 2 条) |
| 5.1.3 选股↔自选+复盘 | `www/app/screener.js` | `_addWatchlistFromPick` (同时写 watchlist + journal) |

### 5.2 主动智能

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| 5.2.1 复盘结构化 | `www/app/journal.js` | `_renderStructuredTags` (假设/情绪/verify 三标签 + AI badge) |
| 5.2.2 AI 复盘助手 | `www/app/journal.js` | `_runAiAssistant` (保存后异步调 LLM, 严格 JSON 候选值) |
| 5.2.3 告警"上次类似情境" | `www/app/alerts.js` | `_fetchJournalContext(code, alertType)` (按 alertType 启发 assumption 标签) |

### 5.2 c 事后验证

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| 阈值 (pending/1w/1m/3m → 7/7/30/90 天) | `scripts/daily_summary.mjs` | `VERIFY_THRESHOLD_DAYS` |
| 导出函数 | `scripts/daily_summary.mjs` | `parseArgs` / `pickJournalsForVerify` / `buildVerifyPrompt` / `applyVerifyReport` / `runVerify` / `fetchStockQuote` |
| CLI | `scripts/daily_summary.mjs` | `--verify` / `--verify-dry-run <journals.json>` |
| 输出 | `<input>.verified.json` | append `### 🔁 AI 事后验证 (date)` 到 content, 写回 verify=verified + verifiedAt |

### 5.3 长期路线图

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| 5.3.1 多智能体 | `www/core/agents.js` | `Core.Agents.runObserver/Analyst/Coach/Pipeline` (5 intent: observe/diagnose/next/today/full) |
| 5.3.2 AI 记忆同步 | `www/core/sync.js` | `Core.Sync.pushAIMemory` / `pullAIMemory` (走 kv 表, 只同步有 AI 痕迹的 journals + alerts) |
| 5.3.3 本地 LLM 优先 | `www/core/ai-service.js` | `Core.AI.resolveEndpoint({ local })` (三态: true/false/未指定, 本地未启用降级) |

### Phase B 交易纪律引擎

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| 纪律检查核心 | `www/core/discipline.js` | `Core.Discipline.preBuyCheck` → `{ ok, blocks, warns, history }`; blocks 硬拦截(假设/止损必填、单票集中度、总仓位、月度回撤熔断), warns 确认放行(追高、重复错误历史); 配置 kv `discipline_config`, 月度锚点 kv `discipline_month_anchor`(_paper 后缀为模拟盘独立锚定); 检查失败降级 warn 不拦交易; 卖出不拦截 |
| 实盘接入 | `www/app/holdings.js` | 新建持仓/买入交易表单加假设+止损价, `save`/`saveTx` 买入前 await preBuyCheck, assumption/stopLoss 写 holdings+transactions 行(非索引字段) |
| 模拟盘接入 | `www/app/paper.js` | `buyFromForm` 同款校验; `autoTradeFromPick` blocks 命中 console.warn 跳过, warns 写交易行 `disciplineWarns` (AI 场景假设固定'题材催化', 止损=成交价×0.92) |

### Phase C 决策自动化流水线 (瘦身版)
| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| C.1 盘前简报 (Node 侧) | `scripts/daily_summary.mjs` | `--premarket` CLI; `runPremarket(deps)` / `fetchUsIndices` (index_us_stock_sina) / `buildEconomicCalendar` (本地公开日期规则: LPR/MLF/PMI/CPI/季报密集期, 无事件不编造) / `fetchCaixinNews` (stock_news_main_cx) / `formatPremarketRaw` / `buildPremarketPrompt`; 每块失败独立降级"本节数据不可用", LLM 失败降级原始罗列版; 不含持仓数据 (Node 读不到 IndexedDB) |
| C.2 模拟盘日终小结 (浏览器侧) | `www/app/paper.js` | `Paper.maybeGenerateEodReport(now)` (工作日 ≥15:30 且当日无记录才生成, `_shouldGenerateEod` 纯函数可注入时间) / `_buildEodReport` (现金/市值/总资产/当日盈亏对照昨日快照 + 当日成交 🤖=AI 自动 + 纪律拦截 + 持仓 Top/Bottom) / `_pushEodToFeishu` (kv `feishu_webhook`, 失败只 warn) / `_renderEodReport` (页面"日终小结"区块); kv `paper_eod_reports` 上限 60, kv `paper_discipline_log` 上限 100 (`_logDisciplineBlock`, autoTradeFromPick 被 blocks 时 append); AI 自动成交交易行带 `auto: true` 标记 |
| C.3 启动钩子 | `www/app.js` | init 里 `Paper.init()` 后 `Paper.maybeGenerateEodReport().catch(...)` (不 await 不阻塞) |

### Phase T AI 短线操盘手 (T1: 模拟盘分账户 sleeve)

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| T1.1 分账户常量 | `www/core/constants.js` | `PAPER_SHORT_CASH`(3万) / `PAPER_SHORT_POSITION_PCT`(0.20, 短线本金小单笔要够一手) |
| T1.2 Paper sleeve | `www/app/paper.js` | holdings/transactions 行非索引字段 `sleeve`('long'\|'short'), **存量无字段 = long**(过滤一律 `(row.sleeve \|\| 'long') === sleeve`); 新 kv `paper_account_short` (3 万); 账户读写收口 `_accountKey`/`_defaultAccount`/`_getAccountRaw`/`_saveAccountRaw`; `getAccount/getPositions/resetAccount/buy(opts.sleeve)` 默认 'long' 向后兼容; `sell` 从持仓行读 sleeve 自动匹配账户; init 双账户各自初始化; `autoTradeFromPick` 预留 `pick.sleeve` (默认 long, T2 才写短线计划); resetAccount 只清对应 sleeve (快照只随 long 重置清空) |
| T1.3 快照 shortTotal | `www/app/paper.js` `snapshotIfNeeded` | `paper_snapshots` 条目加 `shortTotal` (短线现金+市值); 老快照无此字段, 图表端容错 (映射 null 断点) |
| T1.4 纪律引擎 sleeve | `www/core/discipline.js` + `www/core/portfolio.js` | `preBuyCheck` input.sleeve (默认 long); `Portfolio.getAssets({paper, sleeve})`; 月度锚点: long **沿用存量 key `discipline_month_anchor_paper`** (兼容读取, 不迁移), short 用 `discipline_month_anchor_paper_short`; `DEFAULT_CONFIG.short = {maxDailyTrades: 3, cooldownHours: 48}` 结构预留 (T2 启用, 本期不参与检查) |
| T1.5 UI 双 tab | `www/index.html` + `www/app/paper.js` | 模拟盘页「📈 长线模拟」/「⚡ AI 短线」tab (`Paper._sleeve` / `switchSleeve`), 短线 tab 占位说明 (T2/T3 上线预告) + 保留手动表单; 曲线加"AI 短线总资产"第二条资产线; EOD 日终小结加 short 段 (合并卡片分段 + 飞书文本 ⚡ 段) |

### Phase T3 日线级条件单引擎 (AI 短线操盘手: 计划落地与结算)

> 全日线级, 不依赖盘中轮询。结算时序语义: 只认**已收盘**日 K (`_lastClosedBar`: bar.date < today 直接用, bar.date == today 需本地 ≥15:00); 当日 K 未收盘不结算; 收盘后创建的单不回溯当日 K (`createdAfterClose` + `_orderEligible`)。

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| T3.0 常量 | `www/core/constants.js` | COND_ORDER_LIMIT(100) / COND_ORDER_EXPIRE_DAYS(3, 按交易日数) / SHORT_MAX_HOLD_DAYS(5) |
| T3.1 条件单存储 | `www/app/paper.js` | kv `paper_cond_orders` (上限 100 滚动截断); `addCondOrder` (`_checkCondOrder` 纯函数校验: stopLoss < trigger < target 双向统一 / 整手 / 金额≤短线现金) / `listCondOrders(status?)` / `cancelCondOrder` (只改状态不删行) |
| T3.2 每日结算 | `www/app/paper.js` | `settleCondOrders(now?)`: kv `paper_cond_settle.lastSettleDate` 当日防重复; pending 单用最新已收盘日 K 判定 (`_fillCheck`: below 开盘≤触发→开盘价/盘中 low 穿越→触发价, above 对称); 成交走 `buy({sleeve:'short', price, tradeDate, targetPrice})` (buy/sell 新增 price/tradeDate/reason 覆盖参数, 结算不拉实时行情); 现金不足/纪律 blocks → cancelled + cancelReason; `Core.Data.getStockKLine(code,'daily',undefined,undefined,'')` 不复权只读使用, 失败代码本轮跳过不影响其他 |
| T3.3 在持仓位出场 | `www/app/paper.js` | kv `paper_short_positions` `{holdingId, code, stopLoss, targetPrice, entryDate, entryPrice, planOrderId, shares, holdDays, lastSettleBarDate, closed}`; `_exitCheck` 纯函数: 跳空止损/止盈按开盘价, 盘中触及按止损/目标价, **同根 K 双触及保守按止损**; 未触发 holdDays+1, 满 SHORT_MAX_HOLD_DAYS 按收盘价强平 ('到期强平'); 卖出流水带 exitReason; `lastSettleBarDate` 防同根 K 重复结算 (holdDays 不重复递增) |
| T3.4 过期判定 | `www/app/paper.js` | `_tradingDaysAfter` 按 K 线数交易日 (非自然日), createdAt 后第 COND_ORDER_EXPIRE_DAYS 个交易日未成交 → expired; `expireAt` 字段仅 UI 展示用 |
| T3.5 journal 沉淀 | `www/app/paper.js` | `_writeCondJournal` (参照 screener `_addWatchlistFromPick` 模式): 成交/止损/止盈/强平/过期/纪律取消各写一条, 行上 `sleeve:'short'` + `auto:true`, content 含计划原文要素 (`_condPlanLines`: trigger/stop/target/assumption/证伪/失效) + 成交明细 + 原因 |
| T3.6 UI | `www/index.html` + `www/app/paper.js` | 短线 tab `#paperCondSection`: 手动建条件单表单 (走 `Discipline.preBuyCheck({isPaper:true, sleeve:'short'})`) + `#paperCondOrders` 区块 (pending 单列表含取消按钮 + 近期已结算单状态徽标, 全 escapeHtml); `renderPage` 短线 tab 才显示; 结算有动作自动重渲染 |
| T3.7 启动钩子 + 重置 | `www/app.js` + `www/app/paper.js` | app init 后 `Paper.settleCondOrders()` 异步不阻塞 (同 EOD 写法); `resetAccount('short')` 连带清 paper_cond_orders/paper_short_positions/paper_cond_settle |

### Phase T2 (ShortTrader) 盘前 AI 交易计划生成 (AI 短线操盘手: 自动生成 + 自动转条件单)

> 独立域脚本 `www/app/short-trader.js` (window.ShortTrader), 与 paper.js 内 `generateMorningPlan` (T2 手动确认流, kv paper_morning_plan) **两套并存**, kv/逻辑互不干扰: 本套走"自动生成 + 校验管线 + 自动落地条件单"。

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| T2-ST.0 常量 | `www/core/constants.js` | SHORT_PLAN_LOG_LIMIT(100, kv paper_plan_log 上限) / SHORT_PLAN_JOURNAL_DAYS(3, prompt 注入短线 journal 回看天数); 纪律参数复用 `Core.Discipline.DEFAULT_CONFIG.short` (maxDailyTrades 3 / cooldownHours 48, T1 预留本期启用) |
| T2-ST.1 自动生成 | `www/app/short-trader.js` + `www/app.js` | `maybeGeneratePlan(now)`: 交易日 (`_isTradingDay` 纯函数, 周一~周五, 节假日简化不判) + kv `paper_short_plan` 无今日记录 → 自动生成; app init 异步调用不阻塞 (同 settleCondOrders 写法); 失败 console.warn + kv 写 error 记录, UI 显示"生成失败可手动重试" |
| T2-ST.2 上下文组装 | `www/app/short-trader.js` | `_buildPlanContext`: 短线现金/持仓 (含止损/目标/浮盈)/pending 条件单/今日已建单数/近 3 天 sleeve='short' journal 摘要/Regime 状态+gate/指数快照 (只用 Core.Data.getIndexSpot 现有接口)/**候选池 = watchlist 全部 + short 持仓代码** (`_buildCandidatePool` 纯函数去重) |
| T2-ST.3 prompt | `www/app/short-trader.js` | `_buildSystemPrompt`/`_buildUserPrompt` 纯函数: 短线波段操盘手人设 (持有 1-5 天/保守/宁缺毋滥可空仓), 输出严格 JSON `{marketView, plans[0-3]}`, plans 含 code/name/triggerDirection/triggerPrice/stopLoss/targetPrice/positionPct/assumption/probability(0-100 必填)/confidence(低中高 必填)/reason + Core.Premortem 四字段 (bullCase/bearCase/falsifyCondition/invalidation) |
| T2-ST.4 校验管线 | `www/app/short-trader.js` `_validatePlans` (纯函数) | a. JSON schema (`Core.AI.parseJsonOutput` Phase T 模式) + `Core.Premortem.checkPick`; b. 幻觉防护 code∈候选池; c. 价格关系 stopLoss<trigger<target; d. 短线纪律: 今日已建+本轮 ≤maxDailyTrades(3) (quota) / 同代码 48h 短线卖出冷却 (`_hasRecentShortSell`) / positionPct 超 PAPER_SHORT_POSITION_PCT **收敛不丢弃** (`_scalePositionPct`) / regime bear ×gate.positionScale; e. 每条丢弃写 kv `paper_plan_log` {date,code,stage,reason} 上限 100 (`_appendPlanLog`) |
| T2-ST.5 落地 | `www/app/short-trader.js` `generatePlan` | 通过的 plans 逐条 `Paper.addCondOrder({..., source:'ai', sleeve:'short'})`; shares = `Paper._roundLot(短线现金×positionPct/triggerPrice)`, 不足一手丢弃留痕; 整轮存 kv `paper_short_plan` {date, marketView, plans(含 condOrderId), dropped, generatedAt}; LLM 走 `Core.AI.callWithTimeout` (60s), 测试注入 `opts.deps.callLLM` |
| T2-ST.6 UI | `www/index.html` + `www/app/short-trader.js` + `www/app/paper.js` | 短线 tab `#shortTraderSection` "🤖 今日计划": marketView + plans 卡片 (方向/触发/止损/目标/仓位/胜率/信心/reason + pre-mortem 块 + 已转条件单徽标) + dropped 折叠区 + "🔄 重新生成" (`regenerate`, confirm 后覆盖今日记录); 渲染全在 ShortTrader.renderTodayPlan (全 escapeHtml), paper.js renderPage 仅 3 行挂载 |

### Phase D AI 建议"高手化" (D1)

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| D1.1 pre-mortem 工具 | `www/core/premortem.js` | `Core.Premortem.PROMPT_SPEC` (四字段 prompt 说明, bullCase/bearCase/falsifyCondition/invalidation, 禁"无明显风险"空话) / `checkPick`/`checkPicks` (校验, bearCase 空话黑名单) / `renderBlock` (四象限小区块, 全转义) |
| D1.2 screener 接入 | `www/app/screener.js` | systemPrompt 拼 PROMPT_SPEC; parseJsonOutput 后再跑 checkPicks, 缺字段走 Phase T 同一降级 (警告+原始输出+重生成); picks 卡片渲染 renderBlock; `_addWatchlistFromPick` 把 falsifyCondition/invalidation 写入 journal 行 (非索引字段) + content Pre-mortem 段, 并透传 `Paper.autoTradeFromPick` |
| D1.3 ai-advisor 接入 | `www/app/fund/ai-advisor.js` | 同款 prompt/校验/渲染三处接线 |
| D1.4 单股 💡 接入 | `www/app/stock-advisor.js` | free-text 无 schema: prompt 强制 4 行 pre-mortem (看多/看空/证伪条件/失效条件), 输出后软校验 (缺"证伪/失效"只警告不拦截); maxTokens 800→1000 |
| D1.5 模拟盘沉淀 | `www/app/paper.js` | `buy` opts 增加 falsifyCondition/invalidation → transactions 行 (非索引字段); autoTradeFromPick 透传 |
| D1.6 个股公告上下文 | `www/core/news.js` | `Core.News.getStockNotices(code, limit)` (东财 ann API `stock_list` 按个股查询, 失败兜底全量+本地 `_filterNoticesByCode` 过滤, 6h 缓存, 双路径失败返 null) / `formatNoticesForPrompt` (null→"公告数据不可用", 空→"近期无公告"); 注入单股 💡 简评 prompt `data.notices` (最近 5 条标题+日期); ai-advisor/weekly-report 标的是基金非个股, 未注入 |

### Phase D2 回测前置 + 双模型交叉验证

> 全部为**按需触发** (按钮), 不接任何自动流程。

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| D2.1 回测前置工具 | `www/core/prebacktest.js` | `Core.PreBacktest.runForPick({ code, assumption })` (近 2 年日 K → 策略映射 → worker 回测, 15s 超时, 任何失败返 null 降级) / `pickStrategy` (技术突破词→breakout, 业绩拐点/估值修复→ma_cross, 默认 ma_cross) / `judgeVerdict` (sharpe<0→'历史无效', 0~0.5→'历史表现一般', ≥0.5→'历史有效', 阈值常量 THRESHOLDS) / `formatResult` / `renderResultHtml` (徽章+Sharpe/最大回撤/年化/胜率/笔数, 全转义) / `renderUnavailableHtml` |
| D2.2 screener 接入 | `www/app/screener.js` | picks 卡片加"📊 历史验证"按钮 (`data-action="backtest"`, `data-assumption`=理由+bullCase), `_runPreBacktest` 跑完渲染到卡片 `.pb-result` |
| D2.3 单股 💡 接入 | `www/app/stock-advisor.js` | 弹窗 footer 加"📊 历史验证"(`runPreBacktest`, 假设=简评全文) 和"🤝 第二意见"(`runSecondOpinion`); `_lastBrief` 缓存本次简评上下文; 结果渲染 `#saExtra` |
| D2.4 双模型工具 | `www/core/crosscheck.js` | `Core.CrossCheck.pickSecondProvider` (从 `state.apiKeys.llm` map 按 PROVIDER_ORDER 找第一个 ≠当前且配 key 的 provider, custom 除外) / `resolveSecondOpinion(state)` (勾代理→`/api/llm/{provider}/v1`, 否则 provider 默认 baseURL; 未配置返 null → 调用方 toast) / `buildComparePrompt` (主模型 ≤100 字一致性小结) |
| D2.5 第二意见调用 | `www/app/stock-advisor.js` | `Core.AI.callWithTimeout` + opts 覆盖 `baseURL/apiKey/model` + `local:false` (强制远程, 防"优先本地"劫持), 第二 provider 重评 (1 次) → 双段并排 → 主模型一致性小结 (1 次); 不改 ai-service.js |
| D2.6 设置页 | `www/app.js` | "🤝 第二意见"区: provider 下拉 (排除 custom) + per-provider key 输入, 存 `state.apiKeys.llm` map (留空=删除该 provider key); `_secondProviderOptions` / `onSecondProviderChange` |

### Phase E 半自动执行 (实盘待确认交易)

> 设计原则: AI 提建议, 模拟盘自动跑, **实盘必须人确认**。确认流程绝不绕过 `preBuyCheck`。

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| E.1 待确认交易存储 | `www/core/pending.js` | `Core.Pending`: kv `pending_trades` 数组 (上限 50, 优先淘汰已完结卡片), 只做 buy; `add` (同 code pending 去重, 刷新 reason/仓位) / `list(status?)` / `get` / `confirm` / `ignore` (只改状态) / `purgeExpired` (7 天过期惰性转 ignored, list 时执行) / `_suggestPosition` 纯函数 (金额=总资产×5%, 整手向下取整, 不超纪律单票上限剩余额度, 不足一手返 null) |
| E.2 screener 生成入口 | `www/app/screener.js` | `_addWatchlistFromPick` 追加第 4 步: 现价 + `Core.Portfolio.getAssets({paper:false})` 实盘口径 → `_suggestPosition` → `Core.Pending.add` (assumption 固定'题材催化', stopLoss=现价×0.92, 与模拟盘口径一致), 失败只 warn 不影响加自选 |
| E.3 持仓页确认 UI | `www/app/holdings.js` + `index.html` `#pendingTrades` | `_renderPending` (持仓列表上方, 无 pending 不渲染, 理由/pre-mortem 折叠, 全转义) / `confirmPending` (已有同 code 持仓→addTxDialog 加仓, 否则 _formDialog 新建, 预填 code/shares/现价/assumption/stopLoss) / `ignorePending`; **成交落库后**才 `_markPendingConfirmed`, 预填后放弃保存保持 pending |

### Phase W 中长线盯盘改造 (双模式分层轮询)

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| W.1 规则打标 + 分层轮询 | `www/app/alerts.js` | `_horizonOf(type)` (价格/涨跌幅/成交量=short, 其余=long, 运行时按 type 分类, 行上 horizon 非索引字段仅供展示) / `_syncTimers` (幂等: 有启用的短线规则才起 1 分钟定时器; 中长线不起定时器; save/toggle/remove 经 render() 自动重同步) / `_checkShort` (原 60s 行情类逻辑 + P0 交易时段守卫 + P2 通知冷却) / `_checkLong` (事件驱动, `_nextCheckDue` 门控 + `_freqMs` 按规则频率推进 nextCheck); `_setInterval`/`_clearInterval` 可注入 (测试可断言) |
| W.1a P0 交易时段守卫 | `www/app/alerts.js` + `www/core/constants.js` | `_isTradingTime(now)` 纯函数 (周一~周五 且 09:30-11:30/13:00-15:00, 边界含端点, Constants.TRADING_WINDOWS); `_checkShort` 入口第一行守卫, 非交易时段直接 return 不发请求; 定时器常驻、守卫在检查入口 (判断成本为零) |
| W.1b P1 中长线事件驱动 | `www/app/alerts.js` + `www/app.js` | 30 分钟调度定时器已删除; `runLongChecks()` (= `_checkLong` 安全包装, 异常不外抛) 两个触发点: app.js init (异步不阻塞) + `_onShow_pageAlerts`; 规则自带 nextCheck 门控 (日频/周频/双周频), 事件点触发频繁无副作用 |
| W.1c P2 通知冷却 (防 flapping) | `www/app/alerts.js` + `www/core/constants.js` | Constants.ALERT_NOTIFY_COOLDOWN_MS(30分钟); 短线 hit && !triggered 时, lastHit 在冷却期内 → 只落 triggered 不发通知 (振荡价反复穿越不打扰), 超冷却期才 _notify + 更新 lastHit/hitCount; 价格回落复位分支不受影响 |
| W.2 业绩预告异动 (earnings_warning, 周频) | `www/app/alerts.js` + `Core.Data.fetch('stock_yjyg_em')` | `_checkEarningsWarning`: 拉全市场业绩预告 (cache key 带日期 + 6h TTL) → `_filterEarningsWarnings` 纯函数 (负面名单=Constants.EARNINGS_WARNING_NEGATIVE_TYPES 预减/略减/首亏/续亏 + 半年新鲜度 + 命中实盘持仓 !isPaper, `_normalizeCode6` 容忍 SH 前后缀) → `_notifyLong` 带归因文案; 去重 `lastNotifiedKeys[code]` = key 数组 (`报告期_预告类型`, 同期修正公告是独立信号); 全局一条, 创建即首检 |
| W.3 大盘趋势告警 (regime_change, 日频) | `www/app/alerts.js` + `Core.Regime.refresh()` | `_checkRegimeChange`: 与行上 `lastState` 对比, 状态迁移才通知 (`_regimeNotifyText` 纯函数, bear→放缓建仓/bull→转暖/range→维持原计划), 首次只记基线; 全局一条 |
| W.4 估值偏离 (valuation, 双周频) | `www/app/alerts.js` + `Core.Data.fetch('stock_market_pe_lg')` | `_checkValuation` → `_judgeValuation` 纯函数: 指数 (上证/深证/创业板/科创50) PE-TTM 近5年分位 ≥ Constants.VALUATION_PERCENTILE_WARN(80) 命中; 复用 `ai_ctx_pe` 缓存 key 与 AI 上下文共享; 分位字段全缺 → 返 null 静默跳过 (宁缺毋假); `lastNotifiedKey`=超阈指数名单, 跌出阈值区清空, 重新进入再通知。**个股 PE 5 年分位无已验证数据源, 只做指数级** |
| W.5 创建表单中长线优先 | `www/app/alerts.js` `addDialog`/`_onTypeChange`/`save` | optgroup 分组 (📅中长线在前 ⚡短线在后), `#alHorizonHint` 期限提示行 (短线显示"适合日内盯盘"), 全局规则禁输代码 + 唯一性校验 (valuation_drift 为 B 阶段占位名, `_normType` 并入 valuation), 新规则行写 horizon 字段 |
| W.6 常量收口 | `www/core/constants.js` | ALERT_TICK_SHORT_MS(1分钟) / ALERT_TICK_LONG_MS(30分钟, 仅作 _freqMs 兜底, 定时器已删除) / ALERT_LONG_FREQ_MS(财报日频/预告周频/regime日频/估值双周频) / ALERT_LONG_CACHE_TTL_MS(6h) / TRADING_WINDOWS(A股交易时段) / ALERT_NOTIFY_COOLDOWN_MS(30分钟) / EARNINGS_WARNING_NEGATIVE_TYPES / EARNINGS_WARNING_FRESH_MS(半年) / VALUATION_PERCENTILE_WARN(80) / VALUATION_INDEX_NAMES |

### Phase H AI 升级 (3 件, 单 commit 粒度可回滚)

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| H.1 再平衡 AI 讲解 | `www/app/fund/rebalance.js` | `Fund._aiExplain` 流式调用 Core.AI.call(systemPrompt+prompt,stream:true),3 段中文 (📊现在/⚖️调整原因/⚠️注意事项),maxTokens 600,完成时 escapeHtml 转 innerHTML |
| H.2 周报 AI 生成 | `www/app/fund/weekly-report.js` | `Fund.weeklyReportDialog` 拉持仓+新闻+宏观 → 拼 prompt → AI 流式输出 → 4 段格式 (本周盈亏/重要事件/下周关注/风险提示); `_wrCopy` 一键复制 |
| H.3 复盘 AI 主动归因 | `www/app/journal.js` | 提取 `_runAiAssistantCore` (剥离 toast 返纯对象) + 新增 `_runAttributeManually(journalId)` 用户主动触发流程 + `_applyAiInline` 应用按钮; 卡片新增 🪄 AI 归因按钮 |

### Phase Z AI 抗幻觉 + 大盘状态机 (Kimi 路线图 Z1-Z7)

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| Z1 大盘状态机 gate | `www/core/regime.js` | `Core.Regime.gateMultipliers` 根据估值/趋势/情绪输出建仓/调仓乘数 (0.5-1.0); 待确认卡片按 regime 标签自动减仓 |
| Z1b 市场宽度信号 | `www/core/market-width.js` | `Core.MarketWidth.get` 涨跌家数/成交量分布,接 AI prompt 提供替代维度 |
| Z2 verify 结构化 | `www/app/journal.js` + `scripts/daily_summary.mjs` | 复盘 verify 字段结构化 (pending/1w/1m/3m/verified), 事后验证 dry-run CLI |
| Z3 概率校准 | `scripts/daily_summary.mjs` | Brier score + 校准曲线跟踪 AI 自评概率与实际验证结果偏差 |
| Z4 self-consistency | `www/core/self-consistency.js` | `Core.SelfConsistency.vote` 多模型同 prompt 投票取一致答案,替代多空辩论 |
| Z5 FINCON lessons | `www/app/journal.js` | `ai_lessons_v2` 表结构化教训 + 上下文回召 (按 code/assumption 找相似历史) |
| Z6 AI call log | `www/core/ai-call-log.js` | `Core.AICallLog.log/read/list/clear` 记录每次 AI 调用 (prompt/provider/latency/tokens/error),满 200 条滚动截断 |
| Z7 月度教训提炼 | `scripts/daily_summary.mjs` | `--monthly-lessons` CLI 从 ai_lessons_v2 聚合月度教训 |

### Phase F 工程化改进

| 子项 | 实现位置 | 关键方法 |
|------|----------|----------|
| F.1 fund.js 拆分 | `www/app/fund.js` + `www/app/fund/*.js` | 主文件 1740→~400 行 (7 个 DOMAINS 公共方法 + _typeLabel + _renderChart); 9 个子模块 macro-bar/news-bar/ai-advisor/portfolio-risk/news-impact/rebalance/buy-import/seed/weekly-report 在主文件之后加载,各自挂 window.Fund 属性 |
| F.2 备用行情源 | `www/core/data.js` | 腾讯失败 → 新浪 hq.sinajs.cn (GBK 解码); 性能诊断: 无 aktools 时首屏慢 |
| F.3 AI 体验补丁 | `www/core/ai-service.js` + `www/app/*.js` | `callWithTimeout` (60s 默认); `cachedCall` 缓存; V 重新生成按钮 |
| F.4 财报日历提醒 | `www/app/alerts.js` + `www/core/data.js` | 业绩预告/财报日历数据源 + 提醒创建 |

### 体检技术债收口 (FIX-1 ~ FIX-5)

| 子项 | 改动 | 关键点 |
|------|------|--------|
| FIX-1 styles.css 源码 | `www/styles.src.css` (新建 git 跟踪源) + `www/styles.css` (build 产物, gitignored) | Vite minified 曾覆盖源码; build-web 改用 src 拷到 css,index.html 始终引用 `/styles.src.css` |
| FIX-2 阈值常量 | `www/core/constants.js` (新建) | 0.20 单票上限 / 0.92 止损 / {0.2,0.8} 再平衡 / 100 手 / paper 10% / pending 5% / 漂移阈值 0.05 / 月度回撤 0.10; worker 保留硬编码 (无 window) |
| FIX-3 资产口径 | `www/core/portfolio.js` (新建) | `Core.Portfolio.getAssets({paper})` 单一公式 cash+stockMkt+fundMkt; discipline.js _getRealAssets/_getPaperAssets 改为 @deprecated 转发; screener.js 切到 Portfolio |
| FIX-4 空 catch | `www/app.js` / `www/app/journal.js` / `www/core/market.js` | 4 处 `catch (e) {}` 补 `console.warn('[模块] xxx:', e)` 合规 CLAUDE.md |
| FIX-5 AGENTS.md 同步 | `AGENTS.md` + `CLAUDE.md` | 新增 core/constants.js / core/portfolio.js / core/regime.js / core/kb.js / core/market-width.js / core/ai-call-log.js / core/self-consistency.js; fund 子模块 9 个; 阶段能力补 Phase H/Z/F/FIX |

### 8 大页面域 + Core 模块

| 模块 | 域脚本 | 核心功能 |
|------|--------|----------|
| 行情看板 | `www/app/watchlist.js` | 自选股 + K 线 + 行情 |
| 持仓管理 | `www/app/holdings.js` | 持仓 + 交易流水 + 持仓天数/浮盈 |
| 模拟盘 | `www/app/paper.js` | 虚拟资金 + isPaper 隔离持仓 + T1 分账户 sleeve (长线 `paper_account` 10万 / AI 短线 `paper_account_short` 3万, 行上 `sleeve` 非索引字段, 存量=long) + AI 选股自动成交 + 每日快照 (kv: `paper_snapshots`, 含 shortTotal) + Phase C 日终小结 (kv: `paper_eod_reports` / `paper_discipline_log` / `feishu_webhook`) |
| 复盘笔记 | `www/app/journal.js` | 结构化复盘 + 持仓上下文 + AI 助手 |
| 选股筛选 | `www/app/screener.js` | 条件筛选 + AI 选股 + 一键加自选 |
| 资金账户 | `www/app/account.js` | 现金 + 资金流水 + 账户总览 |
| 基金专项 | `www/app/fund.js` | 7 按钮: 申购/AI 选基/再平衡/组合风险/新闻影响/导入推荐/添加 |
| 策略回测 | `www/app/backtest.js` + `www/workers/backtest.worker.js` | 双均线/突破/海龟 3 策略 + 多指标 (夏普/最大回撤/年化) |
| 提醒监控 | `www/app/alerts.js` | 中长线默认:业绩预告异动(周频)/大盘趋势(日频)/估值偏离(双周频)/再平衡/财报日历 (事件驱动: app启动+页面展示触发) + 短线价格类(1 分钟按需轮询, 仅交易时段+前台) + 复盘联动 |
| 顶部市场条 | `www/app/market-bar.js` | 指数滚动条 |

### Dexie 数据表 (`stockmaster`, DB_VERSION 1)

`watchlist` / `holdings` / `transactions` / `journals` / `alerts` / `funds` / `cashflow` / `cache` / `kv` — schema 定义在 `www/core/storage.js` 的 `db.version(1).stores({...})`。
模拟盘复用 `holdings` / `transactions`,行上加 `isPaper: true` 标记 (非索引字段,无 schema 变更);真实视图读取时 `.filter(h => !h.isPaper)` 隔离。

### 测试与验收

- `npm test` — 500+ 项单元 + 沙箱测试 (`test/test_runtime.js` + `test/test_all.js`, 26 节)
- `node scripts/e2e.mjs` — Chrome headless 端到端 (9 项 + 截图到 `e2e_screenshots/`)
- `node scripts/daily_summary.mjs --verify-dry-run ./journals.json` — 事后验证 dry-run
