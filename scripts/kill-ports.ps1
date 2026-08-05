$ErrorActionPreference = 'SilentlyContinue'
$ports = 8088, 8089, 29037
foreach ($port in $ports) {
    $conns = netstat -ano | Select-String ":$port.*LISTENING"
    foreach ($conn in $conns) {
        if ($conn -match '(\d+)\s*$') {
            $pid = [int]$Matches[1]
            if ($pid -gt 4) {
                Stop-Process -Id $pid -Force
                Write-Host "Killed PID $pid on port $port"
            }
        }
    }
}
Stop-Process -Name StockMaster -Force
Write-Host "Done"
