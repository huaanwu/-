# -*- coding:utf-8 -*-
# /usr/bin/env python
"""
Date: 2024/1/12 22:05 (Patched 2026-08-06)
Desc: HTTP 模式主文件 (PATCHED: akshare 1.18+ 兼容 + TypeError 兜底)
"""
import inspect
import json
import logging
import os
import urllib.parse
from logging.handlers import TimedRotatingFileHandler

import akshare as ak
from fastapi import APIRouter
from fastapi import Depends, status
from fastapi import Request
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.templating import Jinja2Templates

from aktools.datasets import get_pyscript_html, get_template_path
from aktools.login.user_login import User, get_current_active_user

app_core = APIRouter()

# 创建一个日志记录器
logger = logging.getLogger(name='AKToolsLog')
logger.setLevel(logging.INFO)

# 创建一个TimedRotatingFileHandler来进行日志轮转
handler = TimedRotatingFileHandler(
    filename='/tmp/aktools_log.log' if os.getenv('VERCEL') == '1' else 'aktools_log.log',
        when='midnight', interval=1, backupCount=7, encoding='utf-8'
)
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)
logger.addHandler(handler)

# 使用日志记录器记录信息
logger.info('这是一个信息级别的日志消息')


# ===== PATCH START (2026-08-06): akshare 1.18+ 兼容 =====
# 旧 aktools 0.0.91 直接 eval 拼字符串传参, akshare 升级后函数签名变了就 TypeError 500
# 这里改成 inspect.signature 自动过滤掉不兼容的 kwargs, 然后再调用
# 同时 catch TypeError (旧代码只 catch KeyError) 兜底为 422

# 函数签名缓存 (避免每个请求都 inspect 一次)
_func_sig_cache = {}
# 函数名 -> 不兼容的 kwargs 列表 (从 TypeError 学习, 后续请求自动去掉)
_dropped_kwargs_cache = {}


def _get_ak_func(item_id):
    """取 akshare 函数, 处理可能的属性/子模块路径 (例: stock_zh_a_spot_em 直接在 ak 下)"""
    return getattr(ak, item_id, None)


def _filter_kwargs(item_id, func, kwargs):
    """用 inspect.signature 过滤掉函数不接受的 kwargs; 如果函数接受 **kwargs 则不过滤"""
    try:
        sig = inspect.signature(func)
    except (ValueError, TypeError):
        return kwargs
    has_var_keyword = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    if has_var_keyword:
        return kwargs
    accepted = {p.name for p in sig.parameters.values()
                if p.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD,
                              inspect.Parameter.KEYWORD_ONLY)}
    # 应用之前学到的 dropped kwargs (本函数已知不接受的)
    learned_dropped = _dropped_kwargs_cache.get(item_id, set())
    filtered = {}
    for k, v in kwargs.items():
        if k in accepted or k in learned_dropped or k not in accepted:
            if k not in accepted and k not in learned_dropped:
                # 第一次见这个不接受的 kwarg, 加进 learned
                learned_dropped.add(k)
            if k in accepted:
                filtered[k] = v
            # else: 跳过 (不接受的)
    _dropped_kwargs_cache[item_id] = learned_dropped
    return filtered


def _parse_query_params(decode_params, has_cookie):
    """从 query string 解析成 dict"""
    if has_cookie:
        # 旧逻辑: cookie 模式只取第一个 key
        parts = decode_params.split(sep="=", maxsplit=1)
        if len(parts) == 2:
            return {parts[0]: parts[1].replace("+", " ")}
        return {}
    # 标准: key=value&key2=value2
    result = {}
    for kv in decode_params.split("&"):
        if "=" not in kv:
            continue
        k, v = kv.split("=", 1)
        result[k] = v.replace("+", " ")
    return result


def _call_ak(item_id, kwargs):
    """调 ak.<item_id> 自动过滤不兼容 kwargs, 返 (data, error_type, error_msg)"""
    func = _get_ak_func(item_id)
    if func is None or not callable(func):
        return None, "not_found", f"ak.{item_id} 不存在或不可调用"
    try:
        filtered = _filter_kwargs(item_id, func, kwargs)
        return func(**filtered), None, None
    except TypeError as e:
        # 第一次 filter 没拦住 (可能是 inspect 失败 / 函数签名动态变化), 再裸调一次不带可疑 kwarg
        msg = str(e)
        # 尝试从错误信息提取不接受的 kwarg 名 (例: "got an unexpected keyword argument 'symbol'")
        import re
        m = re.search(r"unexpected keyword argument '([^']+)'", msg)
        if m:
            bad = m.group(1)
            _dropped_kwargs_cache.setdefault(item_id, set()).add(bad)
            retry_kwargs = {k: v for k, v in kwargs.items() if k != bad}
            try:
                return func(**retry_kwargs), None, None
            except Exception as e2:
                return None, "type_error", f"{type(e2).__name__}: {e2}"
        return None, "type_error", f"{type(e).__name__}: {msg}"
    except Exception as e:
        return None, "call_error", f"{type(e).__name__}: {e}"


def _df_to_json(df):
    """DataFrame → JSON 列表, 失败返 None"""
    try:
        return json.loads(df.to_json(orient="records", date_format="iso"))
    except Exception as e:
        logger.warning(f"to_json 失败: {e}")
        return None
