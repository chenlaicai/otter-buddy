#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${PROJECT_DIR}/.otter-buddy.pid"
LOG_FILE="${PROJECT_DIR}/.otter-buddy.log"

# issue #1252 遗留问题1：端口口径与 loadConfig 对齐（config-service.ts applyDefaults
# server: { port: d(raw.server?.port, 3000) }）——服务监听端口的唯一裁决者是
# config/config.yaml 的 server.port；PORT env 不参与服务端端口决策（src/ 全域零消费
# process.env.PORT），本脚本也不消费——保留 env 层会造成脚本探测口与服务监听口错位，
# 正是本 PR 要消灭的误报形态（本案 3102 事故）。
# 优先级：-p/--port 显式覆盖 > config.yaml server.port > 3000。
resolve_config_port() {
  local cfg="$PROJECT_DIR/config/config.yaml" line
  [ -f "$cfg" ] || return 1
  line=$(grep -E '^[[:space:]]*port:[[:space:]]*"?[0-9]+"?' "$cfg" | head -1) || return 1
  line="${line##*port:}"
  echo "${line%#*}" | tr -d " \t\"'"
}
PORT="$(resolve_config_port || echo 3000)"

# 主仓根：worktree 场景 git-common-dir 指向主仓 .git（其父目录即主仓根）。
# 与 scripts/alpha.sh main_repo_root 同口径。
main_repo_root() {
  local common
  common="$(git rev-parse --git-common-dir 2>/dev/null || echo ".git")"
  (cd "$common/.." && pwd)
}

# F20261014alps 机械闸：worktree 场景下禁止解析到主服务默认端口 3000。
# 端口宪法：主服务 3000 只有主仓能碰；worktree 内应走 alpha.sh（3100-3198 偶数段）。
# 此闸只拦「未显式指定端口却落到 3000」的默认路径——显式 -p 3000 是搭档特权，不拦。
# 只探测不消费：用 for 遍历 "$@"，禁止 shift——shift 会吞掉全部参数，
# 导致下方正式解析循环拿不到命令（start/stop 全落 usage，#1473 引入的回归）。
port_explicit=false
for arg in "$@"; do
  case "$arg" in
    -p|--port) port_explicit=true; break ;;
  esac
done
if [ "$port_explicit" = false ] && [ "$PORT" = "3000" ]; then
  MAIN_ROOT="$(main_repo_root)"
  if [ "$PROJECT_DIR" != "$MAIN_ROOT" ]; then
    echo "[error] Refusing to start on port 3000 from a worktree." >&2
    echo "        Port 3000 is the main service port — only the main repo may use it." >&2
    echo "        Use alpha.sh for isolated worktree validation:" >&2
    echo "          scripts/alpha.sh start" >&2
    echo "        (Or explicitly override with -p <port> if you really mean it.)" >&2
    exit 1
  fi
fi

# F20260916gtlr：本脚本是纯工具——不携带任何防海獭逻辑。
# 「海獭不得杀主进程」由 agent 运行时守卫在 tool 调用层拦截（bash-safety-guard），
# 海獭的一切命令必经 tool 管道，人走终端天然不在拦截域内。

# 解析 -p / --port 参数（显式 -p 覆盖 config 推导出的 PORT）
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port) PORT="$2"; shift 2 ;;
    start|stop|restart|status|logs) CMD="$1"; shift ;;
    *) CMD="$1"; shift ;;
  esac
done

is_running() {
  if [ ! -f "$PID_FILE" ]; then return 1; fi
  kill -0 "$(cat "$PID_FILE")" 2>/dev/null || return 1
}

get_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" || echo ""
}

# 端口占用者 = 监听者，不是「与端口有任意 TCP 关系的进程」（F20261103portx）。
# -sTCP:LISTEN 只留监听套接字：客户端连接进程（浏览器 ESTABLISHED 连接等）天然
# 排除——本案事故：Safari 网络进程的连接条目排在监听者前面，head -1 选中了它，
# stop 报「another worktree's Otter Buddy」并建议 kill 浏览器进程。
# 口径与下方杀伐校验（F20260831aksp T1）对齐——同文件同一端口问题不再两种写法。
port_owner_pid() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

