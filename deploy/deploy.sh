#!/usr/bin/env bash
# 服务器侧部署脚本：拉取新镜像 → 起容器 → 健康检查 → 失败自动回滚
#
# 用法（在服务器 /opt/matrix-hub 下）：
#   ./deploy.sh                 # 部署当前 .env 里的 TAG
#   ./deploy.sh <git-sha>       # 部署指定 tag
#
# 约定：
# - .env 提供 IMAGE / TAG / SITE_DOMAIN / ACME_EMAIL，权限 600，不入库
# - 健康检查失败自动切回上一个 tag，并保留现场
# - 全程只操作镜像与容器，不做编译

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

ENV_FILE=".env"
[ -f "$ENV_FILE" ] || { echo "[FAIL] 缺少 $ENV_FILE"; exit 1; }

# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a

PREV_TAG="${TAG:-}"
NEW_TAG="${1:-$PREV_TAG}"
[ -n "$NEW_TAG" ] || { echo "[FAIL] 未指定 TAG"; exit 1; }
[ -n "${IMAGE:-}" ] || { echo "[FAIL] .env 缺少 IMAGE"; exit 1; }

echo "==> 目标镜像: ${IMAGE}:${NEW_TAG}"
echo "==> 当前镜像: ${IMAGE}:${PREV_TAG:-<none>}"

record_state() {
  {
    echo "time=$(date -Is)"
    echo "prev_tag=${PREV_TAG:-}"
    echo "new_tag=${NEW_TAG}"
    echo "image=${IMAGE}"
  } >> deploy.log
}

health_check() {
  local ok=0
  for i in 1 2 3; do
    sleep 5
    if curl -fsS --max-time 5 http://127.0.0.1:8001/healthz >/dev/null 2>&1 \
       && curl -fsSk --max-time 5 "https://${SITE_DOMAIN:-localhost}/" >/dev/null 2>&1; then
      ok=$((ok + 1))
    else
      echo "    第 ${i} 次探测失败"
    fi
  done
  [ "$ok" -ge 3 ]
}

echo "==> 拉取镜像"
docker compose pull web

echo "==> 启动"
TAG="$NEW_TAG" docker compose up -d web

echo "==> 健康检查（3 次全过才算成功）"
if health_check; then
  echo "==> 部署成功: ${NEW_TAG}"
  sed -i "s/^TAG=.*/TAG=${NEW_TAG}/" "$ENV_FILE" || true
  record_state
  docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true
  exit 0
fi

echo "[FAIL] 健康检查未通过，开始回滚" >&2
if [ -n "${PREV_TAG:-}" ]; then
  TAG="$PREV_TAG" docker compose up -d web
  sleep 5
  if curl -fsS --max-time 5 http://127.0.0.1:8001/healthz >/dev/null 2>&1; then
    echo "==> 已回滚到 ${PREV_TAG}" >&2
  else
    echo "[FAIL] 回滚后仍不健康，需要人工介入" >&2
  fi
else
  echo "[FAIL] 无上一版本可回滚（首次部署）" >&2
fi
record_state
exit 1
