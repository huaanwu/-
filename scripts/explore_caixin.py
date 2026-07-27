"""看财新新闻的全貌, 找出和债基/央行/利率相关的"""
import akshare as ak
df = ak.stock_news_main_cx()
print('总条数:', len(df))
print('所有 tag 类别:')
import collections
tags = collections.Counter(df['tag'].tolist())
for tag, cnt in tags.most_common():
    print(f'  {tag}: {cnt}')

print('\n=== 全部 100 条标题 (tag: 标题) ===')
for i, row in df.iterrows():
    print(f'[{i:3d}] [{row["tag"]:8s}] {row["summary"][:80]}')
