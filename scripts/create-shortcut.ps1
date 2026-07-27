# ============================================================
# StockMaster - 创建桌面快捷方式
# 用法: powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1
# ============================================================
param(
    [string]$ExePath = "",
    [string]$ShortcutName = "StockMaster",
    [string]$IconPath = ""
)

$ErrorActionPreference = 'Stop'

# 默认路径: dist 目录最新 portable exe
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

if (-not $IconPath) {
    $defaultIcon = Join-Path $PSScriptRoot '..\www\icons\icon.ico'
    if (Test-Path $defaultIcon) { $IconPath = $defaultIcon }
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop "$ShortcutName.lnk"

Write-Host "[StockMaster] 创建桌面快捷方式..." -ForegroundColor Cyan
Write-Host "  目标: $ExePath"
$iconDisplay = if ($IconPath) { $IconPath } else { '(默认)' }
Write-Host "  图标: $iconDisplay"
Write-Host "  位置: $lnkPath"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $ExePath
$shortcut.WorkingDirectory = Split-Path $ExePath -Parent
$shortcut.WindowStyle = 1  # Normal (7=Minimized 不适合双击启动)
$shortcut.Description = "StockMaster - 个人 A股/基金投资工具"
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
} else {
    Write-Host "[错误] 创建失败" -ForegroundColor Red
    exit 1
}