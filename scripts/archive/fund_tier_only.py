"""只做 tiered 分级, 复用 v3 的原始数据"""
import json, time

with open(r'D:\get\stock-master\fund_research_v3.json', 'r', encoding='utf-8') as f:
    results = json.load(f)

tier_filters = {
    'short_bond': {'tier1': {'min_scale': 30, 'max_dd': 5, 'min_sharpe': 0.3},
                   'tier2': {'min_scale': 10, 'max_dd': 8, 'min_sharpe': 0.0}},
    'pure_bond':  {'tier1': {'min_scale': 30, 'max_dd': 8, 'min_sharpe': 0.3},
                   'tier2': {'min_scale': 10, 'max_dd': 12, 'min_sharpe': 0.0}},
    'wide':       {'tier1': {'min_scale': 30, 'max_dd': 35, 'min_sharpe': 0.3},
                   'tier2': {'min_scale': 15, 'max_dd': 45, 'min_sharpe': 0.0}}
}

def passes(rec, f, require_all):
    if (rec.get('scale') or 0) < f['min_scale']: return False
    if require_all:
        if abs(rec.get('max_dd') or 100) > f['max_dd']: return False
        if (rec.get('sharpe') or 0) < f['min_sharpe']: return False
        return True
    else:
        return abs(rec.get('max_dd') or 100) <= f['max_dd'] or (rec.get('sharpe') or 0) >= f['min_sharpe']

tiered = {c: {'tier1': [], 'tier2': [], 'tier3': []} for c in results}
for cat, lst in results.items():
    f1 = tier_filters[cat]['tier1']
    f2 = tier_filters[cat]['tier2']
    for r in lst:
        if passes(r, f1, True):
            tiered[cat]['tier1'].append(r)
        elif passes(r, f2, False):
            tiered[cat]['tier2'].append(r)
        else:
            n3 = r.get('n3') or 0
            n1 = r.get('n1') or 0
            if cat == 'short_bond' and n3 >= 5 and n1 >= 0: tiered[cat]['tier3'].append(r)
            elif cat == 'pure_bond' and n3 >= 8 and n1 >= 0: tiered[cat]['tier3'].append(r)
            elif cat == 'wide' and n3 >= 0: tiered[cat]['tier3'].append(r)
    for t in ['tier1', 'tier2']:
        tiered[cat][t].sort(key=lambda x: x.get('sharpe') or 0, reverse=True)
    tiered[cat]['tier3'].sort(key=lambda x: x.get('n3') or 0, reverse=True)

out = {'meta': {'generated': time.strftime('%Y-%m-%d %H:%M'),
                'tier_definitions': {'tier1': '严格: 规模+回撤+夏普 全过',
                                     'tier2': '宽松: 规模+一项',
                                     'tier3': '参考: 仅收益排名'}},
       'tiered': tiered, 'raw': results}

with open(r'D:\get\stock-master\fund_research_v3.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2, default=str)

print('短债: T1={0} T2={1} T3={2}'.format(len(tiered['short_bond']['tier1']),
                                          len(tiered['short_bond']['tier2']),
                                          len(tiered['short_bond']['tier3'])))
print('纯债: T1={0} T2={1} T3={2}'.format(len(tiered['pure_bond']['tier1']),
                                          len(tiered['pure_bond']['tier2']),
                                          len(tiered['pure_bond']['tier3'])))
print('宽基: T1={0} T2={1} T3={2}'.format(len(tiered['wide']['tier1']),
                                          len(tiered['wide']['tier2']),
                                          len(tiered['wide']['tier3'])))
