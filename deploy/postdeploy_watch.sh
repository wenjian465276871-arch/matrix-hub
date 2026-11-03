#!/usr/bin/env bash
# 部署后看门狗：观察 10 分钟的真实请求与可达性，满足条件就自动回滚。
#
# 用法（服务器 /opt/matrix-hub 下）：
#   ./postdeploy_watch.sh <new_tag> <prev_tag>
#   ./postdeploy_watch.sh --self-test        # 只验判定逻辑，不碰容器
#
# 为什么需要它：deploy.sh 的 healthz + 业务探针都是"这一瞬间"的判定。一个部署后
# 第 3 分钟开始每个请求都 502 的版本（上游 Key 失效、慢查询打满、某个依赖间歇性
# 超时）能通过探针，用户却已经不可用。计划 §9.4 #11 要求"10 分钟内 5xx >1% 即回滚"。
#
# 判据为什么不是"比例 > 1% + 样本 ≥30"（2026-11-03 修正）：
# 低流量下比例没有统计意义——演示站 10 分钟常常只有 3–5 个请求，1 个 502 就是 20%，
# 但那是**一次**故障，不足以证明"这一版比上一版坏"。改成绝对数做主判据、比例做上限
# 保护：`5xx ≥3 条 且 比例 >1%`。3/20 回滚，3/5000（0.06%）不回滚。
# 依据：Google SRE Workbook 第 5 章（低流量服务）与低流量告警实践——比率必须配一个
# 绝对下限，否则小样本会把噪声当故障。
#
# 零流量盲区：如果容器或 Caddy 挂了，根本没有请求，错误率恒为 0%，看门狗会一直"绿"。
# 所以**探针连续失败**也要回滚——没有数据不是好消息，是另一种故障。
#
# 第三个限定：回滚前核对线上 tag。10 分钟窗口内可能又部署了一版，拿旧结论回滚新版本
# 是比"晚回滚"更糟的二次事故。

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

WINDOW_MIN="${WATCH_WINDOW_MIN:-10}"
INTERVAL_S="${WATCH_INTERVAL_S:-30}"
MIN_ERRORS="${WATCH_MIN_ERRORS:-3}"
THRESHOLD_PCT="${WATCH_5XX_PCT:-1}"
PROBE_FAIL_LIMIT="${WATCH_PROBE_FAIL_LIMIT:-2}"

log() {
  # 只写 stderr：调用方（deploy.sh）已经把 stdout+stderr 重定向进 watch.log。
  # 2026-11-03 实测踩坑：这里再用 `tee -a watch.log`，同一行会被写两遍
  # （tee 写一次 + stdout 被重定向再写一次），日志翻倍且时间线看起来像重复执行。
  # 手动前台跑想看文件就 `./postdeploy_watch.sh ... 2>&1 | tee -a watch.log`。
  printf '%s %s\n' "$(date -Is)" "$*" >&2
}

