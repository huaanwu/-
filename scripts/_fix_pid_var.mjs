// $pid 是 PowerShell 只读内置变量, 改名为 $connPid
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'D:\\get\\stock-master\\scripts\\start-all.ps1';
let s = readFileSync(p, 'utf8');
const before = s;

s = s.replaceAll('$pid = $conn.OwningProcess', '$connPid = $conn.OwningProcess');
s = s.replaceAll('"ProcessId=$pid"', '"ProcessId=$connPid"');
s = s.replaceAll('PID $pid', 'PID $connPid');

if (s === before) {
  console.log('FAIL: no change applied');
  process.exit(1);
}
writeFileSync(p, s, 'utf8');
console.log('OK, file size', s.length);
