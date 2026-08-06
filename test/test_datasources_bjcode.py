"""测试 _ts_code_for / _bs_code_for 北交所代码归一化 + 日期格式 normalize
跑法: python test/test_datasources_bjcode.py
不需要起 sidecar, 纯函数测试
"""
import sys
import os

# 直接 import sidecar 里的函数 (把 scripts/datasources 加 sys.path)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts', 'datasources'))
try:
    from start_datasources import _ts_code_for, _bs_code_for
except Exception as e:
    # start_datasources.py 顶层 import 了 aktools/tushare/baostock, 没装会失败
    # 这里只要那两个 helper, 直接 exec 提取
    import re
    with open(os.path.join(os.path.dirname(__file__), '..', 'scripts', 'datasources', 'start_datasources.py'), encoding='utf-8') as f:
        src = f.read()
    m = re.search(r'def _ts_code_for.*?def _bs_code_for.*?return "sz\." \+ code\n', src, re.DOTALL)
    if not m:
        print('FAIL: 找不到 _ts_code_for / _bs_code_for 定义')
        sys.exit(1)
    ns = {}
    exec(m.group(0), ns)
    _ts_code_for = ns['_ts_code_for']
    _bs_code_for = ns['_bs_code_for']

# 日期 normalize helpers — 用 ast 提取, 比正则稳
import ast as _ast
with open(os.path.join(os.path.dirname(__file__), '..', 'scripts', 'datasources', 'start_datasources.py'), encoding='utf-8') as f:
    _src = f.read()
_tree = _ast.parse(_src)
_extracted = {}
for _node in _tree.body:
    if isinstance(_node, _ast.FunctionDef) and _node.name in ('_bs_date', '_ts_date'):
        _extracted[_node.name] = _ast.unparse(_node)
if '_bs_date' not in _extracted or '_ts_date' not in _extracted:
    print('FAIL: 找不到 _bs_date / _ts_date 定义')
    sys.exit(1)

class _HTTPException(Exception):
    def __init__(self, code, msg):
        self.status_code = code
        self.detail = msg
import re as _re
_ns = {'HTTPException': _HTTPException, 're': _re}
for _name, _code in _extracted.items():
    exec(_code + '\n', _ns)
_bs_date = _ns['_bs_date']
_ts_date = _ns['_ts_date']

failed = 0
def t(name, got, expected):
    global failed
    if got == expected:
        print('  ok  ' + name)
    else:
        failed += 1
        print(f'  FAIL {name}: got={got!r} expected={expected!r}')

def t_raises(name, fn, exc_class):
    global failed
    try:
        fn()
        failed += 1
        print(f'  FAIL {name}: 期望抛 {exc_class.__name__}, 没抛')
    except exc_class:
        print('  ok  ' + name)
    except Exception as e:
        failed += 1
        print(f'  FAIL {name}: 抛了 {type(e).__name__} 而非 {exc_class.__name__}')

print('北交所代码归一化')

# Tushare
t('Tushare 6xxxxx -> .SH', _ts_code_for('600000'), '600000.SH')
t('Tushare 0xxxxx -> .SZ', _ts_code_for('000001'), '000001.SZ')
t('Tushare 3xxxxx -> .SZ', _ts_code_for('300750'), '300750.SZ')
t('Tushare 4xxxxx -> .BJ (北交所)', _ts_code_for('430047'), '430047.BJ')
t('Tushare 8xxxxx -> .BJ (北交所)', _ts_code_for('830xxx'), '830xxx.BJ')
t('Tushare 已带后缀透传', _ts_code_for('600000.SH'), '600000.SH')
t('Tushare 已带 .BJ 后缀透传', _ts_code_for('430047.BJ'), '430047.BJ')

# Baostock
t('Baostock 6xxxxx -> sh.', _bs_code_for('600000'), 'sh.600000')
t('Baostock 0xxxxx -> sz.', _bs_code_for('000001'), 'sz.000001')
t('Baostock 3xxxxx -> sz.', _bs_code_for('300750'), 'sz.300750')
t('Baostock 4xxxxx -> bj. (北交所)', _bs_code_for('430047'), 'bj.430047')
t('Baostock 8xxxxx -> bj. (北交所)', _bs_code_for('830123'), 'bj.830123')
t('Baostock 已带 sh. 透传', _bs_code_for('sh.600000'), 'sh.600000')
t('Baostock 已带 bj. 透传', _bs_code_for('bj.830123'), 'bj.830123')

print('\n日期格式 normalize (v=date1)')

# Baostock 要 YYYY-MM-DD — 兼容 YYYYMMDD
t('bs_date 已经是 YYYY-MM-DD 透传', _bs_date('2024-06-01'), '2024-06-01')
t('bs_date YYYYMMDD → 加连字符', _bs_date('20240601'), '2024-06-01')
# YYYY-M-D 不接受 — 必须是 0 补位
t_raises('bs_date YYYY-M-D 拒绝', lambda: _bs_date('2024-6-1'), _HTTPException)
t_raises('bs_date 乱七八糟拒绝', lambda: _bs_date('hello'), _HTTPException)
t_raises('bs_date 空串拒绝', lambda: _bs_date(''), _HTTPException)

# Tushare 要 YYYYMMDD — 兼容 YYYY-MM-DD
t('ts_date 已经是 YYYYMMDD 透传', _ts_date('20240601'), '20240601')
t('ts_date YYYY-MM-DD → 去连字符', _ts_date('2024-06-01'), '20240601')
t_raises('ts_date 乱七八糟拒绝', lambda: _ts_date('2024-6-1'), _HTTPException)
t_raises('ts_date 中文拒绝', lambda: _ts_date('昨天'), _HTTPException)

print(f'\n{"全部通过" if failed == 0 else f"{failed} 个失败"}')
sys.exit(0 if failed == 0 else 1)
