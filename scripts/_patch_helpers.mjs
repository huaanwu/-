// 添加 Yellow helper + 把 checkmark 改对 (之前是 ? 因为 cp936 decode 漂移)
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'D:\\get\\stock-master\\scripts\\start-all.ps1';
let s = readFileSync(p, 'utf8');

const old = `function Green($s) { Write-Host "  ? $s" -ForegroundColor Green }
function Red($s)   { Write-Host "  ? $s" -ForegroundColor Red }
function Cyan($s)  { Write-Host "  ? $s" -ForegroundColor Cyan }`;

const nw = `function Green($s)  { Write-Host "  [OK] $s" -ForegroundColor Green }
function Red($s)    { Write-Host "  [X] $s" -ForegroundColor Red }
function Yellow($s) { Write-Host "  [!] $s" -ForegroundColor Yellow }
function Cyan($s)   { Write-Host "  [->] $s" -ForegroundColor Cyan }`;

if (!s.includes(old)) {
  console.log('FAIL: marker not found, current helpers region:');
  const idx = s.indexOf('function Green');
  console.log(s.slice(idx, idx + 250));
  process.exit(1);
}
s = s.replace(old, nw);
writeFileSync(p, s, 'utf8');
console.log('OK helpers updated, size', s.length);
