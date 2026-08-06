# -*- coding:utf-8 -*-
"""
FastAPI app entry point for AKTools (Patched)
Patched 2026-08-06: use app_core from core.api, add /health endpoint
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from aktools.core.api import app_core

app = FastAPI(
    title="AKTools for AKShare",
    version="0.0.91-patched",
    description="AKShare HTTP API wrapper with signature compatibility fixes",
)

# CORS - allow all origins (dev mode)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include the core API router
app.include_router(app_core)

# Custom health endpoint
@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.0.91-patched"}

# Root endpoint - serve the HTML page
@app.get("/")
async def root():
    from aktools.datasets import get_pyscript_html
    from fastapi.responses import HTMLResponse
    file_path = get_pyscript_html(file="homepage.html")
    with open(file_path, encoding="utf-8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)
