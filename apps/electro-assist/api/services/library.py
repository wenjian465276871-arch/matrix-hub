"""指导书库：数据库优先，`samples/` 只做首次 seed 与兜底。

为什么要 seed 而不是继续读文件：
- 读文件绕开了"发布状态"——文件没有草稿/已发布之分；
- 生成结果必须能被同一个接口读到，否则 `/generate` 做完用户也看不见；
- 样例进库后，列表与详情走同一条 SQL 路径，测试覆盖的才是线上路径。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

import store
from models.guide import SCHEMA_VERSION, Guide

log = logging.getLogger("electro.library")

# 每个数据库路径只做一次增量 seed。key 用路径而不是布尔开关，
# 否则同一进程里换库的测试会互相影响。
_seeded_paths: set[str] = set()
_seed_lock = threading.Lock()


def guide_dir() -> Path:
    env = os.getenv("GUIDE_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "data" / "samples"


def _iter_fixtures(directory: Path):
    if not directory.is_dir():
        return
    for path in sorted(directory.glob("*.json")):
        try:
            yield Guide.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except Exception as exc:  # noqa: BLE001 - 单个坏样例不该拖垮整库
            log.warning("跳过非法样例 %s：%s", path.name, exc)


def load_fixtures(directory: Path | None = None) -> list[Guide]:
    """读取目录下所有合法样例。给 seed、兜底与"原语覆盖"测试共用。"""
    return list(_iter_fixtures(directory or guide_dir()))


def ensure_seeded() -> int:
    """把**库里还没有的**样例导入为已发布。

    早期实现是"空库才 seed"，加一份新样例部署上去也不会出现——样例库
    因此停在三份文件里两种状态，用户看到的列表永远不更新。改成按 id 增量导入：
    已存在的记录一律不动（避免覆盖发布状态或人工修改），只补缺失的。

    每个进程对同一个库只扫一次，之后零成本；换了库路径（测试）会重新扫。
    副作用要说清楚：从库里删掉某份样例后，**进程重启会把它补回来**。
    样例是演示资产，这个行为比"删了就不再出现"更符合预期。
    """
    if os.getenv("SEED_GUIDES", "1") != "1":
        return 0

    key = str(store.db_path())
    with _seed_lock:
        if key in _seeded_paths:
            return 0

    directory = guide_dir()
    seeded = 0
    for guide in load_fixtures(directory):
        if store.get_guide(guide.id) is not None:
            continue
        store.save_guide(guide, status="published")
        seeded += 1
    if seeded:
        log.info("已从 %s 增量导入 %d 份样例（published）", directory, seeded)

    with _seed_lock:
        _seeded_paths.add(key)
    return seeded


def normalize_schema_versions() -> int:
    """把存量指导书的 `schema_version` 归一到当前契约版本。

    为什么需要：样例文件写于 1.0/1.1，而 seed 只补缺、不覆盖已有记录；
    结果线上 `GET /guides/{id}` 一直返回旧版本号，看起来像"部署没生效"，
    排查时白花时间（2026-10-29 自己就差点这样误判）。

    边界：
    - **只改版本戳**，steps / criteria / figures / assets 一个字不动；
    - 必须先用当前 `Guide` 校验通过才写回——校验不过说明内容真的不兼容，
      留着旧版本号是诚实的，不能硬掰；
    - 幂等：全部一致时一次查询、零写入；启动时调用可接受。
    """
    fixed = 0
    for row in store.list_guides_with_schema_version(SCHEMA_VERSION):
        try:
            data = json.loads(row["json"])
            data["schema_version"] = SCHEMA_VERSION
            guide = Guide.model_validate(data)
        except Exception as exc:  # noqa: BLE001 - 一份坏数据不该挡住启动
            log.warning("跳过版本归一化 %s：%s", row["id"], exc)
            continue
        store.update_guide_schema_version(
            guide.id,
            SCHEMA_VERSION,
            json.dumps(guide.model_dump(mode="json"), ensure_ascii=False),
        )
        fixed += 1
    if fixed:
        log.info("存量指导书版本戳升级到 %s：%d 份", SCHEMA_VERSION, fixed)
    return fixed


def _card(row: dict) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "summary": row["summary"] or "",
        "system": row["system"],
        "step_count": row["step_count"],
        "estimated_s": row["duration_s"] or None,
        "generated_at": row["generated_at"] or row["updated_at"],
        "is_demo": True,
        "status": row["status"],
        # 来源说明放列表里：演示数据必须一眼可辨，不能等点进去才看到。
        "source_note": row["source_note"] or "",
    }


def list_published(limit: int = 50) -> list[dict]:
    ensure_seeded()
    return [_card(row) for row in store.list_guides(status="published", limit=limit)]


def get_detail(guide_id: str) -> tuple[dict, str] | None:
    """返回 (guide, status)。DB 没有时回落到 fixture（兼容未 seed 的环境）。"""
    ensure_seeded()
    row = store.get_guide(guide_id)
    if row is not None:
        return row["guide"], row["status"]

    for guide in _iter_fixtures(guide_dir()):
        if guide.id == guide_id:
            return guide.model_dump(mode="json"), "published"
    return None
