#!/usr/bin/env bash
# F20261103obarx 防再犯 regression_test：otterbar 探活鉴权适配 + renderer 离线驻留。
#
# 事故背景（2026-11-03，10/30 起持续 4 天）：
#   #1541 鉴权层合入后 /api/conversations 对裸探活 401 → status-core 恒判离线 →
#   renderer「offline_long 退出让位」× launchd KeepAlive/ThrottleInterval 60s =
#   「拉起-注册-秒退-注销」循环 = Dock 每分钟闪动（/tmp/otterbar-swift.log 3646 条）。
#
# 三场景（源码形态断言——运行时行为断言见特性文档「失败证据链」本机实测记录）：
#   场景A：探活请求必须带 X-Otter 身份头（防回退到裸 curl 401）
#   场景B：401 特判 fail-loud 存在（鉴权漂移≠离线，写 stderr 不静默）
#   场景C：renderer 不再含 offline_long 退位路径（防「退出让位」设计回潮）
#
# 说明：A/B/C 均为源码断言而非运行时断言——status-core 是常驻循环脚本（无 --once
# 口径），renderer 需 GUI 环境+Touch Bar；运行时验证以特性文档本机实测矩阵为准
# （修复前/后二进制对照、401/200 对照），CI 上以源码形态锁住关键行为不回退。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATUS_CORE="$REPO_ROOT/scripts/otterbar/status-core.sh"
MAIN_SWIFT="$REPO_ROOT/scripts/otterbar/swift/main.swift"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

[[ -f "$STATUS_CORE" ]] || fail "status-core 不存在: $STATUS_CORE"
[[ -f "$MAIN_SWIFT" ]] || fail "main.swift 不存在: $MAIN_SWIFT"

echo "--- 场景A: 探活请求带 X-Otter 身份头（user 档最小权限） ---"
grep -q 'X-Otter-User-Id: otterbar-status-core' "$STATUS_CORE" \
  || fail "场景A: 探活未带 X-Otter-User-Id 身份头（鉴权适配回退？）"
grep -q 'X-Otter-User-Role: user' "$STATUS_CORE" \
  || fail "场景A: 探活角色档不是 user（最小权限回退？改动了角色需同步评估身份中间件策略表）"
grep -q -- '-w .\\n%{http_code}.' "$STATUS_CORE" \
  || fail "场景A: 探活未用单请求 code+body 形态（-w 状态码）"
pass "场景A: 探活带身份头（user 档）+ 单请求 code+body"

echo "--- 场景B: 口径漂移特判（401/403/404）fail-loud + 不计离线 ---"
for code in 401 403 404; do
  grep -q "\"$code\"" "$STATUS_CORE" \
    || fail "场景B: 无 $code 特判（鉴权/路由漂移会被静默当离线）"
done
grep -q 'probe contract drift (auth/route), not offline' "$STATUS_CORE" \
  || fail "场景B: 漂移特判无 stderr 警告输出"
grep -q 'return 2' "$STATUS_CORE" \
  || fail "场景B: 漂移分支无 return 2（主循环无法区分漂移与真离线）"
grep -q '\$rc" -eq 2' "$STATUS_CORE" \
  || fail "场景B: 主循环无漂移冻结分支（离线计时会被累积——事故再现面）"
pass "场景B: 401/403/404 漂移特判 fail-loud，主循环冻结计时不累积"

echo "--- 场景C: renderer 无 offline_long 退位路径 ---"
# 退位特征：非注释行里 teardown 与 offline_long 同现（grep -n 行号前缀使 ^\s*// 不可用，
# 检视发现：改用「剩除注释列外是否还有命中」的过滤）
if grep -n 'offline_long' "$MAIN_SWIFT" | grep 'teardown' | grep -vE '^[0-9]+: *//'; then
  fail "场景C: offline_long 退位路径疑似回潮（见上行）"
fi
grep -q '驻留' "$MAIN_SWIFT" \
  || fail "场景C: 驻留语义注释缺失（防回潮说明）"
pass "场景C: offline_long 退位路径不存在（驻留设计在位）"

echo ""
echo "ALL PASS: otterbar 探活鉴权适配 + 离线驻留三场景全部通过"
