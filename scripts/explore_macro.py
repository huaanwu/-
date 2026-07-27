"""探索宏观数据的最新一条"""
import akshare as ak

# LPR
lpr = ak.macro_china_lpr()
print('=== LPR ===')
print('  最新 5 行:')
print(lpr.tail(5).to_string())
print()

# PMI
pmi = ak.macro_china_pmi()
print('=== PMI ===')
print('  字段:', list(pmi.columns))
print('  最新 5 行:')
print(pmi.tail(5).to_string())
print()

# CPI
cpi = ak.macro_china_cpi()
print('=== CPI ===')
print('  最新 5 行:')
print(cpi.tail(5).to_string())
print()

# 找其他可用接口
for name in dir(ak):
    if 'macro' in name.lower() or 'repo' in name.lower() or 'shibor' in name.lower():
        print('可用:', name)
