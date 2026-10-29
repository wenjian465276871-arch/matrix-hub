"""上传素材的落盘约定与存在性校验。

生成链路要回答一个问题：**用户说他有这张图，图真的在盘上吗**。
上传接口只管收图，回答不了这个问题——它不知道谁会引用这张图。
所以约定与校验放在这里，上传、生成、归位三个入口共用一套，避免三份正则漂移。

目录约定（一个资产一个目录，便于整目录清理）：

    <UPLOAD_DIR>/a_xxxxxxxxxxxxxxxx/
        a_xxxxxxxxxxxxxxxx.png   归一化后的整图（只存 PNG）
        a_xxxxxxxxxxxxxxxx_r1.png  切图块（可选）
        meta.json                来源格式、尺寸、sha256、切图次数
"""
from __future__ import annotations

import os
import re

# 资产 id 由上传接口分配；文件名只允许"资产 id"或"资产 id_rN / _full"，其余一律拒绝。
ASSET_RE = re.compile(r"^a_[0-9a-f]{16}$")
FILE_RE = re.compile(r"^a_[0-9a-f]{16}(_r\d+|_full)?\.png$")


def upload_dir() -> str:
    """运行时读取，便于测试注入；不要改成模块级常量。"""
    return os.getenv("UPLOAD_DIR", "app_data/uploads")


def asset_dir(asset_id: str) -> str:
    return os.path.join(upload_dir(), asset_id)


def asset_png(asset_id: str) -> str:
    return os.path.join(asset_dir(asset_id), f"{asset_id}.png")


def exists(asset_id: str) -> bool:
    """整图与元信息都在，才算"这张图可用"。

    只看 PNG 不看 meta 是不够的：清理脚本删元信息、或上传中途崩掉时，
    PNG 还在但没有任何来源信息，渲染出来就是一张来历不明的图。
    """
    if not ASSET_RE.match(asset_id):
        return False
    return os.path.exists(asset_png(asset_id)) and os.path.exists(
        os.path.join(asset_dir(asset_id), "meta.json")
    )


def public_url(asset_id: str) -> str:
    """同源地址；CSP 是 `img-src 'self'`，跨域/外链一律不可用。"""
    return f"/api/electro/uploads/{asset_id}/{asset_id}.png"
