// PM2 监管配置 — dev-proxy + reverse-watch-daemon + preview 自动重启 + 日志
// 用法:
//   pm2 start ecosystem.config.cjs                    # 启动三个 app
//   pm2 stop all                                       # 停
//   pm2 restart stock-master-dev-proxy                 # 重启单个
//   pm2 logs                                           # 看全部日志
//   pm2 save && pm2 startup                            # 开机自启 (Windows 用 pm2-installer 或 nssm 替代)
// ?v=daemon7-ai-fallback1-logic2-fix5: 三个 app 加 min_uptime, 防 EADDRINUSE 反复崩
module.exports = {
  apps: [
    {
      name: 'stock-master-dev-proxy',
      script: './scripts/dev-proxy.mjs',
      cwd: 'D:\\get\\stock-master',
      interpreter: 'node',
      autorestart: true,
      restart_delay: 1000,
      max_restarts: 50,
      min_uptime: '20s',  // P1 #6: 活过 20s 才算 "正常启动", 否则计入 unstable
      max_memory_restart: '512M',
      exp_backoff_restart_delay: false,
      out_file: 'D:\\get\\stock-master\\logs\\dev-proxy-out.log',
      error_file: 'D:\\get\\stock-master\\logs\\dev-proxy-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'development',
        PORT: 8089,
        PROXY_PORT: 8089,
        AKSHARE_TARGET: 'http://127.0.0.1:8088',
        NO_AKTOOLS_AUTOSTART: ''
      }
    },
    {
      name: 'stock-master-reverse-watch-daemon',
      script: './scripts/reverse-watch-daemon.mjs',
      cwd: 'D:\\get\\stock-master',
      interpreter: 'node',
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,  // 调小, EADDRINUSE 时更早触发 errored 状态
      min_uptime: '20s',
      max_memory_restart: '256M',
      exp_backoff_restart_delay: 100,
      out_file: 'D:\\get\\stock-master\\logs\\daemon-out.log',
      error_file: 'D:\\get\\stock-master\\logs\\daemon-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'development',
        DEV_PROXY: 'http://127.0.0.1:8089',
        TZ: 'Asia/Shanghai',  // A 股时间用上海时区
        // P0 #2 (第15轮): 暴露到 0.0.0.0, 让手机/APK/局域网访问; DAEMON_HOST=127.0.0.1 可回退
        DAEMON_HOST: '0.0.0.0'
      }
    },
    {
      // 桌面一键启动器 (?v=launcher1 P0 #173): 之前用户手 python -m http.server 3020 现在归 PM2 管
      // 不直接 PM2 跑 python (PM2 会把 script 当 Node 解析, python.exe 报 SyntaxError)
      // 通过 scripts/start-preview.mjs 薄包装调 spawn python -m http.server 3020
      name: 'stock-master-reverse-watch-preview',
      script: './scripts/start-preview.mjs',
      cwd: 'D:\\get\\stock-master',
      interpreter: 'node',
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: '20s',
      max_memory_restart: '128M',
      out_file: 'D:\\get\\stock-master\\logs\\preview-3020-out.log',
      error_file: 'D:\\get\\stock-master\\logs\\preview-3020-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'development',
        RW_DIR: 'D:\\get\\stock-master\\reverse-watch',
        PYTHONUNBUFFERED: '1',
        // P0 #2 (第15轮): 暴露到 0.0.0.0; RW_HOST=127.0.0.1 可回退
        RW_HOST: '0.0.0.0'
      }
    }
  ]
};