# F20261103portx 监听者身份三分类：main-service / otter-or-node / foreign。
# PID 文件丢失时 stop/start/status 也要认得出自己的主进程（本案现场：主服务健康
# 在跑，仅因 PID 文件缺失被当「外人」）。特征：command 带 node 特征（绝对/相对
# 路径的 node 或 dist/src/main.js）→ 查 cwd；cwd=本仓 → main-service，否则
# otter-or-node（他处实例或别的 node 进程，cwd 一并展示供人判断）；无 node 特征
# → foreign。*/node 与 */node.exe 覆盖绝对路径启动形态（检视发现#2）。
# 占用者身份必须验证后才能断言——「likely another worktree's Otter Buddy」
# 这类未验证断言正是本案误报的第三层。
listener_class() {
  local pid="$1" cmd cwd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  # node 特征判定用 ERE（case glob 无法表达「路径定界 + 可带参数」的形态，
  # 带空格的 glob 模式在 case 里语法非法）：
  #   (^|/)node(\.exe)?( |$) —— 路径定界的 node，可带参数；避免 mynode 误匹配
  #   dist/src/main\.js     —— 海獭主服务入口特征（相对/绝对路径均命中）
  if echo "$cmd" | grep -qE '(^|/)node(\.exe)?( |$)|dist/src/main\.js'; then
    cwd="$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd" {print $NF; exit}')"
    if [ "$cwd" = "$PROJECT_DIR" ]; then echo "main-service"; else echo "otter-or-node"; fi
  else
    echo "foreign"
  fi
}

# F20261103portx 占用者报告（stop/start/status 复用）：报告「外人占端口」的两类
# （otter-or-node / foreign），main-service 分支由调用方自行处理（三处文案语义不同）。
# kill 建议只给经过身份验证的分支；foreign 分支明确提示「不是海獭，杀前先核实」。
report_port_occupant() {
  local port="$1" occupant="$2" cls cmd cwd
  cls="$(listener_class "$occupant")"
  cmd="$(ps -p "$occupant" -o command= 2>/dev/null || true)"
  case "$cls" in
    otter-or-node)
      cwd="$(lsof -p "$occupant" 2>/dev/null | awk '$4=="cwd" {print $NF; exit}')"
      echo "[warn] Port $port is in use by another process (PID $occupant, cwd: ${cwd:-unknown})"
      echo "       $cmd"
      echo "       If it is an Otter Buddy instance, stop it from that checkout."
      ;;
    foreign)
      echo "[warn] Port $port is in use by a non-Otter process (PID $occupant):"
      echo "       $cmd"
      echo "       It is NOT an Otter Buddy instance — verify before killing."
      ;;
  esac
}

cmd_start() {
  if is_running; then
    echo "[ok] Already running (PID $(cat "$PID_FILE")) -> http://localhost:$PORT"
    return 0
  fi

  # 端口冲突检测（F20261103portx：占用者身份先验证再报告）
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    if [ "$(listener_class "$occupant")" = "main-service" ]; then
      echo "[error] Otter Buddy is already running (PID $occupant, $PID_FILE missing)"
      echo "        To restart it:  kill $occupant && $0 start"
      exit 1
    fi
    report_port_occupant "$PORT" "$occupant"
    exit 1
  fi

  echo "[1/5] Installing dependencies ..."
  cd "$PROJECT_DIR"
  local install_output
  if ! install_output=$(npm install 2>&1); then
    echo "[error] npm install failed:"
    echo "$install_output"
    exit 1
  fi
  echo "[1/5] Dependencies OK"

  echo "[2/5] Building backend ..."
  local build_output
  if ! build_output=$(npm run build 2>&1); then
    echo "[error] Backend build failed:"
    echo "$build_output"
    exit 1
  fi
  echo "[2/5] Backend OK"

  echo "[3/5] Building frontend ..."
  if ! build_output=$(cd web && npm install && npm run build 2>&1); then
    echo "[error] Frontend build failed:"
    echo "$build_output"
    exit 1
  fi
  echo "[3/5] Frontend OK"

  echo "[4/5] Starting on port $PORT ..."
  : > "$LOG_FILE"
  # nohup + stdin /dev/null：解耦终端生命周期，关终端/IDE 不会带崩服务
  nohup env PORT="$PORT" node dist/src/main.js >> "$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # 等待服务就绪
  echo -n "[5/5] Waiting for server"
  local i
  for i in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo ""
      echo "[error] Server process (PID $pid) exited unexpectedly. Last 20 lines of log:"
      tail -20 "$LOG_FILE"
      rm -f "$PID_FILE"
      exit 1
    fi
    # #1322（F20261016autz）：/api/settings 已接鉴权——健康探针带身份头（无头 401 → curl -sf 判失败）
    if curl -sf -H 'X-Otter-User-Id: script:otter-buddy.sh' -H 'X-Otter-User-Role: admin' "http://localhost:$PORT/api/settings" >/dev/null 2>&1; then
      echo ""
      echo "[ok] Started (PID $pid) -> http://localhost:$PORT"
      echo "     Logs: $LOG_FILE"
      return 0
    fi
    echo -n "."
    sleep 1
  done

  echo ""
  echo "[warn] Server started (PID $pid) but health check timed out after 30s"
  echo "       Check logs: tail -f $LOG_FILE"
}

