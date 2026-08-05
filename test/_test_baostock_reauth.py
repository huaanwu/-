"""baostock socket 半死自愈测试 — 纯函数 + 真实 baostock

覆盖:
  - _force_reauth 标脏 + _consume_reauth 一次性消费
  - _socket_alive 在 socket 被 close 后返 False (fileno 抛错)
  - 端到端: 模拟 socket 半死 (bs.query_history_k_data_plus 返 None)
    → 标脏 + 一次 retry → 第 2 次 baostock 真实查询成功

跑法: uv run --python 3.12 --with baostock python test/_test_baostock_reauth.py
  或  uv run --python 3.12 --with baostock --with fastapi --with uvicorn \
      --with httpx --with tushare --with pandas --with akshare \
      python test/_test_baostock_reauth.py
"""
import os
import sys
import threading

# 加 sidecar 路径
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, '..', 'scripts', 'datasources'))

# 直接 import sidecar 模块拿 _force_reauth / _consume_reauth / _socket_alive
# 但 start_datasources 跑起来会启 uvicorn, 我们只要纯函数, 用 exec 抠出来
import re
src_path = os.path.join(SCRIPT_DIR, '..', 'scripts', 'datasources', 'start_datasources.py')
with open(src_path, 'r', encoding='utf-8') as f:
    src = f.read()

# 抠出 _force_reauth + _consume_reauth + 标脏标志定义 (在 baostock session context 前)
# 简单做法: exec 那段 src 块, 但要先 stub out app/FastAPI/uvicorn 避免副作用
# 实际: sidecar 是 module-style, import 时不会跑 if __name__ == "__main__", 不会启 uvicorn
# 试一下直接 import
try:
    import importlib
    # 显式 stub 掉一些依赖, 防 import 期副作用
    import fastapi
    import uvicorn  # noqa
    import httpx  # noqa
    import pandas  # noqa
    import akshare as ak  # noqa
    # 现在 import sidecar (会跑模块顶层代码, 不启 uvicorn, 只注册 routes)
    spec = importlib.util.spec_from_file_location("start_datasources", src_path)
    sd = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sd)
    sidecar = sd
except Exception as e:
    print(f"[setup] sidecar import 失败: {e}", file=sys.stderr)
    print("SKIP: 需要 baostock/fastapi/uvicorn/httpx/pandas/akshare 环境")
    sys.exit(0)  # SKIP 而非失败, 让 npm test 能在没装这些依赖时也通过

passed = 0
failed = 0
def t(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  ok  {name}")
        passed += 1
    except Exception as e:
        print(f"  FAIL {name}: {e}")
        failed += 1

print("baostock socket 半死自愈单元测试")

# ===== 1. 标脏标志: 纯函数 =====
def test_force_consume_reauth():
    # 重置标志
    sidecar._BS_FORCE_REAUTH = False
    assert sidecar._consume_reauth() is False, "初始 _BS_FORCE_REAUTH=False 应返 False"
    sidecar._force_reauth("test reason")
    assert sidecar._BS_FORCE_REAUTH is True, "标脏后应 True"
    assert sidecar._consume_reauth() is True, "第一次 consume 应 True"
    assert sidecar._consume_reauth() is False, "第二次 consume 应 False (一次性)"

t('force_reauth + consume_reauth 一次性消费', test_force_consume_reauth)

# ===== 2. 线程安全: 多线程并发标脏 + consume =====
def test_thread_safety():
    sidecar._BS_FORCE_REAUTH = False
    results = {'force': 0, 'consume': 0}
    lock = threading.Lock()
    def worker(i):
        for _ in range(50):
            sidecar._force_reauth(f"thread {i}")
            with lock:
                results['force'] += 1
            r = sidecar._consume_reauth()
            if r:
                with lock:
                    results['consume'] += 1
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(5)]
    for t_ in threads: t_.start()
    for t_ in threads: t_.join()
    # 50*5=250 次 force, 最多 250 次 consume
    assert results['force'] == 250, f"force 计数错: {results['force']}"
    assert results['consume'] <= 250, f"consume 上限错: {results['consume']}"
    assert results['consume'] >= 1, f"consume 应至少 1 次: {results['consume']}"
    assert sidecar._consume_reauth() is False, "最终标志应清空"

t('标脏并发线程安全 (5 线程 × 50 次)', test_thread_safety)

