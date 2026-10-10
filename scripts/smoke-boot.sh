#!/usr/bin/env bash
# F20260929boot: 启动保障冒烟测试门——「系统必须能启动」从测试变成机械门槛。
#
# 设计定位（事故回溯 #1202）：
#   启动链路只保留「没有它系统一定起不来」的检查（tsc 编译）；
#   lint 这类「代码丑但系统能跑」的检查必须挪出启动链（见 package.json build/start）。
#   本脚本补的是另一半：build 之后、listen 之前，用 buildApp 全栈装配冒烟
#   （真 sqlite 临时库 + faux LLM + stub embedding，不触网）证明「这次代码能起」。
#
# 调用面：
#   - pre-commit hook（提交前拦——和 lint 同一防线，commit 时就知道起不起得来）
#   - CI check job（merge 前拦）
#   - 本地手动：npm run smoke:boot
#
# 反脆弱语义（反例教训：fresh-db-migration-regression——build 绿 ≠ 能起）：
#   buildApp 失败 = 退出非零 = 门槛拦截。宁可在 commit 时多花 ~30s，
#   不可让「git pull 后系统起不来」再发生第二次。
#
# 实现选择：跑既有 tests/app/build-app.test.ts（fresh-db-migration-regression
# 时期沉淀的全栈装配测试），不另写冒烟脚本——测试已是单一真相源，复制即分叉。

set -euo pipefail

# F1 修复（检视獭-boot 对抗审视）：fail-close 防线。
# vitest.config.ts 的 passWithNoTests: true 使硬编码测试路径被移动/改名/删除时
# vitest 静默返回 EXIT=0（冒烟门 fail-open 失效）——门槛自身必须有失效检测。
SMOKE_TEST="tests/app/build-app.test.ts"
if [ ! -f "$SMOKE_TEST" ]; then
  echo "==> [smoke:boot] 失败：冒烟测试文件不存在：$SMOKE_TEST" >&2
  echo "    门槛 fail-close：测试被移动/改名/删除时必须同步更新本脚本，否则视为启动无保障。" >&2
  exit 1
fi

echo "==> [smoke:boot] 运行 buildApp 全栈装配冒烟测试（真 sqlite + faux LLM）..."
npx vitest run "$SMOKE_TEST" --reporter=dot

# F20261009smex: 存量库形态冒烟（#1390 事故防线 A）——全新库绿 ≠ 存量库能起。
EXISTING_DB_TEST="tests/app/build-app-existing-db.test.ts"
if [ ! -f "$EXISTING_DB_TEST" ]; then
  echo "==> [smoke:boot] 失败：存量库冒烟测试文件不存在：$EXISTING_DB_TEST" >&2
  echo "    门槛 fail-close：测试被移动/改名/删除时必须同步更新本脚本，否则视为启动无保障。" >&2
  exit 1
fi
echo "==> [smoke:boot] 运行存量库形态冒烟测试（#1365 前 schema 快照 + initDatabaseAndModels）..."
npx vitest run "$EXISTING_DB_TEST" --reporter=dot

echo "==> [smoke:boot] 通过：系统可完成全栈装配并服务请求（全新库 + 存量库双形态）"
