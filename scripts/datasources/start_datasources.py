#!/usr/bin/env python
# -*- coding:utf-8 -*-
"""
多源数据 sidecar (Tushare + Baostock + Aktools)
- 把三套数据源统一挂在一个 FastAPI 上, 对外暴露标准化端点
- dev-proxy 走 /api/datasource/* 转发到这里, 上层代码只用一种格式
- 任意一源挂时其他源继续工作 (隔离)
- 全挂时返 503 (前端有腾讯备用源兜底)
- 用法: python scripts/datasources/start_datasources.py [host] [port]
"""
import os
import sys
import logging

# 跟 start_aktools.py 一样, 把 patched aktools 塞 sys.path 最前面
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
PATCHED_AKTOOLS = os.path.join(REPO_ROOT, "aktools-patched")
if os.path.isdir(PATCHED_AKTOOLS):
    sys.path.insert(0, PATCHED_AKTOOLS)
    sys.path.insert(0, os.path.dirname(PATCHED_AKTOOLS))

# 校验 patched aktools 加载成功
try:
    import aktools as _aktools_check
    if PATCHED_AKTOOLS not in getattr(_aktools_check, "__file__", "?"):
        print(f"[datasources] ⚠️  aktools 来自 {_aktools_check.__file__} (不是 patched)", file=sys.stderr)
except ImportError as e:
    print(f"[datasources] ⚠️  aktools 加载失败: {e}", file=sys.stderr)

# 配 logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("datasources")

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
import httpx

# Tushare token (env 注入, 没配则该源下线但其他源继续)
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN", "").strip()

# Patched aktools 端点 (跟 dev-proxy 走同一个)
AKTOOLS_BASE = os.environ.get("AKTOOLS_BASE", "http://127.0.0.1:8088")

app = FastAPI(
    title="StockMaster 多源数据 sidecar",
    description="Tushare (基本面) + Baostock (历史批量) + Aktools (实时) 三源并联, 单源故障不影响其他",
    version="0.1.0",
)


# ===== 通用工具: 标准化响应 =====
def _ok(data, source, extra=None):
    """统一成功响应格式"""
    out = {"ok": True, "source": source, "data": data}
    if extra:
        out.update(extra)
    return out


def _err(message, source, status_code=502):
    """统一失败响应"""
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "source": source, "error": message},
    )


def _source_available(source_name):
    """检查源是否启用 (Tushare 需 token)"""
    if source_name == "tushare":
        return bool(TUSHARE_TOKEN)
    return True

# ?v=datasources-bjcode1: 北交所代码前缀归一化 (4xxxxx / 8xxxxx -> .BJ)
# 之前只用 6→SH, 否则 SZ, 4/8 开头的北交所标的全错
def _ts_code_for(code: str) -> str:
    if "." in code:
        return code
    if code.startswith(("4", "8")):
        return code + ".BJ"
    if code.startswith("6"):
        return code + ".SH"
    return code + ".SZ"


def _bs_code_for(code: str) -> str:
    """Baostock 格式: sh.000001 / sz.000001 / bj.830xxx"""
    if "." in code and (code.startswith(("sh.", "sz.", "bj."))):
        return code
    if code.startswith(("4", "8")):
        return "bj." + code
    if code.startswith("6"):
        return "sh." + code
    return "sz." + code



# ===== 健康检查: 探测三源状态 =====
@app.get("/health")
async def health():
    sources = {
        "tushare": _source_available("tushare"),
        "baostock": True,  # baostock 无外部依赖, 视为可用
        "aktools": False,  # 下面 ping 一下
    }
    # ping aktools
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{AKTOOLS_BASE}/openapi.json")
            sources["aktools"] = r.status_code == 200
    except Exception as e:
        log.warning(f"aktools ping 失败: {e}")
        sources["aktools"] = False
    return _ok(sources, "datasources")


# ===== Tushare 路由 (日线 + 基础行情) =====
try:
    import tushare as ts
    if TUSHARE_TOKEN:
        ts.set_token(TUSHARE_TOKEN)
        _pro = ts.pro_api()
        log.info("Tushare 初始化成功")
    else:
        _pro = None
        log.warning("TUSHARE_TOKEN 未配, Tushare 源下线")
except ImportError as e:
    _pro = None
    log.warning(f"tushare 库未装: {e}")


