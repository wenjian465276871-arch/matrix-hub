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
from routers import diagnose as diagnose_router
from routers import guides as guides_router
from routers import jobs as jobs_router
from routers import quota as quota_router
from routers import records as records_router
from routers import schema as schema_router
from routers import sessions as sessions_router
from routers import uploads as uploads_router
from services import generation, library

APP_ENV = os.getenv("APP_ENV", "dev")
IS_PROD = APP_ENV == "prod"

# 进程内新建的文件（SQLite 库、上传重编码产物）默认 600：
# 计划 §11.3.3 要求数据库仅容器内 app 用户可读。umask 只影响新文件，
# 历史文件需要一次性 chmod（见 OPERATIONS §7）。
os.umask(0o077)

log = logging.getLogger("electro")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """启动时建表、清扫残留 job、导入样例、拉起生成 worker。

    失败必须让容器起不来：一个连数据库都打不开的实例，healthz 返回 ok 只会
    让部署脚本误判"部署成功"。
    """
    applied = store.init_db()
    log.info("DB ready at %s（本次应用迁移：%s）", store.db_path(), applied or "无")

    # 每次部署都会换进程，上一次的 queued/running 已经不可能被执行。
    stale = generation.recover_stale()
    if stale:
        log.warning("启动清扫：%d 个残留 job 标记为 timeout", stale)

    library.ensure_seeded()
    generation.start_worker()
    try:
        yield
    finally:
        generation.stop_worker()


app = FastAPI(
    title="electro-assist API",
    version="0.5.0",
    description="电气调试 AI 作业助手：A2 指导书生成 / A1 引导作业 / B 故障排查",
    docs_url=None if IS_PROD else "/docs",
    redoc_url=None,
    openapi_url=None if IS_PROD else "/openapi.json",
    lifespan=lifespan,
)

app.include_router(schema_router.router)
app.include_router(uploads_router.router)
app.include_router(guides_router.router)
app.include_router(jobs_router.router)
app.include_router(quota_router.router)
app.include_router(sessions_router.router)
app.include_router(records_router.router)
app.include_router(diagnose_router.router)


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
