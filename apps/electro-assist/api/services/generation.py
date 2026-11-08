"""生成编排：校验 → 配额 → 建 job → 入队；worker 执行 → 落库 → 记用量。

三条边界：
1. **ID 由这里分配**。模型输出的 `id` 是语义化的，两人生成同一工序必撞；
   服务端用 64 位随机串覆盖它，`save_guide` 的 upsert 才不会被当成"更新"。
2. **失败也要记用量**。超时/校验失败同样烧 token；只统计成功调用，
   预算熔断会在失败率最高的时候失灵。
3. **job 状态必须收敛**。worker 任何异常都要把 job 打到终态，
   否则前端永远轮询、数据库永远有 running。
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone

import store
from llm import LLMError, generate_guide, get_provider
from llm.pricing import PRICE_VERSION
from models.guide import SCHEMA_VERSION, AssetRef

from . import provenance, quota
from .jobqueue import job_queue

log = logging.getLogger("electro.generate")

MIN_INPUT_CHARS = 10
MAX_INPUT_CHARS = 20_000
# 6144 是 2026-10 按"非思考模式默认 8K"估的，2026-11-02 线上被证伪：
# 思考模式下 reasoning 一次吃掉 8–10K，而 max_tokens 把 reasoning 也算进完成量，
# 于是 JSON 正文还没写完就撞上限（job j_c2c9ae88：两次调用 6144/8192 全部顶满，
# 可见正文不足 600 token）。官方文档：thinking 模式 max_tokens 默认 64K、上限 384K，
# 8K 是**非思考**模式的默认值。给 16384：8 步 × 1–3 图的正常输出 3–5K + 思考 ≤10K 装得下。
MAX_TOKENS = 16384

# 配额是"先查后写"的两步操作：并发下两个请求可能都通过检查再各建一个 job。
# 单 worker 是这套架构的前提（计划 §4），所以一把进程内锁就够；
# 真要上多 worker，必须改成 DB 级原子操作（BEGIN IMMEDIATE 里 count+insert）。
_submit_lock = threading.Lock()


class GenerateRejected(Exception):
    """请求在进入队列前被拒绝。`status` 直接映射为 HTTP 状态码。"""

    def __init__(self, code: str, message: str, *, status: int = 429, retry_after: int = 0):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retry_after = retry_after


def new_guide_id() -> str:
    """18 字符，落在 `^g_[a-z0-9_]{5,31}$` 里；64 位随机，撞车概率可忽略。"""
    return "g_" + secrets.token_hex(8)


_TITLE_PREFIX = re.compile(r"^\s*(?:工序|工序名称|作业名称)\s*[:：]\s*")


def derive_process_title(text: str) -> str:
    """从原文里取一个能当标题的行。

    取第一个非空行，去掉「工序：」这类前缀。**不做摘要**：标题是索引，
    摘要要让模型写就是一次额外调用，且会和正文不一致。
    """
    for line in text.splitlines():
        clean = _TITLE_PREFIX.sub("", line.strip()).strip()
        if clean:
            return clean[:80]
    return "未命名工艺"


def submit(
    text: str,
    client_ip: str,
    retry_of: str | None = None,
    privileged: bool = False,
    assets: list[dict[str, str]] | None = None,
    process_id: str | None = None,
    source_type: str = "text",
    station: str = "",
) -> str:
    cleaned = text.strip()
    if len(cleaned) < MIN_INPUT_CHARS:
        raise GenerateRejected(
            "input_too_short", f"工艺文本至少需要 {MIN_INPUT_CHARS} 个字符", status=422
        )
    if len(cleaned) > MAX_INPUT_CHARS:
        raise GenerateRejected(
            "input_too_long", f"工艺文本过长（{len(cleaned)} 字符），上限 {MAX_INPUT_CHARS}", status=422
        )

    with _submit_lock:
        decision = quota.check(client_ip, retry_of, unlimited=privileged)
        if not decision.ok:
            raise GenerateRejected(
                decision.code, decision.message, status=429, retry_after=decision.retry_after
            )

        if job_queue.capacity_left() <= 0:
            raise GenerateRejected("busy", "生成队列已满，请稍后再试", status=503, retry_after=10)

        # 工艺原文随任务落库：详情页的「重新生成」要靠它，否则用户只能回生成页重粘。
        # 配额检查在落库之前——被拒的请求不该产生一条工艺记录。
        if process_id is None and retry_of:
            # 重试是"同一份工艺再来一次"，不该为它复制一份原文；工位同理继承。
            original = store.get_job(retry_of) or {}
            process_id = original.get("process_id")
            station = station or (original.get("station") or "")
        if process_id is None:
            process_id = store.create_process(
                text=cleaned, title=derive_process_title(cleaned)
            )["id"]

        job_id = store.create_job(
            kind="generate",
            client_ip=client_ip,
            input_text=cleaned,
            retry_of=retry_of,
            assets=assets,
            process_id=process_id,
            source_type="image" if source_type == "image" else "text",
            station=(station or "").strip()[:60],
        )
    if not job_queue.submit(job_id, cleaned):
        store.finish_job(job_id, "failed", error_code="busy", error_detail="队列已满")
        raise GenerateRejected("busy", "生成队列已满，请稍后再试", status=503, retry_after=10)
    return job_id


def _record_usage(job_id: str, model: str, usage, cost_micros: int) -> None:
    if usage is None or (usage.prompt_tokens == 0 and usage.completion_tokens == 0):
        return
    store.record_usage(
        model=model,
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        reasoning_tokens=usage.reasoning_tokens,
        cached_tokens=usage.cached_tokens,
        cost_micros=cost_micros,
        price_version=PRICE_VERSION,
        job_id=job_id,
    )


def _attach_assets(guide, job: dict) -> list[dict]:
    """把本次提交的素材挂到草稿上（**不放进模型**）。返回解析后的素材列表。

    为什么不让模型分配：它没看过图，只能凭说明猜位置——猜错就是"把 A 门的
    照片贴到 B 门步骤下"，而这种错在现场不会被发现，只会被照着做。
    图片位置是事实，事实由人给；模型只做它看得到的文本结构化。

    归位（挂到某一步）由人在草稿页完成，见 `PUT /guides/{id}/assets`。

    返回值给 `provenance.backfill` 用：**恰好 1 张图时才敢把 `asset_id` 写进
    provenance**，所以那边需要知道本次到底传了几张、是哪张。
    """
    job_id = job.get("id", "")
    raw = job.get("assets_json") or "[]"
    try:
        items = json.loads(raw)
    except (TypeError, ValueError):
        log.warning("job 素材字段损坏，按无素材处理 job=%s", job_id)
        return []
    if not isinstance(items, list):
        log.warning("job 素材字段不是数组，按无素材处理 job=%s", job_id)
        return []
    refs = []
    for item in items:
        try:
            refs.append(AssetRef(**item))
        except Exception:  # noqa: BLE001 - 单条坏数据不该让整次生成失败
            log.warning("跳过非法素材 job=%s item=%s", job_id, item)
    # 模型即便照 schema 编了 assets，也在这一步被清掉：只有提交时校验过的才作数。
    guide.assets = refs
    return [item for item in items if isinstance(item, dict)]


def run(job_id: str, text: str, provider_factory=get_provider) -> None:
    """worker 入口。同步阻塞，只在单线程队列里执行。"""
    if not store.mark_job_running(job_id):
        # 已被清扫或重复消费：不要再动它
        return

    provider = None
    try:
        provider = provider_factory()
        job = store.get_job(job_id) or {}
        draft = generate_guide(
            provider,
            text,
            max_tokens=MAX_TOKENS,
            # 输入形态随 job 走：重启后续跑也拿得到，不依赖队列参数。
            source_type=job.get("source_type") or "text",
            station=job.get("station") or "",
        )
        # 服务端接管 ID：模型给的 id 只对"它自己"有意义，不能当主键
        draft.guide.id = new_guide_id()
        # 版本号同理：模型抄错一个数字，前端就会按旧结构解析。
        draft.guide.schema_version = SCHEMA_VERSION
        # 素材同理：模型即使照 schema 编了 asset_id 也一律丢弃，只认提交时传过的。
        for step in draft.guide.steps:
            step.assets = []
        assets = _attach_assets(draft.guide, job)
        # 判据来源：模型给的 provenance 已在 runner 剥掉，这里用原文重新定位回填。
        # 顺序不能换——`asset_id` 要靠"本次恰好 1 张图"判断，必须先拿到素材清单。
        try:
            filled = provenance.backfill(draft.guide, text, assets)
        except Exception as exc:  # noqa: BLE001 - 溯源失败不该让整次生成失败
            # 回填只是"补证据"，不是主链路。它抛异常时，一份没有 provenance 的
            # 指导书仍然可用（前端会显示"无据"）；让生成失败才是更坏的结果。
            log.warning("判据来源回填失败 job=%s：%s", job_id, exc)
            filled = 0
        # 来源工艺随指导书落库：详情页据此提供「重新生成」，不用回生成页重粘。
        saved = store.save_guide(
            draft.guide, status="draft", job_id=job_id, process_id=job.get("process_id")
        )

        _record_usage(job_id, draft.model, draft.usage, draft.cost_micros)
        store.finish_job(
            job_id,
            "succeeded",
            guide_id=saved["id"],
            prompt_tokens=draft.usage.prompt_tokens,
            completion_tokens=draft.usage.completion_tokens,
            reasoning_tokens=draft.usage.reasoning_tokens,
            cost_micros=draft.cost_micros,
        )
        log.info(
            "生成成功 job=%s guide=%s attempts=%d %.1fs ¥%.4f%s",
            job_id,
            saved["id"],
            draft.attempts,
            draft.latency_ms / 1000,
            draft.cost_micros / 1_000_000,
            # 降级与自纠都要留痕：界面上看不出来，日志里必须能查"这份图少了一条动效是为什么"
            f" repairs={'；'.join(draft.repairs)}" if draft.repairs else "",
            # 回填条数进日志：为 0 说明原文里定位不到任何判据，值得查一版
            # （要么 prompt 让模型改写了判据，要么原文切行口径变了）。
            f" sources={filled}" if filled else "",
        )
    except LLMError as exc:
        _record_usage(job_id, getattr(provider, "name", "unknown"), exc.usage, exc.cost_micros)
        status = "timeout" if exc.kind in ("timeout", "budget") else "failed"
        store.finish_job(
            job_id,
            status,
            error_code=exc.kind,
            error_detail=str(exc)[:500],
            prompt_tokens=exc.usage.prompt_tokens,
            completion_tokens=exc.usage.completion_tokens,
            reasoning_tokens=exc.usage.reasoning_tokens,
            cost_micros=exc.cost_micros,
        )
        log.warning("生成失败 job=%s kind=%s：%s", job_id, exc.kind, exc)
    except Exception as exc:  # noqa: BLE001 - job 必须落到终态
        log.exception("生成异常 job=%s", job_id)
        store.finish_job(
            job_id, "failed", error_code="internal", error_detail=type(exc).__name__
        )
    finally:
        if provider is not None and hasattr(provider, "close"):
            provider.close()


def snapshot(job_id: str) -> dict | None:
    row = store.get_job(job_id)
    if row is None:
        return None
    status = row["status"]
    return {
        "id": row["id"],
        "status": status,
        "guide_id": row["guide_id"],
        # 前端凭它在任务成功后仍能提供「用同一份工艺重新生成」
        "process_id": row["process_id"],
        "error_code": row["error_code"],
        # 只回可读的一句话；模型原始输出可能很长，也可能含用户文本
        "error_message": row["error_detail"],
        "created_at": row["created_at"],
        "finished_at": row["finished_at"],
        "duration_ms": row["duration_ms"],
        "usage": {
            "prompt_tokens": row["prompt_tokens"],
            "completion_tokens": row["completion_tokens"],
            "reasoning_tokens": row["reasoning_tokens"],
        },
        "cost_micros": row["cost_micros"],
        "poll_after_ms": 1000 if status in ("queued", "running") else 0,
    }


def start_worker() -> None:
    job_queue.start(run)


def stop_worker() -> None:
    job_queue.stop()


def recover_stale() -> int:
    """启动时把上一次进程留下的 queued/running 全部收敛为 timeout。

    进程重启后内存队列已经没了，这些 job 不可能再被执行；留着只会让前端
    永远转圈。单 worker 部署下这个判断是安全的（不会误杀正在跑的 job）。

    切点取 now+1s：时间戳只有秒级精度，同一秒创建的 job 用 `< now` 会漏掉。
    """
    cutoff = (
        datetime.now(timezone.utc) + timedelta(seconds=1)
    ).isoformat(timespec="seconds")
    return store.sweep_stale_jobs(cutoff)
