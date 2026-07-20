#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/.otter-buddy.pid"
PORT="${PORT:-3000}"

cmd_start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Otter Buddy is already running (PID $(cat "$PID_FILE"))"
    return 0
  fi

  echo "Starting Otter Buddy on port $PORT ..."
  cd "$PROJECT_DIR"
  npm start &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # 等待服务就绪
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/api/otters/big" >/dev/null 2>&1; then
      echo "Otter Buddy started (PID $pid) -> http://localhost:$PORT"
      return 0
    fi
    sleep 1
  done

  echo "Warning: server started (PID $pid) but health check timed out"
}

cmd_stop() {
  if [ ! -f "$PID_FILE" ]; then
    # fallback: 按端口杀进程
    local pids
    pids=$(lsof -ti:"$PORT" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill -9 2>/dev/null
      echo "Stopped process on port $PORT"
    else
      echo "Otter Buddy is not running"
    fi
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
    echo "Stopped Otter Buddy (PID $pid)"
  else
    echo "Otter Buddy (PID $pid) is not running"
  fi
  rm -f "$PID_FILE"

  # 确保端口释放
  local pids
  pids=$(lsof -ti:"$PORT" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Otter Buddy is running (PID $(cat "$PID_FILE")) -> http://localhost:$PORT"
  else
    echo "Otter Buddy is not running"
  fi
}

cmd_logs() {
  # 输出最近的服务器日志（前台模式下直接看终端）
  echo "Run 'npm start' in $PROJECT_DIR to see live logs"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  start     Build and start the server
  stop      Stop the server
  restart   Restart the server
  status    Check if the server is running
  logs      Show log info

Environment:
  PORT      Server port (default: 3000)
EOF
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)       usage; exit 1 ;;
esac
