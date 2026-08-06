#!/usr/bin/env node
// 扫描项目内 .js/.mjs/.py, 删掉注释里的 ` ` 版本戳
//   安全: 只动行注释 / 块注释里的 ?v=, 不动 URL/import 字符串里的 (那些是 cache-bust, 功能)
//
//   模式:
//     `// text...` → `// text...`   (开头)
//     `// text ( )` → `// text`     (末尾)
//     `# text...` → `# text...` (Python)
//     ` * ?v=...` → ` *` (块注释)
//
// 跳过: URL 里 `?v=...` (前后是 `"/"`)  整行只有 `?v=...` 是 URL 的话不动
// 跳过: 字符串里的 `?v=...&` 或 `?v=...'` 这种 (cache-bust 参数)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'www/dist', 'www/lib', 'www/assets', 'android', 'e2e_screenshots', '__pycache__']);
const TARGET_EXTS = new Set(['.js', '.mjs', '.py']);

// 匹配 `?v=...` 后面跟版本戳 (字母数字下划线短横线) 然后是 : 或空格或行尾
// 排除: 前后是 `="` `?'` 之类的 (那是字符串里的 cache-bust)
const COMMENT_PATTERNS = [
  // JS 行注释: // ... [: ]... 或 开头是 // ?v=xxx
  { rx: /^(\s*)(\/\/[^\n]*?)(\s*\?v=[a-zA-Z0-9_-]+)([ \t]*(?:P\d+(?:-\d+)?[ \t]*)?:?[ \t]*)([^\n]*)$/m, keep: '$1$2 $5' },
  // JS 行注释: 末尾 (?v=xxx)  (括号里的)
  { rx: /(\/\/[^\n]*?)\s*\(\?v=[a-zA-Z0-9_-]+\)\s*$/m, keep: '$1' },
  // Python 行注释: # ...?v=xxx... (开头或中间)
  { rx: /^(\s*)(#[^\n]*?)(\s*\?v=[a-zA-Z0-9_-]+)([ \t]*(?:P\d+(?:-\d+)?[ \t]*)?:?[ \t]*)([^\n]*)$/m, keep: '$1$2 $5' },
  // Python 行注释: 末尾
  { rx: /(#[^\n]*?)\s*\(\?v=[a-zA-Z0-9_-]+\)\s*$/m, keep: '$1' },
  // 块注释中间: * text ?v=xxx text  (保留 * 前缀)
  { rx: /^(\s*\*\s*)([^\n]*?)(\s*\?v=[a-zA-Z0-9_-]+)([ \t]*(?:P\d+(?:-\d+)?[ \t]*)?:?[ \t]*)([^\n]*)$/m, keep: '$1$2 $5' },
];

function shouldSkip(dir) {
  return SKIP_DIRS.has(dir);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (shouldSkip(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (TARGET_EXTS.has(extname(p))) yield p;
  }
}

let totalFiles = 0;
let totalFilesChanged = 0;
let totalReplacements = 0;
const fileReports = [];

for (const file of walk(ROOT)) {
  totalFiles++;
  const orig = readFileSync(file, 'utf-8');
  let cur = orig;
  let fileCount = 0;
  // 每种 pattern 跑 5 轮 (防止一行 3+ 个 ?v= 漏), 改到稳定为止
  for (let pass = 0; pass < 5; pass++) {
    let passChanged = false;
    for (const { rx, keep } of COMMENT_PATTERNS) {
      const before = cur;
      cur = cur.replace(rx, keep);
      const matches = before.match(new RegExp(rx.source, 'gm'));
      if (matches) {
        fileCount += matches.length;
        passChanged = true;
      }
    }
    if (!passChanged) break;
  }
  if (cur !== orig) {
    writeFileSync(file, cur, 'utf-8');
    totalFilesChanged++;
    totalReplacements += fileCount;
    fileReports.push({ file: file.replace(ROOT + '\\', ''), count: fileCount });
  }
}

console.log(`[scrub] 扫了 ${totalFiles} 个文件`);
console.log(`[scrub] 改了 ${totalFilesChanged} 个文件, 共 ${totalReplacements} 处替换`);
if (fileReports.length) {
  console.log('\n[scrub] Top 改动:');
  fileReports.sort((a, b) => b.count - a.count).slice(0, 15).forEach(r => {
    console.log(`  ${String(r.count).padStart(3)} ${r.file}`);
  });
}
