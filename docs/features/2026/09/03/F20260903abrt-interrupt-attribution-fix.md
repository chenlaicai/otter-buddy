---
id: F20260903abrt
title: 中断归因增强：用户中断时保留底层 SDK 错误信息（排除 abort 自身产物）
summary: 用户中断消息时，若底层存在真实 API 错误（如 429 限流），中断文案归因到系统问题；排除 abort 自身产生的 "Request was aborted" 错误避免反向归因失真
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
fixes: "#752"
---

## 背景（#752）

9/2 两个时间窗出现20条「[chen中断] 经过 0 次工具调用后，chen强制中断了当前发言」消息，间隔1-2秒。

### 调查结论

代码路径追踪确认：
1. `buildUserAbortBody` 是唯一生成该文案的模板函数（`retry-policy.ts`）
2. 调用链：`abortTerminal(kind:'user')` → `handleUserAbort` → `classifyExit` 返回 `user_abort`
3. `classifyExit` 返回 `user_abort` 的**唯一条件**是 `userAbortedMessages.has(messageId)` 为 true
4. `userAbortedMessages` 只通过 HTTP abort 端点（`POST /api/messages/:id/abort`）填充
5. 429 重试失败路径（`api_error` → `failTerminal`）生成 `[错误]` 文案，**不会**产生 `[chen中断]` 文案

因此 issue 原假设「429 重试链失败被落账为用户中断」**不成立**——这20条消息确实是通过 HTTP abort 端点触发的。

### 真正的问题

虽然归因链路在代码上是正确的（abort 端点 → 用户中断），但存在**信息丢失**问题：

- 用户在 SDK 429 重试期间点击中断 → 消息记录为「经过 0 次工具调用后强制中断」
- 底层的 429 错误信息被完全丢弃，中断统计无法区分「用户主动中断正常执行」和「用户放弃等待系统故障」
- `toolCallCount` 在 SDK 错误路径中因 `activeSessions` 在 finally 块中被清理而始终为 0

## 修复方案

### 核心改动

**exit-classifier.ts**：`classifyExit` 在返回 `user_abort` 时，捕获底层 SDK 错误信息到 `underlyingError` 字段，**但排除 abort 自身产物**：
- 底层有 `_guardAbortReason` → `underlyingError.kind = 'guard_abort'`
- 底层有 Error 且非 abort 自身产物 → `underlyingError.kind = 'api_error'`
- 底层有 Error 但是 abort 自身产物（`isAbortOwnError` 匹配） → `underlyingError = undefined`
- 无错误 → `underlyingError = undefined`
- **关键**：SDK 的 abort 操作会抛出 `"Request was aborted"` 错误，这是 abort 的副作用而非底层 API 错误，必须排除

**retry-policy.ts**：`buildUserAbortBody` 新增可选 `underlyingError` 参数：
- 0 次工具调用 + API 错误（429）→ 「因模型服务限流（429）未能开始，中断了等待」
- 0 次工具调用 + API 错误（非 429）→ 「因模型服务异常未能开始，中断了等待」
- 0 次工具调用 + 守卫拦截 → 「因安全守卫拦截未能开始，中断了等待」
- 有工具调用 或 无 underlyingError → 保持原有文案不变

**orchestrator.ts / types.ts**：透传 `underlyingError` 从 `classifyExit` 到 `abortTerminal` 到 `buildUserAbortBody`。

### 测试

- `exit-classifier.test.ts`：15 个测试覆盖 classifyExit 的所有分支 + underlyingError 捕获逻辑 + isAbortOwnError 排除（含 SDK 抛错与 checkSessionError 包装两种形态）
- `retry-policy.test.ts`：6 个新测试覆盖 buildUserAbortBody 的增强行为
- 全量 108 个相关测试通过，无回归

## 验证

```bash
npx vitest run tests/usecases/conversation/agent-turn-orchestrator/ tests/interface-adapters/agent-invoker.test.ts tests/interface-adapters/agent-invoker-guard-bounce.test.ts tests/interface-adapters/agent-invoker-metrics.test.ts
# 7 files, 108 tests passed
```
