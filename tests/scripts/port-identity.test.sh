#!/usr/bin/env bash
# F20261103portx / F20261113stopp 防再犯 regression_test：
# stop/start/status 端口占用者身份识别 + 无 PID 文件时代停主服务与自愈重建。
#
# 事故背景（2026-11-02 现场，F20261103portx）：
#   主服务健康在跑但 PID 文件缺失 → stop 落入端口占用分支；port_owner_pid 用
#   `lsof -ti:3000 | head -1`（无 LISTEN 过滤）把 Safari 网络进程（与 3000 的
#   ESTABLISHED 客户端连接，恰排监听者前面）当成占用者，未验证身份即断言
#   「another worktree's Otter Buddy」并建议 kill——照做会杀浏览器进程。
#
# 需求变更（2026-11-13 搭档拍板，F20261113stopp）：
#   PID 文件再次丢失（11/11 启动写入后于脚本管辖外被删，轨迹不可考——与
#   F20261103portx 遗留问题同源），stop 依旧只给「kill <pid> && start」指引。
#   搭档明确：stop 的语义就是停掉当前服务，PID 文件只是寻址手段——身份经
#   listener_class 三重验证（LISTEN 端口 + cwd=本仓 + node 特征）后即可代停；
#   start/status 发现主服务在跑但缺 PID 文件时自愈重建文件。本次重写本测试。
#
# 隔离设计（F20261113stopp 重写动机）：
#   旧版直接在仓根跑真实脚本，隐含假设「仓根无存活 PID 文件」——自愈功能落地后
#   该假设不再成立（正常态=PID 文件存在且指向真实主服务，stop 会撞 T1 拒杀分支）。
#   现把脚本拷进 mktemp 沙箱跑（PROJECT_DIR=沙箱），PID 文件/监听者全部隔离，
#   真实主服务零接触。TMP 必须 pwd -P 物理归一——macOS mktemp 落 /var（软链），
#   lsof 报 /private/var 真实路径，不归一 listener_class 的 cwd 比对恒失配。
#
# 端口选用 3457-3461（避开主服务 3000 与 alpha 段 3100-3198）；哑进程仅
# 监听不写文件；trap 兜底清理。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT_SRC="$REPO_ROOT/scripts/otter-buddy.sh"

PORT_LISTEN=3457   # 场景A：监听者 vs 客户端
PORT_MAIN=3458     # 场景B/B2：本仓 node 哑监听（stop 代停）
PORT_HEAL=3459     # 场景B3/B4：status/start 自愈重建 PID 文件
PORT_FOREIGN=3460  # 场景C：python 占用者（拒杀边界）
PORT_PIDF=3461     # 场景D：PID 文件正路（指向谁停谁）

# 沙箱：脚本副本的 PROJECT_DIR=TMP（物理路径归一，见头部隔离设计说明）
# mktemp 跨平台形态：显式路径模板 + 6 个 X（GNU mktemp 强制要求模板含 X，
# macOS -t prefix 无 X 也能跑但 GNU 会报 too few X's——CI Linux 首轮实证）
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/port-identity-test.XXXXXX")" && pwd -P)"
mkdir -p "$TMP/scripts"
cp "$SCRIPT_SRC" "$TMP/scripts/otter-buddy.sh"
SCRIPT="$TMP/scripts/otter-buddy.sh"
PID_FILE="$TMP/.otter-buddy.pid"