@app.get("/tushare/daily")
async def tushare_daily(
    code: str = Query(..., description="6 位股票代码, 例 000001"),
    start_date: str = Query(..., description="YYYYMMDD"),
    end_date: str = Query(..., description="YYYYMMDD"),
    adj: str = Query("qfq", description="qfq/hfq/None"),
):
    """日线行情 (Tushare Pro daily + pro_bar)
    返回: [{date, code, open, close, high, low, volume, amount, ...}]
    """
    if not _pro:
        raise HTTPException(503, "Tushare 未启用 (TUSHARE_TOKEN 未配)")
    # 自动补 .SH / .SZ 后缀
    ts_code = _ts_code_for(code)
    try:
        df = _pro.pro_bar(ts_code=ts_code, adj=adj, start_date=start_date, end_date=end_date)
        if df is None or df.empty:
            # 退到 daily (无复权)
            df = _pro.daily(ts_code=ts_code, start_date=start_date, end_date=end_date)
        if df is None or df.empty:
            return _ok([], "tushare")
        # 标准化列名 (Tushare 英文 → 项目内统一中文)
        rename = {
            "trade_date": "date", "ts_code": "code",
            "open": "open", "high": "high", "low": "low", "close": "close",
            "vol": "volume", "amount": "amount", "pct_chg": "pct_chg",
        }
        df = df.rename(columns=rename)
        # 统一 6 位 code (去掉 .SH/.SZ)
        if "code" in df.columns:
            df["code"] = df["code"].str.split(".").str[0]
        return _ok(df.to_dict("records"), "tushare")
    except Exception as e:
        log.error(f"tushare daily 失败: {e}")
        return _err(str(e), "tushare")


@app.get("/tushare/basic")
async def tushare_basic(
    code: str = Query(..., description="6 位股票代码"),
):
    """股票基础信息 (Tushare stock_basic)
    返回: {code, name, industry, list_date, ...}
    """
    if not _pro:
        raise HTTPException(503, "Tushare 未启用")
    ts_code = _ts_code_for(code)
    try:
        df = _pro.stock_basic(ts_code=ts_code, fields="ts_code,name,industry,list_date,market,exchange")
        if df is None or df.empty:
            return _err(f"未找到 {ts_code}", "tushare", 404)
        row = df.iloc[0].to_dict()
        if "ts_code" in row:
            row["code"] = row.pop("ts_code").split(".")[0]
        return _ok(row, "tushare")
    except Exception as e:
        log.error(f"tushare basic 失败: {e}")
        return _err(str(e), "tushare")


@app.get("/tushare/fina")
async def tushare_fina(
    code: str = Query(..., description="6 位股票代码"),
    limit: int = Query(4, description="最近几期财报"),
):
    """财务摘要 (Tushare fina_indicator)
    返回: [{end_date, roe, grossprofit_margin, debt_to_assets, ...}]
    """
    if not _pro:
        raise HTTPException(503, "Tushare 未启用")
    ts_code = _ts_code_for(code)
    try:
        df = _pro.fina_indicator(ts_code=ts_code, fields="ts_code,end_date,roe,eps,grossprofit_margin,debt_to_assets,netprofit_margin")
        if df is None or df.empty:
            return _ok([], "tushare")
        # 标准化
        if "ts_code" in df.columns:
            df["code"] = df["ts_code"].str.split(".").str[0]
            df = df.drop(columns=["ts_code"])
        return _ok(df.head(limit).to_dict("records"), "tushare")
    except Exception as e:
        log.error(f"tushare fina 失败: {e}")
        return _err(str(e), "tushare")


# ===== Baostock 路由 (日线/分钟/复权 — 批量快 4 倍) =====
# ?v=datasources-baostock1: baostock login 是 thread-local, 跨请求会丢
#   改成"每次请求都 login + 用完 logout", 避免第一次 login 后续请求全失败
import contextlib
import threading

# ?v=datasources-baostock7: socket 累积用久会半死修复
#   - getpeername() 查不出 socket 半死 (TCP 连接能 getpeername 但 send/recv 已死)
#   - 实测累积几小时后会出 [WinError 10038] + error_code=10002007
#   - 修法: 标脏 + auto-retry — 任何 query 收到 BSERR_RECVSOCK_FAIL 或 send_msg 静默 None
#     → 设 _BS_FORCE_REAUTH 标志, 下次 _bs_session 入口强制重 login
_BS_REAUTH_LOCK = threading.Lock()
_BS_FORCE_REAUTH = False  # 任意线程标脏, 下次 _bs_session 重 login


