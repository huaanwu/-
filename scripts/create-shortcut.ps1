# ============================================================
# StockMaster - 创建桌面快捷方式
# 用法:
#   pwsh -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1
#     # 默认 (= -Mode exe): 指向 dist/*portable*.exe
#   pwsh -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1 -Mode all
#     # -Mode all: 启动 start-all.ps1 (双击打开 dev-proxy + daemon + preview + 浏览器)
# ============================================================
param(
  [ValidateSet('exe', 'all')] [string]$Mode = 'exe',
  [string]$ExePath = '',                # Mode=exe 用
  [string]$ScriptPath = '',             # Mode=all 用, 默认指向同目录 start-all.ps1
  [string]$ShortcutName = 'StockMaster',
  [string]$IconPath = ''
)

$ErrorActionPreference = 'Stop'

# ---------- 解析 Mode ----------
if ($Mode -eq 'all') {
  # 一键启动器模式
  if (-not $ScriptPath) {
    $ScriptPath = Join-Path $PSScriptRoot 'start-all.ps1'
  }
  if (-not (Test-Path $ScriptPath)) {
    Write-Host "[错误] 找不到启动脚本: $ScriptPath" -ForegroundColor Red
    exit 1
  }
  $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
  $targetPath = $pwsh
  $arguments = "-NoLogo -ExecutionPolicy Bypass -File `"$ScriptPath`""
  $workingDir = 'D:\get\stock-master'
  $description = 'StockMaster 一键启动 (dev-proxy + daemon + preview + 浏览器)'
} else {
  # 现有 exe 模式
  if (-not $ExePath) {
    $distDir = Join-Path $PSScriptRoot '..\dist'
    $candidate = Get-ChildItem -Path $distDir -Filter '*portable*.exe' -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) {
      Write-Host "[错误] 找不到 dist/*portable*.exe, 请先跑 npm run exe:build" -ForegroundColor Red
      exit 1
    }
    $ExePath = $candidate.FullName
  }
  if (-not (Test-Path $ExePath)) {
    Write-Host "[错误] exe 不存在: $ExePath" -ForegroundColor Red
    exit 1
  }
  $targetPath = $ExePath
  $arguments = $null
  $workingDir = Split-Path $ExePath -Parent
  $description = 'StockMaster - 个人 A股/基金投资工具'
}

# ---------- 图标 ----------
if (-not $IconPath) {
  $defaultIcon = Join-Path $PSScriptRoot '..\www\icons\icon.ico'
  if (Test-Path $defaultIcon) { $IconPath = $defaultIcon }
}

# ---------- 写 .lnk ----------
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop "$ShortcutName.lnk"

Write-Host "[StockMaster] 创建桌面快捷方式 (mode=$Mode) ..." -ForegroundColor Cyan
Write-Host "  目标: $targetPath"
if ($arguments) { Write-Host "  参数: $arguments" }
Write-Host "  目录: $workingDir"
$iconDisplay = if ($IconPath) { $IconPath } else { '(默认)' }
Write-Host "  图标: $iconDisplay"
Write-Host "  位置: $lnkPath"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $workingDir
$shortcut.WindowStyle = 1  # Normal (7=Minimized 不适合双击启动)
$shortcut.Description = $description
if ($arguments) { $shortcut.Arguments = $arguments }
if ($IconPath -and (Test-Path $IconPath)) {
  $shortcut.IconLocation = $IconPath
}
$shortcut.Save()

# 清理 COM
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($shortcut) | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($shell)    | Out-Null
[GC]::Collect()

if (Test-Path $lnkPath) {
  Write-Host "[OK] 桌面快捷方式已创建: $lnkPath" -ForegroundColor Green
  Write-Host "  双击即可启动 (Mode=$Mode)" -ForegroundColor Gray
} else {
  Write-Host "[错误] 创建失败" -ForegroundColor Red
  exit 1
}