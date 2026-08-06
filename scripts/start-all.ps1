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
function Yellow($s) { Write-Host "  ! $s" -ForegroundColor Yellow }
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

# ---------- 1.5 端口占用检查 (只警告, 不杀) ----------
# 之前 (b2498f0) 这里会按 cmdline 杀 "python|aktools|datasources" 的进程,
# 但 PM2 启的 dev-proxy 拉起的 aktools/datasources 也匹配, 误杀导致 .lnk 闪退.
# 现在 dev-proxy watchdog 已有 bind error detection (code === 3 / 4294967295 认输),
# 端口被外部占就 fail loud 不循环, 不需要 .lnk 自动杀进程.
# 如果之前手动跑过 `npm run dev` 留了 orphan, 请手动 pm2 kill 或 taskkill.
$warnPorts = @(8088, 8091)
$warnHit = $false
foreach ($port in $warnPorts) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    $connPid = $conn.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$connPid" -ErrorAction SilentlyContinue
    $cmdShort = if ($proc) { ($proc.CommandLine -split ' ' | Select-Object -First 3) -join ' ' } else { '?' }
    Yellow "port $port 被占: PID $connPid  ($cmdShort)"
    $warnHit = $true
  }
}
if ($warnHit) {
  Write-Host "  ↑ 如果是 PM2 启的, dev-proxy watchdog 会自动接管; 否则 dev-proxy 启不了." -ForegroundColor DarkGray
  Write-Host "    手动清理: pm2 list | pm2 kill;  或 taskkill /F /PID <pid>" -ForegroundColor DarkGray
}


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
