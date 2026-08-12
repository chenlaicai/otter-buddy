#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/.otter-buddy.pid"
LOG_FILE="$PROJECT_DIR/.otter-buddy.log"
PORT="${PORT:-3000}"

# 解析 -p / --port 参数
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

port_owner_pid() {
  lsof -ti:"$1" 2>/dev/null | head -1 || true
}

cmd_start() {
  if is_running; then
    echo "[ok] Already running (PID $(cat "$PID_FILE")) -> http://localhost:$PORT"
    return 0
  fi

  # 端口冲突检测
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    echo "[error] Port $PORT is already in use (PID $occupant)"
    echo "  Stop it first:  kill $occupant"
    echo "  Or use another: $0 start -p <port>"
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
    if curl -sf "http://localhost:$PORT/api/settings" >/dev/null 2>&1; then
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

  # 检查端口是否被其他 worktree 占用
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    echo "[warn] Port $PORT is in use by another process (PID $occupant)"
    echo "       This is likely another worktree's Otter Buddy."
    echo "       Stop it from that worktree, or run:  kill $occupant"
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

  # 检查端口是否有其他进程
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    echo "[info] NOT running in this worktree, but port $PORT is in use (PID $occupant)"
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
  -p, --port <port>  Server port (default: 3000, or \$PORT env)

Examples:
  $(basename "$0") start              # start on port 3000
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
