; NSIS 安装前 hook — 自动关闭 StockMaster 及相关后台进程
; 解决: V13 Tray 常驻模式下关窗口不杀子进程，导致安装程序报"程序正在运行"
!macro customInstallInit
  DetailPrint "正在关闭 StockMaster 及后台服务..."

  ; $EXEDIR = installer.exe 所在目录
  ExecWait '"$EXEDIR\..\scripts\kill-ports.ps1"'

  Sleep 2000
  DetailPrint "已关闭，准备安装 StockMaster..."
!macroend
