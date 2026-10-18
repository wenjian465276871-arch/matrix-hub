"""DeepSeek 计费模型。

单位约定：成本以「微元」（1e-6 元）存整数。DeepSeek 报价是「元/百万 token」，
所以 `token 数 × 单价 = 微元数`——数字正好相等（1 token × 1 元/百万 = 1 微元）。
这个巧合让换算没有除法和四舍五入，也就没有浮点误差。

价格来自开发计划 §3.2（2026-07 核实）。**DeepSeek 改价时必须同步改这里，
并更新 PRICE_VERSION**——否则预算熔断会按旧价格放行，账单会比预算高。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .base import Usage

PRICE_VERSION = "deepseek-2026-07"

CST = timezone(timedelta(hours=8))

# 元 / 百万 token
PRICES: dict[str, dict[str, float]] = {
    "peak": {"in_miss": 2.0, "in_hit": 0.30, "out": 8.0},
    "idle": {"in_miss": 1.0, "in_hit": 0.04, "out": 4.0},
}


def is_peak(at: datetime | None = None) -> bool:
    """工作日 9:00–12:00、14:00–18:00 为高峰价，其余（含周末）半价。"""
    moment = (at or datetime.now(timezone.utc)).astimezone(CST)
    if moment.weekday() >= 5:  # 周六、周日
        return False
    hour = moment.hour
    return 9 <= hour < 12 or 14 <= hour < 18


def cost_micros(usage: Usage, at: datetime | None = None) -> int:
    """一次调用的成本（微元）。思考 token 按输出计费，与 DeepSeek 口径一致。"""
    table = PRICES["peak" if is_peak(at) else "idle"]
    total = (
        usage.billable_prompt_tokens * table["in_miss"]
        + usage.cached_tokens * table["in_hit"]
        + usage.completion_tokens * table["out"]
    )
    return int(round(total))
