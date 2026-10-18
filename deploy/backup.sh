#!/usr/bin/env bash
# 每日备份 SQLite 到宿主机目录（卷外），保留最近 7 份。
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

docker exec -i -e NAME="$NAME" -e KEEP="${KEEP:-7}" "$CONTAINER" python - <<'PY'
import os
import sqlite3

root = "/srv/backups"
path = os.path.join(root, os.environ["NAME"])
conn = sqlite3.connect(path)
result = conn.execute("PRAGMA integrity_check").fetchone()[0]
conn.close()
if result != "ok":
    raise SystemExit(f"[FAIL] integrity_check={result}")

files = sorted(
    (f for f in os.listdir(root) if f.startswith("electro-") and f.endswith(".db")),
    key=lambda f: os.path.getmtime(os.path.join(root, f)),
    reverse=True,
)
keep = int(os.environ.get("KEEP", "7"))
for old in files[keep:]:
    os.remove(os.path.join(root, old))
print(f"integrity=ok kept={min(len(files), keep)}")
PY

echo "==> 完成"
