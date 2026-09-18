#!/usr/bin/env bash
# F20260917alph: alpha 验证环境管理器 — 每个 worktree 一个隔离的 otter-buddy 实例。
#
# Usage:
#   scripts/alpha.sh start [--port PORT] [--quick]  在当前 worktree 拉起隔离验证实例
#   scripts/alpha.sh status                          查看当前 worktree 的 alpha 状态
#   scripts/alpha.sh stop                            停止当前 worktree 的 alpha
#
# 结构隔离哲学（移植自 tutu-vessel alpha.sh，适配 otter 单进程形态）：
#   - 端口：3100-3198 偶数段（3000 主服务段之外的验证专用段），hash 建议制 + 冲突顺延
#     + 白名单避让（.otter/allowed-service-ports.json 声明的外部项目端口不占）
#   - 数据：~/.otter/alpha/<worktree-hash>/ 独立数据根（config 副本 + 空库 + 运行时
#     data/ 目录全落此处），与主服务三维不相交（端口/数据/PID）
#   - 启动：detached-launch.mjs 全分离进程（stdout 裸 PID 机器通道），survive 獭 shell 退出
#   - 失败：每条失败路径清理半启动进程树（TERM 1s → KILL），不留无锁文件的孤儿
#
# 端口宪法：主服务 3000 只有搭档碰；alpha 永远在 3100+ 段。端口被占就是答案——
# 不要去清它（换一个槽位），更永远不要碰 3000 主服务。
set -euo pipefail

# ── 常量 ────────────────────────────────────────────────────
ALPHA_PORT_MIN=3100
ALPHA_PORT_MAX=3198
ALPHA_SLOTS=50            # 3100-3198 偶数共 50 槽
HEALTH_PATH="/api/settings"
HEALTH_TIMEOUT=60         # 主服务冷启动含 embedding 模型加载，放宽到 60s

# ── 基础 helpers ────────────────────────────────────────────

die() { echo "Error: $1" >&2; exit 1; }

worktree_root() {
  git rev-parse --show-toplevel 2>/dev/null || die "Not inside a git repository"
}

# 主仓根：worktree 场景 git-common-dir 指向主仓 .git（其父目录即主仓根）；
# 主仓场景等于自身。与 scripts/download-bge-m3.mjs resolveModelDir 同口径。
main_repo_root() {
  local common
  common="$(git rev-parse --git-common-dir 2>/dev/null || echo ".git")"
  (cd "$common/.." && pwd)
}

# worktree 身份：绝对路径 sha256 前 8 位（tutu 同款——确定性，同 worktree 稳定）
worktree_hash() {
  echo -n "$(worktree_root)" | shasum -a 256 | cut -c1-8
}

alpha_root_dir() {
  echo "$HOME/.otter/alpha/$(worktree_hash)"
}

alpha_json_path() {
  echo "$(worktree_root)/.otter-alpha.json"
}

