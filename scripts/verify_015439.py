"""验证 015439 长盛安逸纯债 E 的数据"""
import akshare as ak
nav = ak.fund_open_fund_info_em(symbol='015439', indicator='单位净值走势')
print('总条数:', len(nav))
print('\n最近 10 天:')
print(nav.tail(10).to_string())
print('\n最早 10 天:')
print(nav.head(10).to_string())
print('\noverview:')
ov = ak.fund_overview_em('015439')
print(ov.iloc[0].to_dict())
print('\n同类 A 类 (007744):')
ov2 = ak.fund_overview_em('007744')
print(ov2.iloc[0].to_dict())