cmd_stop() {
  local my_pid
  my_pid=$(get_pid)

  # 有 PID 文件且进程存活：只杀自己的（先 SIGTERM 优雅退出，超时再 SIGKILL）
  if [ -n "$my_pid" ] && kill -0 "$my_pid" 2>/dev/null; then
    # F20260831aksp T1 杀伐校验：PID 文件里的进程必须确实是 $PORT 的监听者。
    # 关闭 8/29 事故 A 窗口：主仓目录跑 stop -p 3002 时 PID 文件指向 3000 主服务，-p 参数原先不参与杀伐决策。
    # lsof 不可用时跳过校验降级放行（增强闸门不做硬依赖）；端口无人监听但进程存活 → 拒杀（正是事故 A 形态）。
    if command -v lsof >/dev/null 2>&1; then
      local listen_pids
      listen_pids=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
      if ! echo "$listen_pids" | grep -qx "$my_pid"; then
        echo "[error] Refusing to stop: PID file ($PID_FILE) points to PID $my_pid,"
        echo "        but it is NOT listening on port $PORT (listener: ${listen_pids:-none})."
        echo "        Likely wrong directory or PID file from another instance."
        echo "        If you are SURE this process should die:  kill $my_pid"
        return 1
      fi
    fi
    echo -n "Stopping Otter Buddy (PID $my_pid) ..."
    kill -15 "$my_pid" 2>/dev/null || true
    for _ in $(seq 1 5); do
      kill -0 "$my_pid" 2>/dev/null || break
      echo -n "."
      sleep 1
    done
    if kill -0 "$my_pid" 2>/dev/null; then
      kill -9 "$my_pid" 2>/dev/null || true
      echo " (killed)"
    else
      echo " done"
    fi
    rm -f "$PID_FILE"
    return 0
  fi

  # 清理过期 PID 文件
  [ -f "$PID_FILE" ] && rm -f "$PID_FILE" || true

  # 端口占用报告（F20261103portx：无 PID 文件时先认人再说话——本案现场：主服务
  # 健康在跑，仅因 PID 文件缺失被当「另一实例」并误导 kill 命令）
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    if [ "$(listener_class "$occupant")" = "main-service" ]; then
      echo "[warn] Otter Buddy appears to be running (PID $occupant) but $PID_FILE is missing."
      echo "       To restart it:  kill $occupant && $0 start"
      return 1
    fi
    report_port_occupant "$PORT" "$occupant"
    return 1
  fi

  echo "[ok] Not running"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  local my_pid
  my_pid=$(get_pid)

  if [ -n "$my_pid" ] && kill -0 "$my_pid" 2>/dev/null; then
    echo "[ok] Running (PID $my_pid) -> http://localhost:$PORT"
    return 0
  fi

  # 检查端口占用（F20261103portx：身份验证后分类报告）
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    if [ "$(listener_class "$occupant")" = "main-service" ]; then
      echo "[ok] Running (PID $occupant, $PID_FILE missing) -> http://localhost:$PORT"
      return 0
    fi
    report_port_occupant "$PORT" "$occupant"
    return 0
  fi

  echo "[ok] Not running"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [-p port]

Commands:
  start     Build and start the server
  stop      Stop the server (this worktree only)
  restart   Restart the server
  status    Check if the server is running
  logs      Show log info

Options:
  -p, --port <port>  Server port (default: config/config.yaml server.port, fallback 3000)

Examples:
  $(basename "$0") start              # start on config.yaml server.port (fallback 3000)
  $(basename "$0") start -p 3001      # start on port 3001
  $(basename "$0") stop               # stop this worktree's server
  $(basename "$0") restart -p 3001    # restart on port 3001

Multi-worktree:
  # worktree A
  $(basename "$0") start -p 3000
  # worktree B
  $(basename "$0") start -p 3001

  # Each worktree manages its own server independently.
  # stop/restart only affects the current worktree's server.
EOF
}

CMD="${CMD:-}"
case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    echo "Logs: $LOG_FILE"; [ -f "$LOG_FILE" ] && tail -20 "$LOG_FILE" ;;
  *)       usage; exit 1 ;;
esac
