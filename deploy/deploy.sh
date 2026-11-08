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

# 故障注入变量必须在部署前为空（2026-11-08 加，对应评审 P3-5 / 待办 R5-7）。
#
# `FAULT_5XX_PATHS` 是回滚演练用的开关：置上之后对应业务路径恒 500，
# 而 `/healthz` 仍是 200（探针被刻意排除，否则演练时看门狗会先回滚掉它）。
# 也就是说——**演练完忘了清，健康检查看不出来，但用户每一个请求都失败**。
# 演练是人工操作，最容易漏的就是收尾，所以把收尾做成部署前的硬闸。
# 只报变量名、不回显值：.env 里的值可能带路径，不该进日志。
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?FAULT_[A-Z0-9_]*=' "$ENV_FILE"; then
  echo "[FAIL] $ENV_FILE 里残留故障注入变量，拒绝部署：" >&2
  grep -E '^[[:space:]]*(export[[:space:]]+)?FAULT_[A-Z0-9_]*=' "$ENV_FILE" \
    | sed -E 's/=.*/=<已隐去>/' >&2
  echo "       这是回滚演练的开关（业务路径会恒 500，而 /healthz 仍绿）。" >&2
  echo "       确认演练已结束后删掉对应行，再重新部署。" >&2
  exit 1
fi

# 闸门（2026-11-08 加，对应服务器专档 §9 #30）：上一次自动回滚失败就拒绝继续部署。
#
# 为什么要在部署前拦：回滚失败意味着"换回上一版也起不来"，生产已经是坏状态。
# 此时继续叠新版本，只会让现场更难还原，而且新版本的健康检查很可能在坏底座上
# 也过不了，把故障时间拉得更长。停线比抢修更安全。
#
# 三个细节：
#   ① 用 marker 文件而不是解析 JSON——shell 里 `[ -f ]` 不会因为格式变化而误判；
#   ② 允许显式放行 `ROLLBACK_FAILED_ACK=1`，现场确认过就用它，不做成死锁；
#   ③ 放行也要留痕：把 ack 写进 deploy.log，事后能查到"这次是人工越过闸门的"。
STATE_MARKER="backups/rollback_failed"
if [ -f "$STATE_MARKER" ] && [ "${ROLLBACK_FAILED_ACK:-}" != "1" ]; then
  echo "[FAIL] 上一次自动回滚失败，拒绝部署。现场信息："
  sed -n '1,20p' backups/rollback_state.json 2>/dev/null || echo "  （rollback_state.json 缺失）"
  echo "  确认已人工恢复并验证正常后："
  echo "    a) 删掉 backups/rollback_failed 与 backups/rollback_state.json；或"
  echo "    b) 本次执意要部署：ROLLBACK_FAILED_ACK=1 ./deploy.sh ${NEW_TAG}"
  echo "  站点状态："
  # 宿主机不发布 8001（只有 80/443），探针要在容器内跑，否则永远显示 000
  docker exec matrix-hub curl -s -m 5 -o /dev/null -w '    /healthz -> %{http_code}\n' http://127.0.0.1:8001/healthz || true
  exit 1
fi
if [ "${ROLLBACK_FAILED_ACK:-}" = "1" ]; then
  echo "[WARN] ROLLBACK_FAILED_ACK=1：越过「上次回滚失败」闸门（已记入 deploy.log）"
  printf 'ack_rollback_failed=1 time=%s new_tag=%s\n' "$(date -Is)" "$NEW_TAG" >> deploy.log
fi

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

