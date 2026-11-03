#!/usr/bin/env bash
# F20261103portx 防再犯 regression_test：stop/start/status 端口占用者身份识别。
#
# 事故背景（2026-11-02 现场）：
#   主服务健康在跑但 PID 文件缺失 → stop 落入端口占用分支；port_owner_pid 用
#   `lsof -ti:3000 | head -1`（无 LISTEN 过滤）把 Safari 网络进程（与 3000 的
#   ESTABLISHED 客户端连接，恰排监听者前面）当成占用者，未验证身份即断言
#   「another worktree's Otter Buddy」并建议 kill——照做会杀浏览器进程。
#
# 三层修复对应三组断言：
#   场景A（采集层）：监听者+多个保持连接的客户端并存时，占用者必须=监听者
#   场景B（身份层）：无 PID 文件 + 监听者是本仓 node 进程 → 认作主服务，
#                   不再当「另一实例」
#   场景C（推断层）：占用者无 node 特征 → 明确报 non-Otter，不再断言
#                   worktree 实例、不再给裸 kill 建议
#
# 端口选用 3457-3459（避开主服务 3000 与 alpha 段 3100-3198）；哑进程仅
# 监听不写文件；trap 兜底清理。修复前对照输出（git show origin/main 版本）
# 跑同一场景，输出形态见 docs/features/2026/11/03/F20261103portx 文档验证节。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/otter-buddy.sh"

PORT_LISTEN=3457   # 场景A：监听者 vs 客户端
PORT_MAIN=3458     # 场景B：本仓 node 哑监听
PORT_FOREIGN=3459  # 场景C：python 占用者

PIDS=()
cleanup() {
  # bash 3.2 兼容：未初始化/空数组在 set -u 下展开报错，用 ${PIDS[@]+…} 守住
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

need() { command -v "$1" >/dev/null 2>&1 || fail "缺依赖: $1"; }
need lsof; need python3; need node
[[ -f "$SCRIPT" ]] || fail "脚本不存在: $SCRIPT"

cd "$REPO_ROOT"

# ── 场景A：占用者必须是监听者，客户端连接进程不得被选中（采集层回归）──
echo "--- 场景A: LISTEN 过滤（客户端连接不干扰占用者识别）---"
python3 -m http.server "$PORT_LISTEN" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV_PID=$!; PIDS+=("$SRV_PID")
# 等监听就绪
for _ in $(seq 1 20); do
  lsof -nP -tiTCP:"$PORT_LISTEN" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.5
done
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

# ── 场景B：无 PID 文件 + 本仓 node 监听 → 认作主服务（身份层回归）──
echo "--- 场景B: 主服务识别（PID 文件缺失现场）---"
node -e "require('http').createServer((q,s)=>{s.end()}).listen($PORT_MAIN,'127.0.0.1')" >/dev/null 2>&1 &
NODE_PID=$!; PIDS+=("$NODE_PID")
for _ in $(seq 1 20); do
  lsof -nP -tiTCP:"$PORT_MAIN" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.5
done

set +e
out="$(bash "$SCRIPT" stop -p "$PORT_MAIN" 2>&1)"; code=$?
set -e
[ "$code" -eq 1 ] || fail "场景B: stop 应拒绝(exit 1)，实得 $code: $out"
echo "$out" | grep -q "appears to be running" \
  || fail "场景B: 应认出主服务（appears to be running），实得: $out"
echo "$out" | grep -q "PID file is missing" || echo "$out" | grep -qi "missing" \
  || fail "场景B: 应说明 PID 文件缺失，实得: $out"
echo "$out" | grep -q "another worktree" \
  && fail "场景B: 不应再把主服务当另一实例: $out" || true
pass "场景B: 无 PID 文件时认出主服务（PID ${NODE_PID}），不再误报另一实例"

# ── 场景C：占用者无 node 特征 → 报 non-Otter，不给裸 kill 建议（推断层回归）──
echo "--- 场景C: foreign 占用者报告 ---"
python3 -m http.server "$PORT_FOREIGN" --bind 127.0.0.1 >/dev/null 2>&1 &
FOR_PID=$!; PIDS+=("$FOR_PID")
for _ in $(seq 1 20); do
  lsof -nP -tiTCP:"$PORT_FOREIGN" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.5
done

out="$(bash "$SCRIPT" status -p "$PORT_FOREIGN" 2>&1 || true)"
echo "$out" | grep -q "non-Otter process" \
  || fail "场景C: 应报 non-Otter process，实得: $out"
echo "$out" | grep -q "another worktree" \
  && fail "场景C: 不应断言 worktree 实例: $out" || true
echo "$out" | grep -qE "or run: +kill" \
  && fail "场景C: 不应给裸 kill 建议（旧文案特征）: $out" || true
pass "场景C: foreign 占用者如实报告，无未验证断言"

echo ""
echo "ALL PASS: 端口占用者身份识别三场景全部通过"