# ===== PATCH END =====


@app_core.get("/private/{item_id}", description="私人接口", summary="该接口主要提供私密访问来获取数据")
def root(
        request: Request,
        item_id: str,
        current_user: User = Depends(get_current_active_user),
):
    """
    接收请求参数及接口名称并返回 JSON 数据
    此处由于 AKShare 的请求中是同步模式，所以这边在定义 root 函数中没有使用 asyncio 来定义，这样可以开启多线程访问
    :param request: 请求信息
    :type request: Request
    :param item_id: 必选参数; 测试接口名 ak.stock_dxsyl_em() 来获取 打新收益率 数据
    :type item_id: str
    :param current_user: 依赖注入，为了进行用户的登录验证
    :type current_user: str
    :return: 指定 接口名称 和 参数 的数据
    :rtype: json
    """
    interface_list = dir(ak)
    if item_id not in interface_list:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={
                "error": "未找到该接口，请升级 AKShare 到最新版本并在文档中确认该接口的使用方式：https://akshare.akfamily.xyz"
            },
        )
    decode_params = urllib.parse.unquote(str(request.query_params))
    has_cookie = "cookie" in decode_params
    kwargs = _parse_query_params(decode_params, has_cookie) if request.query_params else {}
    received_df, err_type, err_msg = _call_ak(item_id, kwargs)
    if err_type == "not_found":
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"error": err_msg})
    if err_type in ("type_error", "call_error"):
        # PATCH: TypeError → 422 (参数不兼容), call_error → 500
        status_code = status.HTTP_422_UNPROCESSABLE_ENTITY if err_type == "type_error" else status.HTTP_500_INTERNAL_SERVER_ERROR
        return JSONResponse(status_code=status_code, content={"error": err_msg, "dropped_kwargs": list(_dropped_kwargs_cache.get(item_id, []))})
    if received_df is None:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "该接口返回数据为空，请确认参数是否正确：https://akshare.akfamily.xyz"},
        )
    temp_df = _df_to_json(received_df)
    if temp_df is None:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "序列化失败"},
        )
    return JSONResponse(status_code=status.HTTP_200_OK, content=temp_df)


@app_core.get(path="/public/{item_id}", description="公开接口", summary="该接口主要提供公开访问来获取数据")
def root(request: Request, item_id: str):
    """
    接收请求参数及接口名称并返回 JSON 数据
    此处由于 AKShare 的请求中是同步模式，所以这边在定义 root 函数中没有使用 asyncio 来定义，这样可以开启多线程访问
    :param request: 请求信息
    :type request: Request
    :param item_id: 必选参数; 测试接口名 stock_dxsyl_em 来获取 打新收益率 数据
    :type item_id: str
    :return: 指定 接口名称 和 参数 的数据
    :rtype: json
    """
    interface_list = dir(ak)
    if item_id not in interface_list:
        logger.info("未找到该接口，请升级 AKShare 到最新版本并在文档中确认该接口的使用方式：https://akshare.akfamily.xyz")
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={
                "error": "未找到该接口，请升级 AKShare 到最新版本并在文档中确认该接口的使用方式：https://akshare.akfamily.xyz"
            },
        )
    decode_params = urllib.parse.unquote(str(request.query_params))
    has_cookie = "cookie" in decode_params
    kwargs = _parse_query_params(decode_params, has_cookie) if request.query_params else {}
    received_df, err_type, err_msg = _call_ak(item_id, kwargs)
    if err_type == "not_found":
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"error": err_msg})
    if err_type in ("type_error", "call_error"):
        status_code = status.HTTP_422_UNPROCESSABLE_ENTITY if err_type == "type_error" else status.HTTP_500_INTERNAL_SERVER_ERROR
        return JSONResponse(status_code=status_code, content={"error": err_msg, "dropped_kwargs": list(_dropped_kwargs_cache.get(item_id, []))})
    if received_df is None:
        logger.info("该接口返回数据为空，请确认参数是否正确：https://akshare.akfamily.xyz")
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "该接口返回数据为空，请确认参数是否正确：https://akshare.akfamily.xyz"},
        )
    temp_df = _df_to_json(received_df)
    if temp_df is None:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "序列化失败"},
        )
    logger.info(f"获取到 {item_id} 的数据 (kwargs={list(kwargs.keys())})")
    return JSONResponse(status_code=status.HTTP_200_OK, content=temp_df)


def generate_html_response():
    file_path = get_pyscript_html(file="akscript.html")
    with open(file_path, encoding="utf8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content, status_code=200)


short_path = get_template_path()
templates = Jinja2Templates(directory=short_path)


@app_core.get(
    path="/show-temp/{interface}",
    response_class=HTMLResponse,
    description="展示 PyScript",
    summary="该接口主要展示 PyScript 游览器运行 Python 代码",
)
def akscript_temp(request: Request, interface: str):
    return templates.TemplateResponse(
        "akscript.html",
        context={
            "request": request,
            "ip": request.headers["host"],
            "interface": interface,
        },
    )


@app_core.get(
    path="/show",
    response_class=HTMLResponse,
    description="展示 PyScript",
    summary="该接口主要展示 PyScript 游览器运行 Python 代码",
)
def akscript():
    return generate_html_response()
