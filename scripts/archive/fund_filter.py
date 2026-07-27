"""按 3-4-3 配比画像筛选稳健基金候选
   - 短债: 近 1 年 2-5%, 近 3 年 5-15%
   - 纯债: 近 1 年 3-8%, 近 3 年 8-20%
   - 避开高收益激进型
"""
import json

with open(r'D:\get\stock-master\fund_all.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

def num(v):
    try: return float(str(v).replace('%',''))
    except: return None

# 解析
parsed = []
for f in data:
    n1 = num(f.get('近1年'))
    n3 = num(f.get('近3年'))
    ytd = num(f.get('今年来'))
    if n1 is None or n3 is None: continue
    parsed.append({
        'code': str(f.get('基金代码','')),
        'name': f.get('基金简称',''),
        'n1': n1,
        'n3': n3,
        'ytd': ytd if ytd is not None else 0,
        'fee': f.get('手续费','')
    })

# 按画像筛(用 name 包含关键词,简易分类)
def category(name):
    nl = name.lower()
    if '短债' in name or '中短债' in name: return '短债'
    if '纯债' in name: return '纯债'
    if '指数' in name or 'ETF' in name: return '指数'
    if '债' in name: return '偏债'  # 二级债基
    return '其他'  # 股票/混合等

for f in parsed:
    f['cat'] = category(f['name'])

# 短债: 近 1 年 1.5-5%, 近 3 年 4-15%
short_bond = [f for f in parsed if f['cat'] == '短债' and 1.5 <= f['n1'] <= 5 and 4 <= f['n3'] <= 15]
# 纯债: 近 1 年 2-8%, 近 3 年 6-20%
pure_bond = [f for f in parsed if f['cat'] == '纯债' and 2 <= f['n1'] <= 8 and 6 <= f['n3'] <= 20]
# 偏债: 近 1 年 2-10%, 近 3 年 6-25%
mixed_bond = [f for f in parsed if f['cat'] == '偏债' and 2 <= f['n1'] <= 10 and 6 <= f['n3'] <= 25]
# 宽基指数: 名字包含 ETF / 沪深300 / 中证500 / 中证1000 / 红利
broad_index = [f for f in parsed if f['cat'] == '指数' and
               any(k in f['name'] for k in ['沪深300', '中证500', '中证1000', '红利', '上证50', '创业板', '科创50', '中证100', 'A50'])]

# 按近 3 年收益降序
short_bond.sort(key=lambda x: x['n3'], reverse=True)
pure_bond.sort(key=lambda x: x['n3'], reverse=True)
mixed_bond.sort(key=lambda x: x['n3'], reverse=True)
broad_index.sort(key=lambda x: x['n3'], reverse=True)

def show(title, lst, top=15):
    print()
    print('=' * 75)
    print(' {} (共 {} 只,展示前 {} 只)'.format(title, len(lst), min(top, len(lst))))
    print('=' * 75)
    print('  代码       基金简称                     近1年    近3年   今年来   手续费')
    print('-' * 75)
    for f in lst[:top]:
        print('  {:<8}  {:<26}  {:>6.2f}  {:>6.2f}  {:>6.2f}  {}'.format(
            f['code'], f['name'][:26], f['n1'], f['n3'], f['ytd'] or 0, f['fee']))

show('🅰️ 短债基金 (低回撤低收益)', short_bond)
show('🅱️ 中长期纯债 (中低回撤中收益)', pure_bond)
show('🅲 偏债混合 (含可转债,波动稍大)', mixed_bond)
show('🅳 宽基指数 ETF (进攻仓位,回撤较大)', broad_index)

# 写到文件
out = []
for title, lst in [('短债', short_bond), ('纯债', pure_bond), ('偏债', mixed_bond), ('宽基指数', broad_index)]:
    out.append('## {} ({} 只)\n'.format(title, len(lst)))
    for f in lst[:30]:
        out.append('  {:<8}  {:<28}  近1年:{:>6.2f}%  近3年:{:>6.2f}%  手续费:{}'.format(
            f['code'], f['name'][:28], f['n1'], f['n3'], f['fee']))
    out.append('')

with open(r'D:\get\stock-master\fund_candidates.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(out))
print()
print('已保存到 D:\\get\\stock-master\\fund_candidates.txt')
