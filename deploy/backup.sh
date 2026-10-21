#!/usr/bin/env bash
# 每日备份 SQLite + 上传目录到宿主机目录（卷外），各保留最近 7 份。
#
# 为什么不用 cp：
# - 库是 WAL 模式，直接 cp 会丢 -wal 里的最后几笔且不报错；
# - sqlite3 的 backup() 是在线热备，能拿到一致快照。
#
# 为什么备份到卷外：
# 卷损坏/误删时，备份若在同一个卷里等于没备份。
#
# 用法：./backup.sh            （cron 调用）
#       KEEP=14 ./backup.sh    （临时改保留份数）
# 恢复步骤见 docs/OPERATIONS.md §7.4。

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${CONTAINER:-matrix-hub}"
STAMP="$(date +%Y%m%d-%H%M)"
NAME="electro-${STAMP}.db"

echo "==> 备份 $CONTAINER -> $DIR/backups/$NAME"

# /srv/backups 由 compose 绑定到宿主机的 $DIR/backups
docker exec -i -e STAMP="$STAMP" "$CONTAINER" python - <<'PY'
import os
import sqlite3

src = os.environ.get("DB_PATH", "/srv/app_data/electro.db")
dst = f"/srv/backups/electro-{os.environ['STAMP']}.db"
os.makedirs("/srv/backups", exist_ok=True)

s = sqlite3.connect(src)
d = sqlite3.connect(dst)
with d:
    s.backup(d)
s.close()
d.close()
print(f"created {dst}")
PY

echo "==> 备份上传目录"

# 图片不在库里，只备份 db 等于"恢复后指导书还在、图全丢"。
# tar 在容器内执行：卷路径只有容器里才看得见，宿主机直接打包会拿到空目录。
docker exec -e NAME="uploads-${STAMP}.tar.gz" "$CONTAINER" \
    tar czf "/srv/backups/$NAME" -C /srv/app_data uploads

docker exec -i -e NAME="$NAME" -e UPLOADS="uploads-${STAMP}.tar.gz" -e KEEP="${KEEP:-7}" "$CONTAINER" python - <<'PY'
import os
import sqlite3

root = "/srv/backups"
path = os.path.join(root, os.environ["NAME"])
conn = sqlite3.connect(path)
result = conn.execute("PRAGMA integrity_check").fetchone()[0]
conn.close()
if result != "ok":
    raise SystemExit(f"[FAIL] integrity_check={result}")

keep = int(os.environ.get("KEEP", "7"))


def prune(prefix: str, suffix: str) -> int:
    files = sorted(
        (f for f in os.listdir(root) if f.startswith(prefix) and f.endswith(suffix)),
        key=lambda f: os.path.getmtime(os.path.join(root, f)),
        reverse=True,
    )
    for old in files[keep:]:
        os.remove(os.path.join(root, old))
    return min(len(files), keep)


db_kept = prune("electro-", ".db")
up_kept = prune("uploads-", ".tar.gz")
upload_path = os.path.join(root, os.environ["UPLOADS"])
upload_mb = round(os.path.getsize(upload_path) / 1024 / 1024, 2)
print(f"integrity=ok db_kept={db_kept} uploads_kept={up_kept} uploads={upload_mb}MB")
PY

echo "==> 完成"
