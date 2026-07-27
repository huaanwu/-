# PowerShell 7.x Profile 配置片段
# 装完 PS 7.1+ 后,把这个文件内容追加到:
#   $HOME\Documents\PowerShell\Microsoft.PowerShell_profile.ps1
#
# 快速创建(在 pwsh 7 里执行):
#   New-Item -Path $PROFILE -ItemType File -Force
#   notepad $PROFILE
# 然后把下面内容贴进去,保存即可。
# 立即生效: . $PROFILE

# ========== 1. 终端 UTF-8(关键) ==========
# 解决中文乱码的核心开关
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

# 让 PS 内部也按 UTF-8 处理(避免 Out-File 写中文变 GBK)
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'

# ========== 2. 提示符(显示当前路径 + git 分支) ==========
function prompt {
    $loc = Get-Location
    $git = ''
    if (Test-Path .git -PathType Container) {
        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        if ($branch) { $git = " [$branch]" }
    }
    "PS $($loc)${git}> "
}

# ========== 3. 常用别名 ==========
Set-Alias -Name ll   -Value Get-ChildItem -Option Constant
Set-Alias -Name la   -Value Get-ChildItem -Option Constant
Set-Alias -Name grep -Value Select-String  -Option Constant

function la { Get-ChildItem -Force | Format-Table AutoSize }
function ll { Get-ChildItem -Force | Format-Table AutoSize }

# ========== 4. 实用工具函数 ==========
# 快速跳到项目目录
function gst { Set-Location D:\get\stock-master }

# 查看当前端口占用
function port($p) {
    Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue |
        Select-Object LocalAddress, LocalPort, State, OwningProcess
}

# 像 Linux 一样的 which
function which($cmd) { Get-Command $cmd -ErrorAction SilentlyContinue }

# ========== 5. StockMaster 启动快捷方式 ==========
# 一条龙:启动 AKTools Python 后端 + dev-proxy + vite(可选)
function gst-dev {
    Write-Host ">> 1/3 启动 AKTools (Python :8088)" -ForegroundColor Cyan
    Write-Host "  请先在另一个终端跑: pip install aktools" -ForegroundColor Yellow
    Write-Host "  python -m aktools http --host 127.0.0.1 --port 8088" -ForegroundColor Yellow
    Write-Host ""
    Write-Host ">> 2/3 启动 dev-proxy (:8089)" -ForegroundColor Cyan
    Start-Process pwsh -ArgumentList '-NoExit','-Command',"cd D:\get\stock-master; npm run dev:proxy"
    Start-Sleep 1
    Write-Host ">> 3/3 启动 Vite (:3003)" -ForegroundColor Cyan
    Set-Location D:\get\stock-master
    npm run dev:vite
}

function gst-build {
    Set-Location D:\get\stock-master
    npm run build
}

function gst-test {
    Set-Location D:\get\stock-master
    npm test
}

# ========== 6. 模块加载提示 ==========
Write-Host "✓ PowerShell Profile loaded (UTF-8 mode)" -ForegroundColor Green
Write-Host "  常用命令: gst / gst-dev / gst-build / gst-test / port 8089" -ForegroundColor Gray