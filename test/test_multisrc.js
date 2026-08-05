// 多源竞速 + paramMap 单元测试
// 跑法: node test/test_multisrc.js   (基础单测, 不依赖外部服务)
//       MULTISRC_E2E=1 node test/test_multisrc.js  (再跑 e2e, 需 dev-proxy+datasources+baostock 全活)
//
// 设计: _multiSourceRoutes 表从 dev-proxy.mjs 抽到独立 JSON 加载, 避免抄代码失同步
// e2e 部分走 child_process 跑 _multisrc_e2e_runner.js, 绕开 Node 18 Windows 上
// fetch + AbortController 退出时偶发 UV_HANDLE_CLOSING fatal 的 bug
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEV_PROXY = path.join(ROOT, 'scripts', 'dev-proxy.mjs');
let _routesFromFile = null;

/** 从 dev-proxy.mjs 抽出 _multiSourceRoutes 闭包的真实定义
 *  用 sed 思路手抓, 不引入 AST 依赖
 *  注意: dev-proxy 是 ESM, 这里用 regex 抓 `function _multiSourceRoutes` 之后整段
 */
function _loadRoutesFromDevProxy() {
  if (_routesFromFile) return _routesFromFile;
  const src = fs.readFileSync(DEV_PROXY, 'utf-8');
  // 抓 function _multiSourceRoutes(action) { ... } 整段
  const m = src.match(/function _multiSourceRoutes\(action\)\s*\{[\s\S]*?\n\}/);
  if (!m) throw new Error('dev-proxy.mjs 没找到 _multiSourceRoutes 函数, 同步可能脱节');
  // 删 source 路径里的 source 字段映射, 只留表 + paramMap
  // 把函数体包装成可外部调用的形式
  // 简单做法: 把函数体 eval 起来, 拿 R 对象
  const body = m[0];
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${body}\nreturn _multiSourceRoutes;`);
  _routesFromFile = fn();
  return _routesFromFile;
}

// 模拟 _datasourceFetch 里 paramMap 应用逻辑
function applyParamMap(route, params) {
  const mapped = new URLSearchParams();
  for (const [k, v] of params) {
    const mapper = route.paramMap && route.paramMap[k];
    mapped.set(k, mapper ? mapper(v) : v);
  }
  return mapped;
}

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + (e.stack || e.message)); }
};

(async () => {
  console.log('multisrc 单元测试');

  const R = _loadRoutesFromDevProxy();

  // ===== 1. 路由表存在性 =====
  await t('routes.stock_daily 至少 2 个源 (baostock + 兜底)', () => {
    const r = R('stock_daily');
    assert.ok(r && r.length >= 2, 'stock_daily 路由不足 2 个源');
    assert.equal(r[0].source, 'baostock', 'stock_daily[0] 应是 baostock (免费+快)');
    assert.ok(r.find(x => x.source === 'tushare'), '应有 tushare 兜底');
  });

  await t('routes.stock_list 至少 2 个源', () => {
    const r = R('stock_list');
    assert.ok(r && r.length >= 2, 'stock_list 路由不足 2 个源');
    assert.equal(r[0].source, 'baostock', 'stock_list[0] 应是 baostock (全 5000+ 一次拉)');
  });

  await t('routes.stock_basic 至少 1 个源 (tushare 优先)', () => {
    const r = R('stock_basic');
    assert.ok(r && r.length >= 1, 'stock_basic 路由缺失');
  });

  await t('routes.stock_fina 存在 (Tushare 财务)', () => {
    const r = R('stock_fina');
    assert.ok(r && r.length >= 1, 'stock_fina 路由缺失');
  });

  await t('routes 未知 action 返 null', () => {
    const r = R('not_exist_xyz');
    assert.equal(r, null);
  });

  // ===== 2. paramMap 字段归一化 =====
  await t('baostock adj qfq→2', () => {
    const r = R('stock_daily');
    const out = applyParamMap(r[0], new URLSearchParams('code=000001&adj=qfq'));
    assert.equal(out.get('adj'), '2');
    assert.equal(out.get('code'), '000001');
  });

  await t('baostock adj hfq→1', () => {
    const r = R('stock_daily');
    const out = applyParamMap(r[0], new URLSearchParams('adj=hfq'));
    assert.equal(out.get('adj'), '1');
  });

  await t('baostock adj None→3 (不复权)', () => {
    const r = R('stock_daily');
    const out = applyParamMap(r[0], new URLSearchParams('adj=None'));
    assert.equal(out.get('adj'), '3');
  });

  await t('aktools adj 透传 qfq', () => {
    const r = R('stock_daily');
    const aktools = r.find(x => x.source === 'aktools');
    const out = applyParamMap(aktools, new URLSearchParams('adj=qfq'));
    assert.equal(out.get('adj'), 'qfq');
  });

  await t('tushare adj 透传 qfq', () => {
    const r = R('stock_daily');
    const tushare = r.find(x => x.source === 'tushare');
    const out = applyParamMap(tushare, new URLSearchParams('adj=qfq'));
    assert.equal(out.get('adj'), 'qfq');
  });

  // ===== 3. race 语义 =====
  await t('race: 第一个 data != null 胜出, ctl.abort() 后续', async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const ctl = new AbortController();
    const fakeFetch = async (source, delay, hasData) => {
      await sleep(delay);
      if (ctl.signal.aborted) throw new Error('aborted');
      return hasData ? { data: [source], latencyMs: delay } : { data: null, latencyMs: delay };
    };
    const sources = [
      { name: 'baostock', delay: 200, hasData: true },
      { name: 'aktools',  delay: 30,  hasData: true },
      { name: 'tushare',  delay: 100, hasData: true },
    ];
    const attempts = sources.map(s => fakeFetch(s.name, s.delay, s.hasData).then(
      r => ({ ok: true, ...r, source: s.name }),
      err => ({ ok: false, source: s.name, error: err.message })
    ));
    let winner = null;
    let aborted = 0;
    await Promise.all(attempts.map(a => a.then(r => {
      if (r.ok && r.data !== null && r.data !== undefined && !winner) {
        winner = r;
        ctl.abort();
      } else if (r.error === 'aborted') {
        aborted++;
      }
    })));
    assert.equal(winner.source, 'aktools');
    assert.ok(winner.latencyMs <= 50, 'aktools 应最快: ' + winner.latencyMs);
    // 至少一个其他源被 abort (baostock 200ms 还没到时已 abort)
    assert.ok(aborted >= 1, '应有其他源被 abort: aborted=' + aborted);
  });

  await t('race: null data 不算胜出, 等下一源', async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const ctl = new AbortController();
    const fakeFetch = async (source, delay, data) => {
      await sleep(delay);
      if (ctl.signal.aborted) throw new Error('aborted');
      return { data, latencyMs: delay };
    };
    const sources = [
      { name: 'baostock', delay: 10, data: null },
      { name: 'aktools',  delay: 50, data: [{ c: '000001' }] },
    ];
    const attempts = sources.map(s => fakeFetch(s.name, s.delay, s.data).then(
      r => ({ ok: true, ...r, source: s.name }),
      err => ({ ok: false, source: s.name, error: err.message })
    ));
    let winner = null;
    await Promise.all(attempts.map(a => a.then(r => {
      if (r.ok && r.data !== null && r.data !== undefined && !winner) {
        winner = r;
        ctl.abort();
      }
    })));
    assert.equal(winner.source, 'aktools');
  });

  await t('race: 全失败 → winner=null (不返空数据)', async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const ctl = new AbortController();
    const sources = [
      { name: 'baostock', delay: 10 },
      { name: 'aktools',  delay: 20 },
    ];
    const attempts = sources.map(s => sleep(s.delay).then(() => { throw new Error('boom'); }).then(
      r => ({ ok: true, ...r, source: s.name }),
      err => ({ ok: false, source: s.name, error: err.message })
    ));
    let winner = null;
    await Promise.all(attempts.map(a => a.then(r => {
      if (r.ok && r.data !== null && r.data !== undefined && !winner) {
        winner = r;
        ctl.abort();
      }
    })));
    assert.equal(winner, null);
  });

  // ===== 4. e2e (可选, 需 dev-proxy 在 :8089 跑 + datasources 在 :8091 跑 + baostock 真实工作) =====
  if (process.env.MULTISRC_E2E === '1') {
    // 走子进程跑 fetch 测试, 绕开 Node 18 Windows 上 AbortController + fetch
    // 退出时偶发的 UV_HANDLE_CLOSING fatal (子进程死了不影响主测试)
    await t('e2e: multi/stock_daily + multi/stock_list (子进程 _multisrc_e2e_runner.js)', () => {
      const r = spawnSync(process.execPath, [path.join(__dirname, '_multisrc_e2e_runner.js')], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      // 把子进程 stdout 透传出来, 失败时也好 debug
      process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      // e2e 子进程写 "N 通过 / M 失败" 到 stdout, 解析 N+M 跟 "ok" 数对比判断
      // 不用 status (Node 18 Windows 上 AbortController 退出时偶发 UV_HANDLE_CLOSING
      // fatal 把子进程 status 覆盖成非 0, 跟实际测试结果无关)
      const m = r.stdout.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
      if (!m) throw new Error('e2e 子进程没输出通过/失败统计, 看上面日志');
      const [, p, f] = m;
      if (parseInt(f, 10) > 0) throw new Error(`e2e 子进程内部 ${f} 个失败`);
      console.log(`  (e2e 子进程: ${p} 通过 / ${f} 失败)`);
    });
  } else {
    console.log('  --  跳过 e2e (设 MULTISRC_E2E=1 开启, 需 dev-proxy + datasources 跑着)');
  }

  console.log(`\n${passed} 通过 / ${failed} 失败`);
  // Node 18 Windows 上 process.exit 触发 UV_HANDLE_CLOSING fatal 覆盖 exit code
  // Node 24 没这个 bug, 直接 process.exit 即可
  process.exit(failed > 0 ? 1 : 0);
})();
