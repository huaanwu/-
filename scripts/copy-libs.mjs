#!/usr/bin/env node
/**
 * copy-libs: 把 node_modules 里的 UMD 库复制到 www/lib/
 *
 * 沿用 zhanbu/www/lib/build_libs.sh 的模式:
 *   - lunar-javascript + iztro 打成 IIFE bundle
 *   - 我们这里 echarts / dexie 直接用 UMD,复制即可
 *
 * 触发时机:
 *   - 升级 echarts / dexie 时手动跑
 *   - npm run build 自动跑(确保 dist 里包含最新 lib)
 *
 * 用法: node scripts/copy-libs.mjs
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WWW_LIB = path.join(ROOT, 'www', 'lib');

const LIBS = [
  {
    src: 'node_modules/echarts/dist/echarts.min.js',
    dst: 'www/lib/echarts.min.js',
    desc: 'ECharts UMD (~1MB,全图表)'
  },
  {
    src: 'node_modules/dexie/dist/dexie.min.js',
    dst: 'www/lib/dexie.min.js',
    desc: 'Dexie UMD (~96KB,IndexedDB 封装)'
  }
];

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  await fs.mkdir(WWW_LIB, { recursive: true });

  console.log('▶ copy-libs: 复制 UMD 库到 www/lib/');

  for (const lib of LIBS) {
    const src = path.join(ROOT, lib.src);
    const dst = path.join(ROOT, lib.dst);
    if (!(await exists(src))) {
      console.warn(`  ⚠ 源不存在: ${lib.src} (请先 npm install)`);
      continue;
    }
    await fs.copyFile(src, dst);
    const stat = await fs.stat(dst);
    console.log(`  [cp] ${lib.src} → ${lib.dst} (${(stat.size / 1024).toFixed(1)} KB)  ${lib.desc}`);
  }

  console.log('✅ copy-libs 完成');
  console.log('   提示: 升级 echarts / dexie 后,再跑一次本脚本即可');
}

main().catch(e => { console.error(e); process.exit(1); });
