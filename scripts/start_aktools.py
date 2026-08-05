#!/usr/bin/env python
# -*- coding:utf-8 -*-
"""
启动 patched aktools HTTP 服务
- 把 scripts/aktools-patched 目录加到 sys.path 最前面, import 优先用我们的 patched aktools
- 我们的 patch: api.py 用 inspect.signature 自动过滤不兼容 kwargs, utils.py 加 PyPI timeout=5
- aktools 0.0.91 上游已停维护, akshare 1.18.x API 签名改了导致端点全 500, 本 patch 兜底
- 用法: python scripts/start_aktools.py [host] [port]
"""
import os
import sys

# 1) 把 patched aktools 加到 sys.path 最前面 (覆盖 site-packages 里的 0.0.91)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PATCHED_DIR = os.path.join(SCRIPT_DIR, "aktools-patched")
sys.path.insert(0, PATCHED_DIR)
# 同时把 PATCHED_DIR/aktools 父目录也加, 兼容 'aktools.xxx' 的子模块 import
sys.path.insert(0, os.path.dirname(PATCHED_DIR))

# 2) 校验 patched 版本是真的被加载 (不是 site-packages 那个)
import aktools
_loaded_from = getattr(aktools, "__file__", "?")
if PATCHED_DIR not in _loaded_from:
    print(f"[start_aktools] ❌ 加载的不是 patched 版本 ({_loaded_from})", file=sys.stderr)
    sys.exit(2)
print(f"[start_aktools] ✅ aktools 来自: {_loaded_from}", file=sys.stderr)

# 3) 启 uvicorn
host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8088
print(f"[start_aktools] 启动 uvicorn: {host}:{port}", file=sys.stderr)

import uvicorn
from aktools.main import app
uvicorn.run(app, host=host, port=port, log_level="info")