# 回滚结局落盘：与 postdeploy_watch.sh 共用同一份实现（deploy/rollback_state.sh）。
# 2026-11-08 评审 P3-2：此前这里是 echo 一句就 exit，部署期回滚失败不落任何状态，
# 于是「换回上一版也起不来」这条最该被闸门拦住的路径反而没有程序可读的事实。
# shellcheck source=rollback_state.sh
. ./rollback_state.sh


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
    # 知识库自检（计划 §2.3）：quick 模式只跑检索、不调模型，约 50ms。
    # 用镜像里的真实知识库算 Top-3 与未覆盖识别，低于 80% 就回滚——
    # 迁移写坏或知识库文件漏打，都会在这里现形。
    echo "==> 知识库 Top-3 自检（quick，不调模型）"
    if eval_json=$(docker exec matrix-hub python -m scripts.eval_diagnose --quick --json 2>/dev/null); then
      echo "$eval_json"
      if printf '%s' "$eval_json" | grep -Eq '"passed":[[:space:]]*true'; then
        deploy_ok=1
      else
        failure_reason="知识库 Top-3 自检未达标"
        echo "[FAIL] ${failure_reason}" >&2
      fi
    else
      failure_reason="知识库自检执行失败（脚本退出码非 0）"
      echo "$eval_json" >&2
      echo "[FAIL] ${failure_reason}" >&2
    fi
  else
    failure_reason="业务探针失败（接口非 200 或响应结构不符）"
    echo "[FAIL] ${failure_reason}" >&2
  fi
fi

if [ "$deploy_ok" -eq 1 ]; then
  echo "==> 部署成功: ${NEW_TAG}"
  sed -i "s/^TAG=.*/TAG=${NEW_TAG}/" "$ENV_FILE" || true
  record_state

  # 用 ack 越过闸门时，部署成功不等于"上次那次回滚失败已经查清"。
  # 不自动删 marker（删了等于替人下结论），但必须提醒——否则下一次部署又会莫名其妙被拦。
  if [ -f "backups/rollback_failed" ]; then
    echo "[WARN] 本次是 ROLLBACK_FAILED_ACK=1 越过的；backups/rollback_failed 仍在。" >&2
    echo "       确认上次故障已查清后删掉它，否则下一次部署仍会被闸门拦住：" >&2
    echo "       rm -f backups/rollback_failed backups/rollback_state.json" >&2
  fi
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
  # 镜像回收：只留**当前版与上一版**（2026-11-08，评审 P3-7）。
  #
  # 原来的 `prune -af --filter until=168h` 要等 7 天才回收。2026-11-08 一天部署 8 次，
  # 实测堆了 12 个 × 321MB ≈ 3.9GB——40G 的盘上这不是理论风险。改成按 tag 保留：
  # 当前版（正在跑的）+ 上一版（唯一回滚位），其余立即删。
  #
  # 三条安全边界：① 只碰 `$IMAGE:` 前缀的 tag，不碰基础镜像与别的仓库；
  # ② 按引用删而不是 image id（同 id 多 tag 时按 id 删会误伤别的 tag）；
  # ③ 全程 `|| true`——清理失败绝不能把一次成功部署变成失败。
  # 更老的版本没丢：ACR 上有，需要时 `docker pull` 回来。
  keep_refs="${IMAGE}:${NEW_TAG}"
  if [ -n "${PREV_TAG:-}" ]; then keep_refs="$keep_refs ${IMAGE}:${PREV_TAG}"; fi
  docker images --format "{{.Repository}}:{{.Tag}}" | grep -F "${IMAGE}:" | while read -r ref; do
    case " $keep_refs " in *" $ref "*) continue ;; esac
    docker rmi "$ref" >/dev/null 2>&1 || true
  done
  docker image prune -f >/dev/null 2>&1 || true
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
    record_rollback "$PWD/backups" true "rollback_failed" \
      "deploy.sh 自身回滚后 6 次健康复查未通过" "$NEW_TAG" "${PREV_TAG:-}" || true
  fi
else
  echo "[FAIL] 无上一版本可回滚（首次部署）" >&2
  # 首次部署没有回滚点，站点多半没起来——同样落状态，让下一次部署先被闸门拦一下。
  record_rollback "$PWD/backups" true "no_prev_tag" \
    "首次部署失败且无可回滚版本" "$NEW_TAG" "" || true
fi
record_state
exit 1
