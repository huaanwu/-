"""深度调研 v3: 扩展候选池 (Top100/类) + 宽松硬筛, 输出分级候选列表
- 一级 (Tier-1): 严格硬筛通过 (规模 + 回撤 + 夏普) - 主推
- 二级 (Tier-2): 宽松筛选 (规模 + 单项) - 备胎
- 三级 (Tier-3): 仅按收益排名 - 激进/参考

输出: fund_research_v3.json + fund_candidates_tiered.txt
"""
import akshare as ak
import json
import time
import math
import re
import pandas as pd

OUT_JSON = r'D:\get\stock-master\fund_research_v3.json'
OUT_REPORT = r'D:\get\stock-master\fund_candidates_tiered.txt'

def num(v):
    try: return float(str(v).replace('%',''))
    except: return None

# 1. 读排行
with open(r'D:\get\stock-master\fund_all.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

parsed = [f for f in data if num(f.get('近1年')) is not None and num(f.get('近3年')) is not None]
parsed.sort(key=lambda x: num(x.get('近3年')), reverse=True)
print('Total:', len(parsed))

# 2. 分类 (复用 v2 的逻辑 + 扩了一些常见指数)
def category(name):
    if not name: return None
    if '短债' in name or '中短债' in name: return 'short_bond'
    if '纯债' in name: return 'pure_bond'
    if '偏债' in name or '二级债' in name or '增强' in name: return 'mixed_bond'
    if '沪深300' in name and '增强' in name: return 'csi300_enh'
    if '沪深300' in name: return 'csi300'
    if '中证500' in name and '增强' in name: return 'csi500_enh'
    if '中证500' in name: return 'csi500'
    if '上证50' in name: return '上证50'
    if '红利低波' in name or '红利低波动' in name: return '红利低波'
    if '红利' in name: return '红利'
    if 'A50' in name: return 'A50'
    if '科创' in name or '科创板' in name: return '科创'
    if '创业板' in name: return '创业板'
    return None

# 3. 各类收益范围 (粗筛: 不要亏损也不要异常暴利)
short = [f for f in parsed if category(f.get('基金简称','')) == 'short_bond'
         and 0.5 <= num(f.get('近1年')) <= 6 and 2 <= num(f.get('近3年')) <= 18]
pure = [f for f in parsed if category(f.get('基金简称','')) == 'pure_bond'
        and 1 <= num(f.get('近1年')) <= 10 and 4 <= num(f.get('近3年')) <= 25]
wide_keys = ['csi300', 'csi500', '上证50', '红利低波', '红利', 'A50', '科创', '创业板']
wide = [f for f in parsed if category(f.get('基金简称','')) in wide_keys]

print(f'粗筛: 短债 {len(short)} 只, 纯债 {len(pure)} 只, 宽基 {len(wide)} 只')

# 扩到 Top 100 (v2 只有 30)
short_top = sorted(short, key=lambda x: num(x.get('近3年')), reverse=True)[:100]
pure_top = sorted(pure, key=lambda x: num(x.get('近3年')), reverse=True)[:100]
wide_top = sorted(wide, key=lambda x: num(x.get('近3年')), reverse=True)[:100]

candidates = [('short_bond', short_top), ('pure_bond', pure_top), ('wide', wide_top)]
total = sum(len(c[1]) for c in candidates)
print(f'共 {total} 只待调研 (短 {len(short_top)} + 纯 {len(pure_top)} + 宽 {len(wide_top)})')

# 4. 拉详情
def calc_metrics(nav_df):
    if nav_df is None or nav_df.empty: return None
    df = nav_df.copy()
    df['净值日期'] = df['净值日期'].astype(str)
    df = df.sort_values('净值日期').reset_index(drop=True)
    navs = df['单位净值'].astype(float).values
    n = len(navs)
    if n < 60: return None

    peak = navs[0]; max_dd = 0
    for v in navs:
        if v > peak: peak = v
        dd = (v - peak) / peak
        if dd < max_dd: max_dd = dd

    dr = pd.Series(navs).pct_change().dropna()
    if n > 250:
        annual = (math.pow(navs[-1] / navs[0], 250 / n) - 1) * 100
    else:
        annual = num(df.iloc[-1].get('日增长率', 0)) or 0
    vol = float(dr.std()) * math.sqrt(250) * 100 if len(dr) > 30 else 0
    sharpe = (annual - 2) / vol if vol > 0 else 0

    return {
        'days': n, 'annual': round(annual, 2), 'max_dd': round(max_dd * 100, 2),
        'vol': round(vol, 2), 'sharpe': round(sharpe, 2)
    }

results = {'short_bond': [], 'pure_bond': [], 'wide': []}
start = time.time()
total_done = 0
for cat, lst in candidates:
    print(f'\n=== {cat} ({len(lst)} 只) ===')
    for i, f in enumerate(lst):
        code = str(f.get('基金代码',''))
        name = f.get('基金简称','')
        total_done += 1
        elapsed = int(time.time() - start)
        print(f'  [{total_done}/{total}] {code} {name[:22]:<22}  ({elapsed}s)', end='  ', flush=True)

        rec = {
            'code': code, 'name': name,
            'n1': num(f.get('近1年')), 'n3': num(f.get('近3年')),
            'ytd': num(f.get('今年来'))
        }

        # overview
        try:
            ov = ak.fund_overview_em(code)
            if not ov.empty:
                row = ov.iloc[0].to_dict()
                rec['type'] = row.get('基金类型', '')
                rec['manager'] = row.get('基金经理人', '')
                rec['founded'] = row.get('成立日期/规模', '')
                scale_str = str(row.get('净资产规模', ''))
                m = re.search(r'([\d.]+)\s*亿', scale_str)
                if m: rec['scale'] = float(m.group(1))
        except: pass

        # 净值
        try:
            nav = ak.fund_open_fund_info_em(symbol=code, indicator='单位净值走势')
            m = calc_metrics(nav)
            if m: rec.update(m)
        except: pass

        print('规模:{}  回撤:{}%  夏普:{}'.format(
            rec.get('scale', '?'),
            rec.get('max_dd', '?'),
            rec.get('sharpe', '?')
        ))

        results[cat].append(rec)
        time.sleep(0.25)  # 略快一点, 100只太慢了

# 保存
with open(OUT_JSON, 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2, default=str)

print(f'\n调研完成,共耗时 {int(time.time() - start)} 秒, 数据已保存到 {OUT_JSON}')

# 5. 分级
# Tier-1 严格 (主推): 规模 + 回撤 + 夏普 全过
# Tier-2 宽松 (备胎): 规模 + (回撤 或 夏普) 过
# Tier-3 仅收益: 不卡风险指标, 仅收益排名靠前
tier_filters = {
    'short_bond': {
        'tier1': {'min_scale': 30, 'max_dd': 5, 'min_sharpe': 0.3},
        'tier2': {'min_scale': 10, 'max_dd': 8, 'min_sharpe': 0.0},
        'cat_name': '🅰️ 短债'
    },
    'pure_bond': {
        'tier1': {'min_scale': 30, 'max_dd': 8, 'min_sharpe': 0.3},
        'tier2': {'min_scale': 10, 'max_dd': 12, 'min_sharpe': 0.0},
        'cat_name': '🅱️ 纯债'
    },
    'wide': {
        'tier1': {'min_scale': 30, 'max_dd': 35, 'min_sharpe': 0.3},
        'tier2': {'min_scale': 15, 'max_dd': 45, 'min_sharpe': 0.0},
        'cat_name': '🅳 宽基'
    }
}

def passes(rec, f, require_all=True):
    """require_all=True: Tier-1 (全过); False: Tier-2 (规模过 + 至少一项)"""
    if rec.get('scale', 0) < f['min_scale']: return False
    if require_all:
        if abs(rec.get('max_dd', 100)) > f['max_dd']: return False
        if rec.get('sharpe', 0) < f['min_sharpe']: return False
        return True
    else:
        dd_ok = abs(rec.get('max_dd', 100)) <= f['max_dd']
        sh_ok = rec.get('sharpe', 0) >= f['min_sharpe']
        return dd_ok or sh_ok

report = []
report.append('=' * 80)
report.append('  StockMaster 基金候选池 (v3 - 分级版)')
report.append('  数据来源: akshare, 调研时间: ' + time.strftime('%Y-%m-%d %H:%M'))
report.append('  分级标准:')
report.append('    Tier-1 (主推): 规模 + 回撤 + 夏普 全过硬指标')
report.append('    Tier-2 (备胎): 规模 + (回撤或夏普) 之一过')
report.append('    Tier-3 (参考): 仅收益排名, 风险指标不卡')
report.append('=' * 80)

tiered = {'short_bond': {'tier1': [], 'tier2': [], 'tier3': []},
          'pure_bond': {'tier1': [], 'tier2': [], 'tier3': []},
          'wide': {'tier1': [], 'tier2': [], 'tier3': []}}

for cat, lst in results.items():
    f = tier_filters[cat]
    f1 = f['tier1']
    f2 = f['tier2']
    for r in lst:
        if passes(r, f1, require_all=True):
            tiered[cat]['tier1'].append(r)
        elif passes(r, f2, require_all=False):
            tiered[cat]['tier2'].append(r)
        else:
            # 仅收益: 3年>5% 且 1年>0 (短债) / 3年>8% 且 1年>0 (纯债) / 3年>0 (宽基)
            n3 = r.get('n3') or 0
            n1 = r.get('n1') or 0
            if cat == 'short_bond' and n3 >= 5 and n1 >= 0:
                tiered[cat]['tier3'].append(r)
            elif cat == 'pure_bond' and n3 >= 8 and n1 >= 0:
                tiered[cat]['tier3'].append(r)
            elif cat == 'wide' and n3 >= 0:
                tiered[cat]['tier3'].append(r)

    # 排序
    for t in ['tier1', 'tier2']:
        tiered[cat][t].sort(key=lambda x: x.get('sharpe', 0) or 0, reverse=True)
    tiered[cat]['tier3'].sort(key=lambda x: x.get('n3', 0) or 0, reverse=True)

    report.append(f'\n{f["cat_name"]}  (Tier-1 严格筛: 规模≥{f1["min_scale"]}亿, 回撤≤{f1["max_dd"]}%, 夏普≥{f1["min_sharpe"]})')
    report.append('-' * 80)

    for tier_name, tier_emoji in [('tier1', '⭐ T1'), ('tier2', '✓ T2'), ('tier3', '◇ T3')]:
        items = tiered[cat][tier_name]
        report.append(f'\n  {tier_emoji} 主推: {len(items)} 只')
        if not items:
            report.append('    (空)')
            continue
        report.append('  ' + '代码'.ljust(8) + '名称'.ljust(28) + '规模'.rjust(6) + '1年'.rjust(7) + '3年'.rjust(7) + '年化'.rjust(7) + '回撤'.rjust(7) + '夏普'.rjust(7))
        for r in items[:12]:  # 每 tier 最多显示 12 只
            report.append('  ' + '{}'.format(r['code']).ljust(8) +
                         '{}'.format(r['name'][:26]).ljust(28) +
                         '{:>5.1f}'.format(r.get('scale', 0) or 0).rjust(6) +
                         '{:>6.2f}'.format(r.get('n1', 0) or 0).rjust(7) +
                         '{:>6.2f}'.format(r.get('n3', 0) or 0).rjust(7) +
                         '{:>6.2f}'.format(r.get('annual', 0) or 0).rjust(7) +
                         '{:>6.2f}'.format(r.get('max_dd', 0) or 0).rjust(7) +
                         '{:>6.2f}'.format(r.get('sharpe', 0) or 0).rjust(7))

with open(OUT_REPORT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(report))

# 控制台也输出分级总结
print('\n' + '=' * 75)
print(' 分级汇总')
print('=' * 75)
for cat in ['short_bond', 'pure_bond', 'wide']:
    cn = tier_filters[cat]['cat_name']
    t1 = len(tiered[cat]['tier1'])
    t2 = len(tiered[cat]['tier2'])
    t3 = len(tiered[cat]['tier3'])
    print(f'  {cn}: T1={t1}  T2={t2}  T3={t3}  (总 {t1+t2+t3})')

# 输出 JSON 分级结果供 App 消费
out_combined = {
    'meta': {
        'generated': time.strftime('%Y-%m-%d %H:%M'),
        'tier_definitions': {
            'tier1': '严格: 规模+回撤+夏普 全过',
            'tier2': '宽松: 规模+一项',
            'tier3': '参考: 仅收益排名'
        }
    },
    'tiered': tiered
}
with open(OUT_JSON, 'w', encoding='utf-8') as f:
    json.dump(out_combined, f, ensure_ascii=False, indent=2, default=str)

print(f'\n报告: {OUT_REPORT}')
print(f'JSON: {OUT_JSON}')