def _force_reauth(reason: str):
    """baostock socket 半死 → 标脏, 下次 _bs_session 入口重 login"""
    global _BS_FORCE_REAUTH
    with _BS_REAUTH_LOCK:
        _BS_FORCE_REAUTH = True
    log.warning(f"baostock 标脏重 auth: {reason}")


def _consume_reauth():
    global _BS_FORCE_REAUTH
    with _BS_REAUTH_LOCK:
        if _BS_FORCE_REAUTH:
            _BS_FORCE_REAUTH = False
            return True
        return False


def _socket_alive():
    """检查 baostock default_socket 是否仍可用
    - 没设置过 → False
    - 已 close (fileno 抛 OSError) → False
    注意: getpeername() 查不出 socket 半死 (TCP 连接能 getpeername 但 send/recv 已死)
          这种半死由路由层 BSERR 标脏 + 一次 retry 覆盖
    """
    import baostock.common.context as _conx
    sock = getattr(_conx, "default_socket", None)
    if sock is None:
        return False
    try:
        sock.getpeername()  # closed socket 这里抛 OSError
        return True
    except Exception:
        return False


@contextlib.contextmanager
def _bs_session():
    """baostock session 上下文
    ?v=datasources-baostock7: baostock 0.9.30 三层坑 + socket 半死自愈
       1. SocketUtil 是单例, login 创建 socket 写到 conx.default_socket, logout 关闭它
       2. context 里 user_id 即使 logout 后仍 set 着, 只看 user_id 没法判断 socket 死活
       3. send_msg 的 except 静默吞 OSError, 返 None, query 走 BSERR_RECVSOCK_FAIL
       4. (新) socket 累积用久半死: getpeername() 仍 OK 但 send/recv 已死 → 任何 query 必失败
    修法:
      - 启动 smoke test **成功就保留 login**, 失败才 logout 重试
      - _bs_session 三重触发重 auth: socket fileno 死 / 标脏标志 / 无 user_id
      - 路由在 BSERR (尤其 10002007) 时标脏 + 一次 retry
      - BSERR_RECVSOCK_FAIL (10002007) 走 503 而不是 200+空数组
    """
    import baostock as bs
    import time as _time
    import baostock.common.context as _conx

    # 三重触发重 auth: socket 死 / 标脏 / 无 user_id
    need_reauth = (
        not hasattr(_conx, "user_id")
        or not _socket_alive()
        or _consume_reauth()
    )
    if need_reauth:
        log.info("baostock 重 auth 触发 (socket 死 / 标脏 / 无 user_id)")
        for attempt in range(3):
            # 先把可能残留的 closed socket 清掉 (logout 后 attribute 还在)
            if hasattr(_conx, "default_socket"):
                try:
                    _conx.default_socket.close()
                except Exception:
                    pass
                delattr(_conx, "default_socket")
            # 把 user_id 也清掉, 避免 stale 状态
            if hasattr(_conx, "user_id"):
                delattr(_conx, "user_id")
            lg = bs.login()
            if lg.error_code == "0":
                _time.sleep(0.2)
                # login 完顺手探一下 socket 真活着
                if _socket_alive():
                    break
                else:
                    log.warning(f"baostock login 后 socket 不可用, 重试 {attempt+1}/3")
            else:
                log.warning(f"baostock login 重试 {attempt+1}/3: code={lg.error_code} msg={lg.error_msg}")
            _time.sleep(0.5)
        log.info(f"baostock login 最终: code={lg.error_code} alive={_socket_alive()}")
        if lg.error_code != "0" or not _socket_alive():
            log.error(f"baostock login 失败: code={lg.error_code}")
            yield None
            return
    else:
        log.info("baostock session 复用 (单例 socket 仍活跃)")
    try:
        yield bs
    finally:
        # 故意不调 logout! 调了下次 query 就废
        # 进程结束 OS 会自动关 socket
        pass