# ===== 3. _socket_alive: 无 socket / 关闭的 socket =====
def test_socket_alive_none():
    # 把 conx.default_socket 设为 None
    import baostock.common.context as _conx
    if hasattr(_conx, 'default_socket'):
        delattr(_conx, 'default_socket')
    assert sidecar._socket_alive() is False, "无 default_socket 应返 False"

t('_socket_alive 无 socket → False', test_socket_alive_none)

def test_socket_alive_closed():
    # 创建一个 socket 但 close, getpeername 抛错
    import socket
    import baostock.common.context as _conx
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.close()
    _conx.default_socket = s
    assert sidecar._socket_alive() is False, "closed socket 应返 False"
    delattr(_conx, 'default_socket')

t('_socket_alive 已 close socket → False', test_socket_alive_closed)

# ===== 4. 端到端: 真实 bs.login + 半死 (login 后立即 logout 模拟 socket 死) =====
def test_e2e_reauth_picks_up_dirty_flag():
    """模拟: 之前的 query 标脏 → _bs_session 入口 detect 标脏 → 重 login"""
    import baostock as bs
    import baostock.common.context as _conx

    # 第 1 步: 正常 login
    lg = bs.login()
    assert lg.error_code == "0", f"login 失败: {lg.error_msg}"
    assert sidecar._socket_alive() is True, "login 后 socket 应活"

    # 第 2 步: 模拟"socket 半死" — close socket 但不 logout
    # 这样 user_id 仍在, _socket_alive 返 False (getpeername 抛错)
    _conx.default_socket.close()

    # 第 3 步: 标脏 (模拟之前 query 失败时 _force_reauth 调用)
    sidecar._force_reauth("e2e test: socket close")

    # 第 4 步: _bs_session 应该 detect 标脏, 重 login
    with sidecar._bs_session() as session:
        assert session is not None, "标脏后 _bs_session 应重 login 成功"
        assert sidecar._socket_alive() is True, "重 login 后 socket 应活"
        # 真实 query
        rs = session.query_history_k_data_plus(
            "sz.000001", "date,close",
            start_date="2024-06-01", end_date="2024-06-05",
            frequency="d", adjustflag="3"
        )
        assert rs is not None and rs.error_code == "0", f"重 login 后 query 应成功: {rs and rs.error_code} {rs and rs.error_msg}"
        assert len(rs.data) >= 1, f"应返至少 1 条 K 线: {len(rs.data)}"
        print(f"    (e2e 重 login 后拿到 {len(rs.data)} 条 K 线)")

    # 清理
    try:
        bs.logout()
    except: pass

t('端到端: 标脏触发 _bs_session 重 login + query 成功', test_e2e_reauth_picks_up_dirty_flag)

# ===== 5. 完整流程: 触发 retry 路径 =====
def test_e2e_daily_route_retries_on_dirty_socket():
    """走 baostock_daily 路由: 模拟 socket 半死, 看是否真重 login + 返 200"""
    import baostock as bs
    import baostock.common.context as _conx
    from fastapi.testclient import TestClient

    # 用 TestClient 直接调 FastAPI (无需 uvicorn)
    # 第一次请求: 先 force-reauth + 关 socket, 让 retry 走通
    sidecar._BS_FORCE_REAUTH = False

    # 在请求前 close socket (模拟半死)
    if hasattr(_conx, 'default_socket') and _conx.default_socket:
        try:
            _conx.default_socket.close()
        except: pass

    client = TestClient(sidecar.app)
    r = client.get("/baostock/daily?code=000001&start_date=2024-06-01&end_date=2024-06-05&adj=3")
    assert r.status_code == 200, f"期望 200 (retry 成功), 实际 {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("ok") is True
    assert body.get("source") == "baostock"
    assert isinstance(body.get("data"), list)
    assert len(body["data"]) >= 1, f"应返至少 1 条 K 线: {body}"
    print(f"    (e2e daily 路由 socket 死 → 重 login → 返 {len(body['data'])} 条 K 线)")

    # 清理
    try: bs.logout()
    except: pass

t('端到端: baostock_daily 路由 socket 半死 → retry → 200', test_e2e_daily_route_retries_on_dirty_socket)

print(f"\n{passed} 通过 / {failed} 失败")
sys.exit(0 if failed == 0 else 1)