# 纯判定：返回 0 = 该回滚，1 = 继续观察。抽成函数才能被 --self-test 覆盖。
should_rollback() {
  local requests="$1" errors="$2"
  [ "$requests" -gt 0 ] || return 1
  [ "$errors" -ge "$MIN_ERRORS" ] || return 1
  # 整数比较：errors/requests > pct/100  ⇔  errors*100 > pct*requests
  [ $((errors * 100)) -gt $((THRESHOLD_PCT * requests)) ]
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  check() { # 期望 实际 说明
    if [ "$1" -eq "$2" ]; then
      echo "  ok   $3"
    else
      echo "  FAIL $3（期望 $1，实际 $2）"
      fail=1
    fi
  }
  should_rollback 20 3;   check 0 $? "20 请求 3 个 5xx（15%）→ 回滚"
  should_rollback 4 4;    check 0 $? "4 请求 4 个 5xx（100%）→ 回滚"
  should_rollback 1000 3; check 1 $? "1000 请求 3 个 5xx（0.3%，比例保护）→ 不回滚"
  should_rollback 5000 3; check 1 $? "5000 请求 3 个 5xx（0.06%）→ 不回滚"
  should_rollback 10 2;   check 1 $? "10 请求 2 个 5xx（不足 3 条）→ 不回滚"
  should_rollback 50 2;   check 1 $? "50 请求 2 个 5xx（4%，但不足 3 条）→ 不回滚"
  should_rollback 100 1;  check 1 $? "100 请求 1 个 5xx（1%，不大于阈值）→ 不回滚"
  should_rollback 0 0;    check 1 $? "0 请求（无流量，不能据此判定）→ 不回滚"
  [ "$fail" -eq 0 ] && echo "self-test 全部通过" || echo "self-test 有失败"
  exit "$fail"
fi

NEW_TAG="${1:-}"
PREV_TAG="${2:-}"
[ -n "$NEW_TAG" ] || { log "[watch] 缺少 new_tag"; exit 2; }
if [ -z "$PREV_TAG" ]; then
  log "[watch] 无上一版本可回滚（首次部署），跳过观察"
  exit 0
fi

[ -f .env ] || { log "[watch] 缺少 .env"; exit 2; }
# shellcheck disable=SC1090
set -a; . ./.env; set +a
: "${IMAGE:?}" "${SITE_DOMAIN:?}"

# 同一时间只允许一个看门狗：两轮叠在一起会互相回滚到不同的 tag。
LOCK=".watch.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  log "[watch] 已有看门狗在运行，退出"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

fetch_health() {
  curl -fsSk --max-time 5 --resolve "${SITE_DOMAIN}:443:127.0.0.1" \
    "https://${SITE_DOMAIN}/healthz" 2>/dev/null
}

probe_health() {
  fetch_health | grep -q '"status":"ok"'
}

current_tag() {
  docker inspect -f '{{.Config.Image}}' matrix-hub 2>/dev/null | sed 's/.*://'
}

# 回滚只有一份实现：统计触发与探针触发走同一条路径，避免两处逻辑漂移。
do_rollback() {
  local reason="$1" detail="$2" running healthy
  running=$(current_tag || true)
  if [ "$running" != "$NEW_TAG" ]; then
    log "[watch] 线上已是 ${running:-未知}，不是 ${NEW_TAG}；放弃回滚（已有更新的部署）"
    exit 0
  fi

  log "[watch] 回滚到 ${PREV_TAG}（原因：${reason}，${detail}）"
  if ! TAG="$PREV_TAG" docker compose up -d web >>watch.log 2>&1; then
    log "[watch][FAIL] 回滚命令失败，需人工介入"
    exit 1
  fi

  healthy=0
  for i in $(seq 1 6); do
    sleep 5
    if probe_health; then healthy=1; break; fi
    log "[watch] 回滚复查第 ${i} 次未通过"
  done

  if [ "$healthy" -eq 1 ]; then
    # .env 也要退回去，否则下一次手工 `docker compose up -d` 又把坏版本拉起来
    sed -i "s/^TAG=.*/TAG=${PREV_TAG}/" .env 2>/dev/null || true
    log "[watch] 已回滚到 ${PREV_TAG}（.env TAG 已同步）"
  else
    log "[watch][FAIL] 回滚后仍不健康，需人工介入"
  fi

  {
    echo "time=$(date -Is)"
    echo "reason=${reason}"
    echo "detail=${detail}"
    echo "from=${NEW_TAG}"
    echo "to=${PREV_TAG}"
    echo "health_ok=${healthy}"
  } >> deploy.log
  exit 0
}

log "[watch] 开始观察：new=${NEW_TAG} prev=${PREV_TAG} 窗口=${WINDOW_MIN}min 阈值=${THRESHOLD_PCT}% 最少错误=${MIN_ERRORS} 探针容错=${PROBE_FAIL_LIMIT}"

deadline=$(( $(date +%s) + WINDOW_MIN * 60 ))
probe_failures=0
last_requests=0
last_errors=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$INTERVAL_S"

  body=$(fetch_health)
  if [ -z "$body" ]; then
    probe_failures=$((probe_failures + 1))
    log "[watch] healthz 不通（连续 ${probe_failures}/${PROBE_FAIL_LIMIT} 次）"
    if [ "$probe_failures" -ge "$PROBE_FAIL_LIMIT" ]; then
      # 零流量盲区：没有请求时错误率恒为 0%，探针不通就是唯一的信号
      do_rollback "probe_failed" "consecutive=${probe_failures}"
    fi
    continue
  fi
  probe_failures=0

  requests=$(printf '%s' "$body" | grep -o '"requests":[0-9]*' | head -1 | cut -d: -f2)
  errors=$(printf '%s' "$body" | grep -o '"errors_5xx":[0-9]*' | head -1 | cut -d: -f2)
  if [ -z "${requests:-}" ] || [ -z "${errors:-}" ]; then
    log "[watch] 响应里没有 http 段（跑的是旧镜像？），本轮跳过"
    continue
  fi
  last_requests="$requests"
  last_errors="$errors"

  if should_rollback "$requests" "$errors"; then
    log "[watch] 5xx 超判据：${errors}/${requests}"
    do_rollback "postdeploy_5xx" "ratio=${errors}/${requests}"
  fi

  # 日志要如实区分三种情况："没流量"不等于"正常"，"错误很少"也不等于"正常"。
  if [ "$requests" -eq 0 ]; then
    log "[watch] 无真实请求（0 条），不做统计判定"
  elif [ "$errors" -eq 0 ]; then
    log "[watch] 正常：0/${requests} 个 5xx"
  elif [ "$errors" -lt "$MIN_ERRORS" ]; then
    log "[watch] 少量 5xx：${errors}/${requests}，未达最少 ${MIN_ERRORS} 条，不回滚"
  else
    log "[watch] 5xx ${errors}/${requests} 但比例未超 ${THRESHOLD_PCT}%，不回滚"
  fi
done

# 结束语说清楚"为什么没回滚"，不要用一句"未触发"掩盖"根本没样本"。
if [ "$last_requests" -eq 0 ]; then
  log "[watch] 观察结束：窗口内无真实请求，未做统计判定（${NEW_TAG}）"
else
  log "[watch] 观察结束：末次 ${last_errors}/${last_requests} 个 5xx，未达回滚判据（${NEW_TAG}）"
fi
exit 0
