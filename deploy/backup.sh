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
os.makedirs("/srv/backups", exist_ok=True, mode=0o700)
# 备份里是完整业务库（含访客工艺原文与会话记录），目录与文件都只给属主。
# 计划 §11.3.3：「加密（gpg/age）或至少 root-only 600」——这里取后者：
# 容器内没有 gpg，引入它要为 30MB 镜像与密钥托管再开一套流程，收益不成比例。
os.chmod("/srv/backups", 0o700)

s = sqlite3.connect(src)
d = sqlite3.connect(dst)
with d:
    s.backup(d)
s.close()
d.close()
os.chmod(dst, 0o600)
print(f"created {dst}")
PY

echo "==> 备份上传目录"

# 图片不在库里，只备份 db 等于"恢复后指导书还在、图全丢"。
# tar 在容器内执行：卷路径只有容器里才看得见，宿主机直接打包会拿到空目录。
# 注意：这里必须用独立变量。用同一个 $NAME 会被宿主机先展开成 db 文件名，
# 结果把刚备份好的 .db 覆盖成 tar.gz（2026-10-22 实测踩到过）。
UPLOADS="uploads-${STAMP}.tar.gz"
docker exec "$CONTAINER" tar czf "/srv/backups/$UPLOADS" -C /srv/app_data uploads

docker exec -i -e NAME="$NAME" -e UPLOADS="$UPLOADS" -e KEEP="${KEEP:-7}" "$CONTAINER" python - <<'PY'
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
# 上传包里有访客截图，权限与业务库同级。
os.chmod(upload_path, 0o600)
# 历史备份可能是 644：每次备份顺手收紧，不用等人工 chmod。
for name in os.listdir(root):
    path = os.path.join(root, name)
    if os.path.isfile(path) and (name.startswith("electro-") or name.startswith("uploads-")):
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
os.chmod(root, 0o700)
upload_mb = round(os.path.getsize(upload_path) / 1024 / 1024, 2)
print(f"integrity=ok db_kept={db_kept} uploads_kept={up_kept} uploads={upload_mb}MB")
PY

echo "==> 异地副本"

# 计划 §9.4 #13：本地备份不算"有备份"，要有第二个位置。
# 目的地由 BACKUP_OFFSITE_DIR 指定（挂载的 NAS / 另一块盘 / ossutil/rclone 的同步目录），
# 不配置就**明确打印 skipped**——"跑完了"和"有异地副本"是两件事，不许静默成功。
# 云对象存储需要你的 AK：把 OSS 挂到本机或让 rclone 同步该目录即可，脚本不碰凭证。
OFFSITE="${BACKUP_OFFSITE_DIR:-}"
if [ -z "$OFFSITE" ]; then
  echo "offsite=skipped（未配置 BACKUP_OFFSITE_DIR）"
else
  mkdir -p "$OFFSITE"
  for f in "$DIR/backups/$NAME" "$DIR/backups/$UPLOADS"; do
    cp -p "$f" "$OFFSITE/"
    src_bytes=$(wc -c < "$f")
    dst_bytes=$(wc -c < "$OFFSITE/$(basename "$f")")
    if [ "$src_bytes" != "$dst_bytes" ]; then
      echo "[FAIL] 异地副本大小不一致：$f ($src_bytes) vs $OFFSITE/$(basename "$f") ($dst_bytes)" >&2
      exit 1
    fi
  done
  # 与本地同口径轮转：只清理本脚本自己的两类文件，不碰目录里的其他东西。
  KEEP_N="${KEEP:-7}"
  for pattern in 'electro-*.db' 'uploads-*.tar.gz'; do
    # shellcheck disable=SC2012 # 文件名固定格式，无空格；ls -t 足够
    ls -1t "$OFFSITE"/$pattern 2>/dev/null | tail -n "+$((KEEP_N + 1))" | while read -r old; do
      rm -f -- "$old"
    done
  done
  echo "offsite=copied dir=$OFFSITE files=2 keep=$KEEP_N"
fi

echo "==> 完成"
