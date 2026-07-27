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
npm test                    # = node test/test_all.js,纯 Node 无浏览器,21 节 300+ 断言
npm run typecheck           # tsc --noEmit
node scripts/e2e.mjs        # 端到端冒烟:Chrome headless + CDP(不依赖 puppeteer),9 项断言 + 截图到 e2e_screenshots/
node scripts/daily_summary.mjs --verify-dry-run ./journals.json   # 事后验证 dry-run
```

`test/test_all.js` 21 节:JS 语法、域脚本接口完备性 (`DOMAINS` 字典)、Core 命名空间导出、index.html script 引用对账、Worker 结构、关键文件存在、Data 层方法签名、回测引擎 vm 沙箱实测、Vite external 对账、journal/market/fund/alerts 纯函数实测、daily_summary 单测、5.1/5.2/5.3 互通闭环实测、数据源限流。**改完域脚本或新增域方法必须先 `npm test`,并同步更新该文件的 `DOMAINS` 字典。**

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
│   ├── data.js             # Core.Data:fetchWithCache + getStockSpot/getStockQuote/getStockKLine/getFundSpot/getIndexSpot;腾讯财经备用源(GBK 解码)
│   ├── state.js            # 持久化全局状态(proxyBase/apiKeys/ai/sync/currentPage/marketOpen)
│   ├── toast.js / router.js# 吐司提示;hash 路由(switchPage 触发 window._onShow_{pageId})
│   ├── ai-service.js       # Core.AI:6 provider + resolveEndpoint({local}) 本地 LLM 优先降级
│   ├── macro.js / news.js / market.js   # 宏观新闻分析 / 新闻筛选 / 市场状态指数
│   ├── sync.js             # Core.Sync:Supabase REST (signUp/signIn/fullSync/pushAIMemory/pullAIMemory)
│   └── agents.js           # Core.Agents:多智能体 observer/analyst/coach + 5 intent orchestrator
├── app/                    # 按域拆分的页面脚本,每个挂 window.{Domain}(首字母大写)
│   ├── watchlist.js        # 行情看板:自选股 + K线 + 行情
│   ├── holdings.js         # 持仓管理:持仓 + 交易流水 + 持仓天数/浮盈
│   ├── journal.js          # 复盘笔记:结构化标签 + 持仓上下文 + AI 助手 (874 行)
│   ├── screener.js         # 选股筛选:条件筛选 + AI 选股 + 一键加自选
│   ├── fund.js             # 基金专项:7 按钮(申购/AI 选基/再平衡/组合风险/新闻影响/导入推荐/添加),最大文件 ~1740 行
│   ├── backtest.js         # 策略回测 UI
│   ├── alerts.js           # 提醒监控:价格/涨跌幅/成交量 + 复盘联动 + 轮询
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
├── daily_summary.mjs       # 盘后 AI 总结 + 飞书推送 + --verify 事后验证(环境变量:DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL/DEEPSEEK_MODEL/FEISHU_WEBHOOK/AKTOOLS_BASE)
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

### 8 大页面域 + Core 模块

| 模块 | 域脚本 | 核心功能 |
|------|--------|----------|
| 行情看板 | `www/app/watchlist.js` | 自选股 + K 线 + 行情 |
| 持仓管理 | `www/app/holdings.js` | 持仓 + 交易流水 + 持仓天数/浮盈 |
| 复盘笔记 | `www/app/journal.js` | 结构化复盘 + 持仓上下文 + AI 助手 |
| 选股筛选 | `www/app/screener.js` | 条件筛选 + AI 选股 + 一键加自选 |
| 资金账户 | `www/app/account.js` | 现金 + 资金流水 + 账户总览 |
| 基金专项 | `www/app/fund.js` | 7 按钮: 申购/AI 选基/再平衡/组合风险/新闻影响/导入推荐/添加 |
| 策略回测 | `www/app/backtest.js` + `www/workers/backtest.worker.js` | 双均线/突破/海龟 3 策略 + 多指标 (夏普/最大回撤/年化) |
| 提醒监控 | `www/app/alerts.js` | 价格/涨跌幅/成交量 + 复盘联动 + 上次类似情境 |
| 顶部市场条 | `www/app/market-bar.js` | 指数滚动条 |

### Dexie 数据表 (`stockmaster`, DB_VERSION 1)

`watchlist` / `holdings` / `transactions` / `journals` / `alerts` / `funds` / `cashflow` / `cache` / `kv` — schema 定义在 `www/core/storage.js` 的 `db.version(1).stores({...})`。

### 测试与验收

- `npm test` — 300+ 项单元 + 沙箱测试 (`test/test_all.js`, 21 节)
- `node scripts/e2e.mjs` — Chrome headless 端到端 (9 项 + 截图到 `e2e_screenshots/`)
- `node scripts/daily_summary.mjs --verify-dry-run ./journals.json` — 事后验证 dry-run