@app.get("/baostock/daily")
def baostock_daily(
    code: str = Query(..., description="6 位股票代码, 例 000001"),
    start_date: str = Query(..., description="YYYYMMDD"),
    end_date: str = Query(..., description="YYYYMMDD"),
    adj: str = Query("3", description="1=后复权 2=前复权 3=不复权"),
):
    """日线 (Baostock 优势: 批量遍历快 + 无 token + 20+ 年历史)
    返回: [{date, code, open, close, high, low, volume, amount}]

    ?v=datasources-baostock2: 用 sync def (不是 async def), 让 fastapi 走 threadpool
       之前用 async def, baostock 同步阻塞 + asyncio event loop 冲突, query 返 None
    """
    # ?v=datasources-baostock7: socket 半死自愈 — 一次 retry
    #   第一次失败 → 标脏 + 重试 (下次 _bs_session 入口会重 login)
    #   第二次失败 → 503 (真的 baostock 服务挂了)
    BSERR_RECVSOCK_FAIL = "10002007"
    BSERR_SOCKET_ERR = "10002001"
    for attempt in range(2):
        try:
            with _bs_session() as session:
                if session is None:
                    raise HTTPException(503, "Baostock login 失败")
                # Baostock code 格式: sh.000001 / sz.000001 / bj.830xxx
                bs_code = _bs_code_for(code)
                rs = session.query_history_k_data_plus(
                    bs_code,
                    "date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg",
                    start_date=start_date, end_date=end_date,
                    frequency="d", adjustflag=adj,
                )
                log.info(f"baostock query {bs_code} {start_date}..{end_date} (attempt {attempt+1}) → rs type={type(rs).__name__}")
                if rs is None:
                    # send_msg 静默失败 — socket 半死
                    if attempt == 0:
                        _force_reauth(f"query {bs_code} 返 None (socket 半死)")
                        continue
                    raise HTTPException(503, "baostock query 返回 None (底层抛异常被吞)")
                log.info(f"baostock query error_code={rs.error_code} error_msg={rs.error_msg}")
                if rs.error_code != "0":
                    # BSERR socket 类 — 标脏 + retry 一次
                    if attempt == 0 and rs.error_code in (BSERR_RECVSOCK_FAIL, BSERR_SOCKET_ERR, "10001001"):
                        _force_reauth(f"BSERR {rs.error_code} (socket 半死)")
                        continue
                    raise HTTPException(503, f"baostock error: code={rs.error_code} msg={rs.error_msg}")
                # 成功
                rows = []
                while (rs.error_code == "0") and rs.next():
                    row = rs.get_row_data()
                    row_dict = {
                        "date": row[0], "code": row[1].split(".")[-1],
                        "open": float(row[2]) if row[2] else None,
                        "high": float(row[3]) if row[3] else None,
                        "low": float(row[4]) if row[4] else None,
                        "close": float(row[5]) if row[5] else None,
                        "preclose": float(row[6]) if row[6] else None,
                        "volume": float(row[7]) if row[7] else None,
                        "amount": float(row[8]) if row[8] else None,
                        "pct_chg": float(row[12]) if row[12] else None,
                    }
                    rows.append(row_dict)
                return _ok(rows, "baostock")
        except HTTPException:
            raise
        except Exception as e:
            # query 抛异常 — 标脏 + retry
            if attempt == 0:
                _force_reauth(f"query 异常: {e}")
                log.warning(f"baostock 异常, 标脏重试: {e}")
                continue
            log.error(f"baostock daily 失败: {e}")
            return _err(str(e), "baostock")
    # 走到这里说明两次都失败
    raise HTTPException(503, "baostock query 两次都失败 (socket 重置无效)")


