"""探索更多宏观数据"""
import akshare as ak

tests = [
    ('macro_china_pmi_yearly', None),
    ('macro_china_cpi_monthly', None),
    ('macro_china_cpi_yearly', None),
    ('macro_china_m2_yearly', None),
    ('macro_china_industrial_production_yoy', None),
    ('macro_china_reserve_requirement_ratio', None),
    ('macro_china_society_electricity', None),
    ('macro_china_shibor_all', None),
    ('macro_china_bond_public', None),
    ('repo_rate_query', {'date': '2026-07-25'}),
]

for name, args in tests:
    try:
        f = getattr(ak, name)
        df = f(**args) if args else f()
        print(f'=== {name} ===')
        print('  字段:', list(df.columns)[:8])
        print('  最新 3 行:')
        print(df.tail(3).to_string())
        print()
    except Exception as e:
        print(f'{name}: 失败 - {str(e)[:120]}')
        print()
