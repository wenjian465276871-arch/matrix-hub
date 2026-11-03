#!/usr/bin/env bash
# 部署探针：健康探针 + 业务只读探针。
#
# 单独成文件是为了能被本地/CI 直接 `source` 后验证——把探测逻辑埋在一个
# 会直接执行部署的脚本里，就只能靠"真发一版"来测它，那是本末倒置。
#
# 依赖：调用方先 `source .env`（需要 SITE_DOMAIN）；`set -uo pipefail` 由调用方设定。
#
# 本地联调：设 `PROBE_BASE_URL=http://127.0.0.1:8001` 可跳过 TLS 与回环解析，
# 直接打本机端口。生产不设该变量，一律走 443 + --resolve 127.0.0.1。

# 8001 只在容器内监听，宿主机不可访问；必须经 Caddy 的 443，并用 --resolve
# 固定到回环地址，避免走到公网 DNS（2026-10-18 的教训：回滚复查探 8001 永远失败）。
PROBE_BASE="${PROBE_BASE_URL:-https://${SITE_DOMAIN}}"

probe_curl() {
  if [ -n "${PROBE_BASE_URL:-}" ]; then
    curl -fsS --max-time 8 "$@"
  else
    curl -fsSk --max-time 8 --resolve "${SITE_DOMAIN}:443:127.0.0.1" "$@"
  fi
}

probe_health() {
  probe_curl "${PROBE_BASE}/healthz" 2>/dev/null | grep -q '"status":"ok"'
}

health_check() {
  local streak=0 i
  for i in $(seq 1 8); do
    sleep 5
    if probe_health; then
      streak=$((streak + 1))
      echo "    探测通过 ${streak}/3（第 ${i} 次）"
      [ "$streak" -ge 3 ] && return 0
    else
      streak=0
      echo "    第 ${i} 次探测失败"
    fi
  done
  return 1
}

# 业务只读探针（2026-11-03）。
#
# 为什么 `/healthz` 不够：它只证明"进程活着、库能开、磁盘没满"。迁移写坏、
# 静态资源路径错、某个 router 没注册——这些都能满分通过 healthz，而用户点开就是
# 404/500。这里打三条**真实用户会走**的只读路径，任一失败即回滚，不等 10 分钟统计。
#
# 为什么是 GET：不花配额、不调模型、不写库；POST /generate 一次要 ¥0.05 且受配额限制，
# 不能拿它做探针。
#
# 为什么校验响应结构而不只看状态码：Caddy 的 SPA 回退会把不存在的路径变成 200 HTML，
# 只看 200 会把"路由丢了"判成健康。所以每条响应都要求"以 { 开头"且含预期字段。
#
# 注意 JSON 里可能有空格：同一个应用的不同端点序列化方式并不一致（默认 separators
# 与紧凑 separators 都出现过），正则必须用 `[[:space:]]*`，否则部署会因一个空格失败。
probe_business() {
  local base list body gid
  base="${PROBE_BASE}"

  list=$(probe_curl "${base}/api/electro/guides?limit=1" 2>/dev/null) || return 1
  printf '%s' "$list" | head -c 1 | grep -q '{' || return 1
  printf '%s' "$list" | grep -Eq '"items":[[:space:]]*\[' || return 1

  # 列表里没有已发布案例时跳过详情探测（首次空站不该因此部署失败）
  gid=$(printf '%s' "$list" | grep -o '"id":[[:space:]]*"g_[a-z0-9_]*"' | head -1 \
    | sed 's/.*"\(g_[a-z0-9_]*\)"/\1/')
  if [ -n "$gid" ]; then
    body=$(probe_curl "${base}/api/electro/guides/${gid}" 2>/dev/null) || return 1
    printf '%s' "$body" | head -c 1 | grep -q '{' || return 1
    printf '%s' "$body" | grep -Eq '"guide":[[:space:]]*\{' || return 1
  fi

  body=$(probe_curl "${base}/api/electro/diagnose/kb" 2>/dev/null) || return 1
  printf '%s' "$body" | head -c 1 | grep -q '{' || return 1
  printf '%s' "$body" | grep -Eq '"count":[[:space:]]*[1-9]' || return 1
  return 0
}
