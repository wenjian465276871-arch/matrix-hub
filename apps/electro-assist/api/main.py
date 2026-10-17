"""electro-assist API —— P0 阶段仅提供健康检查，业务端点随 P1a 增量加入。"""
from __future__ import annotations

import os

from fastapi import FastAPI

APP_ENV = os.getenv("APP_ENV", "dev")
IS_PROD = APP_ENV == "prod"

app = FastAPI(
    title="electro-assist API",
    version="0.1.0",
    docs_url=None if IS_PROD else "/docs",
    redoc_url=None,
    openapi_url=None if IS_PROD else "/openapi.json",
)


@app.get("/healthz")
def healthz() -> dict:
    """部署脚本与容器健康检查依赖此端点，保持轻量、无外部依赖。"""
    return {"status": "ok", "checks": {"electro": "ok"}}
