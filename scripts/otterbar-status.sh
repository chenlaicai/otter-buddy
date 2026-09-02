#!/bin/bash
# otterbar-status.sh — Touch Bar 海獭状态桥（MTMR 渲染层）
# 从海獭后端拉取状态 → 生成 MTMR items.json → Touch Bar 常驻显示
#
# 三态判定（状态源与渲染层分离，MTMR 只是 renderer 之一）：
#   🔴 等你介入：active 会话 unreadCount > 0（有没看过的消息；读没读本身就是时间窗，
#      不再用陈年 awaiting_user 状态刷屏）
#   ⌨️ 干活中：activityStatus=processing 且 lastMessageTs ≤ WORKING_FRESH_SEC（防僵尸会话）
#   💤 睡觉：两者皆无
# 两态并存时合并显示（如 "🦦 🔴1 ⌨️2"）
#
# 环境变量（可选覆盖）：
#   OTTERBAR_API_BASE       后端地址，默认 http://localhost:3000
#   OTTERBAR_ITEMS_FILE     MTMR 配置路径
#   OTTERBAR_POLL_INTERVAL  轮询间隔秒，默认 5
#   OTTERBAR_WORKING_FRESH  processing 新鲜度窗口秒，默认 1800
set -euo pipefail

API_BASE="${OTTERBAR_API_BASE:-http://localhost:3000}"
ITEMS_FILE="${OTTERBAR_ITEMS_FILE:-$HOME/Library/Application Support/MTMR/items.json}"
POLL_INTERVAL="${OTTERBAR_POLL_INTERVAL:-5}"
WORKING_FRESH="${OTTERBAR_WORKING_FRESH:-1800}"

# ---------- 状态源：一次请求拿全部（activityStatus/unreadCount/lastMessageTs）----------

fetch_state() {
  curl -sf --max-time 4 "$API_BASE/api/conversations" 2>/dev/null | jq -r --argjson fresh "$WORKING_FRESH" '
    def ts2epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    [.[] | select(.status == "active")] |
    [
      ([.[] | select((.unreadCount // 0) > 0)] | length),
      ([.[] | select(.activityStatus == "processing") | select((now - ((.lastMessageTs // "1970-01-01T00:00:00Z") | ts2epoch)) < $fresh)] | length),
      ([.[] | select((.unreadCount // 0) > 0)][0].title // "")
    ] | @tsv' || printf "0\t0\t\n"
}

# ---------- 渲染层：MTMR items.json ----------

render_items() {
  local waiting=$1 working=$2 first_unread="$3"
  local parts=()

  (( waiting > 0 )) && parts+=("🔴等你×$waiting")
  (( working > 0 )) && parts+=("⌨️干活×$working")

  local title
  if (( ${#parts[@]} == 0 )); then
    title="🦦 💤 睡觉"
  else
    local IFS=" "
    title="🦦 ${parts[*]}"
  fi
  (( ${#first_unread} > 0 )) && title="$title · ${first_unread:0:12}"

  cat > "$ITEMS_FILE" << EOF
[
  {
    "type": "staticButton",
    "title": "$title",
    "width": 190,
    "align": "center",
    "bordered": false
  }
]
EOF
}

# ---------- 主循环 ----------

while true; do
  IFS=$'\t' read -r waiting working first_unread <<< "$(fetch_state)"
  render_items "${waiting:-0}" "${working:-0}" "${first_unread:-}"
  sleep "$POLL_INTERVAL"
done
