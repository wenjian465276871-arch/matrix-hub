"""部署前迁移闸门的静态回归：它被删掉/挪到 up 之后，必须有人喊。

为什么不测行为：`deploy.sh` 要真的 docker + 生产卷才能跑，CI 里没有；
但"闸门存在、且在 `compose up` 之前、默认开启"这三件事是纯文本事实，
静态断言足够拦住误删——逻辑本身由 `test_migration_copy.py` 的 5 条用例覆盖。
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DEPLOY = ROOT / "deploy" / "deploy.sh"


def test_migration_gate_runs_before_compose_up():
    text = DEPLOY.read_text(encoding="utf-8")
    gate = text.index("check_migration_copy")
    up = text.index("docker compose up -d web")
    assert gate < up, "迁移预演必须在启动新容器之前"


def test_gate_is_on_by_default_with_documented_escape_hatch():
    text = DEPLOY.read_text(encoding="utf-8")
    assert 'MIGRATION_CHECK:-1' in text, "默认必须是开启；关掉要显式写 0"
    assert "skip_migration_check=1" in text, "越过闸门必须留痕到 deploy.log"
    assert "MIG_VOLUME" in text, "卷名要可覆盖，否则换项目名会静默跳过"
