"""契约端点：给前端生成 TS 类型、给 LLM 拼 system prompt、给调试做校验。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import ValidationError

from models.guide import Guide
from models.visual import Primitive, VisualSpec

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
        "notes": [
            "params 只允许标量，键名必须在该原语的白名单内",
            "fallback_text 必填：渲染失败时降级为文字，现场必须可读",
        ],
    }


@router.post("/validate")
def validate_guide(payload: dict[str, Any]) -> dict[str, Any]:
    """校验一份指导书 JSON。返回结构化错误，便于前端定位到具体步骤与字段。"""
    try:
        Guide.model_validate(payload)
    except ValidationError as exc:
        return {
            "ok": False,
            "errors": [
                {
                    "loc": ".".join(str(p) for p in err["loc"]),
                    "msg": err["msg"],
                    "type": err["type"],
                }
                for err in exc.errors()[:20]
            ],
        }
    return {"ok": True, "errors": []}


@router.post("/validate-visual")
def validate_visual(payload: dict[str, Any]) -> dict[str, Any]:
    """单独校验一条图示声明（渲染层在入库前也会再跑一次）。"""
    try:
        spec = VisualSpec.model_validate(payload)
        spec.validate_against_primitive()
    except (ValidationError, ValueError) as exc:
        msg = str(exc) if isinstance(exc, ValueError) and not isinstance(exc, ValidationError) else exc.errors()[:5]
        return {"ok": False, "errors": msg}
    return {"ok": True, "errors": []}
