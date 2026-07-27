"""探索新闻接口"""
import akshare as ak

tests = ['news_economic_baidu', 'news_cctv', 'stock_news_main_cx', 'news']
for name in tests:
    try:
        f = getattr(ak, name)
        df = f()
        print(f'=== {name} ===')
        print('  字段:', list(df.columns)[:8])
        print('  总数:', len(df))
        if len(df) > 0:
            print('  样本 3 行:')
            print(df.head(3).to_string())
        print()
    except Exception as e:
        print(f'{name} 失败: {str(e)[:120]}')
        print()
