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

port_in_use() {
  lsof -ti:"$1" 2>/dev/null | head -1
}

cmd_start() {
  if is_running; then
    echo "Otter Buddy is already running (PID $(cat "$PID_FILE")) -> http://localhost:$PORT"
    return 0
  fi

  # 端口冲突检测
  local occupant
  occupant=$(port_in_use "$PORT")
  if [ -n "$occupant" ]; then
    echo "Error: port $PORT is already in use (PID $occupant)"
    echo "  Use -p <port> to specify a different port, or stop the existing process first:"
    echo "  $0 stop -p $PORT"
    exit 1
  fi

  echo "Starting Otter Buddy on port $PORT ..."
  cd "$PROJECT_DIR"
  PORT="$PORT" npm start &
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
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Stopped Otter Buddy (PID $pid)"
  fi

  # 确保端口释放
  local pids
  pids=$(lsof -ti:"$PORT" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null
    echo "Freed port $PORT"
  fi

  if ! is_running && [ -z "$pids" ]; then
    echo "Otter Buddy is not running"
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  if is_running; then
    echo "Otter Buddy is running (PID $(cat "$PID_FILE")) -> http://localhost:$PORT"
  else
    echo "Otter Buddy is not running"
  fi
}

cmd_logs() {
  echo "Run 'PORT=$PORT npm start' in $PROJECT_DIR to see live logs"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [-p port]

Commands:
  start     Build and start the server
  stop      Stop the server
  restart   Restart the server
  status    Check if the server is running
  logs      Show log info

Options:
  -p, --port <port>  Server port (default: 3000, or \$PORT env)

Examples:
  $(basename "$0") start              # start on port 3000
  $(basename "$0") start -p 3001      # start on port 3001
  $(basename "$0") stop               # stop
  $(basename "$0") restart -p 3001    # restart on port 3001
EOF
}

CMD="${CMD:-}"
case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)       usage; exit 1 ;;
esac
