#!/bin/bash
# status-core.sh — 系统侧状态聚合（渲染器无关）
# 海獭后端 → Display Model JSON（稳定契约，版本化）
# 渲染层（当前 MTMR / 未来自研 Swift）只消费 display-model.json，不碰后端 API。
#
# Display Model v1 契约：
# {
#   "v": 1,
#   "sys_online": true|false,            # 后端可达性（离线是显式状态，不降级成睡觉）
#   "offline_long": true|false,          # 离线超过 OFFLINE_LONG_SEC（默认600s）
#   "primary": true|false|"unknown",     # 3000 端口进程是否为主仓进程（防 worktree 测试进程冒充）
#   "waiting":  { "count": n, "top": "未读最多的会话名" },
#   "working":  { "convs": n, "otters": n }   # processing 新鲜窗内的会话数 / 去重海獭数
# }
#
# 主进程自证：取 3000 端口 LISTEN 进程的 cwd，与 OTTERBAR_PRIMARY_CWD 比对。
# cwd 非 ASCII（中文路径等）会退出码 5，取不到时 primary=unknown（渲染为降级徽章，
# 不误报）。检测只在数据可达时进行——离线时 primary 无意义，置 unknown。
#
# F20261103obarx 探活鉴权适配：#1541 鉴权层合入后 /api/conversations 须身份头，裸 curl 401
# 事故形态：服务在线却恒判离线 → renderer offline_long 退位 → launchd 60s 拉起循环 = Dock 闪动 4 天。
# 适配：①探活改带 user 档身份头（GET /api/conversations 需 authenticated 即可，最小权限；
# 运行时同机脚本，非浏览器，无 CSRF/preflight 面）；
# ②401 特判——带对头仍 401 = 鉴权口径变更信号，不应静默计入离线（fail-loud：记 stderr 供人查，
# 本轮不探活成功也不翻转 offline_long，避免“鉴权变更被当成离线”再现）。
set -euo pipefail

API_BASE="${OTTERBAR_API_BASE:-http://localhost:3000}"
MODEL_FILE="${OTTERBAR_MODEL_FILE:-$HOME/Library/Application Support/OtterBar/display-model.json}"
POLL_INTERVAL="${OTTERBAR_POLL_INTERVAL:-5}"
WORKING_FRESH="${OTTERBAR_WORKING_FRESH:-1800}"
OFFLINE_LONG_SEC="${OTTERBAR_OFFLINE_LONG_SEC:-600}"
PRIMARY_CWD="${OTTERBAR_PRIMARY_CWD:-/Users/orca/ai/otter-buddy}"

OFFLINE_MODEL='{"v":1,"sys_online":false,"offline_long":false,"primary":"unknown","waiting":{"count":0,"top":""},"working":{"convs":0,"otters":0}}'

mkdir -p "$(dirname "$MODEL_FILE")"

# 主进程自证：true / false / unknown
check_primary() {
  local pid cwd
  pid=$(lsof -tiTCP:"${API_BASE##*:}" -sTCP:LISTEN 2>/dev/null | head -1)
  [[ -z "$pid" ]] && printf 'unknown' && return
  if ! cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1); then
    printf 'unknown' && return
  fi
  [[ -z "$cwd" ]] && printf 'unknown' && return
  [[ "$cwd" == "$PRIMARY_CWD" ]] && printf 'true' || printf 'false'
}

fetch_model() {
  local resp http_code body
  # F20261103obarx：单请求取 code+body（-w 追加末行状态码，免双请求竞态与双倍开销）
  resp=$(curl -s -w '\n%{http_code}' --max-time 4 \
    -H "X-Otter-User-Id: otterbar-status-core" -H "X-Otter-User-Role: user" \
    "$API_BASE/api/conversations" 2>/dev/null) || resp=""
  http_code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [ "$http_code" = "200" ]; then
    :
  elif [ "$http_code" = "401" ] || [ "$http_code" = "403" ] || [ "$http_code" = "404" ]; then
    # F20261103obarx 口径漂移（检视#1/#2 修正）：401/403/404 = 鉴权或路由口径变更，
    # 服务可达但探活口径过时——非离线。fail-loud 记 stderr；MODEL_FILE 不动（保持最后
    # 已知真实状态），主循环冻结离线计时（return 2 语义），防「鉴权变更被当成离线」。
    echo "[status-core] WARN: /api/conversations $http_code with identity headers — probe contract drift (auth/route), not offline" >&2
    return 2
  else
    # 连接层失败（000=拒连/超时）或 5xx：可达性意义上的真离线
    printf '%s\n' "$OFFLINE_MODEL" > "$MODEL_FILE"
    return 1
  fi
  local data primary offline_long
  data="$body"
  primary=$(check_primary)
  offline_long=false
  # 兼容两种响应形态：v1 裸数组 / #1119 起分页包装 {items, total}
  # 归一化在最前面一步完成，后续 jq 逻辑保持原样
  printf '%s' "$data" | jq --argjson fresh "$WORKING_FRESH" \
    --arg primary "$primary" --argjson offline_long "$offline_long" '
    def ts2epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    def fresh_working: select(.activityStatus == "processing")
      | select((now - ((.lastMessageTs // "1970-01-01T00:00:00Z") | ts2epoch)) < $fresh);
    (if type == "array" then . else .items end) as $all |
    [$all[] | select(.status == "active")] as $act |
    {
      v: 1,
      sys_online: true,
      offline_long: $offline_long,
      primary: $primary,
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

# 离线计时：记录离线起始时刻，超窗后 model 标记 offline_long。
# F20261103obarx 三分类（检视#1 修正）：fetch_model 返回
#   0 = 在线，写 model，离线计时清零
#   2 = 口径漂移（401/403/404）——服务可达但探活口径过时：MODEL_FILE 已在 fetch_model
#       内保持不动，这里冻结离线计时（不重置不累积），防鉴权变更被当离线 4 天的事故再现
#   1 = 真离线（拒连/超时/5xx）——累积计时，超窗翻转 offline_long
offline_since=0
while true; do
  rc=0
  fetch_model || rc=$?
  if [ "$rc" -eq 0 ]; then
    offline_since=0
  elif [ "$rc" -eq 2 ]; then
    :  # 口径漂移：冻结计时，等人口径修复
  else
    now_epoch=$(date +%s)
    if (( offline_since == 0 )); then
      offline_since=$now_epoch
    elif (( now_epoch - offline_since >= OFFLINE_LONG_SEC )); then
      jq '.offline_long = true' "$MODEL_FILE" 2>/dev/null > "$MODEL_FILE.tmp" \
        && mv "$MODEL_FILE.tmp" "$MODEL_FILE" \
        || printf '%s\n' "$OFFLINE_MODEL" | jq '.offline_long = true' > "$MODEL_FILE"
    fi
  fi
  sleep "$POLL_INTERVAL"
done
