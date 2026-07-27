# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目性质

StockMaster — 个人自用 A股/基金投资工具(行情/持仓/复盘/选股/回测/提醒/基金/资金账户)。**只服务开发者本人**,不公开,不商业化,**零合规要求**:不接券商交易接口,只做研究与监控。数据全部本地化。

技术栈继承自同作者之前的 zhanbu(AI 占卜大师)项目,沿用其 Capacitor + Vite + 原生 JS 工程骨架。

## 常用命令

### 开发

```bash
npm install                                    # 装依赖

npm run dev:proxy                              # 启动 Node 数据代理 :8089 (需要另一个终端)
                                                # 前置: pip install aktools
                                                #        python -m aktools --host 127.0.0.1 --port 8088
                                                # (aktools 0.0.91+ 移除 'http' 子命令, 直接 --host/--port)

npm run dev:vite                               # 单独启动 Vite :3003
npm run dev                                    # 一条龙: vite + proxy (concurrently)
```

Vite 端口固定 `3003`。APK 走 Capacitor 局域网访问本地 dev-proxy(`androidScheme: 'http'` 已允许明文流量)。修改 `proxyBase` 设置项可切换后端地址。

### 构建与发布

```bash
npm run build                                  # 一条龙: copy-libs + vite build + build-web
                                                # 等价于: node scripts/copy-libs.mjs && vite build && node scripts/build-web.mjs
npm run build:libs                             # 单独把 echarts.min.js / dexie.min.js 复制到 www/lib/
npm run build:web                              # 单独把 dist/ 合并回 www/

npm run sync                                   # build + cap sync android
cd android && ./gradlew assembleDebug          # 产物: android/app/build/outputs/apk/debug/app-debug.apk
```

**严禁**只跑 `vite build` 而不跑 `build-web` — 这样 `npx cap sync` 复制的是源码,`assets/` 进不去 APK,会出问题。

### 测试与类型检查

```bash
npm test                                       # = node test/test_all.js — 纯 Node,无浏览器依赖
npm run typecheck                              # tsc --noEmit
```

`test/test_all.js` 跑 8 组检查:JS 语法、域脚本接口完备性、Core 命名空间导出、index.html script 引用对账、Worker 文件结构、关键文件存在、Data 层方法签名、回测引擎纯函数实测。`test/test_runtime.js` 用 vm sandbox 加载 `www/core/util.js`,覆盖 `escapeHtml` XSS 边界、`parseStockInput` 格式解析、`fmtNum`/`fmtPct`/`fmtMoney`/`pctClass`/`uuid` 边界值。**改完域脚本或新增域脚本必须先 `npm test`**,要新增/删除的域方法同步更新该文件的 `DOMAINS` 字典。

更新依赖:

```bash
# 升级 echarts / dexie: 改 package.json → npm install → npm run build:libs
```

## 架构(沿用 zhanbu 模式)

Web 一份代码出 APK(SPA + Capacitor 8)。**禁止换 Vue/React/TS**,保持原生 JS + HTML + CSS。

