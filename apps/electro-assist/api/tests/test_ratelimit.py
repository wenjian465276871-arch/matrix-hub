"""限流的契约测试。

关注三件事：
1. 阈值真的生效，且拒绝时带 `Retry-After`（前端 429 倒计时的唯一依据）；
2. 换 IP 各自独立，全站上限能兜住"换 IP 绕过"；
3. X-Forwarded-For 只认最右一段——左侧是客户端可伪造的，认错等于限流形同虚设。
"""
from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from core import imaging
from core import ratelimit
from main import app

client = TestClient(app)
URL = "/api/electro/uploads"


def _jpeg(width: int = 1000, height: int = 750) -> bytes:
    """刚好过准入的最小图，避免测试在大图上浪费时间。"""
    im = Image.new("RGB", (width, height), "white")
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _post(ip: str):
    return client.post(
        URL,
        files={"file": ("p.jpg", _jpeg(), "image/jpeg")},
        headers={"X-Forwarded-For": ip},
    )


def test_per_ip_hour_limit_and_retry_after(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    for i in range(ratelimit.DEFAULT_PER_HOUR):
        assert _post("203.0.113.7").status_code == 200, f"第 {i+1} 次应放行"

    r = _post("203.0.113.7")
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "rate_limited"
    retry_after = r.headers.get("Retry-After")
    assert retry_after is not None and retry_after.isdigit()
    assert int(retry_after) > 0


def test_ips_are_independent(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    for _ in range(ratelimit.DEFAULT_PER_HOUR):
        assert _post("203.0.113.7").status_code == 200
    assert _post("203.0.113.7").status_code == 429
    # 另一个 IP 不受影响
    assert _post("198.51.100.9").status_code == 200


def test_site_wide_cap_stops_ip_rotation(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    monkeypatch.setenv("UPLOAD_SITE_PER_DAY", "2")
    ratelimit.reset_limiter()  # 重建单例，让新 env 生效

    assert _post("203.0.113.1").status_code == 200
    assert _post("203.0.113.2").status_code == 200
    # 换第三个 IP：单 IP 额度充足，但全站额度已用尽
    r = _post("203.0.113.3")
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_xff_uses_rightmost_segment(tmp_path, monkeypatch):
    """左侧伪造值不得影响额度归属。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    for _ in range(ratelimit.DEFAULT_PER_HOUR):
        assert _post("9.9.9.9, 203.0.113.7").status_code == 200

    # 左侧换一个伪造值，最右仍是被限的那个 IP
    r = _post("8.8.8.8, 203.0.113.7")
    assert r.status_code == 429


def test_limiter_counts_only_accepted(tmp_path, monkeypatch):
    """被拒的请求不能继续累加，否则额度永远不会恢复。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    for _ in range(ratelimit.DEFAULT_PER_HOUR):
        _post("203.0.113.7")
    for _ in range(5):
        assert _post("203.0.113.7").status_code == 429

    limiter = ratelimit.get_limiter()
    assert len(limiter._hits["203.0.113.7"]) == ratelimit.DEFAULT_PER_HOUR


def test_corrupt_image_returns_422_not_500(tmp_path, monkeypatch):
    """截断的 JPEG 能过魔数与尺寸检查，但解码会失败——必须是 4xx。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    good = _jpeg()
    broken = good[: len(good) // 3]
    r = client.post(
        URL,
        files={"file": ("p.jpg", broken, "image/jpeg")},
        headers={"X-Forwarded-For": "203.0.113.55"},
    )
    assert r.status_code in (415, 422), r.text
