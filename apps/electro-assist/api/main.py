"""electro-assist API。

P1a 起点：先把 A2 的契约（领域模型 + 视觉 DSL）钉死，再往上长生成与渲染。
健康检查保持轻量、无外部依赖，供部署脚本与容器探针使用。
"""
from __future__ import annotations

import logging
import os
import secrets
import shutil
import socket
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

import store
from core.httpwindow import HttpWindow
from routers import diagnose as diagnose_router
from routers import extract as extract_router
from routers import fe as fe_router
from routers import guides as guides_router
from routers import jobs as jobs_router
from routers import passcode as passcode_router
from routers import processes as processes_router
from routers import quota as quota_router
from routers import records as records_router
from routers import schema as schema_router
from routers import sessions as sessions_router
from routers import uploads as uploads_router
from services import generation, library, retention
from services import quota as quota_service

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
    # 存量指导书保留着作者当年的 schema_version，会让"部署是否生效"难以判断。
    # 只改版本戳、内容过校验才写回，见 library.normalize_schema_versions。
    bumped = library.normalize_schema_versions()
    if bumped:
        log.info("版本戳归一化：%d 份存量指导书", bumped)
    generation.start_worker()
    # 保留期（计划 §11.3.3）：启动时一次 + 每日一次。默认只在 prod 开，
    # 开发机与测试库上自动删数据是灾难。cron 仍保留，作为进程没起来时的冗余。
    retention.start()
    try:
        yield
    finally:
        retention.stop()
        generation.stop_worker()


app = FastAPI(
    title="electro-assist API",
    version="0.6.0",
    description="电气调试 AI 作业助手：A2 指导书生成 / A1 引导作业 / B 故障排查",
    docs_url=None if IS_PROD else "/docs",
    redoc_url=None,
    openapi_url=None if IS_PROD else "/openapi.json",
    lifespan=lifespan,
)

# 进程级滚动窗口：部署后看门狗读 `/healthz` 的 http 段决定是否回滚。
# 进程重启即清零，这正是想要的口径——只看"这一版跑起来之后"的表现。
http_window = HttpWindow()


def _fault_paths() -> tuple[str, ...]:
    """读 `FAULT_5XX_PATHS`（逗号分隔的路径前缀）。每次请求都读，不改就基本零成本。

    按请求读取而不是启动时缓存，是为了让测试能 `monkeypatch.setenv` 直接验行为——
    启动时读一次的实现只能靠重启进程来测，那种测试最后一定是"没测"。
    """
    raw = os.getenv("FAULT_5XX_PATHS", "")
    return tuple(part.strip() for part in raw.split(",") if part.strip())


