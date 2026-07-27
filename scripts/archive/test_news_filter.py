"""测试新闻关键词过滤效果"""
import akshare as ak
df = ak.stock_news_main_cx()
KW = {
    'high': ['央行', 'PBOC', '货币政策', '降息', '降准', '加息', 'LPR', 'MLF', '逆回购', '公开市场'],
    'mid':  ['利率', '债市', '债券', '国债', '城投', '信用', '基金', '公募', '理财', '债基', '纯债', '短债', '中短债'],
    'low':  ['通胀', 'CPI', '通缩', 'PMI', '经济', '房地产', '楼市', '稳增长', '政策', '监管', '财政']
}
def score(t):
    t = t.lower(); s=0
    for w in KW['high']:
        if w in t: s += 3
    for w in KW['mid']:
        if w in t: s += 2
    for w in KW['low']:
        if w in t: s += 1
    return s

df['s'] = df.apply(lambda r: score((r['tag'] or '') + ' ' + (r['summary'] or '')), axis=1)
df = df.sort_values('s', ascending=False)
print('=== Top 12 相关新闻 (按 score 降序) ===')
for i, r in df.head(12).iterrows():
    print(f'  [{r["s"]:2d}] [{r["tag"]:8s}] {r["summary"][:90]}')
print()
print(f'总: {len(df)}, 有分(>0): {(df["s"] > 0).sum()}, 无分: {(df["s"] == 0).sum()}')
