# Patched aktools v0.0.91
# - API 签名兼容性修复 (inspect.signature 过滤不兼容 kwargs)
# - timeout=5 防止 akshare 卡死
import sys, inspect, types
from functools import wraps

__version__ = "0.0.91-patched"

# 延迟导入，避免循环
# 先导入 core 包，再导入 core.api（避免循环依赖）
import importlib
import aktools.core
aktools.core.api = importlib.import_module('aktools.core.api')

# 把 core.api 导出为顶层 api 模块
class _ApiModule:
    pass
api = _ApiModule()
api.router = aktools.core.api.app_core

__all__ = ['router', '__version__', '_patch_akshare_call', 'api']
router = api.router

# Patch akshare 函数签名兼容性
def _patch_akshare_call(func_ref):
    """装饰器：调用 akshare 函数时自动过滤不兼容的 kwargs"""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return func_ref(*args, **kwargs)
            except TypeError as e:
                if 'unexpected keyword argument' in str(e):
                    sig = inspect.signature(func_ref)
                    valid_params = set(sig.parameters.keys())
                    valid_kwargs = {k: v for k, v in kwargs.items() if k in valid_params}
                    print(f"[aktools-DEBUG] Retrying without {set(kwargs.keys()) - valid_params}: {e}", file=sys.stderr)
                    return func_ref(*args, **valid_kwargs)
                raise
        return wrapper
    return decorator
