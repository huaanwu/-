// 跑 Python 单测 (北交所归一化 + 日期 normalize)
// 失败 exit 1, 整个 npm test 会挂
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

const tests = [
  'test_datasources_bjcode.py',  // 北交所 + 日期 normalize
];

let totalFailed = 0;
for (const t of tests) {
  console.log(`\n[datasources-py] ${t}`);
  const r = spawnSync(py, [path.join(__dirname, t)], { encoding: 'utf-8', stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[datasources-py] ${t} exit ${r.status}`);
    totalFailed += 1;
  }
}

if (totalFailed > 0) {
  console.error(`\n[datasources-py] ${totalFailed} 个 Python 测试失败`);
  process.exit(1);
}
console.log('\n[datasources-py] 全部通过');
