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

# 部署级配置放文件里，不改 cron 行：cron 是手写的，多一个环境变量就少一处"部署时漏改"。
# 文件由 root 持有、600；不存在也能跑（所有配置项都有默认值）。
if [ -r "$DIR/backup.env" ]; then
  # shellcheck disable=SC1091 # 运行时才存在的部署配置，不参与静态检查
  . "$DIR/backup.env"
fi

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

docker exec -i -e NAME="$NAME" -e UPLOADS="$UPLOADS" "$CONTAINER" python - <<'PY'
import os
import sqlite3

root = "/srv/backups"
path = os.path.join(root, os.environ["NAME"])
conn = sqlite3.connect(path)
result = conn.execute("PRAGMA integrity_check").fetchone()[0]
conn.close()
if result != "ok":
    raise SystemExit(f"[FAIL] integrity_check={result}")

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
print(f"integrity=ok uploads={upload_mb}MB")
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

echo "==> 异地副本（腾讯云 COS）"

# 计划 §9.4 #13 的第二个落点：跨云对象存储。上面的 BACKUP_OFFSITE_DIR 需要另一块盘或
# NAS；整机连同挂载盘一起丢掉时，只有跨云这一层还留着。
#
# 用腾讯云官方 CLI coscli，凭据在 /root/.cos.yaml（600），**本脚本不碰任何密钥**。
# 上传前不列举桶：子用户只授了对象级权限，列举会 403（2026-11-07 实测），
# 而备份文件名由 STAMP 唯一确定，上传与删除都不需要列举。
#
# 远端保留策略：本脚本只负责上传，不在远端轮转（删除要列举）。桶上挂一条
# 生命周期规则（30 天过期）即可；没挂就是一直累积，约 2.5MB/天。
COS_BUCKET="${BACKUP_COS_BUCKET:-}"
COS_CONFIG="${BACKUP_COS_CONFIG:-/root/.cos.yaml}"
if [ -z "$COS_BUCKET" ]; then
  echo "cos=skipped（未配置 BACKUP_COS_BUCKET）"
elif ! command -v coscli >/dev/null 2>&1; then
  # 配了桶却没装工具，是配置错误，不能当"没有异地副本"放过去。
  echo "[FAIL] coscli 未安装，无法上传异地副本" >&2
  exit 1
elif [ ! -r "$COS_CONFIG" ]; then
  echo "[FAIL] COS 凭据文件不可读：$COS_CONFIG" >&2
  exit 1
else
  for f in "$DIR/backups/$NAME" "$DIR/backups/$UPLOADS"; do
    base="$(basename "$f")"
    # 失败即中断：set -e 会让整脚本非零退出，cron 日志里直接是红的，
    # 而不是"备份跑完了"却只有一个本地副本。
    coscli cp "$f" "cos://$COS_BUCKET/$base" -c "$COS_CONFIG" >/dev/null
    echo "  uploaded $base ($(wc -c <"$f") bytes)"
  done
  echo "cos=uploaded bucket=$COS_BUCKET files=2"
fi

echo "==> 轮转本地旧份"

# 放在最后一步，是 2026-11-08 修的 P3-2：原来在容器里做完就 prune，
# 一旦随后 COS 上传失败（网络/凭据/额度），被删掉的旧份已经回不来了，
# 而失败方恰恰是"异地那一层"。现在只要上传没走完，脚本就在 set -e 处退出，
# 本地连旧带新全留着；下一次成功的运行再补做轮转。
docker exec -i -e KEEP="${KEEP:-7}" "$CONTAINER" python - <<'PY'
import os

root = "/srv/backups"
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
print(f"rotated db_kept={db_kept} uploads_kept={up_kept} keep={keep}")
PY

echo "==> 完成"