@app.get("/baostock/stock_list")
def baostock_stock_list():
    """全市场股票列表 (Baostock 优势: 一次性拉全 5000+ 极快)
    返回: [{code, code_name, ipo_date, industry, ...}]
    ?v=datasources-baostock2: sync def (同 daily)
    """
    BSERR_RECVSOCK_FAIL = "10002007"
    BSERR_SOCKET_ERR = "10002001"
    for attempt in range(2):
        try:
            with _bs_session() as session:
                if session is None:
                    raise HTTPException(503, "Baostock login 失败")
                rs = session.query_stock_industry()
                if rs is None:
                    if attempt == 0:
                        _force_reauth("query_stock_industry 返 None (socket 半死)")
                        continue
                    raise HTTPException(503, "baostock query_stock_industry 返回 None")
                if rs.error_code != "0":
                    if attempt == 0 and rs.error_code in (BSERR_RECVSOCK_FAIL, BSERR_SOCKET_ERR, "10001001"):
                        _force_reauth(f"BSERR {rs.error_code} (socket 半死)")
                        continue
                    raise HTTPException(503, f"baostock error: code={rs.error_code} msg={rs.error_msg}")
                # 成功
                rows = []
                while (rs.error_code == "0") and rs.next():
                    row = rs.get_row_data()
                    code = row[1] if len(row) > 1 else ""
                    if not code or not code.startswith(("sh.", "sz.", "bj.")):
                        continue
                    rows.append({
                        "code": code.split(".")[-1],
                        "code_name": row[2] if len(row) > 2 else "",
                        "industry": row[3] if len(row) > 3 else "",
                        "ipo_date": row[4] if len(row) > 4 else "",
                    })
                return _ok(rows, "baostock", {"count": len(rows)})
        except HTTPException:
            raise
        except Exception as e:
            if attempt == 0:
                _force_reauth(f"stock_list 异常: {e}")
                log.warning(f"baostock stock_list 异常, 标脏重试: {e}")
                continue
            log.error(f"baostock stock_list 失败: {e}")
            return _err(str(e), "baostock")
    raise HTTPException(503, "baostock stock_list 两次都失败 (socket 重置无效)")


# ===== Aktools 路由 (透传 patched aktools, 实时行情) =====
# 不重复造轮, 直接转发到 patched aktools (8088)
# 优势: 实时行情 + 已经在跑的 patched aktools 端点直接复用
@app.get("/aktools/{item_id:path}")
async def aktools_proxy(item_id: str):
    """透传任何 /api/public/{item_id} 或 /api/private/{item_id} 到 patched aktools
    item_id 允许点 (例 stock_zh_a_spot_em), 用 :path 转换器接受多段 / 点路径
    """
    target = f"{AKTOOLS_BASE}/api/public/{item_id}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.get(target)
            return JSONResponse(
                status_code=r.status_code,
                content={"ok": r.status_code == 200, "source": "aktools", "data": r.json() if r.headers.get("content-type", "").startswith("application/json") else None},
            )
    except Exception as e:
        return _err(str(e), "aktools")


# ===== 多源并行 (上层只调这一个) =====
# 实际并行逻辑在 dev-proxy 端做 (Node 异步并发), 这里只暴露单源
# 但为了方便单源调试, 保留 /aktools/{path} 直通


if __name__ == "__main__":
    import uvicorn
    # ?v=datasources-baostock6: 启动 smoke test **不 logout**, 保持 socket 活着
    #   老逻辑: smoke test 末尾无条件 `bs.logout()` → 第一个 HTTP 请求来时
    #   socket 已 close → send_msg 静默 OSError → query 返 BSERR_RECVSOCK_FAIL
    #   但 sidecar 返 200 + data=[] → 上层以为"无数据"
    # 新逻辑: 成功就保留 login (把 socket 留给运行时用), 失败 3 次就放弃
    try:
        import baostock as bs
        import time as _t
        for _i in range(3):
            lg = bs.login()
            if lg.error_code == "0":
                _t.sleep(0.3)
                rs = bs.query_history_k_data_plus("sz.000001", "date,close", start_date="2024-06-01", end_date="2024-06-10", frequency="d", adjustflag="3")
                if rs and rs.error_code == "0" and rs.data:
                    log.info(f"baostock 启动 smoke test ✅ ({len(rs.data)} rows) — login 保留")
                    break
                else:
                    log.warning(f"baostock 启动 smoke test 重试 {_i+1}: rs code={rs.error_code if rs else 'None'} data_len={len(rs.data) if rs and rs.data else 0}")
                    # 失败才 logout 重试
                    try: bs.logout()
                    except: pass
            _t.sleep(0.5)
    except Exception as e:
        log.warning(f"baostock 启动 smoke test 跳过: {e}")
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8091
    print(f"[datasources] 启动: {host}:{port}", file=sys.stderr)
    print(f"[datasources] AKTOOLS_BASE={AKTOOLS_BASE}", file=sys.stderr)
    print(f"[datasources] TUSHARE_TOKEN={'已配' if TUSHARE_TOKEN else '未配 (Tushare 源下线)'}", file=sys.stderr)
    print(f"[datasources] aktools loaded from: {getattr(_aktools_check, '__file__', '?')}", file=sys.stderr)
    uvicorn.run(app, host=host, port=port, log_level="info")
