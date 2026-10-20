#!/usr/bin/env python3
"""列出/发布草稿指导书（决策 #16）。

为什么是 CLI 而不是后台页面：项目没有鉴权体系，做一个"发布后台"等于给
公开站加一个没有门锁的入口。发布是低频、可审计、由所有者执行的动作，
放在服务器上跑一条命令最合适。

用法（在 `apps/electro-assist/api` 目录下）：

    ./.venv/Scripts/python.exe -m scripts.publish --list
    ./.venv/Scripts/python.exe -m scripts.publish --publish g_xxxxxxxxxxxxxxxx

服务器（容器内）：

    docker exec matrix-hub python -m scripts.publish --list
    docker exec matrix-hub python -m scripts.publish --publish g_xxxxxxxxxxxxxxxx

`DB_PATH` 未设置时使用 `app_data/electro.db`，与 API 的默认值一致。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import store  # noqa: E402  - 必须在 sys.path 调整之后导入
from models.guide import Guide  # noqa: E402


def list_drafts() -> int:
    """只列草稿：已发布的内容不需要在这里出现，列表接口才是它的出口。"""
    rows = store.list_guides(status="draft", limit=200)
    if not rows:
        print("没有草稿。")
        return 0

    print(f"草稿 {len(rows)} 份（按更新时间倒序）：")
    print(f"{'id':<24} {'system':<10} {'steps':>5}  {'updated_at':<20}  title")
    for row in rows:
        print(
            f"{row['id']:<24} {row['system']:<10} {row['step_count']:>5}  "
            f"{row['updated_at']:<20}  {row['title']}"
        )
    print("\n发布：python -m scripts.publish --publish <id>")
    return 0


def publish_one(guide_id: str) -> int:
    row = store.get_guide(guide_id)
    if row is None:
        print(f"[FAIL] 指导书不存在：{guide_id}", file=sys.stderr)
        return 1

    # 发布前再校验一次：库里可能是旧 schema 或被手工改坏的数据。
    # 已发布内容不可覆盖，所以"发布"这一步是最后一道闸门。
    try:
        Guide.model_validate(row["guide"])
    except Exception as exc:  # noqa: BLE001 - CLI 要把原因打给人看
        print(f"[FAIL] 数据未通过 Guide 校验，拒绝发布：{exc}", file=sys.stderr)
        return 1

    if row["status"] == "published":
        print(f"[SKIP] 已是发布状态：{guide_id}（{row['title']}）")
        return 0

    if not store.publish_guide(guide_id):
        print(f"[FAIL] 发布失败：{guide_id}", file=sys.stderr)
        return 1

    print(f"[OK] 已发布：{guide_id}（{row['title']}）")
    print("     GET /api/electro/guides 现在应包含该条；前端列表会显示它。")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="列出或发布草稿指导书（无后台管理，发布只走 CLI）"
    )
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--list", action="store_true", help="列出全部草稿")
    actions.add_argument("--publish", metavar="GUIDE_ID", help="发布指定草稿")
    args = parser.parse_args(argv)

    # 幂等：库不存在时建表；已存在时只补未应用的迁移。
    store.init_db()
    return list_drafts() if args.list else publish_one(args.publish)


if __name__ == "__main__":
    raise SystemExit(main())
