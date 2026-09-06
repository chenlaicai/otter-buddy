---
id: F20260906cprp
title: "buildRestartResumeFailedMsg 死代码分支收紧：invoke_error 路径清理"
summary: "#818：PR #817 检视发现 buildRestartResumeFailedMsg 接受 invoke_error 分支但从未被调用（F202609048840 后改用 buildRestartResumeFailedInvokeMsg），收紧签名为 skipped_concurrent 单一分支。"
change_type: refactor
capability_test: "n/a: 纯重构无行为变更，签名收紧但调用方只传 skipped_concurrent，现有单元测试全部通过"
created_in_conversation: 71782d9a-32b7-4f3e-8f80-6a946b786a9d
tags: [cleanup, dead-code, retry-policy, refactor]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
created_at: 2026-09-06
---

# buildRestartResumeFailedMsg 死代码分支收紧

## 变更说明

`buildRestartResumeFailedMsg` 原签名接受 `"invoke_error" | "skipped_concurrent"` 两个分支，
但 `invoke_error` 路径在 F202609048840 后已由 `buildRestartResumeFailedInvokeMsg()` 独占——
全局搜索确认唯一调用点 `resume-interrupted-service.ts:397` 仅传 `"skipped_concurrent"`。

本次收紧：
- 类型签名：`"invoke_error" | "skipped_concurrent"` → `"skipped_concurrent"`
- 删除死分支（原 else 分支的 "服务重启自动恢复失败" 文案）
- 保留参数名以维持调用方兼容（`void reason`）

## 验证

- `npx vitest run tests/usecases/conversation/agent-turn-orchestrator/retry-policy.test.ts`：25/25 通过
- `npm run build`：成功
- 已过最简检查：签名收紧 + 删死分支，无更简实现
