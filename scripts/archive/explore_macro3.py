"""再探两个"""
import akshare as ak
import inspect

# repo_rate_hist
try:
    sig = inspect.signature(ak.repo_rate_hist)
    print('repo_rate_hist 签名:', sig)
    df = ak.repo_rate_hist(start_date='20260101', end_date='20260726')
    print('=== repo_rate_hist ===')
    print('  字段:', list(df.columns))
    print('  最新 3 行:')
    print(df.tail(3).to_string())
except Exception as e:
    print('repo_rate_hist:', e)

print()

# macro_china_bond_public
try:
    sig = inspect.signature(ak.macro_china_bond_public)
    print('macro_china_bond_public 签名:', sig)
except Exception as e:
    print('sig:', e)