PIDS=()
cleanup() {
  # bash 3.2 兼容：未初始化/空数组在 set -u 下展开报错，用 ${PIDS[@]+…} 守住
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

need() { command -v "$1" >/dev/null 2>&1 || fail "缺依赖: $1"; }
need lsof; need python3; need node
[[ -f "$SCRIPT_SRC" ]] || fail "脚本不存在: $SCRIPT_SRC"

wait_listen() {
  local port="$1"
  for _ in $(seq 1 20); do
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  fail "端口 $port 监听未就绪"
}

assert_dead() {
  local pid="$1" label="$2"
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  fail "$label: 进程 $pid 应已终止却仍存活"
}

# 哑 node 监听：cwd 必须在沙箱内（listener_class 的 main-service 判定依据）。
# 禁止 $(spawn…) 命令替换调用——子壳里 PIDS+= 不回传父壳，trap 漏杀会泄漏哑进程
# （首轮实鉴：残留监听者占住下轮同端口且 cwd 是已删沙箱，身份分类掉到 otter-or-node）。
SPAWNED_PID=""
spawn_node_listener() {
  local port="$1"
  (cd "$TMP" && exec node -e "require('http').createServer((q,s)=>{s.end()}).listen($port,'127.0.0.1')") >/dev/null 2>&1 &
  SPAWNED_PID=$!
  PIDS+=("$SPAWNED_PID")
  wait_listen "$port"
}

cd "$TMP"

# ── 场景A：占用者必须是监听者，客户端连接进程不得被选中（采集层回归）──
echo "--- 场景A: LISTEN 过滤（客户端连接不干扰占用者识别）---"
python3 -m http.server "$PORT_LISTEN" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV_PID=$!; PIDS+=("$SRV_PID")
wait_listen "$PORT_LISTEN"
# 起一个持有 3 条长连接的客户端进程（模拟事故现场的浏览器连接）
python3 - "$PORT_LISTEN" >/dev/null 2>&1 <<'EOF' &
import socket, sys, time
port = int(sys.argv[1])
socks = [socket.create_connection(("127.0.0.1", port), timeout=5) for _ in range(3)]
time.sleep(120)
EOF
CLI_PID=$!; PIDS+=("$CLI_PID")
sleep 1

out="$(bash "$SCRIPT" status -p "$PORT_LISTEN" 2>&1 || true)"
# 旧版事故形态：报告任意 TCP 关系进程（客户端 bash/python 也可能中选）
echo "$out" | grep -q "PID ${SRV_PID}" \
  || fail "场景A: 应报告监听者 PID ${SRV_PID}，实得: $out"
echo "$out" | grep -q "PID $CLI_PID" \
  && fail "场景A: 误报客户端进程 ${CLI_PID}（LISTEN 过滤失效？）: $out" || true
pass "场景A: 占用者=监听者（PID ${SRV_PID}），客户端 $CLI_PID 未被选中"

# ── 场景B：无 PID 文件 + 本仓 node 监听 → stop 验明身份直接代停（F20261113stopp 新语义）──
echo "--- 场景B: 无 PID 文件 stop 代停主服务 ---"
spawn_node_listener "$PORT_MAIN"; NODE_PID=$SPAWNED_PID
[ ! -f "$PID_FILE" ] || fail "场景B前置: 沙箱 PID 文件应不存在"

set +e
out="$(bash "$SCRIPT" stop -p "$PORT_MAIN" 2>&1)"; code=$?
set -e
[ "$code" -eq 0 ] || fail "场景B: stop 应代停成功(exit 0)，实得 $code: $out"
echo "$out" | grep -q "verified listener identity" \
  || fail "场景B: 应声明按验证身份代停，实得: $out"
assert_dead "$NODE_PID" "场景B"
echo "$out" | grep -q "another worktree" \
  && fail "场景B: 不应再把主服务当另一实例: $out" || true
pass "场景B: 无 PID 文件时 stop 验明主服务身份直接代停（PID ${NODE_PID}）"

# ── 场景B2：过期 PID 文件（指向死进程）+ 本仓 node 监听 → 同样代停 ──
echo "--- 场景B2: 过期 PID 文件 stop 代停主服务 ---"
spawn_node_listener "$PORT_MAIN"; NODE_PID2=$SPAWNED_PID
echo "999999" > "$PID_FILE"

set +e
out="$(bash "$SCRIPT" stop -p "$PORT_MAIN" 2>&1)"; code=$?
set -e
[ "$code" -eq 0 ] || fail "场景B2: stop 应代停成功(exit 0)，实得 $code: $out"
assert_dead "$NODE_PID2" "场景B2"
[ ! -f "$PID_FILE" ] || fail "场景B2: 过期 PID 文件应被清理"
pass "场景B2: 过期 PID 文件不挡路，验明身份后代停（PID ${NODE_PID2}）"

# ── 场景B3/B4：status/start 发现主服务缺 PID 文件 → 自愈重建（F20261113stopp）──
echo "--- 场景B3/B4: status/start 自愈重建 PID 文件 ---"
spawn_node_listener "$PORT_HEAL"; NODE_PID3=$SPAWNED_PID
[ ! -f "$PID_FILE" ] || fail "场景B3前置: 沙箱 PID 文件应不存在"

out="$(bash "$SCRIPT" status -p "$PORT_HEAL" 2>&1 || true)"
echo "$out" | grep -q "PID file re-created" \
  || fail "场景B3: status 应自愈重建 PID 文件，实得: $out"
[ "$(cat "$PID_FILE" 2>/dev/null)" = "${NODE_PID3}" ] \
  || fail "场景B3: 重建的 PID 文件内容应为 ${NODE_PID3}，实得: $(cat "$PID_FILE" 2>/dev/null || echo '<missing>')"
pass "场景B3: status 自愈重建 PID 文件（内容=${NODE_PID3}）"

rm -f "$PID_FILE"
out="$(bash "$SCRIPT" start -p "$PORT_HEAL" 2>&1 || true)"
echo "$out" | grep -q "Already running" \
  || fail "场景B4: start 应幂等报已在运行，实得: $out"
echo "$out" | grep -q "PID file re-created" \
  || fail "场景B4: start 应自愈重建 PID 文件，实得: $out"
[ "$(cat "$PID_FILE" 2>/dev/null)" = "${NODE_PID3}" ] \
  || fail "场景B4: 重建的 PID 文件内容应为 ${NODE_PID3}，实得: $(cat "$PID_FILE" 2>/dev/null || echo '<missing>')"
rm -f "$PID_FILE"
pass "场景B4: start 幂等返回并自愈重建 PID 文件"

# ── 场景C：占用者无 node 特征 → 报 non-Otter + stop 拒杀（推断层/安全边界回归）──
echo "--- 场景C: foreign 占用者报告与 stop 拒杀边界 ---"
python3 -m http.server "$PORT_FOREIGN" --bind 127.0.0.1 >/dev/null 2>&1 &
FOR_PID=$!; PIDS+=("$FOR_PID")
wait_listen "$PORT_FOREIGN"

out="$(bash "$SCRIPT" status -p "$PORT_FOREIGN" 2>&1 || true)"
echo "$out" | grep -q "non-Otter process" \
  || fail "场景C: 应报 non-Otter process，实得: $out"
echo "$out" | grep -q "another worktree" \
  && fail "场景C: 不应断言 worktree 实例: $out" || true

set +e
out="$(bash "$SCRIPT" stop -p "$PORT_FOREIGN" 2>&1)"; code=$?
set -e
[ "$code" -eq 1 ] || fail "场景C: stop 应拒绝(exit 1)，实得 $code: $out"
kill -0 "$FOR_PID" 2>/dev/null \
  || fail "场景C: foreign 进程 $FOR_PID 不应被 stop 杀掉"
echo "$out" | grep -qE "or run: +kill" \
  && fail "场景C: 不应给裸 kill 建议（旧文案特征）: $out" || true
pass "场景C: foreign 占用者如实报告且 stop 拒杀（边界不松动）"

# ── 场景D：PID 文件正路——文件指向谁停谁（terminate_pid 抽函数后回归）──
echo "--- 场景D: PID 文件正路代停 ---"
spawn_node_listener "$PORT_PIDF"; NODE_PID4=$SPAWNED_PID
echo "$NODE_PID4" > "$PID_FILE"

set +e
out="$(bash "$SCRIPT" stop -p "$PORT_PIDF" 2>&1)"; code=$?
set -e
[ "$code" -eq 0 ] || fail "场景D: stop 应成功(exit 0)，实得 $code: $out"
echo "$out" | grep -q "Stopping Otter Buddy (PID $NODE_PID4)" \
  || fail "场景D: 应走 PID 文件正路停止，实得: $out"
assert_dead "$NODE_PID4" "场景D"
[ ! -f "$PID_FILE" ] || fail "场景D: PID 文件应随停止清理"
pass "场景D: PID 文件正路停止不受影响（PID ${NODE_PID4}）"

echo ""
echo "ALL PASS: 端口占用者身份识别 + 无 PID 文件代停/自愈 全部场景通过"
