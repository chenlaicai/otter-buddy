---
id: F20260807rtry
title: agent-auto-and-manual-retry
doc_type: feature

summary: |
  agent 异常中断后支持自动重试和手动重试两种恢复机制。
  技术性中断（timeout/API error/circuit breaker）自动 re-invoke，不注入系统消息；
  前端 failed/aborted 消息新增"重试"按钮，用户可主动触发。

causal_links:
  from:
    - F20260806dgrf   # degenerate_output 梯度介入
  to: []

status: development
change_type: feature
tags: [agent, retry, resilience]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/http/controllers/message-controller.ts
  - src/interface-adapters/http/router.ts
  - web/src/pages/conversation/MessageList.tsx
  - web/src/pages/conversation/ChatView.tsx
  - web/src/pages/conversation/index.tsx
  - web/src/api/client.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260807retry: Agent 异常自动重试 + 手动重试

## 背景

agent 执行过程中遇到异常中断（output-guard timeout、circuit breaker、API error 等）后，
当前行为是直接进入终态（abort/fail），用户必须手动说"继续"才能恢复。
Pi SDK 的 session 是持久化的，技术上完全支持自动重新触发。

## 设计决策

### 核心原则：不注入系统消息

LLM 每次 invocation 都是全量 prompt request，session 里已有完整上下文。
对于技术性中断，agent 根本没产出有效内容，session 状态干净，直接 re-invoke 即可。
注入系统消息只在一个场景有意义：degenerate output（需要打断循环）。

### 两层重试

| 层级 | 触发方 | 场景 | 行为 |
|------|--------|------|------|
| 自动重试 | 系统 | timeout / API error / circuit breaker | fail 当前消息 → 直接 re-invoke |
| 手动重试 | 用户 | 任何 failed/aborted 消息 | 点"重试"按钮 → POST /retry → re-invoke |
| degenerate retry | 系统 | 输出重复循环 | 保留原有注入提醒逻辑（不改动） |

## 实现

### 自动重试（agent-invoker.ts）

在 `handleInvokeError` 终态之前插入 `_tryAutoRetry` 拦截：

- `_isRetryableAbortReason`：streaming_timeout / first_byte_timeout / circuit_break:* → 可重试
- `_isRetryableApiError`：LLM API error → 可重试
- `_executeAutoRetry`：fail 当前消息 → 清理 abortedMessages → 直接 `invokeConversation(retryCount=1)`
- 防循环：`retryCount > 0` 时跳过（`executeRetryWithSystemReminder` 已传 `retryCount=1`）

不重试的场景：
- `degenerate_output`：已有专门的 `handleDegenerateRetry`
- 用户手动 abort：意图明确
- 配置错误（API key 过期等）：重试无意义

### 手动重试

**后端**：`POST /api/messages/:id/retry`
- 校验消息为 terminal status 的 otter 消息
- 直接调 `agentInvoker.invokeConversation`，返回 SSE 流

**前端**：
- `MessageList.tsx`：failed/aborted 的 otter 消息下方显示"重试"按钮
- `index.tsx`：`handleRetryMessage` 调用 retry API 并消费 SSE 流

## 用户体验

```
自动重试：
  agent 执行中遇到 timeout
  → message.failed: "[系统] 生成过程超时, 正在自动重试"
  → message.start: (新消息，agent 基于 session 上下文继续)
  → message.complete: (正常完成)

手动重试：
  用户看到 failed/aborted 消息
  → 点击"重试"按钮
  → 新 streaming 消息出现
  → agent 基于 session 上下文继续执行
```

## 验证

- `npm test`：977 测试全部通过
- 自动重试测试：4 个原有测试更新为验证"自动重试后再犯走终态"流程
- TypeScript 编译 + ESLint 通过
