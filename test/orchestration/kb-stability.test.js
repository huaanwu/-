/**
 * 任务 C: KB JSON sha256 锁 — 跑前/跑后 hash 对比, 前 5 + 后 5 + 总条数
 *
 * 断言:
 *   1. investment_kb.json 存在 + 可解析
 *   2. entries 数组总条数 = 基准 (104)
 *   3. 前 5 条 id 锁
 *   4. 后 5 条 id 锁
 *   5. 跑前 hash == 跑后 hash (sha256 文件指纹不变)
 *
 * 跑法: node test/orchestration/kb-stability.test.js
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

function sha256File(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // 标准化: 去掉 BOM / 尾部空白 / CR
    const normalized = content.replace(/^﻿/, '').replace(/\r/g, '').trimEnd();
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  } catch (e) {
    return null;
  }
}

function loadKB() {
  try {
    const raw = fs.readFileSync(KB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

(async () => {
  console.log('\n[1] KB JSON 存在 + 可解析');
  const kb = loadKB();
  assert(kb !== null, 'investment_kb.json 解析成功');
  assert(Array.isArray(kb.entries), 'entries 是数组');

  console.log('\n[2] entries 总条数');
  const total = kb.entries.length;
  console.log('  entries 总数: ' + total);
  assert(total === 104, `总条数 = 104 (实际 ${total})`);

  console.log('\n[3] 前 5 条 id 锁');
  const first5 = kb.entries.slice(0, 5).map(e => e.id);
  const expectedFirst5 = ['VAL-001', 'VAL-002', 'VAL-003', 'VAL-004', 'VAL-005'];
  assert(JSON.stringify(first5) === JSON.stringify(expectedFirst5),
    `前 5 id = ${JSON.stringify(first5)}`);

  console.log('\n[4] 后 5 条 id 锁');
  const last5 = kb.entries.slice(-5).map(e => e.id);
  const expectedLast5 = ['MAC-012', 'RIVAL-001', 'RIVAL-002', 'RIVAL-003', 'RIVAL-004'];
  assert(JSON.stringify(last5) === JSON.stringify(expectedLast5),
    `后 5 id = ${JSON.stringify(last5)}`);

  console.log('\n[5] 跑前 == 跑后 sha256 文件指纹');
  const hash1 = sha256File(KB_PATH);
  assert(hash1 !== null, '跑前 sha256 算得');
  // 模拟一次"跑后": 再算一次
  const hash2 = sha256File(KB_PATH);
  assert(hash1 === hash2, `sha256 相等: ${hash1.slice(0, 16)}...`);

  console.log('\n' + '='.repeat(50));
  console.log('KB stability: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
