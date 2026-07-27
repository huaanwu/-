# StockMaster — 自用 A股/基金投资工具

> v0.1.0 — MVP 一次塞 7 个功能（行情 / 持仓 / 复盘 / 选股 / 回测 / 提醒 / 基金）

## 跑起来

```bash
# 1. 装依赖
npm install

# 2. 启动 AKShare 数据代理 (新终端)
npm run dev:proxy
# → http://127.0.0.1:8088

# 3. 启动 Vite dev server
npm run dev:vite
# → http://localhost:3003

# 一条龙(同时启动 vite + proxy):
npm run dev
```

## 出 Android APK

```bash
npm run build       # vite build + 合并到 www/
npx cap sync android
cd android && ./gradlew assembleDebug
# 产物:android/app/build/outputs/apk/debug/app-debug.apk
```

## 架构

```
www/
├── index.html              # SPA 入口(所有页面)
├── styles.css              # 全局样式
├── app.js                  # Core 入口(挂全局 + 初始化)
├── core/                   # 通用模块
│   ├── router.js           # 页面切换
│   ├── toast.js            # 提示
│   ├── state.js            # 全局状态
│   ├── storage.js          # IndexedDB (Dexie)
│   ├── data.js             # AKShare 代理 + 缓存
│   └── util.js             # 工具函数
├── app/                    # 按域拆分
│   ├── watchlist.js        # 行情看板
│   ├── holdings.js         # 持仓管理
│   ├── journal.js          # 复盘笔记
│   ├── screener.js         # 选股筛选
│   ├── backtest.js         # 策略回测
│   ├── alerts.js           # 提醒/监控
│   └── fund.js             # 基金专项
└── workers/                # Web Worker
    └── backtest.worker.js
```

## 数据源

- **免费主用**: [AKShare](https://github.com/akfamily/akshare) 通过 `scripts/dev-proxy.mjs` 代理(解决 CORS)
- **付费补充**: Tushare Pro(财务深度数据,几百块/年)

## 跟 zhanbu 的关系

技术栈完全沿用 AI 占卜大师(Capacitor + Vite + 原生 JS + Core/按域拆分)。
自用工具,合规零风险,只服务自己一个人。
