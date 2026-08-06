# ============================================================
# StockMaster - 一键启动器 (桌面 .lnk 调它)
# 启动: dev-proxy :8089 + reverse-watch-daemon :8090 + preview :3020
#       全部交给 dev-supervisor (Node), 进程组绑定:
#         - 要起都起, supervisor 起则 3 个一起起
#         - 要崩都崩, 任一子进程非零退, supervisor 拉所有一起退
#         - 要停都停, .lnk 关窗调 supervisor /stop, 子进程全清
# 打开浏览器: http://127.0.0.1:3020/index.html
# ============================================================
# 用法:
#   pwsh -ExecutionPolicy Bypass -File D:\get\stock-master\scripts\start-all.ps1
# 或双击 desktop\StockMaster.lnk (创建见 create-shortcut.ps1 -Mode all)
# ============================================================

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = 'D:\get\stock-master'
$supervisorScript = Join-Path $projectRoot 'scripts\dev-supervisor.mjs'
$supervisorPort = 8888
$supervisorLog  = Join-Path $projectRoot 'logs\supervisor-out.log'

# 健康检查端点: browser 先开前面两个最后是 preview
$endpoints = @(
  @{ url = 'http://127.0.0.1:8089/health';       label = 'dev-proxy   :8089';  timeout = 20 },
  @{ url = 'http://127.0.0.1:8090/health';       label = 'daemon      :8090';  timeout = 30 },
  @{ url = 'http://127.0.0.1:3020/index.html';  label = 'preview     :3020';  timeout = 15 }
)

$browserUrl = 'http://127.0.0.1:3020/index.html'

function Green($s)  { Write-Host "  [OK] $s" -ForegroundColor Green }
function Red($s)    { Write-Host "  [X] $s" -ForegroundColor Red }
function Yellow($s) { Write-Host "  [!] $s" -ForegroundColor Yellow }
function Cyan($s)   { Write-Host "  [->] $s" -ForegroundColor Cyan }
function Title($s)  { Write-Host "`n[StockMaster] $s" -ForegroundColor Cyan }

# ---------- 1. 端口占用检查 (只警告, 不杀) ----------
# 8088/8091 是 sidecar 端口, 可能被 dev-proxy 启的 aktools/datasources 占着
# (那是 PM2 启的话, supervisor 接管; 否则 dev-proxy 启不了)
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
  Write-Host "    如果是手动跑的, supervisor 接管不了 — 关掉再双击 .lnk" -ForegroundColor DarkGray
}

# ---------- 2. supervisor 已经在跑? ----------
Title "1/4 启动 dev-supervisor"
$existing = Get-NetTCPConnection -LocalPort $supervisorPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$supervisorProc = $null
if ($existing) {
  $existingPid = $existing.OwningProcess
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
  $cmdShort = if ($proc) { ($proc.CommandLine -split ' ' | Select-Object -First 3) -join ' ' } else { '?' }
  Yellow "supervisor 已在跑 (PID $existingPid, $cmdShort), 复用"
  $supervisorProc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
} else {
  # 后台启 supervisor, 日志写文件 (避免乱码/阻塞窗口)
  New-Item -ItemType Directory -Force -Path (Split-Path $supervisorLog) | Out-Null
  $logStream = [System.IO.File]::Open($supervisorLog, 'Create', 'Write', 'ReadWrite')
  $supervisorProc = Start-Process -FilePath node `
    -ArgumentList @($supervisorScript) `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $supervisorLog `
    -RedirectStandardError ($supervisorLog -replace '\.log$', '-err.log') `
    -NoNewWindow -PassThru
  Green "supervisor 已起: PID $($supervisorProc.Id)  日志: $supervisorLog"
}

# ---------- 3. 等 supervisor /health 200 ----------
Cyan "  等 supervisor 就绪..."
$supOK = $false
for ($i = 1; $i -le 15; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$supervisorPort/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $supOK = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $supOK) {
  Red "supervisor 15s 内未就绪, 检查日志: $supervisorLog"
  if ($supervisorProc -and -not $existing) {
    try { Stop-Process -Id $supervisorProc.Id -Force } catch {}
  }
  exit 1
}
Green "supervisor 就绪"

# ---------- 4. 等所有服务端口就绪 ----------
Title "2/4 等待服务就绪"
foreach ($ep in $endpoints) {
  $ok = $false
  for ($i = 1; $i -le $ep.timeout; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri $ep.url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) {
        Green "$($ep.label) 就绪 (${i}s)"
        $ok = $true; break
      }
    } catch { }
    if ($i % 5 -eq 0) { Cyan "  $(${ep.label}) 仍在等待 (${i}s)..." }
    Start-Sleep -Seconds 1
  }
  if (-not $ok) {
    Red "$($ep.label) 超时, supervisor 拉所有一起退"
    try { Invoke-WebRequest -Uri "http://127.0.0.1:$supervisorPort/stop" -Method POST -UseBasicParsing -TimeoutSec 2 } catch {}
    exit 1
  }
}

# ---------- 5. 打开浏览器 ----------
Title "3/4 打开浏览器"
try {
  Start-Process $browserUrl
  Green "已打开: $browserUrl"
} catch {
  Red "打开浏览器失败: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  [OK] StockMaster 已就绪" -ForegroundColor Green
Write-Host "  supervisor 日志: $supervisorLog" -ForegroundColor Gray
Write-Host "  查 supervisor 状态: curl http://127.0.0.1:$supervisorPort/health" -ForegroundColor Gray
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "按任意键停止所有服务并关闭窗口..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

# ---------- 6. 调 supervisor /stop, 等它优雅退 ----------
Title "4/4 停止所有服务"
Cyan "  调 supervisor /stop ..."
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$supervisorPort/stop" -Method POST -UseBasicParsing -TimeoutSec 2 | Out-Null
} catch { }

# 等 supervisor 真退
if ($supervisorProc) {
  $waited = 0
  while (-not $supervisorProc.HasExited -and $waited -lt 6) {
    Start-Sleep -Seconds 1; $waited++
  }
  if ($supervisorProc.HasExited) {
    Green "supervisor 已退出 (${waited}s)"
  } else {
    Yellow "supervisor 6s 内未退, 强杀 PID $($supervisorProc.Id)"
    try { Stop-Process -Id $supervisorProc.Id -Force } catch {}
  }
}
Write-Host ""
Write-Host "全部已停, 窗口关闭" -ForegroundColor DarkGray
