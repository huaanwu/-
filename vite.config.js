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
        '/app/market-bar.js',
        '/core/ai-service.js',
        '/core/ai-call-log.js',
        '/core/self-consistency.js',
        '/core/agents.js',
        '/core/macro.js',
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
        '/core/discipline.js',
        '/core/pending.js',
        '/core/premortem.js',
        '/core/prebacktest.js',
        '/core/crosscheck.js',
        '/core/kb.js',
        '/core/util.js'
      ]
    }
  },
  server: {
    port: 3003,
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
      }
    }
  },
  worker: {
    format: 'es'
  }
})
