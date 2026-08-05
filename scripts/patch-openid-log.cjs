#!/usr/bin/env node
const fs = require('fs');
let code = fs.readFileSync('D:/get/stock-master/electron/main.js', 'utf8');
// 在 590 行后插入 openId 日志行
const marker = '      const allowList = (c.allowedOpenIds || []).filter(Boolean);\n';
const logLine = '      process.stdout.write(\'[feishu] 来消息 openId=\' + msg.openId + \' text=\' + JSON.stringify(msg.text) + \' allowList=\' + JSON.stringify(allowList) + \'\\n\');\n';
if (code.includes(logLine)) { console.log('already patched'); process.exit(0); }
code = code.replace(marker, marker + logLine);
fs.writeFileSync('D:/get/stock-master/electron/main.js', code);
console.log('patched');
