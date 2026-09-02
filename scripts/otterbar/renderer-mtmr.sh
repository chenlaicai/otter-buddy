#!/bin/bash
# renderer-mtmr.sh — 渲染层（MTMR 载体，静态徽章版）
# 消费 Display Model JSON → 生成 MTMR items.json
# 契约：本文件不访问海獭后端，只读 display-model.json——未来切换自研 Swift
# 渲染端时，整体替换本文件即可，系统侧（status-core.sh）零改动。
#
# 行为细则：
# - 长离线（offline_long=true）：休眠自禁——items.json 置空数组，Touch Bar 回归
#   系统默认（MTMR 无配置时不渲染自定义内容）；launchd KeepAlive 会在 plist 的
#   ThrottleInterval 后拉起，拉起后若仍长离线则再次退出，形成低频探测循环。
#   core 恢复在线后 model 恢复正常，renderer 常驻显示。
# - 非主进程（primary=false）：显示 ⚠️ 徽章，数据照常显示（提示 3000 端口被
#   worktree 测试进程占用，搭档一眼识破）。
# - MTMR 对 items.json 全量重载无局部刷新，故徽章静态、标题未变不写盘。
# - 无 Touch Bar / 未装 MTMR 机器：只写孤儿文件，零副作用。
set -euo pipefail

MODEL_FILE="${OTTERBAR_MODEL_FILE:-$HOME/Library/Application Support/OtterBar/display-model.json}"
ITEMS_FILE="${OTTERBAR_ITEMS_FILE:-$HOME/Library/Application Support/MTMR/items.json}"
POLL_INTERVAL="${OTTERBAR_POLL_INTERVAL:-5}"

OFFLINE_MODEL='{"v":1,"sys_online":false,"offline_long":false,"primary":"unknown","waiting":{"count":0,"top":""},"working":{"convs":0,"otters":0}}'
EMPTY_ITEMS='[]'

sup() {
  local n=$1 out="" d
  local map=(⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹)
  if (( n == 0 )); then printf '%s' "⁰"; return; fi
  while (( n > 0 )); do
    d=$(( n % 10 )); out="${map[$d]}${out}"; n=$(( n / 10 ))
  done
  printf '%s' "$out"
}

build_title() {
  local model
  model=$(cat "$MODEL_FILE" 2>/dev/null || true)
  [[ -z "$model" ]] && model="$OFFLINE_MODEL"

  local online offline_long primary wcount wtop wconv wott
  online=$(jq -r '.sys_online // false' <<<"$model" 2>/dev/null || echo false)
  offline_long=$(jq -r '.offline_long // false' <<<"$model" 2>/dev/null || echo false)
  primary=$(jq -r '.primary // "unknown"' <<<"$model" 2>/dev/null || echo unknown)
  wcount=$(jq -r '.waiting.count // 0' <<<"$model" 2>/dev/null || echo 0)
  wtop=$(jq -r '.waiting.top // ""' <<<"$model" 2>/dev/null || echo "")
  wconv=$(jq -r '.working.convs // 0' <<<"$model" 2>/dev/null || echo 0)
  wott=$(jq -r '.working.otters // 0' <<<"$model" 2>/dev/null || echo 0)

  # 前缀：非主进程警告优先于一切在线状态
  local prefix=""
  [[ "$primary" == "false" ]] && prefix="⚠️非主·"

  if [[ "$online" != "true" ]]; then
    printf '%s' "🦦 ${prefix}🖤离线"
    return
  fi

  if (( wcount > 0 || wconv > 0 )); then
    local parts=()
    if (( wcount > 0 )); then parts+=("🔴$(sup "$wcount")"); fi
    if (( wconv > 0 )); then parts+=("⌨️${wconv}场${wott}獭"); fi
    local IFS=" "
    local title="🦦 ${prefix}${parts[*]}"
    if (( wcount > 0 && ${#wtop} > 0 )); then
      title="$title · ${wtop:0:10}"
    fi
    printf '%s' "$title"
  else
    printf '%s' "🦦 ${prefix}💤"
  fi
}

write_items() {
  local title=$1
  cat > "$ITEMS_FILE" << EOF
[
  {
    "type": "staticButton",
    "title": "$title",
    "width": 120
  },
  { "type": "escape" },
  { "type": "volumeDown", "width": 32 },
  { "type": "volumeUp", "width": 32 },
  { "type": "brightnessDown", "width": 32 },
  { "type": "brightnessUp", "width": 32 }
]
EOF
}

mkdir -p "$(dirname "$ITEMS_FILE")"
last_title="__init__"
while true; do
  offline_long=$(jq -r '.offline_long // false' "$MODEL_FILE" 2>/dev/null || echo false)
  if [[ "$offline_long" == "true" ]]; then
    # 长离线：置空配置让 Touch Bar 回归系统默认，自禁退出等 KeepAlive 低频拉起
    printf '%s\n' "$EMPTY_ITEMS" > "$ITEMS_FILE"
    exit 0
  fi
  title=$(build_title)
  if [[ "$title" != "$last_title" ]]; then
    write_items "$title"
    last_title="$title"
  fi
  sleep "$POLL_INTERVAL"
done
