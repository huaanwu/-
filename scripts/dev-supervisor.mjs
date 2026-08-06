// dev-supervisor.mjs
// 捆 3 个 Node 服务成一组, 生命周期一致: 要起都起, 要崩都崩, 要停都停
// - 子进程任一非零退出 -> 杀其他 -> supervisor 退
// - supervisor 收 SIGINT/SIGTERM -> 杀所有子进程 -> 退
// - 不依赖 PM2, .lnk 关窗 = 全部停
//
// 启动顺序: dev-proxy :8089 (其他依赖它) -> daemon :8090 -> preview :3020
// 停止顺序: 反向 (preview -> daemon -> proxy), 给 2s grace, 之后 SIGKILL 兜底

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const SUPERVISOR_PORT = Number(process.env.SUPERVISOR_PORT) || 8888;

const services = [
  { name: 'proxy',   cmd: 'node', args: ['scripts/dev-proxy.mjs'],            color: '\x1b[36m', delay: 0    },
  { name: 'daemon',  cmd: 'node', args: ['scripts/reverse-watch-daemon.mjs'],  color: '\x1b[33m', delay: 1500 },
  { name: 'preview', cmd: 'node', args: ['scripts/start-preview.mjs'],         color: '\x1b[35m', delay: 1500 }
];
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GRACE_MS = 2000;

const procs = new Map();   // name -> ChildProcess
let exiting = false;

function tag(name, color) { return `${color}[${name.padEnd(7)}]${RESET}`; }

function startService(svc) {
  const p = spawn(svc.cmd, svc.args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
    // 不 windowsHide: 子进程需要 console 才能让 taskkill /pid (no /F) 发的 WM_CLOSE 触发 SIGTERM handler
  });
  procs.set(svc.name, p);
  const t = tag(svc.name, svc.color);
  p.stdout.on('data', (d) => process.stdout.write(d.toString('utf8').split('\n').filter(Boolean).map(l => `${t} ${l}`).join('\n') + '\n'));
  p.stderr.on('data', (d) => process.stderr.write(d.toString('utf8').split('\n').filter(Boolean).map(l => `${t} ${l}`).join('\n') + '\n'));
  p.on('exit', (code, signal) => {
    if (exiting) return;
    exiting = true;
    console.error(`${RED}[supervisor]${RESET} ${svc.name} 退出 (code=${code}, signal=${signal}) — 触发全停`);
    killAll('SIGTERM', svc.name);
    setTimeout(() => {
      killAll('SIGKILL', svc.name);
      process.exit(code || 1);
    }, GRACE_MS).unref();
  });
}

function killAll(signal, exceptName) {
  for (const [name, p] of procs) {
    if (name === exceptName) continue;
    if (p.killed || p.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') {
        // Windows: /T 杀进程树 (start-preview 启的 python 也会被带)
        // /F 强杀, 避免 python 不响应 WM_CLOSE 留下孤儿
        spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        p.kill(signal);
      }
    } catch (e) { /* 静默 */ }
  }
  // 兜底清: Node spawn 的子进程 (尤其是 start-preview 启的 python) 经常不在 process tree 里,
  // taskkill /T 不可靠. supervisor 显式扫所有管理的端口, 强杀任何还在占的进程.
  if (process.platform === 'win32') {
    const managedPorts = [8888, 8089, 8090, 3020, 8088, 8091];
    try {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
      const seen = new Set();
      for (const line of out.split('\n')) {
        if (!/LISTENING/.test(line)) continue;
        for (const port of managedPorts) {
          if (!new RegExp(`:${port}\\s`).test(line)) continue;
          const m = line.match(/\s(\d+)\s*$/);
          if (!m) continue;
          const pid = m[1];
          if (seen.has(pid)) continue;
          seen.add(pid);
          spawnSync('taskkill', ['/pid', pid, '/F', '/T'], { stdio: 'ignore' });
        }
      }
    } catch {}
  }
}

function shutdown(sig) {
  if (exiting) return;
  exiting = true;
  console.log(`\n[supervisor] ${sig} 收到, 正在停 ${procs.size} 个服务...`);
  // 反向: preview, daemon, proxy
  const order = ['preview', 'daemon', 'proxy'];
  for (const name of order) {
    const p = procs.get(name);
    if (p && !p.killed && p.exitCode === null) {
      try { p.kill('SIGTERM'); } catch {}
    }
  }
  setTimeout(() => {
    killAll('SIGKILL');
    setTimeout(() => process.exit(0), 200);
  }, GRACE_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

// HTTP 控制端点: /health (查子进程) + /stop (触发 shutdown)
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const statuses = [...procs.entries()].map(([name, p]) => ({
      name, alive: p.exitCode === null && !p.killed
    }));
    const allAlive = statuses.every(s => s.alive);
    res.writeHead(allAlive ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: allAlive, children: statuses, exiting }));
    return;
  }
  if (req.method === 'POST' && req.url === '/stop') {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"stopping":true}');
    setImmediate(() => shutdown('HTTP /stop'));
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(SUPERVISOR_PORT, '127.0.0.1', () => {
  console.log(`[supervisor] HTTP control: http://127.0.0.1:${SUPERVISOR_PORT}/health  /stop`);
});

console.log(`[supervisor] 启动 ${services.length} 个服务 (cwd=${projectRoot})`);
(async () => {
  for (const svc of services) {
    if (svc.delay) await new Promise(r => setTimeout(r, svc.delay));
    console.log(`[supervisor] 启动 ${svc.name} ...`);
    startService(svc);
  }
  console.log('[supervisor] 全部已 spawn, 转发 stdout');
})();
