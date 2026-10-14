#!/usr/bin/env bash
# F20261014pswa 防再犯 capability_test：otter-buddy.sh 命令解析「放行路径」冒烟。
#
# 事故背景（#1473 / F20261014alps 引入，#1492 修复）：
#   port_explicit 预探测循环曾用 while+shift，无 -p 时把 $@ 吞空 → 正式解析循环
#   拿不到命令 → start/stop/restart/status 全部落 Usage 退出 1。
#   当时四层防线（capability_test 7 场景 + 四轮检视 + CI + 终审）全部盯着
#   「机械闸拦不拦」（拒绝路径），没有任何一处断言「无 -p 合法命令能走到
#   主命令分发」（放行路径）。本测试补的正是这条盲区。
#
# 设计约束（不触主进程、不起真实服务）：
#   - 只断言「命令解析走到主分发、不落 Usage」，不断言 cmd_* 真实副作用。
#   - status 是只读路径（读 PID 文件 + sqlite 查询），不起服务、不碰进程。
#   - 机械闸（worktree 落 3000 拒启）语义由 alpha-lifecycle-guard.test.sh 覆盖，这里不重复。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/otter-buddy.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

[[ -f "$SCRIPT" ]] || fail "脚本不存在: $SCRIPT"

# 场景 1（核心回归断言）：无 -p 的合法命令 status 不得落 Usage。
# 放行路径——吞参回归时此处输出 Usage 并 exit 1。
out="$(bash "$SCRIPT" status 2>&1 || true)"
if printf '%s' "$out" | grep -qi "usage"; then
  fail "无 -p 合法命令 'status' 落了 Usage（吞参回归？）输出: $out"
fi
pass "场景1: 无 -p 'status' 未落 Usage（放行路径通）"

# 场景 2：非法命令仍须落 Usage 退出 1（不变面——不误伤 Usage 校验本身）。
# 带 -p 3999 绕过 worktree 机械闸（闸在命令分发之前，无 -p 时会先撞闸而非落 Usage），
# 直达命令解析层断言 Usage 校验仍在。
set +e
out2="$(bash "$SCRIPT" -p 3999 __definitely_not_a_command__ 2>&1)"
code=$?
set -e
[[ $code -ne 0 ]] || fail "非法命令退出码应非 0，实得 0"
printf '%s' "$out2" | grep -qi "usage" || fail "非法命令应落 Usage，输出: $out2"
pass "场景2: 非法命令（-p 3999 绕闸）落 Usage 且非 0 退出（不变面保持）"

# 场景 3：带显式 -p 的合法命令不落 Usage（break 分支不受吞参影响）。
out3="$(bash "$SCRIPT" status -p 3999 2>&1 || true)"
if printf '%s' "$out3" | grep -qi "usage"; then
  fail "带 -p 合法命令 'status -p 3999' 落了 Usage，输出: $out3"
fi
pass "场景3: 带 -p 'status -p 3999' 未落 Usage（break 分支通）"

echo "== script-arg-parse.test.sh 全部通过 =="