@app.middleware("http")
async def attach_request_ref(request: Request, call_next):
    """给每个请求一个 8 位 ref，同时回写到响应头。

    没有它，线上 500 只能靠时间对齐日志；用户报障也说不出可检索的编号。

    顺带记一笔滚动 5xx 比例（`core.httpwindow`）：部署后的看门狗靠它判断
    "起来了但每个请求都 502"这种健康检查看不出来的故障。排除 `/healthz`
    的理由写在 HttpWindow 的模块注释里——探针会把真实比例稀释一个数量级。
    """
    ref = (request.headers.get("X-Request-Id") or secrets.token_hex(4))[:16]
    request.state.ref = ref
    counted = request.url.path != "/healthz"

    # 演练用的故障注入（2026-11-08 加，为验证"部署后看门狗自动回滚"那条链路）。
    # 没有它，O2 只能等真事故来验——而第一次真事故正是最不该做实验的时候。
    # 三条约束，缺一条都会把它变成新的风险：
    #   ① 默认空 ⇒ 生产不受影响（`.env` 里不写这两个变量就等于没这功能）；
    #   ② 显式路径前缀，不搞"全局 5xx 比例"——那会把站点真的打挂，演练不该有这种杀伤；
    #   ③ 只返回纯文本，不套统一信封：这是**人造**故障，页面上看到"fault-injected"
    #      比看到一条像模像样的业务错误码更安全（不会有人把它当真实故障去排查）。
    faults = _fault_paths()
    if faults and request.url.path != "/healthz" and any(
        request.url.path.startswith(p) for p in faults
    ):
        log.warning("故障注入生效：%s（FAULT_5XX_PATHS=%s）", request.url.path, ",".join(faults))
        if counted:
            http_window.record(500)
        return PlainTextResponse("fault-injected", status_code=500, headers={"X-Request-Id": ref})

    try:
        response = await call_next(request)
    except Exception:
        # 未处理异常由 ServerErrorMiddleware 变成 500，但它在这层之外生成响应：
        # 不在这里补记，"每个请求都 500"在窗口里就是零错误——最该回滚的故障反而看不见。
        if counted:
            http_window.record(500)
        raise
    if counted:
        http_window.record(response.status_code)
    response.headers["X-Request-Id"] = ref
    return response


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    """兜底：未捕获异常也必须返回统一信封（与业务错误同形）。

    Starlette 默认的 500 是纯文本 `Internal Server Error`，
    前端解析失败只能显示"未知错误"，排障时也没有任何线索。
    """
    ref = getattr(request.state, "ref", "-")
    log.exception("未处理异常 ref=%s path=%s", ref, request.url.path)
    body = {
        "detail": {
            "code": "internal_error",
            "message": "服务内部错误，请稍后重试",
            "ref": ref,
        }
    }
    response = JSONResponse(status_code=500, content=body)
    response.headers["X-Request-Id"] = ref
    return response


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError):
    """422 也必须走 `{detail:{code,message}}`。

    此前 FastAPI 的默认处理器返回 `{"detail":[{loc,msg,type}...]}`：前端读不到
    `code`，只能把"现象描述太短"显示成"未知错误"。`processes.py` 曾为此在每个
    端点手写长度校验来绕开默认格式——补上这一层，长度约束才能回到 schema 里。

    字段位置去掉 `body.` 前缀：前端要的是"哪个输入框"，不是 Pydantic 的路径语法。
    只回前 5 条：一次全字段校验失败几十条，用户既读不完也用不上。
    """
    ref = getattr(request.state, "ref", "-")
    errors = []
    for err in exc.errors()[:5]:
        parts = [str(part) for part in err.get("loc", ())]
        # 去掉 Pydantic 的来源前缀（body/query/path/header/cookie）：
        # 前端要的是"哪个输入框"，不是它在请求里的位置语法。
        if parts and parts[0] in ("body", "query", "path", "header", "cookie"):
            parts = parts[1:]
        location = ".".join(parts)
        errors.append(
            {
                "field": location or "body",
                "message": str(err.get("msg", "")),
            }
        )
    log.info("请求校验失败 ref=%s path=%s errors=%s", ref, request.url.path, errors)
    return JSONResponse(
        status_code=422,
        content={
            "detail": {
                "code": "invalid_request",
                "message": "请求参数不合法，请检查后重试",
                "errors": errors,
                "ref": ref,
            }
        },
        headers={"X-Request-Id": ref},
    )


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    """`HTTPException` 的字符串 detail 也收进信封。

    路由层多数已经传 dict，但框架自身会抛出字符串 detail（404 无路由、405 方法不允许、
    Caddy 后面的兜底 404）。不归一的话，前端同一个 `detail` 字段有时是对象有时是字符串，
    `parseErrorResponse` 只能放弃解析。
    """
    ref = getattr(request.state, "ref", "-")
    if isinstance(exc.detail, dict):
        detail = dict(exc.detail)
    else:
        detail = {"code": f"http_{exc.status_code}", "message": str(exc.detail)}
    # 5xx 才带 ref：4xx 大多是用户可自行修正的输入问题，塞错误号只会干扰阅读。
    if exc.status_code >= 500:
        detail.setdefault("ref", ref)
    response = JSONResponse(
        status_code=exc.status_code,
        content={"detail": detail},
        headers=exc.headers,
    )
    response.headers["X-Request-Id"] = ref
    return response


app.include_router(schema_router.router)
app.include_router(processes_router.router)
app.include_router(uploads_router.router)
app.include_router(extract_router.router)
app.include_router(guides_router.router)
app.include_router(jobs_router.router)
app.include_router(passcode_router.router)
app.include_router(quota_router.router)
app.include_router(sessions_router.router)
app.include_router(records_router.router)
app.include_router(diagnose_router.router)
app.include_router(fe_router.router)


def _probe_caddy() -> str:
    """探 Caddy 入口是否还在监听。

    为什么用 TCP 而不是再发一次 HTTP：从容器内请求 `http://127.0.0.1/healthz`
    会经 Caddy 回到本进程，形成一次自调用；健康检查不该制造业务流量。
    端口可配是因为本地开发没有 Caddy，测试要能把它指到关闭的端口。
    """
    try:
        port = int(os.getenv("HEALTHZ_CADDY_PORT", "80"))
    except ValueError:
        port = 80
    try:
        timeout = float(os.getenv("HEALTHZ_CADDY_TIMEOUT", "0.3"))
    except ValueError:
        timeout = 0.3
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return "ok"
    except OSError as exc:
        log.warning("healthz Caddy 探测失败（127.0.0.1:%d）：%s", port, exc)
        return "error"


