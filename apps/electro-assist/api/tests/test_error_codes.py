"""错误码登记表的双向门禁（计划 §12.8「端点字段与错误码表冻结」）。

这份测试守的不是"某个接口返回什么码"，而是**登记表与代码不许分叉**：

- 代码里新加一个码、忘了登记 → `verify()` 报「代码里有、表里没登记」；
- 表里留着已经删掉的码 → 报「表里登记了、代码里没人用」；
- 有人用 f-string 拼码但不登记前缀 → 报「用了未登记的前缀族」。

为什么值得单独一个文件：`docs/API.md` §5 是从这张表渲染的，表错了文档就跟着错，
而文档错了没人会知道——前端只能对着 `code` 猜语义。这条链断在哪一环都不会报错，
所以要在 CI 里钉死。

负例都真的跑过：删掉 `ERROR_CODES` 里任意一条 → 本文件第 2 条红。
"""
from __future__ import annotations

from pathlib import Path

from core.errors import ERROR_CODES, PREFIX_FAMILIES, scan_used_codes, verify


def _fake_api(tmp_path: Path, body: str) -> Path:
    """造一个只有 `routers/x.py` 的最小 API 目录，供负例使用。"""
    routers = tmp_path / "routers"
    routers.mkdir()
    (routers / "x.py").write_text(body, encoding="utf-8")
    return tmp_path


def test_registry_matches_code() -> None:
    """真实代码与登记表必须完全对齐——这是门禁本体。"""
    problems = verify()
    assert problems == [], "错误码与登记表不一致：\n" + "\n".join(problems)
    # 数量下限只是防"表被清空后 verify 空转通过"（清空会让 stale 检查全绿）。
    assert len(ERROR_CODES) >= 50
    assert "extract_" in PREFIX_FAMILIES


def test_unregistered_code_is_detected(tmp_path: Path) -> None:
    """代码里出现未登记的码必须被报出来，且指出位置。"""
    api = _fake_api(
        tmp_path,
        'def f():\n    raise ValueError({"code": "brand_new_code"})\n',
    )
    problems = verify(api)
    hits = [p for p in problems if "brand_new_code" in p]
    assert hits, f"未登记的码没有被检出，实际输出：{problems[:3]}"
    assert "没登记" in hits[0]
    assert "routers/x.py" in hits[0]


def test_stale_entry_is_detected(tmp_path: Path) -> None:
    """表里有、代码里没人用，同样是缺陷——死条目会让读者以为它还会出现。"""
    api = _fake_api(tmp_path, "x = 1\n")
    problems = verify(api)
    assert any("adopt_limit" in p and "没人用" in p for p in problems)


def test_prefix_family_must_be_registered(tmp_path: Path) -> None:
    """f-string 拼码不能成为黑洞：前缀必须登记。"""
    api = _fake_api(
        tmp_path,
        'def f(kind):\n    return {"code": f"mystery_{kind}"}\n',
    )
    problems = verify(api)
    assert any("mystery_" in p and "前缀族" in p for p in problems)


def test_known_prefix_is_not_treated_as_exact_code(tmp_path: Path) -> None:
    """已登记前缀不该再被当成"未登记精确码"重复报一次。"""
    api = _fake_api(
        tmp_path,
        'def f(kind):\n    return {"detail": {"code": f"extract_{kind}"}}\n',
    )
    _, prefixes = scan_used_codes(api)
    assert "extract_" in prefixes
    problems = verify(api)
    assert not any("`extract_`" in p and "没登记" in p for p in problems)


def test_job_error_code_is_scanned() -> None:
    """异步任务的码走 `error_code=` 关键字，不扫它就会漏掉 `busy` / `internal`。"""
    exact, _ = scan_used_codes()
    assert "busy" in exact
    assert "internal" in exact
