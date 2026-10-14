#!/usr/bin/env bash
# F20261014alps L2: 跨项目服务生命周期全局兜底扫描工具
# 扫描多个项目的「无锁文件 + cwd 属于已删 worktree」的孤儿实例
#
# Usage:
#   scripts/service-lifecycle-sweep.sh [--kill] [--project <name>]
#
# 配置文件：service-lifecycle.toml（项目根目录）
#   [project]
#   name = "otter-buddy"
#   main_port = 3000
#   alpha_port_range = [3100, 3198, 2]
#   worktree_pattern = ".otter/worktrees/*"
#   lock_file_name = ".otter-alpha.json"
#   process_pattern = "dist/src/main.js"

set -euo pipefail

# ── 端口宪法（从配置文件读取，默认值向后兼容）────────────────
ALPHA_PORT_MIN=3100
ALPHA_PORT_MAX=3198
MAIN_PORT=3000

die() { echo "Error: $*" >&2; exit 1; }

# ── 配置文件解析（python3 tomllib，安全无 eval 注入）────
parse_config() {
  local config_file="$1"
  [ -f "$config_file" ] || return 1
  
  # 用 python3 标准库 tomllib 解析 TOML，输出 shell 变量赋值（已转义）
  local python_bin
  python_bin=$(command -v python3) || die "python3 not found (required for TOML parsing)"
  
  eval "$("$python_bin" -c "
import sys
try:
    import tomllib
except ImportError:
    print('Error: tomllib requires Python 3.11+', file=sys.stderr)
    sys.exit(1)

with open('$config_file', 'rb') as f:
    config = tomllib.load(f)

if 'project' not in config:
    sys.exit(0)

p = config['project']
for key, value in p.items():
    if isinstance(value, list):
        value = ' '.join(str(v) for v in value)
    else:
        value = str(value)
    value = value.replace(chr(92), chr(92)*2).replace('$', chr(92)+'$').replace(chr(39), chr(92)+chr(39)).replace(chr(34), chr(92)+chr(34))
    print(f'CONFIG_{key.upper()}=\"{value}\"')
")"
}

