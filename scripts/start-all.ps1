# ============================================================
# StockMaster - 一键启动器 (桌面 .lnk 调它)
# 单进程模式: 1 端口 :8089, 包含 dev-proxy + daemon + 静态
# 启动: node scripts/unified-server.mjs (内含 dev-proxy + daemon + express.static)
#
# 端口:
#   - 8089  unified-server (dev-proxy API + daemon API + 静态)
#   - 8088  aktools (Python, sidecar, 自动启)
#   - 8091  datasources (Python, sidecar, 自动启)
#
# 浏览器: http://127.0.0.1:8089/index.html
# ============================================================
# 用法:
#   pwsh -ExecutionPolicy Bypass -File D:\get\stock-master\scripts\start-all.ps1
# 或双击 desktop\StockMaster.lnk (创建见 create-shortcut.ps1 -Mode all)
# ============================================================

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = 'D:\get\stock-master'
$unifiedScript = Join-Path $projectRoot 'scripts\unified-server.mjs'

$port = if ($env:UNIFIED_PORT) { [int]$env:UNIFIED_PORT } else { 8089 }
$browserUrl = "http://127.0.0.1:$port/index.html"

function Green($s)  { Write-Host "  [OK] $s" -ForegroundColor Green }
function Red($s)    { Write-Host "  [X] $s" -ForegroundColor Red }
function Yellow($s) { Write-Host "  [!] $s" -ForegroundColor Yellow }
function Cyan($s)   { Write-Host "  [->] $s" -ForegroundColor Cyan }
function Title($s)  { Write-Host "`n[StockMaster] $s" -ForegroundColor Cyan }

# ---------- 1. 端口占用检查 (只警告, 不杀) ----------
# 8088/8091 是 sidecar 端口, 可能被手动起的 aktools/datasources 占着, 自动启会复用
$warnPorts = @(8088, 8091, $port)
$warnHit = $false
foreach ($p in $warnPorts) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    $connPid = $conn.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$connPid" -ErrorAction SilentlyContinue
    $cmdShort = if ($proc) { ($proc.CommandLine -split ' ' | Select-Object -First 3) -join ' ' } else { '?' }
    if ($p -eq $port) {
      Red "port $p 已被占用 (PID $connPid, $cmdShort)"
      Yellow "  如需替换, 先停掉旧进程: Stop-Process -Id $connPid -Force"
      exit 1
    }
    Yellow "port $p 被占: PID $connPid  ($cmdShort)"
    $warnHit = $true
  }
}
if ($warnHit) {
  Write-Host "    如果是手动跑的, unified-server 会复用 (不会重复启)" -ForegroundColor DarkGray
}

# ---------- 2. 启 unified-server ----------
Title "1/3 启动 unified-server (单进程单端口)"
if (-not (Test-Path $unifiedScript)) {
  Red "找不到: $unifiedScript"
  exit 1
}

# 准备日志目录
$logDir = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$unifiedLog = Join-Path $logDir 'unified-out.log'

# 后台启 unified-server, 日志写文件 (避免乱码/阻塞窗口)
$env:UNIFIED_PORT = $port
$env:UNIFIED_HOST = '127.0.0.1'
# 不自动启 aktools/datasources (用户已手动启了 8088/8091)
# 如需测试环境自动启, 可注释下面两行
# $env:NO_AKTOOLS_AUTOSTART = '1'
# $env:NO_DATASOURCES_AUTOSTART = '1'

$unifiedProc = Start-Process -FilePath node `
  -ArgumentList @($unifiedScript) `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $unifiedLog `
  -RedirectStandardError ($unifiedLog -replace '\.log$', '-err.log') `
  -NoNewWindow -PassThru
Green "unified-server 已起: PID $($unifiedProc.Id)  端口 $port  日志: $unifiedLog"

# ---------- 3. 等 /health 200 ----------
Cyan "  等 unified-server 就绪..."
$ok = $false
for ($i = 1; $i -le 30; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
      $json = $r.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
      if ($json.unified) {
        Green "unified-server 就绪 (unified=true, ${i}s, PID=$($json.pid), mem=$($json.memory))"
        $ok = $true
        break
      }
    }
  } catch { }
  if ($i % 5 -eq 0) { Cyan "  仍在等待 (${i}s)..." }
  Start-Sleep -Seconds 1
}
if (-not $ok) {
  Red "unified-server 30s 内未就绪, 检查日志: $unifiedLog"
  try { Stop-Process -Id $unifiedProc.Id -Force } catch {}
  exit 1
}

# 顺便也确认下 /daemon/health
try {
  $d = Invoke-WebRequest -Uri "http://127.0.0.1:$port/daemon/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
  if ($d.StatusCode -eq 200) { Green "daemon /daemon/health OK" }
} catch { Yellow "daemon /daemon/health 暂未就绪 (可能 aktools/datasources 还没起, 正常)" }

# ---------- 4. 打开浏览器 ----------
Title "2/3 打开浏览器"
try {
  Start-Process $browserUrl
  Green "已打开: $browserUrl"
} catch {
  Yellow "打开浏览器失败: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  [OK] StockMaster 已就绪 (单进程单端口模式)" -ForegroundColor Green
Write-Host "  主页:   $browserUrl" -ForegroundColor Gray
Write-Host "  health: http://127.0.0.1:$port/health" -ForegroundColor Gray
Write-Host "  日志:   $unifiedLog" -ForegroundColor Gray
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "按任意键停止 unified-server 并关闭窗口..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

# ---------- 5. 优雅退 (调 SIGTERM, 让 unified-server 自己收尾) ----------
Title "3/3 停止 unified-server"
Cyan "  停 PID $($unifiedProc.Id) ..."
try { Stop-Process -Id $unifiedProc.Id -Force } catch {}
if ($unifiedProc) {
  $waited = 0
  while (-not $unifiedProc.HasExited -and $waited -lt 6) {
    Start-Sleep -Seconds 1; $waited++
  }
  if ($unifiedProc.HasExited) { Green "unified-server 已退出 (${waited}s)" }
  else { Yellow "unified-server 6s 内未退, 强杀 PID $($unifiedProc.Id)" }
}
Write-Host ""
Write-Host "全部已停, 窗口关闭" -ForegroundColor DarkGray
