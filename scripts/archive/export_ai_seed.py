"""从 v3 数据里挑出 AI 用的紧凑候选集 (T1 + T2 top 10)"""
import json

with open(r'D:\get\stock-master\fund_research_v3.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

def compact(r):
    """只保留 LLM 决策需要的字段"""
    return {
        'code': r['code'],
        'name': r['name'],
        'type': r.get('type', ''),
        'scale': round(r.get('scale', 0) or 0, 1),
        'n1': round(r.get('n1', 0) or 0, 2),
        'n3': round(r.get('n3', 0) or 0, 2),
        'annual': round(r.get('annual', 0) or 0, 2),
        'max_dd': round(r.get('max_dd', 0) or 0, 2),
        'sharpe': round(r.get('sharpe', 0) or 0, 2)
    }

candidates = []
for cat in ['short_bond', 'pure_bond', 'wide']:
    for tier in ['tier1', 'tier2']:
        for r in data['tiered'][cat][tier][:10]:
            candidates.append({
                'tier': tier,
                'category': cat,
                **compact(r)
            })

# 元信息
out = {
    'generated': data['meta']['generated'],
    'note': 'AI 选基候选池: T1 (严格) + T2 top10, 共 50-60 只',
    'tier_definitions': data['meta']['tier_definitions'],
    'candidates': candidates
}

with open(r'D:\get\stock-master\www\fund_ai_seed.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print('导出 {0} 只基金到 www/fund_ai_seed.json'.format(len(candidates)))
print('短债: {0}, 纯债: {1}, 宽基: {2}'.format(
    sum(1 for c in candidates if c['category'] == 'short_bond'),
    sum(1 for c in candidates if c['category'] == 'pure_bond'),
    sum(1 for c in candidates if c['category'] == 'wide')
))
