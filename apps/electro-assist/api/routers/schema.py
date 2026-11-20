"""契约端点：给前端生成 TS 类型、给 LLM 拼 system prompt、给调试做校验。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from models.guide import Guide
from models.visual import (
    MAX_MOTION_TRACKS,
    MotionAnim,
    Primitive,
    device_catalog,
    motion_slots,
)

router = APIRouter(prefix="/api/electro/schema", tags=["schema"])


@router.get("/guide")
def guide_schema() -> dict[str, Any]:
    """JSON Schema。LLM 的结构化输出约束与前端类型生成都以它为准。"""
    return Guide.model_json_schema()


@router.get("/visual")
def visual_primitives() -> dict[str, Any]:
    """可用视觉原语清单。前端渲染器与 prompt 共用同一份枚举，避免漂移。"""
    return {
        "primitives": [p.value for p in Primitive],
        "required": ["primitive", "fallback_text"],
        "motion": {
            "max_tracks": MAX_MOTION_TRACKS,
            "duration_ms": [400, 2400],
            "anims": [a.value for a in MotionAnim],
            "slots": motion_slots(),
        },
        # 三维场景的受控枚举：部件（含中文释义）、可指名瞬间、所属工位一起下发。
        # 只给 subject 列表的话，调用方拿不到 t 的语义，只能自己编；只给部件键的话，
        # `drive` / `drive2` 在调用方眼里同样是没有语义的缩写。
        "devices": device_catalog(),
        "notes": [
            "params 只允许标量，键名必须在该原语的白名单内",
            "fallback_text 必填：渲染失败时降级为文字，现场必须可读",
            "motion 可选：target 必须是该原语的槽位，同一槽位只能一条轨道",
            "flow / draw 只作用于描边槽位（meter.needle、flow_arrow.arrow）",
        ],
    }
