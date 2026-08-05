import axios from 'axios';
console.log('=== probe 1: /open-apis/callback/ws/endpoint ===');
try {
  const r1 = await axios.post('https://open.feishu.cn/open-apis/callback/ws/endpoint', {
    AppID: 'cli_a938d49491399bd3',
    AppSecret: '2l06yYpWM8Et2yLd7eNdsh8nQnjUo2s0'
  }, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 10000, validateStatus: () => true });
  console.log('HTTP=' + r1.status);
  console.log('BODY=' + JSON.stringify(r1.data).slice(0, 500));
} catch (e) { console.log('ERROR1=' + e.message); }

console.log('\n=== probe 2: /callback/ws/endpoint (no /open-apis) ===');
try {
  const r2 = await axios.post('https://open.feishu.cn/callback/ws/endpoint', {
    AppID: 'cli_a938d49491399bd3',
    AppSecret: '2l06yYpWM8Et2yLd7eNdsh8nQnjUo2s0'
  }, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 10000, validateStatus: () => true });
  console.log('HTTP=' + r2.status);
  console.log('BODY=' + JSON.stringify(r2.data).slice(0, 800));
} catch (e) { console.log('ERROR2=' + e.message); }