"""错误码登记表：API 响应体 `detail.code` 与异步任务 `error_code` 的唯一事实源。

为什么要有这张表：错误码本来散在 13 个 router 和 6 个异常类里，前端只能靠 HTTP 状态
猜语义，新增一个码也没有任何地方会提醒你「文档没写它」。2026-11-08 之前
`docs/API.md` 只有端点表、没有码表，计划 §12.8 要求的「P0 冻结错误码表」一直空着。

现在的约束是**双向**的，由 `verify()` 保证，`scripts/export_openapi.py --check`
与 `tests/test_error_codes.py` 各调用一次：

- 代码里出现的码 → 必须在 `ERROR_CODES` 里（防新增未登记）；
- `ERROR_CODES` 里的码 → 必须在代码里真的用得上（防表里养死条目）；
- 用了 f-string 拼码的位置 → 前缀必须登记在 `PREFIX_FAMILIES`（防「动态码」变成黑洞）。

`status` 只在**该码恒用同一个状态**时才写数字。异常类抛出的码状态由端点的
`except` 决定（同一个 `session_closed` 在提交步骤和结束会话都是 409，但那是端点的
选择，不是码的性质），这类写 `None`，表格里显示「由端点定」。
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]

# 扫描范围：只扫生产代码。tests/ 里当然也会出现码（断言用），但它们不该成为事实源。
SCAN_DIRS = ("routers", "core", "services", "llm", "models")
SCAN_FILES = ("main.py",)
SKIP_DIRS = {"tests", "scripts", "__pycache__", ".venv", "data"}

# 首参即错误码的异常类。新增这类异常时**必须**加进来，否则它的码不会被扫描到，
# 表里也不会提醒——这是本文件唯一的「需要人记住」的地方，所以放在顶部显眼位置。
CODE_EXCEPTIONS = frozenset(
    {
        "CriterionError",
        "DiagnosisError",
        "QuotaError",
        "RevisionError",
        "SessionError",
        "LLMError",
    }
)


@dataclass(frozen=True)
class ErrorSpec:
    """一个码的登记项。

    `where` 写模块而不是行号：行号每次都漂，写进文档第二天就是错的。
    """

    message: str
    status: int | None = None
    where: str = ""


@dataclass(frozen=True)
class PrefixFamily:
    """用 f-string 拼出来的码族，如 `extract_{kind}`。

    `members` 是可能拼进花括号的取值集合；它同时出现在 `ERROR_CODES` 里
    （那些值在代码里是异常构造的首参，会被扫描到），这里只负责让文档说清楚
    「拼出来的码长什么样、谁能出现」。
    """

    pattern: str
    message: str
    where: str
    members: tuple[str, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------- 码表
#
# 分组顺序与 `docs/API.md` §5 的表格一致：先阅读者最常撞到的，再按模块。

ERROR_CODES: dict[str, ErrorSpec] = {
    # ---- 通用与框架兜底
    "invalid_request": ErrorSpec("请求体不合 schema（字段缺失、类型错、长度越界）", 422, "main.py"),
    "not_found": ErrorSpec("资源不存在，或凭当前 id 读不到", 404, "routers/guides.py 等"),
    "internal_error": ErrorSpec("未预期异常，响应带 `ref` 供查日志", 500, "main.py"),
    "rate_limited": ErrorSpec("该 IP 的窗口配额已用完，响应带 `retry_after`", 429, "core/ratelimit.py 调用方"),
    # ---- 口令
    "passcode_required": ErrorSpec("该操作需要口令令牌，请求没带 `X-Passcode-Token`", 401, "routers/guides.py"),
    "passcode_invalid": ErrorSpec("口令或令牌不正确 / 已过期（令牌 12 小时）", 401, "routers/jobs.py"),
    "passcode_disabled": ErrorSpec("服务端没配置口令，写入口整体关闭", 503, "routers/guides.py"),
    # ---- 工艺文本与生成
    "input_too_short": ErrorSpec("工艺文本少于 10 字符，不够生成一份指导书", 422, "routers/processes.py"),
    "input_too_long": ErrorSpec("工艺文本超过 20,000 字符上限", 422, "routers/processes.py"),
    "process_not_found": ErrorSpec("工艺原文不存在，或已过 30 天保留期", 404, "routers/processes.py"),
    "idempotency_key_required": ErrorSpec("提交步骤必须带 `Idempotency-Key`，否则无法保证重投不产生第二条记录", 400, "routers/sessions.py"),
    "busy": ErrorSpec("生成队列已满，任务未被接收（异步任务的 `error_code`）", None, "services/generation.py"),
    "internal": ErrorSpec("生成过程抛了非 LLM 异常（异步任务的 `error_code`，详情是异常类名）", None, "services/generation.py"),
    # ---- 素材上传与切图
    "too_large": ErrorSpec("图片超过 5MB", 413, "routers/uploads.py"),
    "unreadable": ErrorSpec("图片无法解码（损坏、或不是 png/jpg/webp）", 422, "routers/uploads.py"),
    "bad_asset_id": ErrorSpec("素材 id 格式不合法（应为 `a_` + 16 位十六进制）", 400, "routers/uploads.py"),
    "bad_path": ErrorSpec("取图路径不合法（文件名不在该素材的切片清单里）", 400, "routers/uploads.py"),
    "bad_region_id": ErrorSpec("切块 id 格式不合法", 400, "routers/uploads.py"),
    "region_not_found": ErrorSpec("切块不存在", 404, "routers/uploads.py"),
    "slice_limit": ErrorSpec("同一张图的切图次数超过上限（每图 12 次/时）", 429, "routers/uploads.py"),
    "adopt_limit": ErrorSpec("同一张图被复制成独立素材的次数超过上限（6 次）", 429, "routers/uploads.py"),
    "asset_not_found": ErrorSpec("素材不存在或已过期", 422, "routers/extract.py"),
    "assets_required": ErrorSpec("至少要提供 1 项（图片 / 素材项）", 422, "routers/extract.py"),
    "too_many_assets": ErrorSpec("一次提交的图片超过 3 张", 422, "routers/extract.py"),
    "duplicate_asset": ErrorSpec("同一张图在本次提交里出现两次", 422, "routers/extract.py"),
    "asset_duplicate": ErrorSpec("同一素材被挂到两个位置（一个素材只能归位一次）", 422, "routers/guides.py"),
    "unknown_asset": ErrorSpec("这份草稿里没有该素材，无法归位", 422, "routers/guides.py"),
    "bad_caption": ErrorSpec("素材说明为空，或含标记语法（说明是纯文本）", 422, "routers/guides.py"),
    "step_not_found": ErrorSpec("草稿里没有该 `step_id`", 422, "routers/guides.py"),
    # ---- 指导书修订与发布
    "guide_invalid": ErrorSpec("草稿数据无法解析成 Guide（库里存的 JSON 与当前 schema 不兼容）", 409, "routers/guides.py"),
    "published_locked": ErrorSpec("已发布的指导书不可改；要改内容请生成新版本", 409, "routers/guides.py"),
    # ---- A1 会话与判据
    "session_not_found": ErrorSpec("会话不存在", 404, "routers/sessions.py"),
    "guide_missing": ErrorSpec("开始会话时指定的指导书不存在", None, "services/sessions.py"),
    "guide_not_found": ErrorSpec("会话关联的指导书已被删除", None, "services/sessions.py"),
    "session_closed": ErrorSpec("会话已结束（done / aborted），不能再提交", None, "services/sessions.py"),
    "step_already_passed": ErrorSpec("该步已通过，不允许重投（要复测请对未通过步提交）", None, "services/sessions.py"),
    "out_of_order": ErrorSpec("提交的步序与当前进度不连续", None, "services/sessions.py"),
    "steps_incomplete": ErrorSpec("结束会话时仍有步骤未通过（`done` 的前置条件）", None, "services/sessions.py"),
    "record_missing": ErrorSpec("该步还没有任何记录，无法读取或导出", None, "services/sessions.py"),
    "invalid_value": ErrorSpec("实测值不是数字，或不在判据允许的取值域内", None, "services/criteria.py"),
    "manual_not_confirmed": ErrorSpec("人工确认类判据未勾选确认", None, "services/criteria.py"),
    "missing_criterion": ErrorSpec("该步有判据没有提交结果", None, "services/criteria.py"),
    "unknown_criterion": ErrorSpec("提交了该步不存在的判据 id", None, "services/criteria.py"),
    # ---- B 故障排查
    "run_not_found": ErrorSpec("逐步诊断会话不存在", 404, "routers/diagnose.py"),
    "entry_not_found": ErrorSpec("知识库里没有该条目 id", None, "services/diagnosis.py"),
    "check_not_found": ErrorSpec("该诊断会话没有这个检查项序号", None, "services/diagnosis.py"),
    "duplicate_check": ErrorSpec("该检查项已回填过，不能重复提交（改结论请重开一轮）", None, "services/diagnosis.py"),
    "run_finished": ErrorSpec("诊断会话已收束，不再接受回填", None, "services/diagnosis.py"),
    "wrong_order": ErrorSpec("回填的检查项不是当前待办项", None, "services/diagnosis.py"),
    "value_required": ErrorSpec("该检查项要求实测值，提交里没有", None, "services/diagnosis.py"),
    "value_invalid": ErrorSpec("实测值格式不合法", None, "services/diagnosis.py"),
    "result_required": ErrorSpec("该检查项要求 pass/fail 结论，提交里没有", None, "services/diagnosis.py"),
    "resume_mismatch": ErrorSpec("`Last-Event-ID` 不在本次流的事件序列里（跨请求续读不被支持），应重发请求", None, "routers/diagnose.py"),
    "stream_failed": ErrorSpec("流内失败帧：召回或重排阶段抛错，连接已结束", None, "routers/diagnose.py"),
    # ---- 识别（图片 → 结构化）
    "vision_not_configured": ErrorSpec("服务端没配置视觉模型 Key，识别入口整体关闭", 503, "routers/extract.py"),
    "extract_invalid": ErrorSpec("模型输出不合结构化 schema，无法当作识别结果", 502, "routers/extract.py"),
    # ---- 上游 LLM 失败分类（LLMError.kind）
    # 这些值本身也是代码里的字面量（异常构造首参），所以必须登记；
    # 对外表现为 `extract_<kind>` 或异步任务的 error_code。
    "auth": ErrorSpec("上游鉴权失败：Key 无效、被吊销或额度耗尽", None, "llm/deepseek.py"),
    "network": ErrorSpec("上游网络失败：连接超时、DNS、TLS", None, "llm/deepseek.py"),
    "timeout": ErrorSpec("上游在单次调用时限内没有返回", None, "llm/deepseek.py"),
    "rate_limit": ErrorSpec("上游限流（不是本站配额）", None, "llm/deepseek.py"),
    "server": ErrorSpec("上游 5xx", None, "llm/deepseek.py"),
    "truncated": ErrorSpec("输出被 `max_tokens` 截断，JSON 不完整", None, "llm/deepseek.py"),
    "validation": ErrorSpec("模型输出不是合法 JSON，或字段不合 schema", None, "llm/deepseek.py"),
    "bad_request": ErrorSpec("上游拒绝请求（参数或模型名有误）", None, "llm/deepseek.py"),
    "budget": ErrorSpec("剩余时间预算不足以再发起一次调用（不是上游错误）", None, "llm/runner.py"),
}

PREFIX_FAMILIES: dict[str, PrefixFamily] = {
    "extract_": PrefixFamily(
        pattern="extract_{kind}",
        message="图片识别时上游失败，`kind` 取 `auth` / `network` / `timeout` / `rate_limit` / "
        "`server` / `truncated` / `validation` / `bad_request` / `budget` 之一；前端提示按 kind 分档",
        where="routers/extract.py",
        members=("auth", "network", "timeout", "rate_limit", "server", "truncated", "validation", "bad_request", "budget"),
    ),
    "http_": PrefixFamily(
        pattern="http_{status}",
        message="框架自身抛的 `HTTPException`（无此路由 404、方法不允许 405 等）被收进统一信封时补的码",
        where="main.py",
    ),
}


# ---------------------------------------------------------------- 校验


def _iter_sources(api_dir: Path):
    for name in SCAN_DIRS:
        base = api_dir / name
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.py")):
            # 只比较**相对**路径的片段：绝对路径里若恰好有一级叫 `scripts`（常见于
            # 用户目录），按绝对路径判会把整个项目跳过去，扫描结果静默为空。
            if SKIP_DIRS & set(path.relative_to(api_dir).parts):
                continue
            yield path
    for name in SCAN_FILES:
        path = api_dir / name
        if path.is_file():
            yield path


def _joined_head(node: ast.JoinedStr) -> str:
    """取 f-string 的字面前缀：`f"extract_{kind}"` → `extract_`。"""
    head = ""
    for part in node.values:
        if isinstance(part, ast.Constant):
            head += str(part.value)
        else:
            break
    return head


def scan_used_codes(api_dir: Path | None = None) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """静态扫描生产代码，返回 `({精确码: [位置]}, {前缀: [位置]})`。

    覆盖三种产生方式：
    1. `{"code": "literal"}` / `{"error_code": "literal"}`（含 `detail=` 嵌套）；
    2. `{"code": f"prefix_{x}"}` → 记为前缀族；
    3. `SomeError("literal", ...)`（`CODE_EXCEPTIONS` 里的类，首参即码）。

    不做运行时收集：`app` 里没有任何注册表能枚举「可能出现的码」，静态扫描是唯一
    能在 CI 里 0 依赖跑起来的办法。代价是新增异常类必须同步 `CODE_EXCEPTIONS`。
    """
    root = api_dir or API_DIR
    exact: dict[str, list[str]] = {}
    prefixes: dict[str, list[str]] = {}

    for path in _iter_sources(root):
        rel = path.relative_to(root).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # 生产代码语法错误会先在别处炸，这里不重复报
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values):
                    if not (isinstance(key, ast.Constant) and key.value in {"code", "error_code"}):
                        continue
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        exact.setdefault(value.value, []).append(f"{rel}:{node.lineno}")
                    elif isinstance(value, ast.JoinedStr):
                        prefixes.setdefault(_joined_head(value), []).append(f"{rel}:{node.lineno}")
            elif isinstance(node, ast.Call):
                func = node.func
                name = getattr(func, "id", None) or getattr(func, "attr", None)
                # 关键字形式：`store.finish_job(..., error_code="busy")`。
                # 异步任务的码多数走这条路，漏了它 `busy` / `internal` 会被判成死条目。
                for kw in node.keywords:
                    if kw.arg not in {"code", "error_code"}:
                        continue
                    if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                        exact.setdefault(kw.value.value, []).append(f"{rel}:{kw.value.lineno}")
                    elif isinstance(kw.value, ast.JoinedStr):
                        prefixes.setdefault(_joined_head(kw.value), []).append(f"{rel}:{kw.value.lineno}")
                if name in CODE_EXCEPTIONS and node.args:
                    first = node.args[0]
                    if isinstance(first, ast.Constant) and isinstance(first.value, str):
                        exact.setdefault(first.value, []).append(f"{rel}:{node.lineno}")
    # 同一处可能被多个分支收两次（dict 里嵌 dict），去重后再返回，判定不变但报错位置不重复
    return (
        {code: sorted(set(places)) for code, places in exact.items()},
        {prefix: sorted(set(places)) for prefix, places in prefixes.items()},
    )


def verify(api_dir: Path | None = None) -> list[str]:
    """返回问题清单；空列表 = 通过。`--check` 与单测都只认这个返回值。"""
    exact, prefixes = scan_used_codes(api_dir)
    problems: list[str] = []

    for code, places in sorted(exact.items()):
        if code not in ERROR_CODES:
            problems.append(f"代码里有、表里没登记：`{code}`（{places[0]}）")

    for code, spec in sorted(ERROR_CODES.items()):
        if code not in exact:
            problems.append(f"表里登记了、代码里没人用：`{code}`（{spec.where}）")

    for prefix, places in sorted(prefixes.items()):
        if prefix not in PREFIX_FAMILIES:
            problems.append(f"用了未登记的前缀族：`{prefix}`（{places[0]}）")

    for prefix, family in sorted(PREFIX_FAMILIES.items()):
        if prefix not in prefixes:
            problems.append(f"前缀族登记了、代码里没人用：`{prefix}`（{family.where}）")
        for member in family.members:
            if member not in ERROR_CODES:
                problems.append(f"族成员未登记：`{prefix}` 的 `{member}`")

    return problems
