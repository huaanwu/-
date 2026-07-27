/**
 * Fund.Seed - 一键导入推荐组合
 * 2026-07-26 基于 akshare 数据硬筛的 2 只短债/纯债
 * 仅写入代码+名称+type, 实际份额/成本由用户买入后编辑
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  window.Fund.seedRecommended = async function() {
    const RECOMMENDED = [
      { code: '007194', name: '长城短债 A', type: 'short_bond', note: '流动性后备 / 98亿 / 3年10.54% / 回撤-1.22%' },
      { code: '018581', name: '中银纯债 D', type: 'pure_bond', note: '收益主力 / 106亿 / 3年13.04% / 回撤-1.95%' }
    ];
    let added = 0, skipped = 0;
    for (const f of RECOMMENDED) {
      const exists = await Core.Storage.get('funds', f.code);
      if (exists) { skipped++; continue; }
      await Core.Storage.add('funds', {
        code: f.code, name: f.name, type: f.type, note: f.note,
        shares: 0, costNav: 0, addedAt: Date.now()
      });
      added++;
    }
    toastSuccess(`已导入 ${added} 只, 跳过 ${skipped} 只已存在`);
    this.render();
  };
})();