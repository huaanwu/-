"""深度调研:Top 100 基金的规模/回撤/夏普,综合筛选"""
import akshare as ak
import json
import time
import math
import re
import pandas as pd

OUT = r'D:\get\stock-master\fund_research.json'
PROGRESS = r'D:\get\stock-master\fund_research_progress.txt'

def num(v):
    try: return float(str(v).replace('%',''))
    except: return None

# 1. 读排行
with open(r'D:\get\stock-master\fund_all.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

ranked = [f for f in data if num(f.get('近3年')) is not None and num(f.get('近1年')) is not None]
ranked.sort(key=lambda x: num(x.get('近3年')), reverse=True)
top100 = ranked[:100]
print('Total ranked:', len(ranked), 'Top 100 selected')
print()

results = []
start = time.time()
for i, f in enumerate(top100):
    code = str(f.get('基金代码',''))
    name = f.get('基金简称','')
    
    elapsed = int(time.time() - start)
    print(f'[{i+1:3d}/100] {code} {name[:22]:<22}  ({elapsed}s)', end='  ', flush=True)
    
    rec = {
        'code': code, 'name': name,
        'n1': num(f.get('近1年')),
        'n3': num(f.get('近3年')),
        'ytd': num(f.get('今年来'))
    }
    
    # 1. 概况: 类型/规模/经理
    try:
        ov = ak.fund_overview_em(code)
        if not ov.empty:
            row = ov.iloc[0].to_dict()
            rec['type'] = row.get('基金类型', '')
            rec['manager'] = row.get('基金经理人', '')
            rec['founded'] = row.get('成立日期/规模', '')
            rec['fee'] = row.get('最高认购费率', '')
            # 解析规模
            scale_str = str(row.get('净资产规模', ''))
            m = re.search(r'([\d.]+)\s*亿', scale_str)
            if m: rec['scale'] = float(m.group(1))
    except: pass
    
    # 2. 净值: 算最大回撤/夏普/波动
    try:
        nav = ak.fund_open_fund_info_em(symbol=code, indicator='单位净值走势')
        if not nav.empty:
            df = nav.copy()
            df['净值日期'] = df['净值日期'].astype(str)
            df = df.sort_values('净值日期').reset_index(drop=True)
            navs = df['单位净值'].astype(float).values
            n = len(navs)
            rec['days'] = n
            
            if n > 60:
                # 最大回撤
                peak = navs[0]; max_dd = 0
                for v in navs:
                    if v > peak: peak = v
                    dd = (v - peak) / peak
                    if dd < max_dd: max_dd = dd
                rec['max_dd'] = round(max_dd * 100, 2)
                
                # 年化收益
                if n > 250:
                    annual = (math.pow(navs[-1] / navs[0], 250 / n) - 1) * 100
                else:
                    annual = rec['n1'] or 0
                rec['annual'] = round(annual, 2)
                
                # 波动率(年化)
                dr = pd.Series(navs).pct_change().dropna()
                if len(dr) > 60:
                    vol = float(dr.std()) * math.sqrt(250) * 100
                    rec['vol'] = round(vol, 2)
                    # 夏普 (无风险 2%)
                    rec['sharpe'] = round((annual - 2) / vol, 2) if vol > 0 else 0
    except: pass
    
    print('规模:{}  回撤:{}%  夏普:{}'.format(
        rec.get('scale', '?'),
        rec.get('max_dd', '?'),
        rec.get('sharpe', '?')
    ))
    
    results.append(rec)
    time.sleep(0.4)
    
    # 每 10 个保存一次
    if (i+1) % 10 == 0:
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2, default=str)

# 最终保存
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2, default=str)

print()
print('调研完成,数据已保存到', OUT)
print('总耗时:{} 秒'.format(int(time.time() - start)))