is_port_free() {
  ! lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

is_pid_alive() {
  kill -0 "$1" 2>/dev/null
}

# 白名单端口列表（换行分隔）。文件不存在/解析失败 → 空集（无避让）。
# 语义域：搭档手工声明的外部项目 dev server 端口（F20260914dsrv）——alpha 不占用，
# 防「白名单放行杀 alpha」与「restart-service 撞 alpha」两类语义混淆。
whitelisted_ports() {
  local repo_root="$1" wl
  wl="$repo_root/.otter/allowed-service-ports.json"
  [ -f "$wl" ] || return 0
  python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    for s in d.get('services', []):
        print(int(s['port']))
except Exception:
    pass
" "$wl" 2>/dev/null || true
}

# 建议端口：hash 十进制 % 50 → 3100 + n*2（确定性；同 worktree 端口稳定可复用）
suggest_port() {
  local h
  h=$(( 16#$(worktree_hash) % ALPHA_SLOTS ))
  echo $(( ALPHA_PORT_MIN + h * 2 ))
}

# 从建议端口起 +2 顺延探测（wrap 到段首），跳过被占与白名单端口；50 槽全满报错
find_free_port() {
  local main wl_ports p count=0
  main="$(main_repo_root)"
  wl_ports="$(whitelisted_ports "$main")"
  p="$(suggest_port)"
  while [ "$count" -lt "$ALPHA_SLOTS" ]; do
    if is_port_free "$p" && ! printf '%s\n' "$wl_ports" | grep -qx "$p"; then
      echo "$p"
      return 0
    fi
    p=$((p + 2))
    if [ "$p" -gt "$ALPHA_PORT_MAX" ]; then p="$ALPHA_PORT_MIN"; fi
    count=$((count + 1))
  done
  die "No free alpha port in ${ALPHA_PORT_MIN}-${ALPHA_PORT_MAX} (even slots, whitelist-excluded)"
}

is_valid_alpha_port() {
  local port="$1" main
  [ "$((port % 2))" -eq 0 ] && \
    [ "$port" -ge "$ALPHA_PORT_MIN" ] && \
    [ "$port" -le "$ALPHA_PORT_MAX" ] || return 1
  main="$(main_repo_root)"
  ! printf '%s\n' "$(whitelisted_ports "$main")" | grep -qx "$port"
}

# ── 进程管理（tutu 移植）────────────────────────────────────

# 递归终止进程树（先杀子进程，深度优先）。防 detached 子进程残留成孤儿。
kill_process_tree() {
  local pid="$1"
  local signal="${2:-TERM}"
  [ -n "$pid" ] || return 0
  is_pid_alive "$pid" || return 0
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_process_tree "$child" "$signal"
  done
  kill "-$signal" "$pid" 2>/dev/null || true
}

# 停掉进程树并短暂等待，超时升级 KILL。每条失败路径都用它——半启动的 alpha
# 永远不能以「无锁文件孤儿」形态存活（否则 stop 找不到、端口白占）。
stop_process_tree() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill_process_tree "$pid" TERM 2>/dev/null
  sleep 1
  kill_process_tree "$pid" KILL 2>/dev/null
}

# 从 launcher stdout 读 PID。该 stdout 是机器通道——只允许一个裸 PID。
# 但 FORCE_COLOR 环境下 console.log 会给 PID 包 ANSI 颜色码，之后所有 kill -0
# 全部打偏 → 误报「进程死了」→ 孤儿占端口且无锁文件可停（tutu 血泪实证）。
# 此处 sed 剥 ANSI + 正则校验，拿到非纯数字即失败。
read_launcher_pid() {
  local raw stripped esc
  raw="$1"
  esc="$(printf '\033')"
  stripped="$(printf '%s' "$raw" | LC_ALL=C sed -E "s/${esc}\[[0-9;]*[A-Za-z]//g")"
  if [[ ! "$stripped" =~ ^[[:space:]]*([0-9]+)[[:space:]]*$ ]]; then
    echo "Launcher did not print a PID (stdout: ${stripped})" >&2
    return 1
  fi
  printf '%s' "${BASH_REMATCH[1]}"
}

# 等健康检查通过，fail-fast：进程死了立刻返回，不傻等满超时。
wait_for_health_or_exit() {
  local port="$1"
  local pid="$2"
  local max_wait="${3:-$HEALTH_TIMEOUT}"
  local waited=0
  echo "Waiting for API on port $port ..." >&2
  while [ "$waited" -lt "$max_wait" ]; do
    if curl -sf "http://localhost:$port$HEALTH_PATH" >/dev/null 2>&1; then
      return 0
    fi
    if ! is_pid_alive "$pid"; then
      echo "Process (PID $pid) exited before port $port became healthy." >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "Service failed to become healthy within ${max_wait}s." >&2
  return 1
}

# 锁文件字段读取（容错：文件缺失/坏 JSON → 空串）
json_field() {
  python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    v = d.get(sys.argv[2], '')
    print('' if v is None else v)
except Exception:
    pass
" "$1" "$2" 2>/dev/null || true
}

# ── config 副本生成 ─────────────────────────────────────────

# 从主仓 config.yaml 生成 alpha 副本：
#   1. server.port          → 分配端口（缺失即失败——alpha 落 3000 默认端口是事故）
#   2. database.path        → alpha 数据根下的空库
#   3. embedding.localModelPath → 主仓 models 绝对路径（localModelPath 按进程 cwd
#      解析，不改写则从 worktree 启动会解析到 <worktree>/models 触发重新下载
#      bge-m3 ~2GB 到每个 worktree；改写后多实例共享只读）
#   4. 剥离 feishu/weixin/inbound 外部通道段——隔离实例连上真实飞书长连接/微信
#      轮询/招聘桥接是明确违反隔离承诺的副作用（真实消息会打进验证环境）
# 注意：scheduler/features 等段原样继承（验证环境与生产行为一致），见特性文档
# 「实现记录」——alpha 实例的定时任务在独立库上运行，验证结束 stop 即消失。
generate_alpha_config() {
  local src="$1" dst="$2" port="$3" db_path="$4" models_root="$5"
  python3 - "$src" "$dst" "$port" "$db_path" "$models_root" <<'PYEOF'
import io, re, sys

src, dst, port, db_path, models_root = sys.argv[1:6]
STRIP_SECTIONS = ("feishu", "weixin", "inbound")
REWRITE = {
    "server": {"port": port},
    "database": {"path": db_path},
    "embedding": {"localModelPath": models_root},
}

out, section, stripped = [], None, []
for line in io.open(src, encoding="utf-8"):
    m = re.match(r"^([A-Za-z][\w-]*):", line)
    if m:
        section = m.group(1)
    if section in STRIP_SECTIONS:
        if m and m.group(1) not in stripped:
            stripped.append(m.group(1))
        continue
    k = re.match(r"^  ([A-Za-z][\w-]*):", line)
    if k and section in REWRITE and k.group(1) in REWRITE[section]:
        # server.port 保持裸数字（config 校验要求 Number 类型）；
        # path / localModelPath 是字符串，带引号防特殊字符歧义
        fmt = "%s" if k.group(1) == "port" else '"%s"'
        out.append(("  %s: " + fmt + "\n") % (k.group(1), REWRITE[section][k.group(1)]))
        continue
    out.append(line)

rewritten = "".join(out)
# 硬校验：端口没改写成意味着源 config 缺 server.port 段——alpha 会落到默认 3000
# 与主服务相撞，这是本特性要消灭的事故形态，宁可不启动。
if not re.search(r"^  port: %s$" % port, rewritten, re.M):
    sys.stderr.write("config rewrite failed: server.port not found/rewritten in %s\n" % src)
    sys.exit(2)
io.open(dst, "w", encoding="utf-8").write(rewritten)
if stripped:
    sys.stderr.write("stripped sections: %s\n" % ", ".join(stripped))
PYEOF
}

# ── 命令 ────────────────────────────────────────────────────

cmd_start() {
  local port="" quick=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port="$2"; shift 2 ;;
      --quick|-q) quick=true; shift ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  local wt_root json_path
  wt_root="$(worktree_root)"
  json_path="$(alpha_json_path)"

  # 已在跑？stale-lock 清理（对齐 tutu cmd_start）：
  # 锁 PID 已死 → 清理本 worktree 起的端口孤儿（ cmdline 精确匹配 worktree 路径，
  # 不误伤接管该端口的外部进程）→ 删锁文件 → 继续启动。
  if [ -f "$json_path" ]; then
    local existing_pid existing_port
    existing_pid="$(json_field "$json_path" pid)"
    existing_port="$(json_field "$json_path" port)"
    if [ -n "$existing_pid" ] && is_pid_alive "$existing_pid"; then
      die "Alpha already running for this worktree (PID $existing_pid). Use 'alpha.sh stop' first."
    fi
    if [ -n "$existing_port" ]; then
      local orphan
      for orphan in $(lsof -tiTCP:"$existing_port" -sTCP:LISTEN 2>/dev/null || true); do
        if ps -p "$orphan" -o command= 2>/dev/null | grep -q "$wt_root"; then
          echo "Cleaning up orphaned alpha process (PID $orphan) on port $existing_port ..." >&2
          stop_process_tree "$orphan"
        fi
      done
    fi
    rm -f "$json_path"
  fi

  # 端口解析
  if [ -z "$port" ]; then
    port="$(find_free_port)"
  else
    if ! is_valid_alpha_port "$port"; then
      die "Port $port is invalid. Alpha requires an even port in ${ALPHA_PORT_MIN}-${ALPHA_PORT_MAX} that is not whitelisted."
    fi
    if ! is_port_free "$port"; then
      die "Port $port is not free."
    fi
  fi

  local alpha_home config_file log_file
  alpha_home="$(alpha_root_dir)"
  config_file="$alpha_home/config.yaml"
  log_file="$alpha_home/otter-buddy.log"
  mkdir -p "$alpha_home"

  # 构建（--quick 跳过；dist 缺失时兜底跑一次）
  if [ "$quick" = true ]; then
    if [ ! -d "$wt_root/dist" ]; then
      echo "--quick specified but dist/ not found; running build anyway ..." >&2
      (cd "$wt_root" && npm run build) >&2
    else
      echo "Skipping build (--quick mode)" >&2
    fi
  else
    (cd "$wt_root" && npm run build) >&2
  fi

  # config 副本（三字段改写 + 通道段剥离）
  local main_root
  main_root="$(main_repo_root)"
  if [ ! -f "$main_root/config/config.yaml" ]; then
    die "Main config not found: $main_root/config/config.yaml"
  fi
  generate_alpha_config "$main_root/config/config.yaml" "$config_file" \
    "$port" "$alpha_home/otter-buddy.db" "$main_root/models" \
    || die "Failed to generate alpha config (see stderr above). No process started."

  # 全分离启动（survive 獭 shell 退出）。cwd = alpha 数据根：main.ts 的相对路径
  # （data/logs、./data）全部落进独立数据根，实现运行时数据隔离。
  local launch_output launch_pid
  launch_output="$(cd "$alpha_home" && node "$SCRIPT_DIR/detached-launch.mjs" \
    "$log_file" node "$wt_root/dist/src/main.js" --config "$config_file")" || launch_output=''

  launch_pid="$(read_launcher_pid "$launch_output")" \
    || die "Failed to launch detached alpha process. No lockfile written; nothing to clean up."

  # 健康检查（fail-fast）——失败路径清理半启动进程树，不留无锁文件孤儿
  if ! wait_for_health_or_exit "$port" "$launch_pid"; then
    stop_process_tree "$launch_pid"
    die "Alpha failed to become healthy. Process cleaned up. Log: $log_file"
  fi

  # 从端口解析真实监听 PID（launcher 直接 spawn node，通常等于 launch_pid；
  # 未来启动命令加 wrapper 时以监听者为准——对齐 tutu）
  local server_pid
  server_pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -z "$server_pid" ] || ! is_pid_alive "$server_pid"; then
    server_pid="$launch_pid"
  fi

  cat > "$json_path" <<ENDJSON
{
  "pid": $server_pid,
  "port": $port,
  "config": "$config_file",
  "log": "$log_file",
  "worktree": "$wt_root",
  "alpha_root": "$alpha_home",
  "base_url": "http://localhost:$port",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON

  echo "Alpha started (PID $server_pid) -> http://localhost:$port" >&2
  echo "  Data root: $alpha_home" >&2
  echo "  Log:       $log_file" >&2
  echo "  Stop with: scripts/alpha.sh stop" >&2
  # 机器通道：锁文件全文（jq 友好）
  cat "$json_path"
}

cmd_status() {
  local json_path
  json_path="$(alpha_json_path)"

  if [ ! -f "$json_path" ]; then
    echo '{"status":"none","message":"No alpha environment for this worktree"}'
    return 0
  fi

  local pid port
  pid="$(json_field "$json_path" pid)"
  port="$(json_field "$json_path" port)"

  if [ -n "$pid" ] && is_pid_alive "$pid"; then
    echo "{\"status\":\"running\",\"pid\":$pid,\"port\":$port,\"base_url\":\"http://localhost:$port\"}"
  else
    echo '{"status":"stopped","message":"Lockfile exists but process is not running (stale). Re-run start to clean up."}'
  fi
  return 0
}

cmd_stop() {
  local json_path
  json_path="$(alpha_json_path)"

  if [ ! -f "$json_path" ]; then
    echo "No alpha environment for this worktree." >&2
    return 0
  fi

  local pid port
  pid="$(json_field "$json_path" pid)"
  port="$(json_field "$json_path" port)"

  if [ -z "$pid" ]; then
    echo "Lockfile has no PID; removing." >&2
    rm -f "$json_path"
    return 0
  fi

  if is_pid_alive "$pid"; then
    # 杀伐校验（沿用 otter-buddy.sh F20260831aksp T1）：锁文件 PID 必须确实是
    # 锁定端口的监听者。锁文件指向别的进程时拒杀——宁可让人来裁决。
    # lsof 不可用时跳过校验降级放行（增强闸门不做硬依赖）。
    if command -v lsof >/dev/null 2>&1; then
      local listen_pids
      listen_pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
      if ! echo "$listen_pids" | grep -qx "$pid"; then
        echo "Refusing to stop: lockfile PID $pid is NOT listening on port $port (listener: ${listen_pids:-none})." >&2
        echo "If you are SURE this process should die: kill $pid" >&2
        return 1
      fi
    fi
    echo "Stopping alpha (PID $pid, port $port) ..." >&2
    stop_process_tree "$pid"
    echo "Stopped." >&2
  else
    echo "Alpha was not running (PID $pid already dead)." >&2
  fi

  rm -f "$json_path"
}

# ── Main ────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    start)  shift; cmd_start "$@" ;;
    status) cmd_status ;;
    stop)   cmd_stop ;;
    *)
      echo "Usage: scripts/alpha.sh start|status|stop" >&2
      echo "" >&2
      echo "Commands:" >&2
      echo "  start [--port PORT] [--quick]  Start isolated alpha instance (3100-3198 even, auto port)" >&2
      echo "  status                         Show current worktree's alpha status" >&2
      echo "  stop                           Stop current worktree's alpha" >&2
      exit 1
      ;;
  esac
fi
