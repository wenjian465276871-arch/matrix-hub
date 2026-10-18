"""electro-assist API。

P1a 起点：先把 A2 的契约（领域模型 + 视觉 DSL）钉死，再往上长生成与渲染。
健康检查保持轻量、无外部依赖，供部署脚本与容器探针使用。
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

import store
from routers import guides as guides_router
from routers import schema as schema_router
from routers import uploads as uploads_router

APP_ENV = os.getenv("APP_ENV", "dev")
IS_PROD = APP_ENV == "prod"

log = logging.getLogger("electro")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """启动时建表并跑迁移。

    失败必须让容器起不来：一个连数据库都打不开的实例，healthz 返回 ok 只会
    让部署脚本误判"部署成功"。
    """
    applied = store.init_db()
    log.info("DB ready at %s（本次应用迁移：%s）", store.db_path(), applied or "无")
    yield


app = FastAPI(
    title="electro-assist API",
    version="0.2.0",
    description="电气调试 AI 作业助手：A2 指导书生成 / A1 引导作业 / B 故障排查",
    docs_url=None if IS_PROD else "/docs",
    redoc_url=None,
    openapi_url=None if IS_PROD else "/openapi.json",
    lifespan=lifespan,
)

app.include_router(schema_router.router)
app.include_router(uploads_router.router)
app.include_router(guides_router.router)


@app.get("/healthz", tags=["ops"])
def healthz() -> dict:
    """部署脚本与容器探针依赖此端点。

    加入 DB 检查的理由：读写数据库是后续所有业务端点的前提，
    只探进程活着等于把"能起不能干活"判成健康。
    """
    checks = {"electro": "ok"}
    try:
        store.ping()
        checks["db"] = "ok"
    except Exception as exc:  # noqa: BLE001 - 健康检查不该因为异常类型而 500
        log.warning("healthz DB 检查失败：%s", exc)
        checks["db"] = "error"

    status = "ok" if all(v == "ok" for v in checks.values()) else "degraded"
    return {"status": status, "checks": checks}
