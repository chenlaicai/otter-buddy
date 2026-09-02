#!/bin/bash
# renderer-mtmr.sh — 渲染层（MTMR 载体，静态徽章版）
# 消费 Display Model JSON → 生成 MTMR items.json
# 契约：本文件不访问海獭后端，只读 display-model.json——未来切换自研 Swift
# 渲染端时，整体替换本文件即可，系统侧（status-core.sh）零改动。
#
# 为什么是静态的：MTMR 对 items.json 的任何变化都是整条 Touch Bar 全量重载
# （无局部刷新/无 websocket），字符轮换动画 = 每秒整条 bar 闪烁，不可用。
# 真动画需求走自研 Swift 渲染端课题（DFR 私有接口），见对应 issue。
#
# 无 Touch Bar 机器安全性：本脚本只写文件，不碰硬件；未装 MTMR 时 items.json
# 无人消费，纯孤儿文件，无副作用。
set -euo pipefail

MODEL_FILE="${OTTERBAR_MODEL_FILE:-$HOME/Library/Application Support/OtterBar/display-model.json}"
ITEMS_FILE="${OTTERBAR_ITEMS_FILE:-$HOME/Library/Application Support/MTMR/items.json}"
POLL_INTERVAL="${OTTERBAR_POLL_INTERVAL:-5}"

OFFLINE_MODEL='{"v":1,"sys_online":false,"waiting":{"count":0,"top":""},"working":{"convs":0,"otters":0}}'

# 数字 → Unicode 上标（🔴³ 比 🔴×3 紧凑）
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

  local online wcount wtop wconv wott
  online=$(jq -r '.sys_online // false' <<<"$model" 2>/dev/null || echo false)
  wcount=$(jq -r '.waiting.count // 0' <<<"$model" 2>/dev/null || echo 0)
  wtop=$(jq -r '.waiting.top // ""' <<<"$model" 2>/dev/null || echo "")
  wconv=$(jq -r '.working.convs // 0' <<<"$model" 2>/dev/null || echo 0)
  wott=$(jq -r '.working.otters // 0' <<<"$model" 2>/dev/null || echo 0)

  if [[ "$online" != "true" ]]; then
    printf '%s' "🦦 🖤离线"
    return
  fi

  if (( wcount > 0 || wconv > 0 )); then
    local parts=()
    if (( wcount > 0 )); then parts+=("🔴$(sup "$wcount")"); fi
    if (( wconv > 0 )); then parts+=("⌨️${wconv}场${wott}獭"); fi
    local IFS=" "
    local title="🦦 ${parts[*]}"
    if (( wcount > 0 && ${#wtop} > 0 )); then
      title="$title · ${wtop:0:10}"
    fi
    printf '%s' "$title"
  else
    printf '%s' "🦦 💤"
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
last_title=""
while true; do
  title=$(build_title)
  if [[ "$title" != "$last_title" ]]; then
    write_items "$title"
    last_title="$title"
  fi
  sleep "$POLL_INTERVAL"
done
