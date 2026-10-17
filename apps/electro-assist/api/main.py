"""electro-assist API。

P1a 起点：先把 A2 的契约（领域模型 + 视觉 DSL）钉死，再往上长生成与渲染。
健康检查保持轻量、无外部依赖，供部署脚本与容器探针使用。
"""
from __future__ import annotations

import os

from fastapi import FastAPI

from routers import schema as schema_router
from routers import uploads as uploads_router

APP_ENV = os.getenv("APP_ENV", "dev")
IS_PROD = APP_ENV == "prod"

app = FastAPI(
    title="electro-assist API",
    version="0.2.0",
    description="电气调试 AI 作业助手：A2 指导书生成 / A1 引导作业 / B 故障排查",
    docs_url=None if IS_PROD else "/docs",
    redoc_url=None,
    openapi_url=None if IS_PROD else "/openapi.json",
)

app.include_router(schema_router.router)
app.include_router(uploads_router.router)


@app.get("/healthz", tags=["ops"])
def healthz() -> dict:
    """部署脚本与容器健康检查依赖此端点，保持轻量、无外部依赖。"""
    return {"status": "ok", "checks": {"electro": "ok"}}
