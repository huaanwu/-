"""验证 短债 T1 Top 3: 016871 / 013523 / 015942"""
import akshare as ak
for code in ['016871', '013523', '015942', '007194']:
    try:
        ov = ak.fund_overview_em(code)
        d = ov.iloc[0].to_dict()
        print('---', code, '---')
        print('  简称:', d.get('基金简称'))
        print('  类型:', d.get('基金类型'))
        print('  规模:', d.get('净资产规模'))
        print('  经理:', d.get('基金经理人'))
        print('  业绩基准:', d.get('业绩比较基准'))
    except Exception as e:
        print(code, '失败:', e)
