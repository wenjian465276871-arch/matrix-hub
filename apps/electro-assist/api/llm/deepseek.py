"""DeepSeek 实现（OpenAI 兼容接口）。

为什么直接用 httpx 而不引 openai SDK：
这里只用到一个端点、一个 JSON 模式，SDK 带来的主要价值（多端点、工具调用封装）
我们暂时不需要，而它对超时与错误类型的包装反而让我们多一层映射。
更重要的是：错误分类必须精确到"该不该重试"，这一层自己写最清楚。

安全：Key 只出现在请求头里。异常信息、日志、返回体一律不含 Key。
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from .base import Completion, LLMError, Usage

log = logging.getLogger("electro.llm.deepseek")

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-flash"


def _retry_after(resp: httpx.Response) -> float | None:
    """Retry-After 可能是秒数，也可能是 HTTP-date。只处理得动的部分，其余忽略。"""
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


class DeepSeekProvider:
    name = DEFAULT_MODEL

    def __init__(
        self,
        api_key: str,
        *,
        model: str = DEFAULT_MODEL,
        base_url: str = DEFAULT_BASE_URL,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("DeepSeek API Key 为空")
        self.name = model
        self._key = api_key.strip()
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            transport=transport,
            headers={
                "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

    # ------------------------------------------------------------------ 生命周期

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "DeepSeekProvider":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ 调用

    def structured(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        timeout_s: float,
        max_tokens: int = 4096,
    ) -> Completion:
        # DeepSeek 的 json_object 模式不接受 schema 参数，schema 是通过 system prompt
        # 注入的（见 prompts.py）。这里保留参数是为了接口与"支持 json_schema 的厂商"对齐。
        log.debug("请求结构化输出，schema 顶层字段：%s", sorted(schema.get("properties", {})))

        body = {
            "model": self.name,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "stream": False,
        }

        started = time.monotonic()
        try:
            resp = self._client.post(
                "/chat/completions",
                json=body,
                timeout=httpx.Timeout(
                    connect=max(1.0, min(5.0, timeout_s)),
                    read=timeout_s,
                    write=max(1.0, min(10.0, timeout_s)),
                    pool=max(1.0, min(5.0, timeout_s)),
                ),
            )
        except httpx.TimeoutException as exc:
            raise LLMError("timeout", f"模型调用超过 {timeout_s:.0f}s") from exc
        except httpx.HTTPError as exc:
            # 不把原始异常串进消息：它可能带 URL 与代理信息，且对排查没有额外价值
            raise LLMError("network", f"网络错误（{type(exc).__name__}）") from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        self._raise_for_status(resp)
        return self._parse(resp, latency_ms)

    def vision(
        self,
        *,
        system: str,
        user: str,
        images: list[str],
        timeout_s: float,
        max_tokens: int = 2048,
    ) -> Completion:
        """图片 + 文字 → 文本。`images` 是 data URL（`data:image/png;base64,...`）。

        刻意不开 `response_format=json_object`：多模态 + JSON 模式在部分模型上
        会互相打架（要么忽略 JSON 约束，要么把图当附件不读）。这里靠提示词约束，
        再用 `extract_json` 做有限容错——与生成链路同一套解析策略。
        """
        if not images:
            raise ValueError("vision 调用缺少图片")

        content: list[dict[str, Any]] = [{"type": "text", "text": user}]
        content.extend(
            {"type": "image_url", "image_url": {"url": url, "detail": "high"}}
            for url in images
        )

        body = {
            "model": self.name,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.0,
            "stream": False,
        }

        started = time.monotonic()
        try:
            resp = self._client.post(
                "/chat/completions",
                json=body,
                timeout=httpx.Timeout(
                    connect=max(1.0, min(5.0, timeout_s)),
                    read=timeout_s,
                    write=max(1.0, min(10.0, timeout_s)),
                    pool=max(1.0, min(5.0, timeout_s)),
                ),
            )
        except httpx.TimeoutException as exc:
            raise LLMError("timeout", f"图片识别超过 {timeout_s:.0f}s") from exc
        except httpx.HTTPError as exc:
            raise LLMError("network", f"网络错误（{type(exc).__name__}）") from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        self._raise_for_status(resp)
        return self._parse(resp, latency_ms)

    # ------------------------------------------------------------------ 内部

    def _parse(self, resp: httpx.Response, latency_ms: int) -> Completion:
        try:
            data = resp.json()
        except ValueError as exc:
            raise LLMError("server", "响应不是合法 JSON", status=resp.status_code) from exc

        choices = data.get("choices") or []
        if not choices:
            raise LLMError("server", "响应缺少 choices", status=resp.status_code)
        choice = choices[0]
        message = choice.get("message") or {}
        text = (message.get("content") or "").strip()
        finish_reason = choice.get("finish_reason")

        # 先解析用量再判错：截断/空正文同样烧了 token，
        # 如果错误里不带 usage，预算统计会漏掉最贵的那几次调用。
        raw_usage = data.get("usage") or {}
        details = raw_usage.get("completion_tokens_details") or {}
        usage = Usage(
            prompt_tokens=int(raw_usage.get("prompt_tokens") or 0),
            completion_tokens=int(raw_usage.get("completion_tokens") or 0),
            reasoning_tokens=int(details.get("reasoning_tokens") or 0),
            cached_tokens=int(raw_usage.get("prompt_cache_hit_tokens") or 0),
        )

        if not text:
            # 真实踩过的坑：思考 token 也算 completion，max_tokens 给小了会只剩思考没有正文
            raise LLMError(
                "validation",
                "模型返回空内容（思考 token 可能吃满了 max_tokens，或触发内容过滤）",
                status=resp.status_code,
                usage=usage,
            )
        if finish_reason == "length":
            raise LLMError(
                "truncated", "输出被 max_tokens 截断，JSON 不完整", usage=usage
            )

        return Completion(
            text=text,
            model=str(data.get("model") or self.name),
            usage=usage,
            finish_reason=finish_reason,
            latency_ms=latency_ms,
        )

    @staticmethod
    def _raise_for_status(resp: httpx.Response) -> None:
        status = resp.status_code
        if status < 400:
            return

        detail = ""
        try:
            payload = resp.json()
            detail = str(payload.get("error", {}).get("message", ""))[:300]
        except ValueError:
            detail = resp.text[:300]

        if status in (401, 403):
            raise LLMError("auth", f"鉴权失败：{detail or '请检查 DEEPSEEK_API_KEY'}", status=status)
        if status == 429:
            raise LLMError(
                "rate_limit",
                f"触发限流：{detail or '稍后重试'}",
                status=status,
                retry_after=_retry_after(resp),
            )
        if status == 400:
            raise LLMError("bad_request", f"请求被拒绝：{detail}", status=status)
        if status >= 500:
            raise LLMError("server", f"上游错误：{detail or status}", status=status)
        raise LLMError("bad_request", f"未预期的状态码 {status}：{detail}", status=status)
