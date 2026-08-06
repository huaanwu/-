# -*- coding:utf-8 -*-
# /usr/bin/env python
"""
Date: 2024/1/12 22:05 (Patched 2026-08-06)
Desc: HTTP 模式主文件 (PATCHED: akshare 1.18+ 兼容 + TypeError 兜底 + Windows stdout 重定向)
"""
import inspect
import io
import json
import logging
import os
import sys
import urllib.parse
import warnings
from contextlib import redirect_stdout, redirect_stderr
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

# Create a logger
logger = logging.getLogger(name='AKToolsLog')
logger.setLevel(logging.INFO)

# Create a TimedRotatingFileHandler for log rotation
handler = TimedRotatingFileHandler(
    filename='/tmp/aktools_log.log' if os.getenv('VERCEL') == '1' else 'aktools_log.log',
    when='midnight', interval=1, backupCount=7, encoding='utf-8'
)
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)
logger.addHandler(handler)
logger.info('这是一个信息级别的日志消息')


# Patch start: akshare 1.18+ compatible + TypeError fallback
_func_sig_cache = {}
_dropped_kwargs_cache = {}


def _get_ak_func(item_id):
    """取 akshare 函数"""
    return getattr(ak, item_id, None)


def _filter_kwargs(item_id, func, kwargs):
    """用 inspect.signature 过滤掉函数不接受的 kwargs"""
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
    learned_dropped = _dropped_kwargs_cache.get(item_id, set())
    filtered = {}
    for k, v in kwargs.items():
        if k in accepted:
            filtered[k] = v
        elif k not in learned_dropped:
            learned_dropped.add(k)
    _dropped_kwargs_cache[item_id] = learned_dropped
    return filtered


def _parse_query_params(decode_params, has_cookie):
    """从 query string 解析成 dict"""
    if has_cookie:
        parts = decode_params.split(sep="=", maxsplit=1)
        if len(parts) == 2:
            return {parts[0]: parts[1].replace("+", " ")}
        return {}
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
    filtered = _filter_kwargs(item_id, func, kwargs)

    # Windows stdout/stderr redirect: akshare 进度条会写 Unicode 字符到 stdout
    # 在 Windows 上可能导致 OSError: [Errno 22]
    # 用 StringIO 捕获所有 stdout/stderr 输出
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    try:
        with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                result = func(**filtered)
    except OSError as e:
        # 如果 redirect 也没用（底层文件描述符问题），尝试 reconfigure
        if e.errno == 22:
            stdout_capture = io.StringIO()
            stderr_capture = io.StringIO()
            try:
                sys.stdout.reconfigure(encoding='utf-8')
                sys.stderr.reconfigure(encoding='utf-8')
                with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")
                        result = func(**filtered)
            except Exception as e2:
                return None, "call_error", f"{type(e2).__name__}: [Errno {e2.errno}] {e2.strerror}"
        else:
            return None, "call_error", f"{type(e).__name__}: [Errno {e.errno}] {e.strerror}"
    except TypeError as e:
        msg = str(e)
        import re
        m = re.search(r"unexpected keyword argument '([^']+)'", msg)
        if m:
            bad = m.group(1)
            _dropped_kwargs_cache.setdefault(item_id, set()).add(bad)
            retry_kwargs = {k: v for k, v in kwargs.items() if k != bad}
            try:
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")
                        result = func(**retry_kwargs)
            except Exception as e2:
                return None, "type_error", f"{type(e2).__name__}: {e2}"
        return None, "type_error", f"{type(e).__name__}: {msg}"
    except Exception as e:
        return None, "call_error", f"{type(e).__name__}: {e}"

    return result, None, None


def _df_to_json(df):
    """DataFrame -> JSON 列表, 失败返 None"""
    try:
        return json.loads(df.to_json(orient="records", date_format="iso"))
    except Exception as e:
        logger.warning(f"to_json 失败: {e}")
        return None


@app_core.get("/private/{item_id}", description="私人接口", summary="该接口主要提供私密访问来获取数据")
def root_private(
        request: Request,
        item_id: str,
        current_user: User = Depends(get_current_active_user),
):
    interface_list = dir(ak)
    if item_id not in interface_list:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "未找到该接口，请升级 AKShare 到最新版本并在文档中确认该接口的使用方式：https://akshare.akfamily.xyz"},
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
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"error": "该接口返回数据为空，请确认参数是否正确：https://akshare.akfamily.xyz"})
    temp_df = _df_to_json(received_df)
    if temp_df is None:
        return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content={"error": "序列化失败"})
    return JSONResponse(status_code=status.HTTP_200_OK, content=temp_df)


@app_core.get("/public/{item_id}", description="公开接口", summary="该接口主要提供公开访问来获取数据")
def root_public(request: Request, item_id: str):
    interface_list = dir(ak)
    if item_id not in interface_list:
        logger.info("未找到该接口，请升级 AKShare 到最新版本并在文档中确认该接口的使用方式：https://akshare.akfamily.xyz")
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "未找到该接口，请升级 AKShare 到最新版本并在文档中确认该接口的使用方式：https://akshare.akfamily.xyz"},
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
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"error": "该接口返回数据为空，请确认参数是否正确：https://akshare.akfamily.xyz"})
    temp_df = _df_to_json(received_df)
    if temp_df is None:
        return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content={"error": "序列化失败"})
    logger.info(f"获取到 {item_id} 的数据 (kwargs={list(kwargs.keys())})")
    return JSONResponse(status_code=status.HTTP_200_OK, content=temp_df)


def generate_html_response():
    file_path = get_pyscript_html(file="akscript.html")
    with open(file_path, encoding="utf8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content, status_code=200)


short_path = get_template_path()
templates = Jinja2Templates(directory=short_path)


@app_core.get(path="/show-temp/{interface}", response_class=HTMLResponse, description="展示 PyScript", summary="该接口主要展示 PyScript 游览器运行 Python 代码")
def akscript_temp(request: Request, interface: str):
    return templates.TemplateResponse("akscript.html", context={"request": request, "ip": request.headers["host"], "interface": interface})


@app_core.get(path="/show", response_class=HTMLResponse, description="展示 PyScript", summary="该接口主要展示 PyScript 游览器运行 Python 代码")
def akscript():
    return generate_html_response()
