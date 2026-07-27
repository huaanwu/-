"""综合脚本:拉 3 只基金概况 + 净值曲线,自己算最大回撤/夏普/波动率"""
import akshare as ak
import json
import math
import time

CANDIDATES = [
    ('008505', '浙商中短债 A', '短债 30%'),
    ('008566', '蜂巢添盈纯债 A', '纯债 40%'),
    ('501050', '华夏上证 50AH 优选 A', '宽基 30%')
]

def calc_metrics(nav_df):
    """nav_df: 净值日期, 单位净值, 日增长率"""
    df = nav_df.copy()
    df['净值日期'] = df['净值日期'].astype(str)
    df = df.sort_values('净值日期').reset_index(drop=True)

    # 净值
    navs = df['单位净值'].astype(float).values
    dates = df['净值日期'].values
    n = len(navs)
    if n < 30: return None

    # 日收益率
    dr = df['日增长率'].astype(float).values
    # 排除 nan
    valid = ~df['日增长率'].isna()
    dr = dr[valid]

    # 1/3 年收益
    end = navs[-1]
    last = {}
    for days, label in [(250, '1年'), (750, '3年'), (1250, '5年')]:
        if n > days:
            last[label] = (end / navs[-days-1] - 1) * 100
        elif n > 60:
            last[label] = (end / navs[0] - 1) * 100
    # 今年来
    ytd_idx = None
    for i, d in enumerate(dates):
        if d.startswith(str(d[:4])):
            pass
    # 简单 YTD: 找今年 1 月 1 日
    year_prefix = dates[-1][:4] + '-01-01'
    ytd_idx = None
    for i, d in enumerate(dates):
        if d >= year_prefix:
            ytd_idx = i; break
    if ytd_idx is not None and ytd_idx > 0:
        last['YTD'] = (end / navs[ytd_idx] - 1) * 100

    # 最大回撤
    peak = navs[0]
    max_dd = 0
    for v in navs:
        if v > peak: peak = v
        dd = (v - peak) / peak
        if dd < max_dd: max_dd = dd

    # 年化收益 (5 年)
    if n > 250:
        annual = (math.pow(end / navs[0], 250 / n) - 1) * 100
    else:
        annual = last.get('1年', 0)

    # 波动率 (年化)
    if len(dr) > 60:
        vol = float(dr.std()) * math.sqrt(250)
    else:
        vol = 0

    # 夏普 (假设无风险 2%)
    sharpe = (annual / 100 - 0.02) / (vol / 100) if vol > 0 else 0

    return {
        '天数': n,
        '区间': f'{dates[0]} ~ {dates[-1]}',
        '年化收益%': round(annual, 2),
        '最大回撤%': round(max_dd * 100, 2),
        '年化波动%': round(vol, 2),
        '夏普比率': round(sharpe, 2),
        '1年%': round(last.get('1年', 0), 2),
        '3年%': round(last.get('3年', 0), 2),
        '5年%': round(last.get('5年', 0), 2),
        'YTD%': round(last.get('YTD', 0), 2)
    }

all_data = []
for code, name, role in CANDIDATES:
    print()
    print('=' * 75)
    print('  {}  {}  ({})'.format(code, name, role))
    print('=' * 75)
    rec = {'code': code, 'name': name, 'role': role}

    # 1. 概况
    try:
        ov = ak.fund_overview_em(code)
        if not ov.empty:
            row = ov.iloc[0].to_dict()
            rec['overview'] = row
            print('\n  [概况]')
            for k, v in row.items():
                if v is not None and str(v) != 'nan' and str(v) != '':
                    s = str(v)
                    if len(s) > 60: s = s[:60] + '...'
                    print('    {}: {}'.format(k, s))
    except Exception as e:
        print('  概况失败:', str(e)[:80])

    # 2. 净值曲线 + 计算指标
    try:
        nav = ak.fund_open_fund_info_em(symbol=code, indicator='单位净值走势')
        if not nav.empty:
            m = calc_metrics(nav)
            if m:
                rec['metrics'] = m
                print('\n  [计算指标]')
                for k, v in m.items():
                    print('    {}: {}'.format(k, v))
    except Exception as e:
        print('  净值失败:', str(e)[:80])

    # 3. 持仓
    try:
        # 用最新年份试
        year = time.strftime('%Y')
        h = ak.fund_portfolio_hold_em(symbol=code, date=year)
        if not h.empty:
            rec['holdings'] = h.to_dict(orient='records')
            print('\n  [股票持仓 Top 5] (最新: {})'.format(year))
            for _, r in h.head(5).iterrows():
                print('    {}: {} ({})'.format(r.get('股票名称', '?'), r.get('股票代码', '?'), r.get('占净值比例', '?')))
        else:
            print('\n  [股票持仓] (最新: {}) — 0 条(可能是债基)'.format(year))
    except Exception as e:
        print('  持仓失败:', str(e)[:80])

    all_data.append(rec)
    time.sleep(1)

# 保存
with open(r'D:\get\stock-master\fund_full_details.json', 'w', encoding='utf-8') as f:
    json.dump(all_data, f, ensure_ascii=False, indent=2, default=str)

# 写个对比表
lines = []
lines.append('=' * 75)
lines.append('  3 只候选基金对比表')
lines.append('=' * 75)
headers = ['指标'] + [c[1][:18] for c in CANDIDATES]
lines.append('{:<18} {:<22} {:<22} {:<22}'.format(*headers))
lines.append('-' * 75)
metrics_keys = ['区间', '年化收益%', '最大回撤%', '年化波动%', '夏普比率', '1年%', '3年%', '5年%', 'YTD%']
for k in metrics_keys:
    row = [k]
    for r in all_data:
        m = r.get('metrics', {}) or {}
        v = m.get(k, '-')
        if isinstance(v, float): v = f'{v:.2f}'
        row.append(str(v)[:20])
    lines.append('{:<18} {:<22} {:<22} {:<22}'.format(*row))

# 概况关键信息
lines.append('')
lines.append('--- 概况 ---')
for rec in all_data:
    ov = rec.get('overview', {}) or {}
    lines.append('\n  {} {}:'.format(rec['code'], rec['name']))
    for k in ['基金类型', '成立日期/规模', '基金经理', '最新规模', '夏普比率', '基金风险等级']:
        if k in ov:
            lines.append('    {}: {}'.format(k, ov[k]))

print()
print()
print('\n'.join(lines))

with open(r'D:\get\stock-master\fund_compare.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print()
print()
print('对比表已保存到 D:\\get\\stock-master\\fund_compare.txt')