# ── 项目扫描 ────────────────────────────────────────────
scan_project() {
  local project_dir="$1" project_name="$2"
  local config_file="$project_dir/service-lifecycle.toml"
  
  # 读配置（默认值兜底）
  local alpha_min=$ALPHA_PORT_MIN alpha_max=$ALPHA_PORT_MAX
  local worktree_pattern=".otter/worktrees/*"
  local lock_file_name=".otter-alpha.json"
  local process_pattern="dist/src/main.js"
  
  if [ -f "$config_file" ]; then
    parse_config "$config_file"
    alpha_min="${CONFIG_ALPHA_PORT_RANGE_MIN:-$alpha_min}"
    alpha_max="${CONFIG_ALPHA_PORT_RANGE_MAX:-$alpha_max}"
    worktree_pattern="${CONFIG_WORKTREE_PATTERN:-$worktree_pattern}"
    lock_file_name="${CONFIG_LOCK_FILE_NAME:-$lock_file_name}"
    # process_pattern 支持多模式（空格分隔，如 "dist/src/main.js server/index.mjs"）
    process_pattern="${CONFIG_PROCESS_PATTERN:-$process_pattern}"
  fi
  
  echo "Scanning project: $project_name ($project_dir)" >&2
  
  # 扫描端口段 + dev_server_ports（如果有配置）
  local port pid cwd wt_name lock_file orphan_count=0
  local scan_ports="$(seq "$alpha_min" 2 "$alpha_max")"
  
  # 补充 dev_server_ports（从配置文件读，空格分隔）
  if [ -n "${CONFIG_DEV_SERVER_PORTS:-}" ]; then
    # 去方括号 + 逗号转空格
    local dev_ports=$(echo "$CONFIG_DEV_SERVER_PORTS" | tr -d '[]' | tr ',' ' ')
    scan_ports="$scan_ports $dev_ports"
  fi
  
  for port in $scan_ports; do
    for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
      # 形态校验：cmdline 含 process_pattern（支持多模式，空格分隔）
      local match=false
      for pattern in $process_pattern; do
        if ps -p "$pid" -o command= 2>/dev/null | grep -q "$pattern"; then
          match=true
          break
        fi
      done
      if [ "$match" = false ]; then
        continue
      fi
      
      # cwd 必须属于本项目 worktree（支持嵌套路径：.otter/worktrees/<name>/ 任意子目录）
      cwd="$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd"{print $NF}')"
      case "$cwd" in
        "$project_dir"/.otter/worktrees/*/*) ;;
        "$project_dir"/.otter/worktrees/*) ;;
        *) continue ;;
      esac
      
      # 提取 worktree 名（第一个路径段），查锁文件
      wt_name="${cwd#"$project_dir"/.otter/worktrees/}"
      wt_name="${wt_name%%/*}"
      lock_file="$project_dir/.otter/worktrees/$wt_name/$lock_file_name"
      
      if [ ! -f "$lock_file" ]; then
        echo "  Orphan: PID $pid (port $port, cwd: $cwd)" >&2
        echo "$pid"  # stdout 机器通道
        orphan_count=$((orphan_count + 1))
      fi
    done
  done
  
  if [ "$orphan_count" -eq 0 ]; then
    echo "  No orphans found." >&2
  fi
}

# ── 主命令 ──────────────────────────────────────────────
KILL=false
PROJECT_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --kill) KILL=true; shift ;;
    --project) PROJECT_FILTER="$2"; shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# 扫描项目列表（默认扫当前目录 + 已知项目）
PROJECTS=()
if [ -n "$PROJECT_FILTER" ]; then
  # 单项目模式：从已知项目根找匹配项目
  case "$PROJECT_FILTER" in
    otter-buddy)
      [ -d "/Users/orca/ai/otter-buddy" ] && PROJECTS+=("/Users/orca/ai/otter-buddy:otter-buddy")
      ;;
    colink)
      [ -d "/Users/orca/ai/others/colink" ] && PROJECTS+=("/Users/orca/ai/others/colink:colink")
      ;;
    *)
      die "Unknown project: $PROJECT_FILTER (known: otter-buddy, colink)"
      ;;
  esac
  if [ ${#PROJECTS[@]} -eq 0 ]; then
    die "Project $PROJECT_FILTER not found"
  fi
else
  # 多项目模式：扫已知项目根（otter-buddy + colink）
  [ -d "/Users/orca/ai/otter-buddy" ] && PROJECTS+=("/Users/orca/ai/otter-buddy:otter-buddy")
  [ -d "/Users/orca/ai/others/colink" ] && PROJECTS+=("/Users/orca/ai/others/colink:colink")
fi

# 执行扫描
ALL_ORPHANS=()
for project_spec in "${PROJECTS[@]}"; do
  IFS=':' read -r project_dir project_name <<< "$project_spec"
  orphans=$(scan_project "$project_dir" "$project_name")
  if [ -n "$orphans" ]; then
    ALL_ORPHANS+=($orphans)
  fi
done

# 汇总
if [ ${#ALL_ORPHANS[@]} -eq 0 ]; then
  echo "" >&2
  echo "No orphaned instances found across all projects." >&2
  exit 0
fi

echo "" >&2
echo "Found ${#ALL_ORPHANS[@]} orphaned instance(s) total." >&2

if [ "$KILL" = true ]; then
  echo "" >&2
  echo "Killing orphans..." >&2
  for pid in "${ALL_ORPHANS[@]}"; do
    echo "  Killing PID $pid ..." >&2
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$pid" 2>/dev/null || true
  done
  echo "Cleanup complete." >&2
else
  echo "" >&2
  echo "Run with --kill to terminate them." >&2
fi
