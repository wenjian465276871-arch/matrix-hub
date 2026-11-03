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

# 探针（健康 + 业务只读）单独成文件：本地/CI 可直接 source 后验证，
# 不必真发一版才能测。见 deploy/probe.sh。
[ -f ./probe.sh ] || { echo "[FAIL] 缺少 probe.sh"; exit 1; }
# shellcheck source=probe.sh
. ./probe.sh


echo "==> 拉取镜像"
TAG="$NEW_TAG" docker compose pull web

echo "==> 启动"
TAG="$NEW_TAG" docker compose up -d web

echo "==> 健康检查（3 次全过才算成功）"
deploy_ok=0
failure_reason="健康检查未通过"
if health_check; then
  # 健康检查只证明"进程活着"，业务探针证明"接口能用"。两条都过才算部署成功：
  # 一个 200 的 /healthz + 一个 500 的 /guides，对用户来说就是坏版本。
  echo "==> 业务只读探针（列表 / 详情 / 知识库）"
  if probe_business; then
    deploy_ok=1
  else
    failure_reason="业务探针失败（接口非 200 或响应结构不符）"
    echo "[FAIL] ${failure_reason}" >&2
  fi
fi

if [ "$deploy_ok" -eq 1 ]; then
  echo "==> 部署成功: ${NEW_TAG}"
  sed -i "s/^TAG=.*/TAG=${NEW_TAG}/" "$ENV_FILE" || true
  record_state
  # 部署后 10 分钟 5xx 看门狗（计划 §9.4 #11）：健康检查与业务探针都是"这一瞬间"的判定，
  # 看不出"部署后第 3 分钟开始每个请求都 502"。后台跑，不阻塞 CI。
  if [ -x ./postdeploy_watch.sh ]; then
    if command -v setsid >/dev/null 2>&1; then
      setsid ./postdeploy_watch.sh "$NEW_TAG" "${PREV_TAG:-}" >>watch.log 2>&1 </dev/null &
    else
      ./postdeploy_watch.sh "$NEW_TAG" "${PREV_TAG:-}" >>watch.log 2>&1 </dev/null &
    fi
    echo "==> 已启动 10 分钟 5xx 看门狗（日志 watch.log）"
  fi
  # -a 是必须的：不带 -a 只清 dangling（无 tag）镜像，而 CI 每个部署都打 tag，
  # 结果就是每个 commit 留一个 318MB 的镜像，永不回收（10-19 实测已堆积 15 个）。
  docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
  exit 0
fi

echo "[FAIL] ${failure_reason}，开始回滚" >&2
if [ -n "${PREV_TAG:-}" ]; then
  TAG="$PREV_TAG" docker compose up -d web
  rolled_back=0
  for i in $(seq 1 6); do
    sleep 5
    if probe_health; then rolled_back=1; break; fi
    echo "    回滚复查第 ${i} 次未通过"
  done
  if [ "$rolled_back" -eq 1 ]; then
    echo "==> 已回滚到 ${PREV_TAG}" >&2
  else
    echo "[FAIL] 回滚后仍不健康，需要人工介入" >&2
  fi
else
  echo "[FAIL] 无上一版本可回滚（首次部署）" >&2
fi
record_state
exit 1
