#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/.otter-buddy.pid"
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
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

get_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" || echo ""
}

port_owner_pid() {
  lsof -ti:"$1" 2>/dev/null | head -1
}

cmd_start() {
  if is_running; then
    echo "Otter Buddy is already running (PID $(cat "$PID_FILE")) -> http://localhost:$PORT"
    return 0
  fi

  # 端口冲突检测
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    echo "Error: port $PORT is already in use (PID $occupant)"
    echo "  Stop it first:  kill $occupant"
    echo "  Or use another: $0 start -p <port>"
    exit 1
  fi

  echo "Building Otter Buddy ..."
  cd "$PROJECT_DIR"
  npm run build 2>&1 | tail -1

  echo "Starting Otter Buddy on port $PORT ..."
  PORT="$PORT" node dist/src/main.js &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # 等待服务就绪
  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/api/otters/big" >/dev/null 2>&1; then
      echo "Otter Buddy started (PID $pid) -> http://localhost:$PORT"
      return 0
    fi
    sleep 1
  done

  echo "Warning: server started (PID $pid) but health check timed out"
}

cmd_stop() {
  local my_pid
  my_pid=$(get_pid)

  # 有 PID 文件且进程存活：只杀自己的（先 SIGTERM 优雅退出，超时再 SIGKILL）
  if [ -n "$my_pid" ] && kill -0 "$my_pid" 2>/dev/null; then
    kill -15 "$my_pid" 2>/dev/null || true
    for _ in $(seq 1 5); do
      kill -0 "$my_pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$my_pid" 2>/dev/null; then
      kill -9 "$my_pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "Stopped Otter Buddy (PID $my_pid)"
    return 0
  fi

  # 清理过期 PID 文件
  [ -f "$PID_FILE" ] && rm -f "$PID_FILE"

  # 检查端口是否被其他 worktree 占用
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    echo "Port $PORT is in use by another process (PID $occupant)"
    echo "  This is likely another worktree's Otter Buddy."
    echo "  Stop it from that worktree, or run:  kill $occupant"
    return 1
  fi

  echo "Otter Buddy is not running"
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
    echo "Otter Buddy is running (PID $my_pid) -> http://localhost:$PORT"
    return 0
  fi

  # 检查端口是否有其他进程
  local occupant
  occupant=$(port_owner_pid "$PORT")
  if [ -n "$occupant" ]; then
    echo "Otter Buddy is NOT running in this worktree"
    echo "  But port $PORT is in use by another process (PID $occupant)"
    return 0
  fi

  echo "Otter Buddy is not running"
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
  logs)    echo "Run 'PORT=$PORT npm start' in $PROJECT_DIR to see live logs" ;;
  *)       usage; exit 1 ;;
esac
