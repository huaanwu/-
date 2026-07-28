// 验证 _judgeClosedTrade 在 bars=[] 时返回什么
const bars = [];
const exitDate = '2026-07-20';
const pnl = -0.5;
const gain = (parseFloat(pnl) || 0) > 0;
console.log('gain =', gain);

const barsHeld = exitDate && bars ? bars.filter(b => b.date && b.date <= exitDate).length : 0;
console.log('barsHeld =', barsHeld);

const cond = barsHeld < 3 && bars && bars.length;
console.log('cond (truthy?) =', cond, 'typeof', typeof cond);

if (cond) console.log('→ 择时错');
else console.log('→ 假设错误');