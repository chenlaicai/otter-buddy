#!/usr/bin/env bash
# F20261014pswa 防再犯 capability_test：otter-buddy.sh 命令解析「放行路径」冒烟。
#
# 事故背景（#1473 / F20261014alps 引入，#1492 修复）：
#   port_explicit 预探测循环曾用 while+shift，无 -p 时把 $@ 吞空 → 正式解析循环
#   拿不到命令 → start/stop/restart/status 全部落 Usage 退出 1。事故现场用户跑的
#   正是无 -p 的 stop/restart。
#   当时四层防线全部只测「机械闸拦不拦」（拒绝路径），没有任何一处断言
#   「合法命令能走到主命令分发」（放行路径）。本测试补这条盲区。
#
# 设计关键（S1/J1 修正，检视獭-1495 两轮发现）：
#   worktree 语境下机械闸（scripts/otter-buddy.sh:42-51）在命令分发（:267）之前——
#   无 -p 且 PORT=3000 时闸先 exit 1、输出不含 Usage。故：
#   - 「无 -p」形态在 worktree 恒撞闸（测不到命令解析层）→ 检测到闸输出即显式 SKIP
#     并大声声明；主仓语境（PROJECT_DIR==MAIN_ROOT）不撞闸，无 -p 真实跑（CI 兑现）。
#   - 「-p 3999 绕闸」形态直达 :267 命令分发层，测「命令解析」本身，与闸行为解耦。
#
# 断言强度（S1 加固）：全部用「正断言」——exit 0 + 输出含 [ok]/[info]（cmd_status
# 输出面仅此前缀，见 scripts/otter-buddy.sh:214-233），杜绝「非 Usage 早崩也绿」假阳性。
#
# 不触主进程、不起真实服务：status 是只读路径（读 PID 文件 + sqlite 查询）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/otter-buddy.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
skip() { echo "SKIP: $*"; }

[[ -f "$SCRIPT" ]] || fail "脚本不存在: $SCRIPT"

# 正断言辅助：exit 0 且输出含 [ok]/[info]（cmd_status 真实输出面）。
assert_status_ok() {
  local label="$1"; shift
  local out code
  set +e
  out="$(bash "$SCRIPT" "$@" 2>&1)"
  code=$?
  set -e
  [[ $code -eq 0 ]] || fail "$label 退出码应为 0，实得 $code；输出: $out"
  printf '%s' "$out" | grep -qi "usage" && fail "$label 落了 Usage（吞参回归？）输出: $out"
  printf '%s' "$out" | grep -qE '\[ok\]|\[info\]' \
    || fail "$label 缺 [ok]/[info] 正证据（非 Usage 早崩？）输出: $out"
  pass "$label"
}

# 场景 1（核心回归断言，双形态）：
# 吞参回归机制（1:1 复刻真实解析循环 :59-66 验证）：坏形态 while+shift 预探测
# 对「status -p」（命令在前）先吞掉 status、遇 -p 才 break → 正式解析 $@ 剩「-p 3999」
# → CMD 空 → 落 Usage（敏感）；对「-p status」（-p 在前）首 token 即 break 不吞（恒绿）。
echo "--- 场景1a: 无 -p（事故现场原始形态）---"
raw="$(bash "$SCRIPT" status 2>&1 || true)"
if printf '%s' "$raw" | grep -qi "Refusing to start on port 3000"; then
  skip "场景1a: worktree 撞机械闸（无 -p 恒拦，测不到命令解析层）——主仓语境/CI 才真实跑无-p"
else
  assert_status_ok "场景1a: 主仓语境 无-p 'status'" status
fi

echo "--- 场景1b: -p 3999 绕闸（命令在前，回归敏感）---"
assert_status_ok "场景1b: 'status -p 3999'" status -p 3999

# 场景 2：非法命令仍须落 Usage 退出 1（不变面——不误伤 Usage 校验本身）。
# -p 3999 绕闸直达命令解析层。
set +e
out2="$(bash "$SCRIPT" -p 3999 __definitely_not_a_command__ 2>&1)"
code=$?
set -e
[[ $code -ne 0 ]] || fail "非法命令退出码应非 0，实得 0"
printf '%s' "$out2" | grep -qi "usage" || fail "非法命令应落 Usage，输出: $out2"
pass "场景2: 非法命令（-p 3999 绕闸）落 Usage 且非 0 退出（不变面保持）"

# 场景 3：-p 前置形态功能完整性断言（对吞参回归不敏感，恒绿——防误伤该形态）。
# 坏形态下「-p status」首 token -p 即 break 不吞参 → STATUS_OK，故本场景不能用作
# 回归探测（那是场景 1b 的职责），只证明修复后 -p 前置形态功能正常。
assert_status_ok "场景3: '-p 3999 status'（-p 前置，功能完整性）" -p 3999 status

# 场景 4：--port 长形态（J3，一行成本）。
assert_status_ok "场景4: '--port 3999 status'（长形态）" --port 3999 status

echo "== script-arg-parse.test.sh 全部通过 =="
