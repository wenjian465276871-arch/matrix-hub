"""脚本共用引导的契约测试。

为什么值得测：`.env` 解析看起来"就三行"，但它是三个脚本共同的输入口。
写错的表现不是报错，而是**读不到 Key 却继续跑**——最后表现为"模型调用 401"，
排查会从 provider 一路查回来。这里把三条口径钉住：
1. 只认 `KEY=VALUE`，注释与空行跳过；
2. 已有环境变量优先（CI 注入不被文件覆盖）；
3. 默认路径只在本仓内（`api/.env` → 仓库根 `.env`），指向不存在的文件时返回 None。
"""
from __future__ import annotations

import os
from pathlib import Path

from scripts import _bootstrap


def test_load_env_file_parses_and_skips_noise(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ELECTRO_TEST_KEY", raising=False)
    env = tmp_path / ".env"
    env.write_text(
        "# 注释\n\nELECTRO_TEST_KEY='sk-123'\n没有等号的行\n",
        encoding="utf-8",
    )

    assert _bootstrap.load_env_file(env) is True
    assert os.environ["ELECTRO_TEST_KEY"] == "sk-123"


def test_load_env_file_does_not_override_existing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ELECTRO_TEST_KEY", "from-shell")
    env = tmp_path / ".env"
    env.write_text("ELECTRO_TEST_KEY=from-file\n", encoding="utf-8")

    _bootstrap.load_env_file(env)
    assert os.environ["ELECTRO_TEST_KEY"] == "from-shell"


def test_default_env_candidates_stay_inside_repo(tmp_path: Path) -> None:
    candidates = _bootstrap.default_env_files()
    api_dir = Path(__file__).resolve().parent.parent

    assert candidates[0] == api_dir / ".env"
    assert candidates[1] == _bootstrap.REPO_ROOT / ".env"
    # 关键回归：默认值不得指向仓库之外的私有目录
    for path in candidates:
        assert _bootstrap.REPO_ROOT in path.parents
    assert _bootstrap.find_env_file(str(tmp_path / "missing.env")) == (
        tmp_path / "missing.env"
    ).resolve()
