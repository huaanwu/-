# ============================================================
# StockMaster - 一键启动器 (桌面 .lnk 调它)
# 启动: dev-proxy :8089 + reverse-watch-daemon :8090 + preview :3020
#       全部走 PM2 监管, 幂等 (已起的不会重起)
# 打开浏览器: http://127.0.0.1:3020/index.html (1 个 tab)
# ============================================================
# 用法:
#   pwsh -ExecutionPolicy Bypass -File D:\get\stock-master\scripts\start-all.ps1
# 或双击 desktop\StockMaster.lnk (创建见 create-shortcut.ps1 -Mode all)
# ============================================================

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = 'D:\get\stock-master'
$ecosystemConfig = Join-Path $projectRoot 'ecosystem.config.cjs'

# 启动哪些 app (只在 list 内的 stock-master-* 才会被影响, hermes-gateway / mimo2codex-sidecar 等不动)
$stockApps = @(
  'stock-master-dev-proxy',
  'stock-master-reverse-watch-daemon',
  'stock-master-reverse-watch-preview'
)

# 健康检查端点: 浏览器先开前面两个最后是 preview
$endpoints = @(
  @{ url = 'http://127.0.0.1:8089/health';       label = 'dev-proxy   :8089';  timeout = 20 },
  @{ url = 'http://127.0.0.1:8090/health';       label = 'daemon      :8090';  timeout = 30 },
  @{ url = 'http://127.0.0.1:3020/index.html';  label = 'preview     :3020';  timeout = 15 }
)

$browserUrl = 'http://127.0.0.1:3020/index.html'

function Green($s) { Write-Host "  ✓ $s" -ForegroundColor Green }
function Red($s)   { Write-Host "  ✗ $s" -ForegroundColor Red }
function Cyan($s)  { Write-Host "  › $s" -ForegroundColor Cyan }
function Title($s) { Write-Host "`n[StockMaster] $s" -ForegroundColor Cyan }

# ---------- 1. pm2 是否可用 ----------
Title "1/5 检查 pm2"
try {
  $pm2 = (Get-Command pm2 -ErrorAction Stop).Source
  Green "pm2 在 $pm2"
} catch {
  Red "pm2 不在 PATH, 请先 npm i -g pm2"
  exit 1
}

# ---------- 1.5 清理孤儿 Python (避免端口冲突) ----------
# 之前手动跑过 `npm run dev` 留的 aktools/datasources 子进程没人管
# 启动 PM2 后, dev-proxy 内的 watchdog 启新子进程会撞端口 → 死循环
# 这里先按端口清掉占的 Python 进程
$orphanPorts = @(8088, 8091)
foreach ($port in $orphanPorts) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    $pid = $conn.OwningProcess
    if ($pid -gt 0) {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue
      $cmd = if ($proc) { $proc.CommandLine } else { '' }
      if ($cmd -match 'python|aktools|datasources') {
        Cyan "清理孤儿: port $port ← PID $pid (Python, 非 PM2 管)"
        try { Stop-Process -Id $pid -Force -ErrorAction Stop } catch { Red "  杀不掉: $($_.Exception.Message)" }
      } else {
        Yellow "port $port 被非 Python 进程占 (PID $pid), 跳过 — 你自己处理"
      }
    }
  }
}
Start-Sleep -Seconds 1

# ---------- 2. PM2 启动所有 stock-master app (幂等) ----------
Title "2/5 启动 PM2 app (已起的跳过)"
Set-Location $projectRoot
foreach ($name in $stockApps) {
  # 已 online 的不重起
  $running = pm2 list 2>&1 | Select-String -Pattern "^\| \d+\s+\|\s+$name\s+\|.*\|\s+online\s+\|" -CaseSensitive:$false
  if ($running) {
    Green "$name 已 online, 跳过"
    continue
  }
  Cyan "启动 $name ..."
  pm2 start $ecosystemConfig --only $name 2>&1 | Out-Null
  Start-Sleep -Seconds 1
}

# ---------- 3. 健康检查 (轮询 /health) ----------
Title "3/5 等待服务就绪"
foreach ($ep in $endpoints) {
  $ok = $false
  for ($i = 1; $i -le $ep.timeout; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri $ep.url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) {
        Green "$($ep.label) 就绪 (${i}s)"
        $ok = $true
        break
      }
    } catch { }
    if ($i % 5 -eq 0) { Cyan "  $(${ep.label}) 仍在等待 (${i}s)..." }
    Start-Sleep -Seconds 1
  }
  if (-not $ok) {
    Red "$($ep.label) 超时未就绪, 请手动 pm2 logs $name 排查"
    Write-Host ""
    Write-Host "  调试命令: pm2 list / pm2 logs <name> --lines 50" -ForegroundColor Yellow
    exit 1
  }
}

# ---------- 4. 打开浏览器 ----------
Title "4/5 打开浏览器"
try {
  Start-Process $browserUrl
  Green "已打开: $browserUrl"
} catch {
  Red "打开浏览器失败: $($_.Exception.Message)"
  Write-Host "  请手动访问: $browserUrl" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  ✓ StockMaster 已就绪" -ForegroundColor Green
Write-Host "  停止所有后台: pm2 stop $stockApps" -ForegroundColor Gray
Write-Host "  查看日志:     pm2 logs --lines 50" -ForegroundColor Gray
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "按任意键关闭窗口..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