```
www/
├── index.html              # SPA 入口:含所有 <section class="page">、<script src>、Header / Nav / Modal / Toast 容器
├── styles.src.css          # git 跟踪的样式源码 (FIX-1)
├── styles.css              # build 产物 (gitignored, 由 build-web.mjs 从 src 拷出)
├── app.js                  # Core 入口:挂全局兼容层 (window.Core → 全局 fn alias) + 启动 init() + 设置页 _renderSettings()
├── core/                   # 通用模块 (Core.* 命名空间,所有 .js 内挂 window.Core)
│   ├── util.js             # escapeHtml/safeHTML、fmtNum/fmtPct/fmtMoney、parseStockInput、uuid、debounce
│   ├── storage.js          # Dexie 4 封装 (CRUD + cacheGet/cacheSet 带 TTL + kv + clearAll)
│   ├── data.js             # AKShare 代理 fetch + IndexedDB 缓存 (getStockSpot/getKLine/getFundSpot/...)
│   ├── state.js            # 全局状态 (proxyBase, apiKeys, ai, sync, currentPage, marketOpen)
│   ├── constants.js        # 跨模块阈值常量 (FIX-2: LOT_SIZE/STOP_LOSS_RATIO_AUTO/MAX_SINGLE_STOCK_PCT/...)
│   ├── portfolio.js        # 单一资产口径 (FIX-3: getAssets({paper}) = cash + stockMkt + fundMkt)
│   ├── discipline.js       # 交易纪律引擎 (Phase B: preBuyCheck blocks/warns, 实盘/模拟盘共用)
│   ├── pending.js          # 实盘待确认交易 (Phase E: kv pending_trades, _suggestPosition 建议仓位)
│   ├── premortem.js        # AI pre-mortem 工具 (Phase D1: bullCase/bearCase/falsify/invalidation)
│   ├── prebacktest.js      # AI 回测前置 (Phase D2: 近2年日K → worker → sharpe/最大回撤)
│   ├── crosscheck.js       # 双模型交叉验证 (Phase D2: pickSecondProvider + 双段并排)
│   ├── regime.js           # 大盘状态机 gate (Z1: gateMultipliers 输出建仓乘数)
│   ├── market-width.js     # 市场宽度信号 (Z1b: 涨跌家数/成交量, 接入 AI prompt)
│   ├── kb.js               # 投资百科 (Y10: 高手版 AI 顾问 KB 索引)
│   ├── ai-service.js       # LLM 客户端 (支持 deepseek/openai/moonshot/qwen/zhipu + 自定义 baseURL + callWithTimeout)
│   ├── ai-call-log.js      # AI 调用 trace (Z6: prompt/provider/latency/tokens/error, 200 条滚动截断)
│   ├── self-consistency.js # 多模型投票 (Z4: 替代多空辩论, 取一致答案)
│   ├── toast.js            # 吐司提示
│   ├── router.js           # 页面切换 (switchPage / goSettings,会触发 window._onShow_{pageId})
│   ├── macro.js            # 宏观新闻分析 (macro.py seed → JSON)
│   ├── news.js             # 新闻筛选
│   ├── market.js           # 市场状态/指数数据
│   ├── sync.js             # 可选 Supabase 云同步
│   └── agents.js           # AI agent 调度
├── app/                    # 按域拆分的页面脚本(每域一个 .js,挂 window.{Domain})
│   ├── watchlist.js   (行情看板)
│   ├── holdings.js    (持仓管理)
│   ├── paper.js       (模拟盘, AI 选股自动成交 + 每日快照 + 日终小结)
│   ├── journal.js     (复盘笔记,Markdown 渲染)
│   ├── screener.js    (选股筛选,待确认卡片走 Core.Portfolio.getAssets)
│   ├── stock-advisor.js (单股 AI 简评 + 历史验证 + 第二意见)
│   ├── backtest.js    (策略回测)
│   ├── alerts.js      (提醒/监控,本地通知)
│   ├── fund.js        (基金专项主文件 ~400 行,7 个 DOMAINS 公共方法)
│   ├── fund/          (Phase F 拆分,各子文件挂 window.Fund 属性)
│   │   ├── macro-bar.js / news-bar.js / seed.js
│   │   ├── ai-advisor.js / portfolio-risk.js / news-impact.js
│   │   ├── rebalance.js (含 H.1 AI 讲解 _aiExplain)
│   │   ├── buy-import.js
│   │   └── weekly-report.js (H.2 AI 周报)
│   ├── account.js     (资金账户/流水)
│   └── market-bar.js  (顶部市场条)
├── workers/
│   └── backtest.worker.js   # 策略回测 Web Worker (vite worker.format: 'es')
├── lib/                    # 本地 UMD 库 (echarts.min.js / dexie.min.js, 由 copy-libs.mjs 复制)
├── assets/                 # Vite 产物
└── kb_data/, icons/, public/

scripts/
├── dev-proxy.mjs           # Express + http-proxy-middleware, /api/akshare → AKTools, /api/llm/{provider} → LLM
├── copy-libs.mjs           # node_modules/{echarts,dexie} → www/lib/
├── build-web.mjs           # dist/ → www/ (回滚 styles.css 引用,src → www 复制)
├── supabase_schema.sql     # 可选云同步的 Postgres schema
├── powershell-profile.ps1  # PowerShell 7.x profile 片段(UTF-8 + gst 快捷命令)
├── daily_summary.mjs, e2e*.mjs, emu_e2e.mjs  # 离线数据采集 / e2e 测试 runner
└── archive/                # 探索期临时脚本(fund_filter*.py、explore_*.py、fund_deep_research*.py 等)
```

### 关键约定

