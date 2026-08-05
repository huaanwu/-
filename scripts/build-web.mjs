#!/usr/bin/env node
/**
 * build-web: 把 Vite 产物 (www/dist/) 合并回 www/ 根目录
 * 沿用 zhanbu/scripts/build-web.mjs 模式
 *
 * 流程:
 *   1) 拷贝 dist/index.html → www/index.html(把 hashed CSS 引用替换成 /styles.css)
 *   2) 合并 dist/assets/ → www/assets/
 *   3) 拷贝 dist/ 下其余 public 文件
 *   4) 清理 dist/
 *
 * 用法: node scripts/build-web.mjs
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const DIST = path.join(WWW, 'dist');
const DIST_SNAPSHOT = path.join(WWW, '.dist-snapshot');
const ASSETS = path.join(WWW, 'assets');

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function rimraf(p) {
  if (!(await exists(p))) return;
  await fs.rm(p, { recursive: true, force: true });
  console.log(`  [rm] ${path.relative(ROOT, p)}`);
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function main() {
  if (!(await exists(DIST))) {
    console.error('❌ www/dist/ 不存在,请先 npm run build:vite (或 npm run dev:vite 试一下)');
    process.exit(1);
  }

  console.log('▶ build-web: 把 Vite 产物合并回 www/');

  // 1) 拷贝 dist/index.html → www/index.html(覆盖,styles.css link 替换)
  //    FIX-1 后 index.html 引用 /styles.src.css (git 跟踪的源码 link).
  //    Vite build 时会把 link 转成 hashed path (/assets/style-<hash>.css);
  //    本脚本反过来把 hashed path 改回 /styles.src.css, 保持 git 跟踪版不变.
  //    www/styles.css 是兜底 (gitignore), 不再被此步骤覆盖 — 见下方步骤 2 的复制逻辑
  const distIndex = path.join(DIST, 'index.html');
  const wwwIndex = path.join(WWW, 'index.html');
  if (await exists(distIndex)) {
    let distContent = await fs.readFile(distIndex, 'utf-8');
    distContent = distContent.replace(
      /<link\s+rel="stylesheet"\s+crossorigin\s+href="(?:\/assets\/(?:index|style)-[A-Za-z0-9_-]+\.css|\/styles\.css)"\s*\/?>/g,
      '<link rel="stylesheet" crossorigin href="/styles.src.css">'
    );
    await fs.writeFile(wwwIndex, distContent);
    console.log('  [cp] dist/index.html → www/index.html (hashed stylesheet → /styles.src.css)');
  } else {
    console.warn('  ⚠ dist/index.html 缺失,跳过');
  }

  // 2) 合并 dist/assets/ → www/assets/ (JS/图片等 hashed 资源)
  //    CSS 路径由 index.html 决定: index.html link /styles.src.css (git 跟踪),
  //    dev 时 Vite 实时编译; build 时由本脚本把 www/styles.src.css 原样复制到
  //    www/styles.css 作为兜底 (APK 也走 /styles.css, Vite 优化版本由 dist 提供)。
  //    这样 git 始终跟踪 src 版, build 不污染 git 工作树。
  const distAssets = path.join(DIST, 'assets');
  if (await exists(distAssets)) {
    await rimraf(ASSETS);
    await copyDir(distAssets, ASSETS);
    console.log('  [cp] dist/assets/* → www/assets/');

    // 复制 src CSS 到 www/styles.css (gitignore, APK 加载路径)
    const srcCss = path.join(WWW, 'styles.src.css');
    if (await exists(srcCss)) {
      await fs.copyFile(srcCss, path.join(WWW, 'styles.css'));
      const { size: srcSize } = await fs.stat(path.join(WWW, 'styles.css'));
      console.log(`  [cp] www/styles.src.css → www/styles.css (${srcSize} bytes, 源码版 — 不用 Vite hashed)`);
    } else {
      console.warn('  ⚠ www/styles.src.css 不存在, www/styles.css 保留旧版本');
    }
  }

  // 3) 拷贝 dist/ 下其余 public 文件
  const distEntries = await fs.readdir(DIST, { withFileTypes: true });
  for (const e of distEntries) {
    if (e.name === 'index.html' || e.name === 'assets') continue;
    const src = path.join(DIST, e.name);
    const dst = path.join(WWW, e.name);
    if (e.isDirectory()) {
      await rimraf(dst);
      await copyDir(src, dst);
    } else {
      await fs.copyFile(src, dst);
    }
    console.log(`  [cp] dist/${e.name} → www/${e.name}`);
  }

  // 3.5) 拷贝 www/public/ 下的 PWA 资源到 www/ 根 (sw.js, manifest.webmanifest, icons/)
  //      vite dev mode 从 www/public/ 直接提供, 但 APK 加载需要 www/sw.js
  const publicDir = path.join(WWW, 'public');
  if (await exists(publicDir)) {
    const publicEntries = await fs.readdir(publicDir, { withFileTypes: true });
    for (const e of publicEntries) {
      const src = path.join(publicDir, e.name);
      const dst = path.join(WWW, e.name);
      if (e.isDirectory()) {
        await rimraf(dst);
        await copyDir(src, dst);
        console.log(`  [cp] www/public/${e.name}/ → www/${e.name}/`);
      } else {
        await fs.copyFile(src, dst);
        console.log(`  [cp] www/public/${e.name} → www/${e.name}`);
      }
    }
  }

  // 3.6) Service Worker 缓存版本戳: 每次 build 重写 www/sw.js 的 CACHE_NAME
  //      (cache-first 策略下, CACHE_NAME 不变 → 旧 SW 永远供旧资源, APK/浏览器"打到旧版")
  //      源文件 www/public/sw.js 保持占位, 不污染 git
  const swOut = path.join(WWW, 'sw.js');
  if (await exists(swOut)) {
    let sw = await fs.readFile(swOut, 'utf-8');
    const stamp = `stockmaster-${Date.now()}`;
    sw = sw.replace(/const CACHE_NAME = '[^']*';/, `const CACHE_NAME = '${stamp}';`);
    await fs.writeFile(swOut, sw);
    console.log(`  [sw] CACHE_NAME → ${stamp} (旧缓存随新 SW activate 自动清理)`);
  }

  // 3.9) 保留 dist 临时副本到 .dist-snapshot/ (gitignored) 便于手工核验
  //      Git 不跟踪 .dist-snapshot/, 这里直接覆盖上次
  console.log('  [cp] dist/ → .dist-snapshot/ (临时副本)');
  await rimraf(DIST_SNAPSHOT);
  await copyDir(DIST, DIST_SNAPSHOT);

  // 4) 清理 dist/
  await rimraf(DIST);

  // 5) 注入版本号到 www/app.js (v + git desc + 日期)
  //    防止 package.json 改了 app.js 没改导致脱节
  //    git 不跟踪这个改动 (app.js 本来就是 gitignored 之外的产物, 不对, app.js 是 git 跟踪)
  //    → 我们不在这里直接改 git 跟踪的 app.js, 而是写一份 .app-version-info.json 给 APK 读取
  //    app.js 顶部的 APP_VERSION/APP_BUILD_DATE 仍由开发者手动维护, 构建时打印出来对比
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf-8'));
    const buildDate = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    const versionInfo = {
      version: pkg.version || '0.0.0',
      buildDate,
      gitCommit: await _tryGitShortHash(),
      builtAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(WWW, 'version.json'),
      JSON.stringify(versionInfo, null, 2),
      'utf-8'
    );
    console.log(`  [ver] version.json: ${versionInfo.version} · ${buildDate}${versionInfo.gitCommit ? ' · ' + versionInfo.gitCommit : ''}`);

    // 对照 app.js 顶部的 APP_VERSION/APP_BUILD_DATE, 不一致则 warn
    const appJs = await fs.readFile(path.join(WWW, 'app.js'), 'utf-8');
    const vMatch = appJs.match(/var APP_VERSION\s*=\s*'([^']+)'/);
    const dMatch = appJs.match(/var APP_BUILD_DATE\s*=\s*'([^']+)'/);
    const appVer = vMatch ? vMatch[1] : '(missing)';
    const appDate = dMatch ? dMatch[1] : '(missing)';
    const pkgV = 'v' + versionInfo.version;
    if (appVer !== pkgV) {
      console.warn(`  ⚠ app.js APP_VERSION = '${appVer}' vs package.json version '${pkgV}' — 不同步, 设置页会显示旧版本`);
    }
    if (appDate !== buildDate) {
      console.warn(`  ⚠ app.js APP_BUILD_DATE = '${appDate}' vs today '${buildDate}' — 构建日期不一致`);
    }
    if (appVer === pkgV && appDate === buildDate) {
      console.log(`  [ver] app.js APP_VERSION/APP_BUILD_DATE 与 package.json 同步 ✓`);
    }
  } catch (e) {
    console.warn('  ⚠ 版本注入失败:', e.message);
  }

  console.log('✅ build-web 完成, www/ 现在包含 Vite 处理后的产物');
  console.log('   下一步: npx cap sync android');
}

async function _tryGitShortHash() {
  try {
    const { execFileSync } = await import('child_process');
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch { return null; }
}

main().catch(e => { console.error(e); process.exit(1); });
