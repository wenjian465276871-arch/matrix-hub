#!/usr/bin/env python3
"""从 FastAPI 的 OpenAPI 规格导出 `docs/API.md`。

为什么用脚本而不是手写：接口清单是**最容易漂移**的文档——多一个端点、改一个字段，
手写版本不会有人记得同步。这里以 `app.openapi()` 为唯一来源，重跑即更新。

用法（在 `apps/electro-assist/api` 目录下）：
    ./.venv/Scripts/python.exe scripts/export_openapi.py
    ./.venv/Scripts/python.exe scripts/export_openapi.py --out ../../../docs/API.md

注意：输出**不含时间戳**，同一份代码重复导出的结果逐字节一致，避免无意义的 diff。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

DEFAULT_OUT = API_DIR.parents[2] / "docs" / "API.md"  # matrix-hub/docs/API.md
METHOD_ORDER = ["get", "post", "put", "patch", "delete"]

# 中文说明：OpenAPI 的 summary 来自函数名（英文、且形如 "List Guides"），对读者没有信息量。
# 这里只补"这个端点干什么"，不重复 schema；新增端点若未登记，退回自动摘要并在导出时提示。
CURATED = {
    "GET /healthz": "健康检查：进程 + 数据库 + 磁盘余量，供部署脚本与容器探针使用",
    "GET /api/electro/schema/guide": "取 Guide 的 JSON Schema（schema_version 1.2）",
    "GET /api/electro/schema/visual": "取视觉 DSL 的 JSON Schema（7 种原语）",
    "POST /api/electro/schema/validate": "校验一份 Guide，返回错误列表",
    "POST /api/electro/schema/validate-visual": "只校验视觉 DSL 片段",
    "POST /api/electro/uploads": "上传工艺截图（≤5MB，限流 6/时·20/日）",
    "POST /api/electro/uploads/{asset_id}/slice": "按模式切图（整图/表格/行带/密集文字）",
    "GET /api/electro/uploads/{asset_id}": "取上传资产的元信息与切片清单",
    "GET /api/electro/uploads/{asset_id}/{filename}": "取原图或某张切片（二进制）",
    "GET /api/electro/guides": "指导书列表，**只含已发布**（草稿不进列表）",
    "GET /api/electro/guides/{guide_id}": "指导书详情；返回 `{status, guide}` 信封，草稿凭 id 可读",
    "PUT /api/electro/guides/{guide_id}/assets": "草稿素材归位：全量重排已有素材到步骤/素材区；已发布 409",
    "POST /api/electro/generate": "提交生成任务，返回 202 + job_id（单 worker 有界队列）",
    "GET /api/electro/jobs/{job_id}": "轮询生成任务状态，成功后带 guide_id",
    "GET /api/electro/quota": "查生成配额与全站预算余量",
    "POST /api/electro/passcode/verify": "用访问口令换短期令牌（只豁免每 IP 配额，预算仍生效）",
    "POST /api/electro/sessions": "开始一次作业会话（绑定 guide，设备/位置选填）",
    "GET /api/electro/sessions/{session_id}": "取会话状态：当前步号、指导书、已提交记录",
    "POST /api/electro/sessions/{session_id}/steps/{seq}": "提交一步实测值；**必须带 Idempotency-Key**，判定在服务端",
    "POST /api/electro/sessions/{session_id}/finish": "结束会话（done 需全部通过 / aborted 可随时）",
    "GET /api/electro/records/{session_id}": "整份作业记录（按步骤分组、含每次尝试与异常链）",
    "POST /api/electro/diagnose": "按现象检索故障知识库；查不到返回 uncovered_reason",
    "GET /api/electro/diagnose/kb": "知识库覆盖范围（子系统、条目数、版本）",
    "POST /api/electro/diagnose/runs": "开始逐步诊断（故障树）：返回条目、首个检查项与候选",
    "GET /api/electro/diagnose/runs/{run_id}": "取逐步诊断状态：已填步骤、当前检查、结论",
    "POST /api/electro/diagnose/runs/{run_id}/checks/{order}":
        "回填一项检查（确认 pass/fail 或实测值），由服务端判定并推进",
    "POST /api/electro/diagnose/runs/{run_id}/abort": "中止逐步诊断，保留已完成步骤",
}


def schema_name(spec: dict) -> str:
    """取 `$ref` 的短名；内联 schema 用类型名兜底。"""
    if not spec:
        return "—"
    if "$ref" in spec:
        return spec["$ref"].rsplit("/", 1)[-1]
    if "items" in spec:
        inner = schema_name(spec["items"])
        return f"{inner}[]"
    if "anyOf" in spec:
        return " | ".join(schema_name(s) for s in spec["anyOf"])
    return spec.get("type", "—")


def body_schema(operation: dict) -> str:
    content = operation.get("requestBody", {}).get("content", {})
    for media, spec in content.items():
        if media.startswith("application/json"):
            return schema_name(spec.get("schema", {}))
    return "—"


def response_schema(operation: dict) -> str:
    for code in ("200", "201", "202"):
        spec = operation.get("responses", {}).get(code)
        if not spec:
            continue
        content = spec.get("content", {})
        for media, media_spec in content.items():
            if media.startswith("application/json"):
                return f"{code} · {schema_name(media_spec.get('schema', {}))}"
    return "—"


def collect(spec: dict) -> list[dict]:
    rows = []
    for path, item in spec.get("paths", {}).items():
        for method in METHOD_ORDER:
            op = item.get(method)
            if not op:
                continue
            rows.append(
                {
                    "method": method.upper(),
                    "path": path,
                    "tag": (op.get("tags") or ["default"])[0],
                    "summary": CURATED.get(f"{method.upper()} {path}", (op.get("summary") or "").strip()),
                    "body": body_schema(op),
                    "resp": response_schema(op),
                }
            )
    rows.sort(key=lambda r: (r["path"], METHOD_ORDER.index(r["method"].lower())))
    return rows


def render(spec: dict, rows: list[dict]) -> str:
    info = spec.get("info", {})
    business = [r for r in rows if r["path"] != "/healthz"]
    out: list[str] = []
    a = out.append

    a("# API 参考")
    a("")
    a("> 由 `apps/electro-assist/api/scripts/export_openapi.py` 从 `app.openapi()` 生成，**不要手改**。")
    a("> 接口变更后重跑脚本并提交本文件：`cd apps/electro-assist/api && ./.venv/Scripts/python.exe scripts/export_openapi.py`")
    a(f"> 服务版本：`{info.get('version', '—')}` ｜ 端点 **{len(rows)}** 个（业务 **{len(business)}** + `/healthz`）")
    a("")
    a("## 1. 约定")
    a("")
    a("| 项 | 说明 |")
    a("|---|---|")
    a("| Base URL | 生产为同源 `/api/electro`；本地 `http://127.0.0.1:8001` |")
    a("| 反代 | Caddy 同源反代，**无 CORS**；API 只监听容器内 `127.0.0.1:8001` |")
    a("| 内容类型 | 除取图接口外均为 `application/json` |")
    a("| 错误体 | `{\"detail\": {\"code\": ..., \"message\": ...}}`，限流另带 `retry_after` |")
    a("| 幂等 | `POST /sessions/{id}/steps/{seq}` **必须**带 `Idempotency-Key` |")
    a("| 配额 | 生成 2/时·10/日（每 IP）、上传 6/时·20/日、会话 10/时；超限 429 + `Retry-After` |")
    a("| 可见性 | `GET /guides` 只返回 `published`；草稿凭随机 id 访问 |")
    a("")
    a("## 2. 端点清单")
    a("")
    a("| 方法 | 路径 | 说明 | 请求体 | 响应 |")
    a("|---|---|---|---|---|")
    for r in rows:
        method = f"`{r['method']}`"
        a(f"| {method} | `{r['path']}` | {r['summary'] or '—'} | `{r['body']}` | `{r['resp']}` |")
    a("")

    tags: dict[str, list[dict]] = {}
    for r in rows:
        tags.setdefault(r["tag"], []).append(r)
    a("## 3. 按模块")
    a("")
    for tag in sorted(tags):
        a(f"### {tag}")
        a("")
        for r in tags[tag]:
            a(f"- `{r['method']} {r['path']}` — {r['summary'] or '（无说明）'}")
        a("")

    schemas = spec.get("components", {}).get("schemas", {})
    if schemas:
        a("## 4. 数据模型")
        a("")
        a("字段与约束以 `apps/electro-assist/api/models/` 为准，本节只列形状。")
        a("")
        for name in sorted(schemas):
            node = schemas[name]
            props = node.get("properties") or {}
            if not props:
                continue
            required = set(node.get("required") or [])
            a(f"### {name}")
            a("")
            a("| 字段 | 类型 | 必填 |")
            a("|---|---|---|")
            for field, meta in props.items():
                kind = schema_name(meta) if "$ref" in meta or "items" in meta else meta.get("type", "—")
                if meta.get("enum"):
                    kind = "enum(" + " / ".join(str(e) for e in meta["enum"]) + ")"
                a(f"| `{field}` | `{kind}` | {'是' if field in required else '否'} |")
            a("")
    return "\n".join(out).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument(
        "--check",
        action="store_true",
        help="只比对，不写盘；文档与代码不一致时退出码 1（供 CI 使用）",
    )
    args = parser.parse_args()

    from main import app  # 延迟导入：让 argparse 先处理帮助

    spec = app.openapi()
    rows = collect(spec)
    text = render(spec, rows)
    out = Path(args.out)
    if args.check:
        current = out.read_text(encoding="utf-8") if out.exists() else ""
        if current != text:
            print(f"[FAIL] {out} 与当前代码不一致，请运行 python scripts/export_openapi.py 重新导出")
            return 1
        print(f"[OK] {out} 与代码一致（{len(rows)} 个端点）")
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"写入 {out}：{len(rows)} 个端点，{len(spec.get('components', {}).get('schemas', {}))} 个模型")
    missing = [f"{r['method']} {r['path']}" for r in rows if f"{r['method']} {r['path']}" not in CURATED]
    if missing:
        print("提示：以下端点没有中文说明，已退回自动摘要——建议补进脚本的 CURATED：")
        for m in missing:
            print("   ", m)
    print(json.dumps({"paths": len(spec.get("paths", {})), "operations": len(rows)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
