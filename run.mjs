/**
 * StockMaster 魔改运行器 — 用 cmd.exe 绕开砸掉的 Git Bash
 * 用法: node run.mjs [test|build|git|add|commit|verify|fixbash]
 */
import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const ROOT = 'D:/get/stock-master';
const shell = 'cmd.exe';

/** cmd.exe 下跑命令 */
function run(cmd, args) {
  return spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
}

/** execFile 式同步 (避免注入) */
function xSync(cmd, args) {
  return execSync(`"${cmd}" ${args.map(a => '"' + a.replace(/"/g, '\\"') + '"').join(' ')}`, {
    cwd: ROOT, encoding: 'utf8', shell: 'cmd.exe'
  });
}

const cmds = {
  test() { run('node', ['test/test_all.js']); },

  build() { run('cmd.exe', ['/c', 'npm run build']); },

  git() { console.log(xSync('git', ['status', '--short'])); },

  fixbash() {
    // 用 cmd 设置 TMP/TEMP 为前斜杠路径, 再测 bash
    const out = execSync(
      'set TMP=C:/Users/laowu/AppData/Local/Temp && set TEMP=C:/Users/laowu/AppData/Local/Temp && bash --noprofile --norc -c "echo hello"',
      { encoding: 'utf8', shell: 'cmd.exe' }
    );
    console.log('bash 测试:', out.trim());
  },

  add() {
    const files = [
      'www/core/learning-pool.js',
      'www/app/short-trader.js',
      'www/app/long-trader.js',
      'www/app/intraday-trader.js',
      'www/app/screener.js',
      'www/app/fund/ai-advisor.js',
      'www/app.js',
      'www/core/premortem.js',
      'www/core/constants.js',
      'test/test_all.js',
      'vite.config.js',
      'www/index.html'
    ];
    for (const f of files) {
      if (existsSync(ROOT + '/' + f)) {
        xSync('git', ['add', f.replace(/\//g, '\\')]);
        console.log('  added:', f);
      }
    }
  },

  commit() {
    const msgFile = ROOT + '/__msg.txt';
    const msg = process.argv[3] || 'P0+P3: self-consistency/归因细化/Regime显式注入/市场宽度/学习池';
    writeFileSync(msgFile, msg, 'utf8');
    xSync('git', ['commit', '-F', msgFile]);
  },

  verify() {
    const files = [
      'www/core/learning-pool.js',
      'www/app/short-trader.js',
      'www/app/long-trader.js',
      'www/app/intraday-trader.js',
      'www/app/screener.js',
      'www/app/fund/ai-advisor.js'
    ];
    for (const f of files) {
      try {
        // 用 node --check 做语法验证 (安全, 不执行代码)
        execSync(`node --check "${ROOT}/${f}"`, { encoding: 'utf8', shell: 'cmd.exe' });
        console.log('  ✓ 语法通过:', f);
      } catch (e) {
        console.error('  ✗ 语法错误:', f, e.stderr || e.message);
      }
    }
  }
};

const key = process.argv[2] || 'verify';
if (cmds[key]) cmds[key]();
else console.log('用法: node run.mjs [test|build|git|add|commit|verify|fixbash]');