def _electro_checks() -> dict[str, str]:
    """进程 + 数据库 + 磁盘：现有 `/healthz` 的三项。"""
    checks = {"electro": "ok"}
    try:
        store.ping()
        checks["db"] = "ok"
    except Exception as exc:  # noqa: BLE001 - 健康检查不该因为异常类型而 500
        log.warning("healthz DB 检查失败：%s", exc)
        checks["db"] = "error"

    try:
        usage = shutil.disk_usage(os.path.dirname(store.db_path()) or ".")
        free_ratio = usage.free / usage.total if usage.total else 0.0
        try:
            threshold = float(os.getenv("HEALTHZ_MIN_FREE_RATIO", "0.10"))
        except ValueError:
            # 配置写错不该让站点永久 degraded：退回默认值并继续工作。
            threshold = 0.10
        checks["disk"] = "ok" if free_ratio >= threshold else "error"
        if checks["disk"] == "error":
            log.warning(
                "healthz 磁盘余量不足：free=%.1f%% threshold=%.1f%%",
                free_ratio * 100,
                threshold * 100,
            )
    except Exception as exc:  # noqa: BLE001 - 取不到磁盘信息本身就不算健康
        log.warning("healthz 磁盘检查失败：%s", exc)
        checks["disk"] = "error"
    return checks


@app.get("/healthz", tags=["ops"], response_model=dict)
def healthz(
    scope: str | None = Query(
        default=None,
        description="live=进程；ready/electro=进程+DB+磁盘；all=再加 Caddy。"
        "显式 scope 时 readiness 失败返回 503。",
        pattern="^(live|ready|electro|all)$",
    ),
):
    """健康检查。默认口径不变，显式 scope 才启用分级判定。

    为什么必须分级（计划 §2.4）：容器探针只想要"进程还在吗"，部署脚本要看
    "这一版能不能接流量"，监控还想知道 Caddy 有没有起来。三者混在一个端点、
    一个状态码上，就必然出现"healthz 200 但每个请求都 502"。
    现在：`live` 永远 200；`ready`/`electro` 任一检查失败返回 **503**；
    `all` 额外探 Caddy。默认（不带 scope）保持 200 + 完整报告，供 uptime 与人工查看。

    预算仍然只报告、不参与判定——预算是业务指标，把"今天花了 85%"判成不健康，
    会让部署回滚一个完全正常的版本。
    """
    if scope == "live":
        return {"status": "ok", "scope": "live", "checks": {"process": "ok"}}

    checks = _electro_checks()
    include_caddy = scope == "all"
    if include_caddy:
        checks["caddy"] = _probe_caddy()

    status = "ok" if all(value == "ok" for value in checks.values()) else "degraded"

    # 显式 readiness 才带 HTTP 状态码；默认口径必须保持 200，
    # 否则 uptime 与既有看板会把"磁盘 89%"读成整站宕机。
    http_status = 200 if scope is None or status == "ok" else 503

    payload: dict = {"status": status, "checks": checks}
    if scope is not None:
        payload["scope"] = scope

    # 预算与滚动窗口只给默认报告与 scope=all：
    # readiness 每 30 秒被探一次，没必要每次都做三次用量统计。
    if scope is None or include_caddy:
        budget: dict = {"level": "unknown"}
        try:
            budget_status = quota_service.budget_status()
            quota_service.alert_if_needed(budget_status)
            budget = budget_status.to_dict()
        except Exception as exc:  # noqa: BLE001 - 读不到用量不该让健康检查 500
            log.warning("healthz 预算检查失败：%s", exc)
        payload["budget"] = budget
        payload["http"] = http_window.snapshot()

        # 保留期清理状态：**只报告，不参与 status 判定**。
        # 清理失败意味着数据没按期删除，但站点仍然完全可用；若把它算进 ready，
        # 一次凌晨清理失败就会让部署脚本 503、看门狗回滚掉一个正常版本。
        # 真正的用法是：监控或人读这个字段，连续失败次数 >0 就该去看日志。
        state = retention.read_state()
        if state:
            payload["retention"] = state

    return JSONResponse(status_code=http_status, content=payload)
