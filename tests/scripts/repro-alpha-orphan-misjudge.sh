#!/usr/bin/env bash
# 最小复现：验证 sweep 对「无锁 + worktree 目录存在」的孤儿判据
# 修复前：keep（目录在）判孤儿=误判（BUG）；deleted（目录删）判孤儿=正确
# 修复后：keep 不判孤儿=正确；deleted 判孤儿=正确（真孤儿仍回收）
# 用法：bash repro-alpha-orphan-misjudge.sh <sweep脚本路径> <keep|deleted>
# 无 root/特殊权限依赖；仅需 lsof + node（macOS 自带 / 项目依赖）。
set -u

SWEEP_SCRIPT="${1:?usage: <sweep脚本路径> <keep|deleted>}"
MODE="${2:-keep}"

MAIN="/Users/orca/ai/otter-buddy"
FAKE_WT="$MAIN/.otter/worktrees/zzz-fake-alpha-orphan"
FAKE_PORT=3160

rm -rf "$FAKE_WT"
mkdir -p "$FAKE_WT/dist/src"
cat > "$FAKE_WT/dist/src/main.js" <<'JS'
import http from 'http';
http.createServer((q,r)=>r.end('fake-alpha')).listen(3160,'127.0.0.1',()=>{});
setInterval(()=>{},1000);
JS

( cd "$FAKE_WT" && exec node dist/src/main.js ) >/dev/null 2>&1 &
FAKE_NODE_PID=$!
sleep 1

LISTENER_PID=$(lsof -tiTCP:$FAKE_PORT -sTCP:LISTEN 2>/dev/null | head -1)
if [ -z "$LISTENER_PID" ]; then
  echo "FAIL: fake 进程未监听" >&2
  kill -9 "$FAKE_NODE_PID" 2>/dev/null || true
  rm -rf "$FAKE_WT"
  exit 1
fi
# 监听者必须是本脚本起的 fake node——被别的进程占用时绝不 kill 无辜占用者
if [ "$LISTENER_PID" != "$FAKE_NODE_PID" ]; then
  echo "FAIL: 端口 $FAKE_PORT 被非 fake 进程占用（listener=${LISTENER_PID}），不 kill 无辜占用者" >&2
  kill -9 "$FAKE_NODE_PID" 2>/dev/null || true
  rm -rf "$FAKE_WT"
  exit 1
fi
NODE_PID="$FAKE_NODE_PID"
echo "listener=$NODE_PID mode=$MODE" >&2

if [ "$MODE" = "deleted" ]; then
  rm -rf "$FAKE_WT"
fi

OUT=$(bash "$SWEEP_SCRIPT" --project otter-buddy 2>&1)

if echo "$OUT" | grep -q "$NODE_PID"; then
  echo "VERDICT: ORPHAN(判孤儿 PID $NODE_PID)"
else
  echo "VERDICT: NOT_ORPHAN(未判孤儿)"
fi

kill -9 "$NODE_PID" 2>/dev/null
rm -rf "$FAKE_WT"