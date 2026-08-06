#!/usr/bin/env node
// 用 Node 替换 start-all.ps1 的 step 1.5 段, 避免 PowerShell UTF-8 decode 漂移

import { readFileSync, writeFileSync } from 'node:fs';

const path = 'D:\\get\\stock-master\\scripts\\start-all.ps1';
const src = readFileSync(path, 'utf8');

// 1.5 段的开头和结尾 marker
const startMarker = '# ---------- 1.5 ';
const endMarker = 'Start-Sleep -Seconds 1';

const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: 找不到 1.5 段开头');
  process.exit(1);
}
// 找 1.5 段的结尾: 下一个 '# ---------- 2.' 段的开头
const nextSectionIdx = src.indexOf('# ---------- 2.', startIdx);
if (nextSectionIdx === -1) {
  console.error('FAIL: 找不到 1.5 段结尾');
  process.exit(1);
}

// 在 1.5 段内找最后一个 Start-Sleep -Seconds 1, 标记为旧段尾
const endIdx = src.lastIndexOf(endMarker, nextSectionIdx);
if (endIdx === -1 || endIdx < startIdx) {
  console.error('FAIL: 找不到 Start-Sleep -Seconds 1');
  process.exit(1);
}
const oldEnd = endIdx + endMarker.length;

const newBlock = `# ---------- 1.5 端口占用检查 (只警告, 不杀) ----------
# 之前 (b2498f0) 这里会按 cmdline 杀 "python|aktools|datasources" 的进程,
# 但 PM2 启的 dev-proxy 拉起的 aktools/datasources 也匹配, 误杀导致 .lnk 闪退.
# 现在 dev-proxy watchdog 已有 bind error detection (code === 3 / 4294967295 认输),
# 端口被外部占就 fail loud 不循环, 不需要 .lnk 自动杀进程.
# 如果之前手动跑过 \`npm run dev\` 留了 orphan, 请手动 pm2 kill 或 taskkill.
\$warnPorts = @(8088, 8091)
\$warnHit = \$false
foreach (\$port in \$warnPorts) {
  \$conn = Get-NetTCPConnection -LocalPort \$port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (\$conn) {
    \$pid = \$conn.OwningProcess
    \$proc = Get-CimInstance Win32_Process -Filter "ProcessId=\$pid" -ErrorAction SilentlyContinue
    \$cmdShort = if (\$proc) { (\$proc.CommandLine -split ' ' | Select-Object -First 3) -join ' ' } else { '?' }
    Yellow "port \$port 被占: PID \$pid  (\$cmdShort)"
    \$warnHit = \$true
  }
}
if (\$warnHit) {
  Write-Host "  ↑ 如果是 PM2 启的, dev-proxy watchdog 会自动接管; 否则 dev-proxy 启不了." -ForegroundColor DarkGray
  Write-Host "    手动清理: pm2 list | pm2 kill;  或 taskkill /F /PID <pid>" -ForegroundColor DarkGray
}`;

// 拼接: src[0..startIdx] + newBlock + '\n' + src[oldEnd..]
const before = src.slice(0, startIdx);
const after = src.slice(oldEnd);
const out = before + newBlock + '\n' + after;

writeFileSync(path, out, 'utf8');
console.log('OK: step 1.5 段已替换, 文件总长', out.length, '字节');
