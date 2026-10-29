"""访客写入治理的「口令豁免」通道（决策 #2 / 计划 §2.4）。

为什么需要它：公开站默认每 IP 2 次/时、10 次/日，正常演示够用；但现场演示、
批量生成样例会连续超过这个额度。计划里一直写着「预留仅口令可写开关」，
设计稿也留了口令入口，代码却从未实现——这里补齐，并把它限制在最小面：

- **只豁免「每 IP」配额**，全站日预算与队列上限照旧生效（费用口径不能开口子）；
- 口令只存在服务器 `.env`，不进仓库、不进日志、不回显；
- 换取的是**短期令牌**（HMAC 签名 + 过期时间），不是把口令本身发来发去；
- 验证接口本身限流，避免被当成口令爆破入口。

未配置 `ELECTRO_PASSCODE` 时，整个功能关闭：验证接口返回 503，生成接口行为不变。
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time

ENV = "ELECTRO_PASSCODE"
TOKEN_TTL_SECONDS = 12 * 3600
# 允许的时钟偏移：令牌有效期不接受"未来很远"的 exp，避免密钥泄露后被长期利用。
CLOCK_SKEW_SECONDS = 300


def enabled() -> bool:
    return bool(os.getenv(ENV, "").strip())


def _key() -> bytes:
    """由口令派生签名密钥。

    不直接用口令当 HMAC key：口令可能很短，派生一次让 key 固定为 32 字节；
    这不能把弱口令变强，但能避免"短 key + 已知消息"这种低级问题。
    """
    code = os.getenv(ENV, "")
    return hashlib.sha256(("electro-passcode-v1:" + code).encode("utf-8")).digest()


def verify_code(code: str) -> bool:
    """恒定时间比较，避免按字符逐位试探。"""
    expected = os.getenv(ENV, "")
    if not expected:
        return False
    return hmac.compare_digest(code.encode("utf-8"), expected.encode("utf-8"))


def issue(now: float | None = None, ttl: int = TOKEN_TTL_SECONDS) -> dict:
    moment = time.time() if now is None else now
    exp = int(moment + ttl)
    message = f"v1.{exp}"
    signature = hmac.new(_key(), message.encode("ascii"), hashlib.sha256).hexdigest()
    return {"token": f"{message}.{signature}", "expires_in": ttl}


def verify_token(token: str | None) -> bool:
    """格式错、过期、签名不符，一律 False；调用方不需要区分原因。"""
    if not token or not enabled():
        return False
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return False
    try:
        exp = int(parts[1])
    except ValueError:
        return False
    now = int(time.time())
    if exp <= now or exp > now + TOKEN_TTL_SECONDS + CLOCK_SKEW_SECONDS:
        return False
    message = f"v1.{exp}"
    expected = hmac.new(_key(), message.encode("ascii"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts[2])
