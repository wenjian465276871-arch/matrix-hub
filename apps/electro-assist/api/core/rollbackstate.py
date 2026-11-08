"""部署后看门狗的回滚结果（宿主写、容器读）。

**为什么需要这个文件**：`postdeploy_watch.sh` 回滚失败时只写一行
`[FAIL] 需人工介入` 然后 `exit 0`——没有任何出口。能发现"站点挂了"的只有
`uptime.yml`，而它实测日均 2–8 次、最坏间隔数小时。等于最坏情况下一整夜没人知道。

这里把"上次自动回滚的结局"变成一个可被程序读的事实，两个消费者：

1. `/healthz` 的 `rollback` 字段 —— 监控/人可以看；
2. `deploy.sh` 开头的闸门 —— **上一次回滚失败时拒绝继续部署**，除非显式 ack。
   理由：回滚失败意味着"换回上一版也起不来"，生产已经是坏状态，这时继续叠新版本
   只会让现场更难还原。

**为什么放在 backups 卷**：宿主 `/opt/matrix-hub/backups` 已挂进容器 `/srv/backups`
（`compose.yml` 的 `./backups:/srv/backups`），宿主 root 写得进去、容器 uid 10001
读得出来，不需要新增挂载，也不用放宽目录权限。轮转只删 `*.db` / `*.tar.gz`，不碰它。

**读不到就当没失败**：文件缺失、内容损坏、权限不足一律返回 `{}`。
`/healthz` 不能因为读不到一个状态文件就变成不健康——那会让部署脚本回滚一个正常版本。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_PATH = "/srv/backups/rollback_state.json"


def _state_path() -> Path:
    return Path(os.getenv("ROLLBACK_STATE_PATH") or DEFAULT_PATH)


def read() -> dict:
    """返回看门狗写下的最近一次回滚结果；没有或不合法时返回 `{}`。"""
    try:
        data = json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def summary() -> dict:
    """给 `/healthz` 用的精简视图。

    只暴露"有没有失败"和失败时的少量上下文，不透传整份文件——
    以后宿主往文件里加内部字段（比如完整日志路径），不会顺着健康检查漏出去。
    """
    state = read()
    if not state:
        return {"failed": False}
    failed = bool(state.get("failed"))
    view: dict = {"failed": failed}
    if failed:
        for key in ("at", "reason", "detail", "from_tag", "to_tag"):
            if state.get(key):
                view[key] = state[key]
    return view
