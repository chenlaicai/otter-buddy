#!/usr/bin/env bash
# e2e 冒烟服务管理器（F20260920ecig，issue #1058）。
#
# Usage:
#   scripts/e2e-server.sh start   构建并启动 e2e 冒烟服务（config.e2e.yaml，端口 3199）
#   scripts/e2e-server.sh stop    停止并清理（服务进程 + e2e 数据目录）
#   scripts/e2e-server.sh run <playwright-args...>
#                                 start → 等健康 → npx playwright test → stop（始终清理）
#
# 设计：
#   - 与 alpha.sh 的分工：alpha 是「本地验证环境管理器」（config 副本+独立数据根+端口段协商），
#     本脚本是「CI/本地共用的 e2e 冒烟流水线」（固定 config.e2e.yaml + 固定端口 3199 +
#     幂等清理）。CI 步骤与本地命令完全同构，避免两套逻辑漂移。
#   - 端口 3199：3100-3198 偶数段是 alpha 专属（scripts/alpha.sh），取段外奇数尾避免冲突。
#   - 健康等待复用 alpha.sh 同款轮询（/api/settings），超时 90s（无 embedding 模型时启动应 <10s，
#     放宽余量覆盖 CI 冷缓存；下载模型失败不阻塞启动——FTS-only 降级路径）。
set -euo pipefail

PORT=3199
BASE_URL="http://localhost:${PORT}"
HEALTH_TIMEOUT=90
# 路径一律锚定 repo root（cmd_run 会 cd web 跑 playwright，EXIT trap 里的 cmd_stop
# 若用相对路径会解析到 web/ 下——pid 文件找不到 → 服务孤儿。实测踩过。）
REPO_ROOT="$(git rev-parse --show-toplevel)"
E2E_DATA_DIR="${REPO_ROOT}/data/e2e"
E2E_PID_FILE="${E2E_DATA_DIR}/server.pid"
LOG_FILE="${E2E_DATA_DIR}/server.log"

die() { echo "Error: $1" >&2; exit 1; }

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    if curl -sf -o /dev/null "${BASE_URL}/api/settings"; then
      echo "e2e server healthy at ${BASE_URL}"
      return 0
    fi
    # 进程死了就别等了
    if [ -f "${E2E_PID_FILE}" ] && ! kill -0 "$(cat "${E2E_PID_FILE}")" 2>/dev/null; then
      echo "--- server log tail ---" >&2
      tail -20 "${LOG_FILE}" >&2 || true
      die "e2e server exited during startup"
    fi
    sleep 1
  done
  echo "--- server log tail ---" >&2
  tail -20 "${LOG_FILE}" >&2 || true
  die "e2e server not healthy within ${HEALTH_TIMEOUT}s"
}

cmd_start() {
  cd "${REPO_ROOT}"

  # 幂等：已在跑则先停
  if [ -f "${E2E_PID_FILE}" ] && kill -0 "$(cat "${E2E_PID_FILE}")" 2>/dev/null; then
    running_pid="$(cat "${E2E_PID_FILE}")"
    echo "e2e server already running (pid ${running_pid}), skipping start"
    return 0
  fi

  mkdir -p "${E2E_DATA_DIR}"

  # 端口占用快速失败（复核獭建议1）：/dev/tcp 探测是 bash 内建（3.2 可用、无 lsof 依赖）。
  # Why: 端口被占时服务 bind 失败，wait_healthy 要空转 90s 才 die，报错还无法定位是端口冲突。
  if (echo > "/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
    die "port ${PORT} already in use — another process is listening (hint: scripts/e2e-server.sh stop, or check the occupier)"
  fi

  # 后端构建（跳过 bge-m3 下载失败阻塞：build 脚本内已容错）+ 前端构建
  npm run build
  npm --prefix web ci
  npm --prefix web run build

  # 启动（后台、日志落文件）
  nohup node dist/src/main.js --config config/config.e2e.yaml > "${LOG_FILE}" 2>&1 &
  local pid=$!
  echo "$pid" > "${E2E_PID_FILE}"
  echo "e2e server starting (pid ${pid}) -> ${BASE_URL}"

  wait_healthy
}

cmd_stop() {
  if [ -f "${E2E_PID_FILE}" ]; then
    local pid
    pid="$(cat "${E2E_PID_FILE}")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # 优雅关闭窗口（main.ts SIGTERM dispose 5s 超时兜底）
      for _ in $(seq 1 7); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "${E2E_PID_FILE}"
  fi
  rm -rf "${E2E_DATA_DIR}"
  echo "e2e server stopped, data cleaned"
}

cmd_run() {
  # 始终清理（trap 保证失败路径也不留孤儿进程/脏数据）
  trap cmd_stop EXIT
  cmd_start
  cd web
  E2E_BASE_URL="${BASE_URL}" npx playwright test "$@"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  run)
    shift
    cmd_run "$@"
    ;;
  *) die "Usage: $0 start|stop|run [playwright-args...]" ;;
esac
