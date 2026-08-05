import { defineConfig } from 'vite'

export default defineConfig({
  root: 'www',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // CSS 不切分,styles.css 保持原样在 www/ 根目录被 index.html 引用
    cssCodeSplit: false,
    // 域脚本不参与 Vite bundle(由 index.html 通过 <script src> 标签加载,沿用 zhanbu 模式)
    rollupOptions: {
      external: [
        '/app/watchlist.js',
        '/app/stock-advisor.js',
        '/app/holdings.js',
        '/app/paper.js',
        '/app/short-trader.js',
        '/app/long-trader.js',
        '/app/journal.js',
        '/app/screener.js',
        '/app/backtest.js',
        '/app/alerts.js',
        '/app/fund.js',
        '/app/fund/macro-bar.js',
        '/app/fund/news-bar.js',
        '/app/fund/seed.js',
        '/app/fund/ai-advisor.js',
        '/app/fund/portfolio-risk.js',
        '/app/fund/news-impact.js',
        '/app/fund/rebalance.js',
        '/app/fund/buy-import.js',
        '/app/fund/weekly-report.js',
        '/app/account.js',
        '/app/research-pool.js',
        '/app/market-bar.js',
        '/core/ai-service.js',
        '/core/behavioral.js',
        '/core/research-pool.js',
        '/core/ai-call-log.js',
        '/core/ai/effect-request.js',
        '/core/ai/tool-registry.js',
        '/core/ai/tracing.js',
        '/core/ai/orchestrator.js',
        '/core/ai/entry.js',
        '/core/ai/policy-bundle.js',  // P6.2: 宏观策略注入层
        '/core/ai/weekly-attribution.js',  // V7: 周度归因
        '/core/ai/post-mortem.js',  // V8: 事后复盘
        '/core/ai/kb-feedback.js',  // V9: KB 命中率
        '/app/weekly-review.js',  // V7: 周度归因调度器
        '/sim-runner.js',  // V10: 模拟盘实时监控 SPA
        '/core/scheduler.js',  // V2: 跨域定时调度器
        '/core/self-consistency.js',
        '/core/learning-pool.js',
        '/core/agents.js',
        '/core/macro.js',
'/core/cycle.js',  // P2: 宏观周期定位
'/core/screener-rules.js',  // P3.1: 选股规则引擎
'/core/state-matrix.js',  // P3.2: 价×时状态矩阵
        '/core/news.js',
        '/core/market.js',
        '/core/sync.js',
        '/core/router.js',
        '/core/toast.js',
        '/core/state.js',
        '/core/storage.js',
        '/core/data.js',
        '/core/market-width.js',
        '/core/regime.js',
        '/core/similar-market.js',
        '/core/discipline.js',
        '/core/pending.js',
        '/core/premortem.js',
        '/core/prebacktest.js',
        '/core/crosscheck.js',
        '/core/kb.js',
        '/core/alerts-agent.js',
        '/core/util.js',
        '/core/risk-mine.js',  // Phase Y.1.2: 排雷数据聚合
        '/core/reverse-discipline.js',  // P0.5: 反向策略 4 闸预检 (code-level 偏误防御)
        '/core/screener-reverse.js',  // P1.0: 反向策略选股器
        '/core/reverse-pool.js',  // P1.0: 反向策略 4 池存储
        '/core/scoring.js',     // Tier 6: 多因子打分
        '/core/weight-advisor.js',  // Tier 6: LLM 周度动态权重
        '/core/user-profile.js',  // Commit 1: 用户画像 (7 字段 schema)
        '/core/agent.js',         // AI 管家: 工具调用循环 + 分级授权
        '/core/agent-tools.js',   // AI 管家: renderer-direct 工具集 (v0.2.0 全盘接管)
        '/app/agent-ui.js',       // AI 管家: 侧边栏对话窗
        '/core/settings-sync.js',  // v0.2.3: 设置项云同步 (WebDAV)
        '/app/feishu-app-settings.js',  // V13: 飞书凭证设置页
        '/core/steward/allocator.js',  // S4: 配资计划生成器
        '/core/steward/pool.js',      // S3: 股池快照
        '/core/steward/graph.js',     // V14 G1: 决策图谱数据模型
        '/core/steward/strategies.js', // ST: 子策略 + 实验期
        '/core/steward/lessons.js',   // v27: 教训库
        '/core/steward/index.js',     // v27.1: Steward 门面入口
        '/app/steward-ui.js'          // S4: 管家计划卡片 UI
      ]
    }
  },
  server: {
    host: '0.0.0.0',  // V12: LAN 访问用 (手机浏览器 / APK 调试)
    port: 3003,
    // P3-3: 允许 vite dev 服务 www/ 之外的 reverse-watch/ 独立 SPA
    fs: {
      allow: ['..']   // 相对 www/ 的父目录(D:\get\stock-master\)都能访问
    },
    // 开发环境用 vite proxy 转后端
    // aktools 0.0.91+ 接口路径是 /api/public/{item_id}
    // vite 保留原始路径(不会剥前缀),所以 path.replace 正常工作
    proxy: {
      '/api/akshare': {
        target: 'http://127.0.0.1:8088',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/akshare/, '/api/public')
      },
      // LLM 代理 (解决浏览器 fetch DeepSeek/OpenAI 的 CORS)
      // 浏览器 → /api/llm/deepseek/v1/chat/... → dev-proxy → DeepSeek
      '/api/llm': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true
      },
      // 东方财富代理 (解决浏览器 fetch 行业板块的 CORS)
      // 浏览器 → /api/eastmoney/api/qt/clist/get?... → dev-proxy → push2.eastmoney.com
      // vite 默认会剥 /api/eastmoney 前缀, 这里 rewrite 补回, 否则 dev-proxy 路由不匹配
      '/api/eastmoney': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true,
        rewrite: (path) => `/api/eastmoney${path}`
      },
      // 新浪行业板块代理 (东财限流时的 fallback)
      // 浏览器 → /api/sina/q/view/newFLJK.php?param=industry → dev-proxy → money.finance.sina.com.cn
      '/api/sina': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true
      },
      // 自动发现本地 LLM (浏览器调用 dev-proxy 服务器端扫描, 绕过 CORS)
      '/api/discover': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true
      },
      // dev-proxy 自检端点 (浏览器 SPA 内 selfCheck 走这里)
      '/health': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true
      },
      // 本地大模型透传 (绕浏览器 CORS)
      // 浏览器 → /api/local/v1/chat/completions → dev-proxy → http://127.0.0.1:8082/v1/...
      '/api/local': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true
      },
      // 腾讯/新浪行情透传 (绕浏览器 CORS, dev-proxy 加 Referer)
      // 浏览器 → /api/tencent/list=sh600519 → dev-proxy → https://hq.sinajs.cn/list=...
      '/api/tencent': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true
      },
      // 天天基金历史净值 (aktools 端点 500 时 fallback; dev-proxy 透传到 fund.eastmoney.com)
      // 浏览器 → /api/fund/eastmoney/pingzhongdata/007194.js → dev-proxy → fund.eastmoney.com
      '/api/fund': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true
      },
      // v0.2.3 设置项云同步 (WebDAV 透传) — 浏览器 → vite proxy → dev-proxy → 用户指定 WebDAV
      // dev-proxy /api/webdav 解析 ?url= 参数透传到任意 WebDAV (坚果云/Nextcloud)
      '/api/webdav': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true
      }
    }
  },
  worker: {
    format: 'es'
  }
})
