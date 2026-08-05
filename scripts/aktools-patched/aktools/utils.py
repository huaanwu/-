# -*- coding:utf-8 -*-
"""
Date: 2024/12/12 18:00 (PATCHED 2026-08-06: PyPI timeout + fail-soft)
Desc: 工具函数
"""
from functools import lru_cache

import requests


@lru_cache()
def get_latest_version(package: str = "akshare") -> str:
    """
    获取开源库的最新版本
    https://pypi.org/project/akshare/
    :param package: 库名称
    :type package: str
    :return: 版本
    :rtype: str
    """
    # PATCH: 加 timeout=5 防止 PyPI 不可达时永远 hang (aktools 0.0.91 旧版用 requests.get 无 timeout)
    url = f"https://pypi.org/pypi/{package}/json"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/58.0.3029.110 Safari/537.3"
    }
    try:
        # 5s 超时足够, 失败/超时都走 fail-soft 返 "0.0.0"
        r = requests.get(url, headers=headers, timeout=5)
    except (requests.exceptions.ProxyError, requests.exceptions.Timeout,
            requests.exceptions.ConnectionError, Exception):
        # PATCH: 任何网络异常都吞掉, 返 "0.0.0" 让 /version 端点不 hang
        return "0.0.0"
    try:
        data_json = r.json()
        version = data_json['info']['version']
        return version
    except Exception:
        # PATCH: 解析失败也返 0.0.0
        return "0.0.0"
