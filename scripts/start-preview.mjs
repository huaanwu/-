// ============== scripts/start-preview.mjs ==============
// 桌面一键启动器 ( ): 启动 reverse-watch preview :3020
// 为什么不直接 PM2 跑 python -m http.server:
//   PM2 把 script 字段当 Node 解析, python.exe 报 SyntaxError
// 为什么不直接 Start-Process python ... :
//   PM2 看不到, 开机自启需另写
// 解: 写个 thin wrapper 调 spawn 'python -m http.server 3020 --bind 127.0.0.1'

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const PORT = Number(process.env.PORT) || 3020;  // ?v=daemon7-ai-fallback1-logic2-fix5: 接受 PORT env (Browser preview autoPort)
// 改 0.0.0.0 (默认), 让手机/APK/局域网能访问 (原 127.0.0.1 互锁)
const HOST = process.env.RW_HOST || '0.0.0.0';
const CWD = process.env.RW_DIR || path.resolve(process.cwd(), 'reverse-watch');

function pickPython() {
  // 按需决定: 优先 PATH 里的 python (用户已经在 WindowsApps + Local\Python 都有)
  return process.env.PYTHON_BIN || 'python';
}

const py = pickPython();
const args = ['-u', '-m', 'http.server', String(PORT), '--bind', HOST];

console.log(`[start-preview] cwd: ${CWD}`);
console.log(`[start-preview] cmd: ${py} ${args.join(' ')}`);

const child = spawn(py, args, {
  cwd: CWD,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, PYTHONUNBUFFERED: '1' }
});

let killed = false;
function shutdown(sig) {
  if (killed) return;
  killed = true;
  console.log(`[start-preview] received ${sig}, killing child pid=${child.pid}`);
  try {
    // Windows 下 child.kill('SIGTERM') 对 python 子进程不可靠
    // 用 taskkill /T /F 杀进程树, 防止 python http.server 残留 (实测 netstat 会看到两个 LISTENING 端口)
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));

child.on('exit', (code, sig) => {
  console.log(`[start-preview] child exited code=${code} sig=${sig}`);
  process.exit(code ?? 0);
});
child.on('error', (e) => {
  console.error(`[start-preview] spawn error: ${e.message}`);
  process.exit(1);
});
