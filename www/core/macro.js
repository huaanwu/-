/**
 * Core.Macro - 宏观环境数据
 * 通过 dev-proxy 调 AKShare, 24h 缓存到 IndexedDB
 *
 * 输出: {
 *   generated: ISO 时间,
 *   sources: ['akshare'],
 *   data: {
 *     lpr_1y, lpr_5y, lpr_date,
 *     repo_fr007, repo_date,        // 银行间 7 天回购
 *     shibor_on, shibor_1y, shibor_date,
 *     cpi_yoy, cpi_date,
 *     pmi, pmi_date,
 *     m2_yoy, m2_date,
 *     ip_yoy, ip_date,
 *     electricity_yoy, elec_date
 *   },
 *   notes: { [key]: '更新/失败原因' }
 * }
 */
(function() {
  'use strict';

  const TTL_24H = 24 * 60 * 60 * 1000;
  const CACHE_KEY = 'macro_snapshot_v1';

  /**
   * 拉一项宏观数据, 失败返回 null
   * fn: () => Promise<{value, date}>
   */
  async function _safeFetch(name, fn) {
    try {
      const r = await fn();
      if (r && r.value !== null && r.value !== undefined) return r;
      return null;
    } catch (e) {
      console.warn(`[Macro] ${name} 失败:`, e.message || e);
      return null;
    }
  }

  async function _getMacro() {
    const cacheKey = `${CACHE_KEY}_${Core.State.get('proxyBase')}`;
    // 读缓存
    const cached = await Core.Storage.cacheGet(cacheKey);
    if (cached) return cached;

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // 各项数据并发拉 (用 Core.Data.fetch 自带缓存, 但我们靠外层 macro cache 控制)
    const tasks = [
      _safeFetch('LPR', async () => {
        const data = await Core.Data.fetch('macro_lpr', 'macro_china_lpr', {}, 24*60*60*1000);
        if (!data || data.length === 0) return null;
        const last = data[data.length - 1];
        return {
          value: { lpr_1y: parseFloat(last.LPR1Y), lpr_5y: parseFloat(last.LPR5Y) },
          date: String(last.TRADE_DATE)
        };
      }),
      _safeFetch('回购利率 (7d)', async () => {
        const data = await Core.Data.fetch('macro_repo', 'repo_rate_hist', { start_date: '20260101', end_date: today }, 24*60*60*1000);
        if (!data || data.length === 0) return null;
        const last = data[data.length - 1];
        return {
          value: { fr007: parseFloat(last.FR007), fdr007: parseFloat(last.FDR007) },
          date: String(last.date).slice(0, 10)
        };
      }),
      _safeFetch('Shibor', async () => {
        const data = await Core.Data.fetch('macro_shibor', 'macro_china_shibor_all', {}, 24*60*60*1000);
        if (!data || data.length === 0) return null;
        const last = data[data.length - 1];
        return {
          value: { on: parseFloat(last['O/N-定价']), '1y': parseFloat(last['1Y-定价']) },
          date: String(last.日期).slice(0, 10)
        };
      }),
      _safeFetch('CPI 同比', async () => {
        const data = await Core.Data.fetch('macro_cpi', 'macro_china_cpi_yearly', {}, 24*60*60*1000);
        if (!data || data.length === 0) return null;
        const last = data[data.length - 1];
        if (isNaN(parseFloat(last.今值))) return null;
        return { value: { yoy: parseFloat(last.今值) }, date: String(last.日期).slice(0, 10) };
      }),
      _safeFetch('制造业 PMI', async () => {
        const data = await Core.Data.fetch('macro_pmi', 'macro_china_pmi_yearly', {}, 24*60*60*1000);
        if (!data || data.length === 0) return null;
        const last = data[data.length - 1];
        if (isNaN(parseFloat(last.今值))) return null;
        return { value: parseFloat(last.今值), date: String(last.日期).slice(0, 10) };
      }),
      _safeFetch('M2 同比', async () => {
        const data = await Core.Data.fetch('macro_m2', 'macro_china_m2_yearly', {}, 24*60*60*1000);
        if (!data || data.length === 0) return null;
        const last = data[data.length - 1];
        if (isNaN(parseFloat(last.今值))) return null;
        return { value: { yoy: parseFloat(last.今值) }, date: String(last.日期).slice(0, 10) };
      }),
      _safeFetch('工业增加值', async () => {
        const data = await Core.Data.fetch('macro_ip', 'macro_china_industrial_production_yoy', {}, 24*60*60*1000);
        if (!data || data.length === 0) return null;
        const last = data[data.length - 1];
        if (isNaN(parseFloat(last.今值))) return null;
        return { value: { yoy: parseFloat(last.今值) }, date: String(last.日期).slice(0, 10) };
      }),
      _safeFetch('全社会用电量', async () => {
        const data = await Core.Data.fetch('macro_elec', 'macro_china_society_electricity', {}, 24*60*60*1000);
        if (!data || data.length === 0) return null;
        const last = data[data.length - 1];
        const v = parseFloat(last['全社会用电量同比']);
        if (isNaN(v)) return null;
        return { value: { yoy: v }, date: String(last.统计时间).slice(0, 7) };
      })
    ];

    const results = await Promise.all(tasks);

    const snap = {
      generated: new Date().toISOString(),
      sources: ['akshare'],
      data: {},
      notes: {}
    };
    const names = ['lpr', 'repo', 'shibor', 'cpi', 'pmi', 'm2', 'ip', 'electricity'];
    results.forEach((r, i) => {
      const n = names[i];
      if (r) {
        if (typeof r.value === 'object') {
          Object.assign(snap.data, r.value);
        } else {
          snap.data[n] = r.value;
        }
        snap.data[n + '_date'] = r.date;
      } else {
        snap.notes[n] = '拉取失败 (可能接口已停)';
      }
    });

    await Core.Storage.cacheSet(cacheKey, snap, TTL_24H);
    return snap;
  }

  /**
   * 格式化宏观快照为 prompt 友好的中文文本
   */
  function formatForPrompt(snap) {
    const d = snap.data;
    const lines = [];
    lines.push('## 宏观环境快照 (生成于 ' + snap.generated.slice(0, 16).replace('T', ' ') + ')');
    if (d.lpr_1y !== undefined) {
      lines.push(`- **LPR**: 1Y = ${d.lpr_1y}%, 5Y = ${d.lpr_5y}% (更新于 ${d.lpr_date})`);
    }
    if (d.fdr007 !== undefined) {
      lines.push(`- **银行间 7 天回购 (FDR007)**: ${d.fdr007}% (更新于 ${d.repo_date}, 越低说明资金面越宽松)`);
    }
    if (d.on !== undefined) {
      lines.push(`- **Shibor**: 隔夜 = ${d.on}%, 1Y = ${d['1y']}% (更新于 ${d.shibor_date})`);
    }
    if (d.cpi !== undefined) {
      lines.push(`- **CPI 同比**: ${d.cpi}% (更新于 ${d.cpi_date}, < 1% 警惕通缩, > 3% 警惕通胀)`);
    }
    if (d.pmi !== undefined) {
      const state = d.pmi > 50 ? '扩张' : (d.pmi < 50 ? '收缩' : '持平');
      lines.push(`- **制造业 PMI**: ${d.pmi} (${state}, 更新于 ${d.pmi_date}, 50 是荣枯线)`);
    }
    if (d.m2 !== undefined) {
      lines.push(`- **M2 同比**: ${d.m2}% (更新于 ${d.m2_date}, > 10% 偏宽松, < 8% 偏紧)`);
    }
    if (d.ip !== undefined) {
      lines.push(`- **规模以上工业增加值**: ${d.ip}% YoY (更新于 ${d.ip_date})`);
    }
    if (d.electricity !== undefined) {
      lines.push(`- **全社会用电量**: ${d.electricity}% YoY (更新于 ${d.elec_date})`);
    }
    if (Object.keys(snap.notes).length > 0) {
      lines.push('');
      lines.push('**注意**: ' + Object.entries(snap.notes).map(([k, v]) => `${k}: ${v}`).join('; '));
    }
    return lines.join('\n');
  }

  /**
   * 清除缓存 (供"刷新"按钮)
   */
  async function refresh() {
    const cacheKey = `${CACHE_KEY}_${Core.State.get('proxyBase')}`;
    await Core.Storage.cacheSet(cacheKey, null, 1);  // 立即过期
  }

  window.Core = window.Core || {};
  window.Core.Macro = {
    get: _getMacro,
    formatForPrompt,
    refresh
  };
})();
