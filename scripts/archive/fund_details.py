"""拉 3 只候选基金的完整详情:基本信息/规模/风险/基金经理/持仓"""
import akshare as ak
import json
import time

CANDIDATES = [
    ('008505', '浙商中短债 A (短债 30% 仓位)'),
    ('008566', '蜂巢添盈纯债 A (纯债 40% 仓位)'),
    ('501050', '华夏上证 50AH 优选 A (宽基 30% 仓位)')
]

INDICATORS = [
    '基本信息',
    '基金规模',
    '基金风险',
    '基金经理',
    '持仓',
    '资产配置'
]

def safe_num(v, default=None):
    try: return float(str(v).replace('%',''))
    except: return default

def fetch_one(code, name):
    print()
    print('=' * 75)
    print('  基金 {}  {}'.format(code, name))
    print('=' * 75)
    result = {'code': code, 'name': name}
    for ind in INDICATORS:
        print('\n  >> {}:'.format(ind))
        try:
            df = ak.fund_open_fund_info_em(symbol=code, indicator=ind)
            if df is None or df.empty:
                print('     (无数据)')
                result[ind] = None
                continue
            result[ind] = df.to_dict(orient='records')
            # 打印前 5 行
            print('     共 {} 条'.format(len(df)))
            for i, row in df.head(5).iterrows():
                kv = []
                for k, v in row.items():
                    if v is not None and str(v) != 'nan' and str(v) != '':
                        s = str(v)
                        if len(s) > 30: s = s[:30] + '...'
                        kv.append('{}:{}'.format(k, s))
                print('     - ' + ' | '.join(kv[:5]))
        except Exception as e:
            print('     错误: {}'.format(str(e)[:100]))
            result[ind] = None
        time.sleep(0.3)  # 避免请求过快
    return result

all_results = []
for code, name in CANDIDATES:
    all_results.append(fetch_one(code, name))
    time.sleep(1)

# 写 JSON
with open(r'D:\get\stock-master\fund_details.json', 'w', encoding='utf-8') as f:
    json.dump(all_results, f, ensure_ascii=False, indent=2, default=str)
print()
print()
print('完整数据保存到: D:\\get\\stock-master\\fund_details.json')
