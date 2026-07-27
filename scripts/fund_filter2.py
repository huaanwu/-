"""修正宽基筛选 - 严格只保留沪深300/中证500/中证1000/上证50/红利/A50"""
import json

with open(r'D:\get\stock-master\fund_all.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

def num(v):
    try: return float(str(v).replace('%',''))
    except: return None

# 严格宽基关键词
WIDE_BASES = ['沪深300', '中证500', '中证1000', '上证50', '红利低波', '红利', 'A50', 'A 股', '中证100']
NARROW_EXCLUDE = ['创业板', '科创', '半导体', '芯片', '新能源', '医药', '消费', '军工', '通信', '科技', '互联网', 'AI', '智能制造', '光伏', '银行', '券商', '保险', '地产', '资源', '有色', '煤炭', '钢铁', '化工']

def is_wide_base(name):
    if not any(k in name for k in WIDE_BASES): return False
    if any(k in name for k in NARROW_EXCLUDE): return False
    if '指数增强' in name: return True  # 增强指数也 OK
    return True

# 解析
parsed = []
for f in data:
    n1 = num(f.get('近1年'))
    n3 = num(f.get('近3年'))
    if n1 is None or n3 is None: continue
    name = f.get('基金简称','')
    if is_wide_base(name):
        parsed.append({
            'code': str(f.get('基金代码','')),
            'name': name,
            'n1': n1, 'n3': n3, 'ytd': num(f.get('今年来')) or 0,
            'fee': f.get('手续费','')
        })

# 按"近 3 年" 排序(取稳的,排除过激的)
parsed.sort(key=lambda x: x['n3'], reverse=True)

print('=' * 75)
print(' 🅳 真宽基指数 ETF / 联接 (共 {} 只,Top 20)'.format(len(parsed)))
print('  (沪深 300 / 中证 500 / 中证 1000 / 上证 50 / 红利 / A50)')
print('=' * 75)
print('  代码       基金简称                     近1年    近3年   今年来   手续费')
print('-' * 75)
for f in parsed[:20]:
    print('  {:<8}  {:<26}  {:>6.2f}  {:>6.2f}  {:>6.2f}  {}'.format(
        f['code'], f['name'][:26], f['n1'], f['n3'], f['ytd'], f['fee']))

# 同时也筛纯沪深 300 / 中证 500 各 5 只(用户熟悉的)
key300 = [f for f in parsed if '沪深300' in f['name']][:5]
key500 = [f for f in parsed if '中证500' in f['name']][:5]
key50 = [f for f in parsed if '上证50' in f['name']][:5]
key_dividend = [f for f in parsed if '红利' in f['name']][:5]

print()
print('=' * 75)
print(' 子分类 Top 5(用户最熟悉的几个指数)')
print('=' * 75)
for label, lst in [('沪深 300 ETF/联接', key300), ('中证 500 ETF/联接', key500),
                     ('上证 50 ETF/联接', key50), ('红利 ETF/联接', key_dividend)]:
    if lst:
        print('\n  {}:'.format(label))
        for f in lst:
            print('    {:<8}  {:<28}  近1年:{:>6.2f}%  近3年:{:>6.2f}%  手续费:{}'.format(
                f['code'], f['name'][:28], f['n1'], f['n3'], f['fee']))