- **Core 命名空间**:每个 `core/*.js` 都用 IIFE: `(function() { 'use strict'; ... window.Core = window.Core || {}; window.Core.X = {...}; })()`,对外只暴露 `window.Core.{Module}.{method}`。
- **域脚本暴露**:`www/app/*.js` 同样挂 `window.{Domain}`(首字母大写),`app.js` 的全局兼容层把它们的方法再 `var x = Domain.method` 拉平,以便 index.html 的 `onclick=` 内联调用。**新增域方法要在 `test/test_all.js` 的 `DOMAINS` 字典补上**。
- **Vite external**:`vite.config.js` 的 `rollupOptions.external` 已列出全部 `core/*.js` 和 `app/*.js`。理由:这些文件由 index.html `<script src>` 直接加载,不参与 Vite bundling,跟 zhanbu 保持一致。**新增域脚本必须同步加进 external 列表**,否则 Vite 会尝试打包它,运行时报错。
- **启动顺序**:`app.js` 末尾的 `init()` IIFE 串行执行:init DB → init State → checkMarketStatus (每分钟刷新) → Data.health (异步,失败不弹 toast) → 各域 `X.init()` → switchPage('pageWatchlist') → _renderSettings。
- **Vite dev proxy**:`/api/akshare → http://127.0.0.1:8088`(rewrite 为 `/api/public/{item_id}`,匹配 aktools 0.0.91+ 接口路径),`/api/llm → http://127.0.0.1:8089`(dev-proxy.mjs 自己)。**生产/APK 不走 vite proxy**,用户必须本地跑 dev-proxy,APK 通过局域网 IP 访问。

### 数据流

```
domain JS ──fetch──> Core.Data.fetchWithCache(cacheKey, path, params, ttl)
                        │
                        ├─ IndexedDB cache (cacheGet) ——命中──┐
                        │                                      │
                        └─ AKShare proxy (/api/akshare/...)    │
                                ↓                              │
                            Dev-Proxy                          │
                                ↓                              │
                            AKTools (Python :8088) ────────────┘
```

`Core.Storage.cacheSet` 默认 TTL 5 分钟;行情类 1 分钟,K 线 1 天,基金净值 1 小时,季度持仓 30 天。**所有外部数据必须走 Core.Data.fetch**,禁止直接 fetch。

## 编码规范(硬性)

| 项 | 规则 |
|---|---|
| **API Key / Token** | 运行时 UI 输入,**禁止**任何形式的硬编码(包 AKShare 默认 token、Tushare token、LLM key) |
| **innerHTML** | 所有用户/AI 输出必须经 `Core.Util.escapeHtml()` 转义(XSS 防护) |
| **eval** | **禁止** `eval()`,动态加载改用 ES Module `import()` |
| **catch 空块** | 空 `catch {}` 必须加 `console.warn('[模块名] 错误:', e)` |
| **新增域脚本** | 1) 放 `www/app/<name>.js` 2) 加到 `vite.config.js` `rollupOptions.external` 3) 加到 `index.html` `<script src>` 4) 在 `app.js` 的 `init()` 里调用 `X.init()` 5) 在 `test/test_all.js` 的 `DOMAINS` 里列方法 |
| **缓存** | 任何 fetch 都走 `Core.Data.fetchWithCache(key, path, params, ttl)`,TTL 与数据时效匹配 |
| **新增依赖** | 必须有充分理由,优先复用 zhanbu 已经用过的库 |
| **版本号** | `www/app.js` 顶部 `APP_VERSION` 改值触发 `Core.Storage.cacheClear()`(IndexedDB schema 自动适配) |

## 数据合规

- AKShare 数据**仅供学习研究**,不公开、不分发、不接入真实交易接口。
- 数据全部本地(Dexie/IndexedDB),可选 Supabase 自托管同步。
- 不做代客理财/荐股。

## 开发环境(本机)

- **PowerShell 7.1.5** 已装,路径 `C:\Program Files\PowerShell\7\pwsh.exe`,与系统内置 PS 5.1(`powershell.exe`)共存,**不要卸载 5.1**(系统组件依赖)
- 用户级 Profile:`C:\Users\laowu\OneDrive\文档\PowerShell\Microsoft.PowerShell_profile.ps1`(由 `scripts/powershell-profile.ps1` 生成),注册了快捷命令:
  - `gst` → `cd D:\get\stock-master`
  - `gst-dev` / `gst-build` / `gst-test` → 一条龙启动 dev-proxy+Vite / `npm run build` / `npm test`
  - `port <端口>` → 查看本机端口占用
  - `ll` / `la` / `which` → 类似 Linux 别名
- 终端编码已强制 UTF-8(`OutputEncoding` / `[Console]::OutputEncoding` / `chcp 65001`),中文和 emoji 输出正常
- AI agent 调用走 **Git Bash**,不依赖 PowerShell;PowerShell 是用户手动验证用的工具
