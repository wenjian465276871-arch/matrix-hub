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
  # scope=ready：检查失败返回 503，curl -f 直接失败；不带 scope 的默认口径
  # 永远 200（只有 status 字段变 degraded），不适合当部署闸门。
  #
  # 先取到变量再 `<<<` 喂给 grep，**不要写成 `curl ... | grep -q`**：
  # 理由同 probe_business 顶部注释（SIGPIPE + pipefail）。
  local body
  body=$(probe_curl "${PROBE_BASE}/healthz?scope=ready" 2>/dev/null) || return 1
  grep -q '"status":"ok"' <<< "$body"
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
#
# ## 2026-11-19：不许把大 body 串成管道（这条曾让部署无端回滚）
#
# 原写法是 `printf '%s' "$body" | head -c 1 | grep -q '{'`。`head -c 1` 读一个字节就退出，
# `printf` 还在写剩下的内容 → 收到 SIGPIPE（退出码 141）；而 deploy.sh 是 `set -o pipefail`，
# 整条管道被判为失败 → `return 1` → **接口明明全是 200，部署却报"响应结构不符"并回滚**。
#
# 触发条件是**响应变大**：知识库从 19 条涨到 397 条后，`/diagnose/kb` 从 ~2KB 变成 40KB，
# 超过管道缓冲后每次都 SIGPIPE；同一个函数里的 `grep -q` 也会提前退出，属同类隐患。
# 40KB 以下的小响应（guides 列表 902B）永远不触发，所以这个坑藏了很久。
#
# 结论：**判断首字符用 bash 内建 `${var:0:1}`，匹配用 `grep ... <<< "$var"`**，
# 两者都不建管道，下游退出再早也不会波及上游。
probe_business() {
  local base list body gid
  base="${PROBE_BASE}"

  list=$(probe_curl "${base}/api/electro/guides?limit=1" 2>/dev/null) || return 1
  [ "${list:0:1}" = "{" ] || return 1
  grep -Eq '"items":[[:space:]]*\[' <<< "$list" || return 1

  # 列表里没有已发布案例时跳过详情探测（首次空站不该因此部署失败）
  #
  # 用 bash 正则而不是 `grep -o | head -1 | sed`：`head -1` 同样会提前退出，
  # 一旦列表变大就重演上面那个 SIGPIPE；而且 grep 无匹配时 pipefail 会让赋值语句返回 1，
  # 在 `set -e` 下直接终止脚本。这里是纯内存匹配，两者都不存在。
  gid=""
  if [[ "$list" =~ \"id\":[[:space:]]*\"(g_[a-z0-9_]+)\" ]]; then
    gid="${BASH_REMATCH[1]}"
  fi
  if [ -n "$gid" ]; then
    body=$(probe_curl "${base}/api/electro/guides/${gid}" 2>/dev/null) || return 1
    [ "${body:0:1}" = "{" ] || return 1
    grep -Eq '"guide":[[:space:]]*\{' <<< "$body" || return 1
  fi

  body=$(probe_curl "${base}/api/electro/diagnose/kb" 2>/dev/null) || return 1
  [ "${body:0:1}" = "{" ] || return 1
  grep -Eq '"count":[[:space:]]*[1-9]' <<< "$body" || return 1
  return 0
}

# 业务探针重试（2026-11-13）。
#
# 为什么不是"探一次就判死"：容器刚起来时，启动保留期清理（retention 延迟 3s 起）
# 可能正在扫库/扫上传目录，第一次只读请求偶尔会超过 8s 超时。2026-11-13 15:43
# 的部署就因此回滚——同一镜像在临时容器里 list 200 / kb 200，回滚后旧容器也全过。
# 结构性故障（路由丢了、库空了）会连续失败，重试不会掩盖它；4 次 × 3s 只多等 9s。
probe_business_retry() {
  local i
  for i in 1 2 3 4; do
    probe_business && return 0
    if [ "$i" -lt 4 ]; then
      echo "    业务探针第 ${i} 次失败，3 秒后重试" >&2
      sleep 3
    fi
  done
  return 1
}
