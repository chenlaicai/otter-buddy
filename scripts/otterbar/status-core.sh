#!/bin/bash
# status-core.sh — 系统侧状态聚合（渲染器无关）
# 海獭后端 → Display Model JSON（稳定契约，版本化）
# 渲染层（当前 MTMR / 未来自研 Swift）只消费 display-model.json，不碰后端 API。
#
# Display Model v1 契约：
# {
#   "v": 1,
#   "sys_online": true|false,          # 后端可达性（离线是显式状态，不降级成睡觉）
#   "waiting":  { "count": n, "top": "未读最多的会话名" },
#   "working":  { "convs": n, "otters": n }   # processing 新鲜窗内的会话数 / 去重海獭数
# }
set -euo pipefail

API_BASE="${OTTERBAR_API_BASE:-http://localhost:3000}"
MODEL_FILE="${OTTERBAR_MODEL_FILE:-$HOME/Library/Application Support/OtterBar/display-model.json}"
POLL_INTERVAL="${OTTERBAR_POLL_INTERVAL:-5}"
WORKING_FRESH="${OTTERBAR_WORKING_FRESH:-1800}"

OFFLINE_MODEL='{"v":1,"sys_online":false,"waiting":{"count":0,"top":""},"working":{"convs":0,"otters":0}}'

mkdir -p "$(dirname "$MODEL_FILE")"

fetch_model() {
  local data
  if ! data=$(curl -sf --max-time 4 "$API_BASE/api/conversations" 2>/dev/null); then
    printf '%s\n' "$OFFLINE_MODEL" > "$MODEL_FILE"
    return 0
  fi
  printf '%s' "$data" | jq --argjson fresh "$WORKING_FRESH" '
    def ts2epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    def fresh_working: select(.activityStatus == "processing")
      | select((now - ((.lastMessageTs // "1970-01-01T00:00:00Z") | ts2epoch)) < $fresh);
    [.[] | select(.status == "active")] as $act |
    {
      v: 1,
      sys_online: true,
      waiting: {
        count: ([$act[] | select((.unreadCount // 0) > 0)] | length),
        top: (([$act[] | select((.unreadCount // 0) > 0)] | sort_by(-(.unreadCount // 0)) | .[0].title) // "")
      },
      working: {
        convs: ([$act[] | fresh_working] | length),
        otters: ([$act[] | fresh_working | .otterIds[]?] | unique | length)
      }
    }' > "$MODEL_FILE"
}

while true; do
  fetch_model || printf '%s\n' "$OFFLINE_MODEL" > "$MODEL_FILE"
  sleep "$POLL_INTERVAL"
done
