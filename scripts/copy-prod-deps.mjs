#!/usr/bin/env node
/**
 * copy-prod-deps: 收集 dev-proxy 运行时需要的 npm 依赖, 复制到 prod-deps/node_modules/
 *
 * 背景 (v0.2.17 修):
 *   - NSIS 装时 electron-builder extraResources 只列了 'express' + 'http-proxy-middleware' 两个顶层包
 *   - 实际 dev-proxy 启动还需要 38 个传递依赖 (body-parser / qs / debug / http-proxy / is-glob / ...),
 *     缺一个就 'Cannot find module X' 整个 8089 死掉 → AI / akshare 全部 'Failed to fetch'
 *   - 这就是 v0.2.15 '修 AI 走 apiUrl' 一直没修好, 跟之前的版本一样坏 的真正原因
 *
 * 用法:
 *   1) npm run build:win 之前自动跑 (在 package.json prebuild:win)
 *   2) 或手动: node scripts/copy-prod-deps.mjs
 *
 * 行为:
 *   1) `npm ls --all --omit=dev` 拿到 express + http-proxy-middleware 的完整依赖树
 *   2) 解析出所有顶层包名 (去重)
 *   3) 每个包从 node_modules/<name> 复制到 prod-deps/node_modules/<name>
 *      (保留 node_modules/<name>/node_modules/<sub-dep> 嵌套结构, npm 解析器会向上找)
 *   4) 写 prod-deps/.deps-list (供 build 验证 + 调试)
 *
 * 副作用:
 *   - 创建 prod-deps/node_modules/ (~2 MB, 41 个包)
 *   - 不修改 package.json / source code
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_MODULES = join(ROOT, 'node_modules');
const OUT_BASE = join(ROOT, 'prod-deps');
const OUT_MODULES = join(OUT_BASE, 'node_modules');

// 必装的根包: dev-proxy 需 express + http-proxy-middleware; 主进程 WS 长连需 protobufjs (V13 飞书)
const ROOTS = ['express', 'http-proxy-middleware', 'protobufjs'];

function log(...a) { console.log('[copy-prod-deps]', ...a); }
function die(msg, code = 1) { console.error('[copy-prod-deps] ❌', msg); process.exit(code); }

function collectTransitiveDeps() {
  log('收集传递依赖 (npm ls --all, 含 devDependencies)...');
  let json;
  try {
    // 默认包含 devDependencies (express + http-proxy-middleware 在 devDependencies 里)
    const out = execSync('npm ls --all --json', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    json = JSON.parse(out);
  } catch (e) {
    // npm ls 在 missing peer deps 时 exit 1, 但 stdout 仍输出有效 JSON
    if (e.stdout) {
      try { json = JSON.parse(e.stdout); }
      catch { die('npm ls 输出解析失败: ' + (e.message || e)); }
    } else {
      die('npm ls 失败: ' + (e.message || e));
    }
  }
  const set = new Set();
  // 顶层依赖树从 json.dependencies 开始; 我们要 express + http-proxy-middleware 这两棵子树
  if (!json.dependencies) die('npm ls 输出无 dependencies 字段');
  for (const root of ROOTS) {
    if (!json.dependencies[root]) die(`npm ls 没找到根依赖: ${root} (package.json devDependencies 没列? 试试 npm install)`);
  }
  function walk(deps) {
    if (!deps) return;
    for (const name of Object.keys(deps)) {
      // 跳过无效条目 (npm 在 missing 时偶尔产出 { invalid: true })
      if (!deps[name] || typeof deps[name] !== 'object') continue;
      // 我们要的是真正的包名 (取第一个 / 段, 处理 @scope/pkg 形式)
      const topName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
      set.add(topName);
      walk(deps[name].dependencies);
    }
  }
  for (const root of ROOTS) walk(json.dependencies[root].dependencies);
  // 把两个根包自己也加上
  for (const r of ROOTS) set.add(r);
  return [...set].sort();
}

function copyPackage(pkgName) {
  const src = join(SRC_MODULES, pkgName);
  const dst = join(OUT_MODULES, pkgName);
  if (!existsSync(src)) {
    log('  ⚠️ 缺失源包, 跳过:', pkgName);
    return false;
  }
  // 用 cpSync 递归复制 (cpSync 自带覆盖, 比 cp -r shell 简单)
  cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: true });
  return true;
}

function main() {
  log('ROOT =', ROOT);
  log('源 node_modules =', SRC_MODULES);
  log('目标 =', OUT_MODULES);

  if (!existsSync(SRC_MODULES)) die('源 node_modules 不存在, 先跑 npm install');

  const deps = collectTransitiveDeps();
  log(`共 ${deps.length} 个顶层包需要复制:`);
  for (const d of deps) log('  -', d);

  // 清理旧 prod-deps
  if (existsSync(OUT_BASE)) {
    log('清理旧 prod-deps/ ...');
    rmSync(OUT_BASE, { recursive: true, force: true });
  }
  mkdirSync(OUT_MODULES, { recursive: true });

  let copied = 0, failed = 0;
  for (const pkg of deps) {
    if (copyPackage(pkg)) copied++;
    else failed++;
  }

  // 写 .deps-list 供调试
  writeFileSync(join(OUT_BASE, '.deps-list'), deps.join('\n') + '\n', 'utf8');

  // 统计大小
  function dirSize(p) {
    if (!existsSync(p)) return 0;
    let total = 0;
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const fp = join(d, f);
        const s = statSync(fp);
        if (s.isDirectory()) walk(fp);
        else total += s.size;
      }
    };
    walk(p);
    return total;
  }
  const sizeBytes = dirSize(OUT_MODULES);
  log(`✅ 完成: 复制 ${copied}/${deps.length} 个包${failed ? `, ${failed} 个缺失` : ''}, 总大小 ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  if (failed) {
    log('⚠️ 有包没复制, NSIS 装时 dev-proxy 仍会缺依赖; 请检查上面列表');
  }
  log('下一步: npm run build:win');
}

main();
