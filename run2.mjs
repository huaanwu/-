/**
 * StockMaster 魔改运行器 v2 — 直接用 node 调 cmd.exe, 完全不经过 bash
 * 用法: node run2.mjs [test|git|add|commit|verify|status]
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const ROOT = 'D:\\get\\stock-master';

function cmd(command) {
  try {
    const r = execSync(command, { cwd: ROOT, encoding: 'utf8', shell: 'cmd.exe' });
    return r;
  } catch (e) {
    console.error('[CMD错误]', e.message?.split('\n')[0]);
    return e.stdout || '';
  }
}

const cmds = {
  test() {
    // npm test = node test/test_all.js
    const r = execSync('node test\\test_all.js', { cwd: ROOT, encoding: 'utf8', shell: 'cmd.exe', maxBuffer: 10 * 1024 * 1024 });
    console.log(r);
  },

  status() {
    const r = execSync('git status', { cwd: ROOT, encoding: 'utf8', shell: 'cmd.exe' });
    console.log(r);
  },

  diff() {
    const r = execSync('git diff --stat', { cwd: ROOT, encoding: 'utf8', shell: 'cmd.exe' });
    console.log(r);
  },

  verify() {
    const files = [
      'www\\core\\learning-pool.js',
      'www\\app\\short-trader.js',
      'www\\app\\long-trader.js',
      'www\\app\\intraday-trader.js',
      'www\\app\\screener.js',
      'www\\app\\fund\\ai-advisor.js',
      'www\\app.js',
      'www\\core\\premortem.js',
      'www\\core\\constants.js',
      'test\\test_all.js',
    ];
    for (const f of files) {
      try {
        execSync(`node --check "${ROOT}\\${f}"`, { encoding: 'utf8', shell: 'cmd.exe' });
        console.log('  ✓', f);
      } catch (e) {
        console.error('  ✗', f, e.message?.split('\n')[0]);
      }
    }
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
      'www/index.html',
      'www/core/market-width.js',
    ];
    for (const f of files) {
      const fullPath = ROOT + '\\' + f.replace(/\//g, '\\');
      if (existsSync(fullPath)) {
        execSync(`git add "${fullPath}"`, { encoding: 'utf8', shell: 'cmd.exe' });
        console.log('  added:', f);
      }
    }
  },

  commit() {
    const msgFile = ROOT + '\\__msg.txt';
    const msg = process.argv[3] || 'P0+P3: self-consistency/归因细化/Regime显式注入/市场宽度/学习池';
    writeFileSync(msgFile, msg, 'utf8');
    execSync(`git commit -F "${msgFile}"`, { cwd: ROOT, encoding: 'utf8', shell: 'cmd.exe' });
  },
};

const key = process.argv[2] || 'status';
if (cmds[key]) cmds[key]();
else console.log('用法: node run2.mjs [test|status|diff|verify|add|commit]');
