# start-dev-proxy.ps1
# 一键拉起 stock-master dev-proxy (:8089) — reverse-watch (:3020) 也要走它转发 LLM/AKShare
# 用法: pwsh -File D:\get\stock-master\scripts\start-dev-proxy.ps1
#       或在 reverse-watch 目录跑: ..\stock-master\scripts\start-dev-proxy.ps1

$ErrorActionPreference = 'Stop'
$port = 8089
$projectRoot = 'D:\get\stock-master'
$logDir = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDir 'dev-proxy.log'

# 0. UTF-8 (避免中文乱码)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 1. 检查端口
Write-Host ">> 检查端口 $port ..." -ForegroundColor Cyan
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  $pid_ = $listener.OwningProcess
  Write-Host "✓ dev-proxy 已在运行 (PID: $pid_)" -ForegroundColor Green
  Write-Host "  日志可能位于: $logFile" -ForegroundColor Gray
  Write-Host "  健康检查: http://127.0.0.1:$port/health" -ForegroundColor Gray
  Write-Host "  CORS 白名单: http://localhost:3020 (reverse-watch)" -ForegroundColor Gray
  exit 0
}

# 2. 准备日志目录
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

# 3. 启动
Write-Host ">> 启动 dev-proxy (后台, 日志: $logFile) ..." -ForegroundColor Cyan
Set-Location $projectRoot
$proc = Start-Process -FilePath 'pwsh' `
  -ArgumentList '-NoExit', '-Command', "npm run dev:proxy 2>&1 | Tee-Object -FilePath '$logFile'" `
  -PassThru -WindowStyle Hidden

Start-Sleep -Seconds 2

# 4. 健康检查
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) { $ok = $true; break }
  } catch {
    Start-Sleep -Seconds 1
  }
}

if ($ok) {
  Write-Host "✅ dev-proxy 启动成功 (PID: $($proc.Id))" -ForegroundColor Green
  Write-Host "  → http://127.0.0.1:$port/health" -ForegroundColor Gray
  Write-Host "  → reverse-watch (:3020) 可调用 /api/llm/{provider}/chat/completions" -ForegroundColor Gray
  Write-Host "  → 日志: Get-Content '$logFile' -Tail 50 -Wait" -ForegroundColor Gray
} else {
  Write-Host "❌ dev-proxy 启动失败, 请检查日志:" -ForegroundColor Red
  Write-Host "   Get-Content '$logFile' -Tail 50" -ForegroundColor Yellow
  Write-Host "   或确认: npm run dev:proxy 是否能独立跑" -ForegroundColor Yellow
  exit 1
}