#!/usr/bin/env bash
# 回滚结局落盘：`deploy.sh` 与 `postdeploy_watch.sh` 共用同一份实现。
#
# **为什么抽出来**（2026-11-08 评审 P3-2/P3-3）：
# 1. 两个回滚点原先各写各的——看门狗有 `record_rollback`，`deploy.sh` 自己回滚失败时
#    只 `echo [FAIL] 需人工介入` 就 exit 1，不落任何状态。结果是「部署期回滚失败」这条
#    最该被闸门拦住的路径，恰恰没有留下任何程序可读的事实。
# 2. 这份状态被 `/healthz` 解析，字段名与权限必须两处完全一致：容器 uid 10001 要能读，
#    文件就得 644；谁写歪一处，线上就是「有状态但看不见」。
#
# 三份产物：
#   rollback_state.json     最近一次结局（覆盖写，`/healthz` 读它）
#   rollback_failed         marker，存在即代表失败（`deploy.sh` 用它做硬闸，`[ -f ]` 不解析 JSON）
#   rollback_history.jsonl  追加写，每次结局一行（P3-3：覆盖写会丢掉上一次失败，历史不能只留一份）
#
# 用法（两个脚本都 `source` 它，不要复制函数）：
#   record_rollback <state_dir> <true|false> <reason> <detail> <from_tag> <to_tag>
#
# 返回值：写成功 0，写失败 1（调用方自行决定要不要因此中断——`deploy.sh` 已在失败路径上，
# 不该因为写不了状态文件而改变退出码；看门狗同理）。

record_rollback() {
  local dir="$1" failed="$2" reason="$3" detail="$4" from_tag="$5" to_tag="$6"
  local state="$dir/rollback_state.json"
  local marker="$dir/rollback_failed"
  local history="$dir/rollback_history.jsonl"
  local at line

  mkdir -p "$dir" 2>/dev/null || true
  at=$(date -Is)

  # 单行 JSON。detail 来自固定字符串 + 计数，但这里仍做两层剥离：
  # 未转义的 `"` 会截断字符串，落单的 `\` 会形成非法转义（`\q`）——两者都会让
  # `/healthz` 读到坏 JSON，而 `rollbackstate.read()` 对坏 JSON 是**静默返回 {}**，
  # 也就是说：失败被"吞掉"，比报错更糟。tag 同样剥，代价为零。
  # 先剥反斜杠再剥引号：顺序反了的话 `\"` 会先被拆成 `\` + 空，留下一个反斜杠。
  local safe_detail safe_reason safe_from safe_to
  safe_detail=${detail//\\/}
  safe_detail=${safe_detail//\"/}
  safe_detail=${safe_detail//$'\n'/ }
  safe_reason=${reason//\\/}
  safe_reason=${safe_reason//\"/}
  safe_from=${from_tag//\\/}
  safe_from=${safe_from//\"/}
  safe_to=${to_tag//\\/}
  safe_to=${safe_to//\"/}

  line=$(printf '{"failed": %s, "at": "%s", "reason": "%s", "detail": "%s", "from_tag": "%s", "to_tag": "%s"}' \
    "$failed" "$at" "$safe_reason" "$safe_detail" "$safe_from" "$safe_to")

  if ! printf '%s\n' "$line" > "$state.tmp"; then
    echo "[state][FAIL] 状态文件写入失败（$state）" >&2
    return 1
  fi
  # 644 不是随手写的：容器里跑的是 uid 10001，root 写的 600 文件它读不到，
  # `/healthz` 就会一直显示 `{"failed": false}`——失败被权限静默吞掉。
  chmod 644 "$state.tmp" 2>/dev/null || true
  if ! mv -f "$state.tmp" "$state"; then
    echo "[state][FAIL] 状态文件替换失败（$state）" >&2
    return 1
  fi

  # 历史：追加，不覆盖。写不进去不阻断主流程（状态文件已经写成了）。
  printf '%s\n' "$line" >> "$history" 2>/dev/null || true

  if [ "$failed" = "true" ]; then
    if ! : > "$marker"; then
      echo "[state][FAIL] marker 创建失败（$marker）" >&2
      return 1
    fi
    chmod 644 "$marker" 2>/dev/null || true
  else
    rm -f "$marker"
  fi
  return 0
}
