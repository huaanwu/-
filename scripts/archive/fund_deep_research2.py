"""深度调研 v2: 按用户画像(短债/纯债/宽基)直接筛 Top 50 各类, 拉详情"""
import akshare as ak
import json
import time
import math
import re
import pandas as pd

OUT = r'D:\get\stock-master\fund_research_v2.json'

def num(v):
    try: return float(str(v).replace('%',''))
    except: return None

def safe_get(rec, *keys, default='?'):
    for k in keys:
        if k in rec and rec[k] is not None:
            return rec[k]
    return default

# 1. 读排行
with open(r'D:\get\stock-master\fund_all.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

parsed = [f for f in data if num(f.get('近1年')) is not None and num(f.get('近3年')) is not None]
parsed.sort(key=lambda x: num(x.get('近3年')), reverse=True)
print('Total:', len(parsed))

# 2. 分类
def category(name):
    if '短债' in name or '中短债' in name: return 'short_bond'
    if '纯债' in name: return 'pure_bond'
    if '偏债' in name or '二级债' in name or '增强' in name: return 'mixed_bond'
    # 宽基
    if '沪深300' in name: return 'csi300'
    if '中证500' in name: return 'csi500'
    if '上证50' in name: return '上证50'
    if '红利' in name and ('低波' in name or '低波动' in name): return '红利低波'
    if '红利' in name: return '红利'
    if 'A50' in name: return 'A50'
    if '沪深300' in name and '增强' in name: return 'csi300_enh'
    if '中证500' in name and '增强' in name: return 'csi500_enh'
    return None

# 短债: 1年 1-5%, 3年 4-15%
short = [f for f in parsed if category(f.get('基金简称','')) == 'short_bond'
         and 1 <= num(f.get('近1年')) <= 5 and 4 <= num(f.get('近3年')) <= 15]
# 纯债: 1年 2-8%, 3年 6-20%
pure = [f for f in parsed if category(f.get('基金简称','')) == 'pure_bond'
        and 2 <= num(f.get('近1年')) <= 8 and 6 <= num(f.get('近3年')) <= 20]
# 宽基: 沪深300/中证500/上证50/红利/A50 (排除增强 - 太激进)
wide_keys = ['csi300', 'csi500', '上证50', '红利低波', '红利', 'A50']
wide = [f for f in parsed if category(f.get('基金简称','')) in wide_keys]

print(f'粗筛: 短债 {len(short)} 只, 纯债 {len(pure)} 只, 宽基 {len(wide)} 只')

# 每类取 Top 30 (按 3 年收益)
short_top = sorted(short, key=lambda x: num(x.get('近3年')), reverse=True)[:30]
pure_top = sorted(pure, key=lambda x: num(x.get('近3年')), reverse=True)[:30]
wide_top = sorted(wide, key=lambda x: num(x.get('近3年')), reverse=True)[:30]

candidates = [('short_bond', short_top), ('pure_bond', pure_top), ('wide', wide_top)]
total = sum(len(c[1]) for c in candidates)
print(f'共 {total} 只待调研 (短 {len(short_top)} + 纯 {len(pure_top)} + 宽 {len(wide_top)})')

# 3. 拉详情
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
        time.sleep(0.3)

# 保存
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2, default=str)

print(f'\n调研完成,共耗时 {int(time.time() - start)} 秒, 数据已保存到 {OUT}')

# 输出综合 Top 5 / 类
print('\n' + '=' * 75)
print(' 综合排名 (按"规模 + 夏普 + 回撤"硬指标)')
print('=' * 75)

# 硬筛选: 规模 >= 30 亿, 回撤 < X (按类), 夏普 >= 0.3
filters = {
    'short_bond': {'min_scale': 30, 'max_dd': 5, 'min_sharpe': 0.3, 'cat_name': '🅰️ 短债'},
    'pure_bond': {'min_scale': 30, 'max_dd': 8, 'min_sharpe': 0.3, 'cat_name': '🅱️ 纯债'},
    'wide': {'min_scale': 30, 'max_dd': 35, 'min_sharpe': 0.3, 'cat_name': '🅳 宽基'}
}

report = []
for cat, lst in results.items():
    f = filters[cat]
    qualified = [r for r in lst
                 if r.get('scale', 0) >= f['min_scale']
                 and abs(r.get('max_dd', 100)) <= f['max_dd']
                 and r.get('sharpe', 0) >= f['min_sharpe']]
    # 按夏普降序
    qualified.sort(key=lambda x: x.get('sharpe', 0), reverse=True)
    
    print(f'\n{f["cat_name"]} (规模≥{f["min_scale"]}亿, 回撤≤{f["max_dd"]}%, 夏普≥{f["min_sharpe"]}, {len(qualified)}/{len(lst)} 合格)')
    print('-' * 75)
    print('  代码       基金简称                       规模    1年    3年   年化   回撤    夏普')
    
    report.append(f'\n## {f["cat_name"]} (规模≥{f["min_scale"]}亿, 回撤≤{f["max_dd"]}%, {len(qualified)}/{len(lst)} 合格)')
    report.append('| 代码 | 简称 | 规模 | 1年 | 3年 | 年化 | 回撤 | 夏普 |')
    report.append('|---|---|---|---|---|---|---|---|')
    
    for r in qualified[:8]:
        print('  {:<8}  {:<28}  {:>5.1f}  {:>5.2f}  {:>5.2f}  {:>5.2f}  {:>6.2f}  {:>5.2f}'.format(
            r['code'], r['name'][:28],
            r.get('scale', 0),
            r.get('n1', 0) or 0, r.get('n3', 0) or 0,
            r.get('annual', 0) or 0, r.get('max_dd', 0) or 0, r.get('sharpe', 0) or 0
        ))
        report.append('| {} | {} | {:.1f} | {:.2f} | {:.2f} | {:.2f} | {:.2f} | {:.2f} |'.format(
            r['code'], r['name'][:20],
            r.get('scale', 0),
            r.get('n1', 0) or 0, r.get('n3', 0) or 0,
            r.get('annual', 0) or 0, r.get('max_dd', 0) or 0, r.get('sharpe', 0) or 0
        ))

with open(r'D:\get\stock-master\fund_final_report.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(report))

print()
print('报告保存到 D:\\get\\stock-master\\fund_final_report.txt')
