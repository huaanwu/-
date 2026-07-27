"""探索新闻/政策数据源"""
import akshare as ak

# 1. 百度热点
try:
    df = ak.news_report_time_baidu()
    print('=== news_report_time_baidu ===')
    print('  字段:', list(df.columns)[:6])
    print('  最新 5 行:')
    print(df.head(5).to_string())
except Exception as e:
    print('news_report_time_baidu 失败:', e)

print()

# 2. 微博
try:
    df = ak.stock_js_weibo_report()
    print('=== stock_js_weibo_report ===')
    print('  字段:', list(df.columns)[:6])
    print('  样本:')
    print(df.head(3).to_string())
except Exception as e:
    print('stock_js_weibo_report 失败:', e)

print()

# 3. 财新/华尔街见闻 是否有接口
for name in dir(ak):
    if any(kw in name.lower() for kw in ['news', 'wallstreet', 'caixin', 'cls', 'futures', 'futunn']):
        print('可用:', name)
