---
id: F20260821rtmx
title: streaming-timeout-retry-message-lost-fix
doc_type: feature

# 记忆索引
summary: |
  修复 streaming_timeout 自动重试后消息输出全部丢失的 bug。
  handleAutoRetry 将消息置 failed 后未调 prepareForRetry 重置生命周期，
  导致重试轮输出事件 append 全部失败。附带修复重试注入文案错配（no_yield 文案用于 timeout 场景）。

# 因果链路
causal_links:
  from:
    - F20260727guar   # degenerate-loop-silence-fix（OutputGuard 超时机制）

# 元数据
status: development
type: fix
tags: [agent, orchestrator, retry, timeout, message-lifecycle]
modules: [src/usecases/conversation/agent-turn-orchestrator]

# 时间
created_at: 2026-08-25
---

# F20260821rtmx - streaming_timeout 自动重试消息丢失修复

## 1. 问题背景

### 1.1 事故现场

对话《上下文压缩交接相关的优化》中，mimo 小獭两次 streaming_timeout（120s 流断），UI 显示「[系统] 生成过程超时, 正在自动重试」但用户看不到任何重试动静。

**日志时间线**（traceId=t_4f7753ff00bb）：

| 时间 | 事件 | 说明 |
|------|------|------|
| 10:41:31 | 消息 eecbe39b 首轮 streaming_timeout | 120s 流断 |
| 10:41:31 | 发出「正在自动重试」 | handleAutoRetry 调 failMessage |
| 10:41:31 | 重试 LLM request 发出 | executeTurn 循环继续 |
| 10:43:36 | 重试轮又超时 | 关键报错：`Cannot append event to message with status: failed` |
| 10:50:42 | 消息 8e9170ab 完整重演 | 同一模式第二次命中 |

### 1.2 根因分析

**文件**: `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts:486-497`

**调用链**：

1. `routeGuardAbort` → `handleAutoRetry`（streaming_timeout, retryCount===0）
2. `handleAutoRetry` 调 `failMessage(messageId, failBody)` → 消息状态变为 `failed`
3. 返回 `null`
4. `executeTurn` 主循环 line 147-153：fallback 路径触发重试
5. `driver.invoke(currentInput)` → LLM 重新生成 → 尝试 `appendEvent`
6. **`canAppendEvent('failed')` 返回 `false`**（`message.ts:83-85`：仅 `streaming`/`speaking` 可追加）
7. 抛出 `Cannot append event to message with status: failed`
8. 重试轮全部输出丢失

**三条重试路径对比**：

| 路径 | failMessage | 生命周期重置 | 结果 |
|------|------------|-------------|------|
| degenerate_retry | ✅ | `startNewMessage` 开新消息 | ✅ 正常 |
| no_yield_retry | ✅ | `prepareForRetry` 重置→streaming | ✅ 正常 |
| **auto_retry (timeout)** | ✅ | **什么都没做** | ❌ 消息卡死在 failed |

**附带 bug**：`executeTurn` fallback 固定用 `buildYieldRetryMsg` → 产出「你上一次行动没有调用 yield 交棒就结束了」。timeout 重试应该用「上一轮生成超时，请继续完成发言」类文案。

## 2. 修复方案

### 2.1 Bug 1 修复：handleAutoRetry 添加 prepareForRetry

**文件**: `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts:486-497`

**改动**：在 `failMessage` 后添加 `prepareForRetry(messageId, false)` 调用，将消息状态从 `failed` 重置回 `streaming`。

**`prepareForRetry` 语义**（`send-message.ts:371-404`）：
- 消息 status 必须是 `failed` 才能调（`canPrepareForRetry` guard）
- 执行 `resetForStreaming` 将状态重置回 `streaming`
- 创建新 Turn 关联
- `preserveSegments=false` 时不保留 segments（timeout 重试无有效 speak 内容）

**失败处理**：`prepareForRetry` 失败时降级为 `abortTerminal`（与 handleYieldRetry 的降级策略一致）。

### 2.2 Bug 2 修复：重试文案按场景匹配

**文件**: `src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts`

**新增**：`buildAutoRetryMsg(reason: string)` 函数，按 guardReason 返回匹配的重试文案：
- `streaming_timeout` → 「上一轮生成过程超时，已被系统自动重试。请从中断处继续完成你的发言」
- `first_byte_timeout` → 「上一轮模型响应超时，已被系统自动重试。请重新生成你的发言」
- `circuit_break:*` → 「上一轮工具调用异常，已被系统自动重试。请检查工具调用策略后继续」

**文件**: `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts:147-153`

**改动**：`executeTurn` fallback 根据 `reason.kind` 选择重试文案：
- `guard_abort` → `buildAutoRetryMsg(reason.guardReason)`
- 其他 → `buildYieldRetryMsg(toolCallCount, hasOrphanText)`（原有逻辑）

## 3. 影响范围

### 3.1 直接影响

- `streaming_timeout` 自动重试：消息可正常接收重试轮输出
- `first_byte_timeout` 自动重试：同上
- `circuit_break:*` 自动重试：同上

### 3.2 无影响

- `degenerate_retry` 路径：使用 `startNewMessage`，不经过 `prepareForRetry`
- `no_yield_retry` 路径：已有 `prepareForRetry`，行为不变
- `user_abort` 路径：不触发重试
- `api_error` 路径：`failTerminal`，不触发重试

### 3.3 风险评估

**低风险**：
- `prepareForRetry` 是成熟接口（no_yield 路径已验证）
- 失败时降级为 `abortTerminal`（与现有行为等价，不会更差）
- 重试文案是纯文本变更，不影响逻辑

**需关注**：
- 重试成功后消息终态：`tryCompleteSpeaking` 检查 `msg?.status !== 'speaking'`，重置后消息为 `streaming`，LLM speak 调用后变为 `speaking`，可正常收尾
- 重试再超时：`retryCount` 已设为 1，`routeGuardAbort` 不再触发 auto-retry，走 `abortTerminal`（符合预期：不无限循环）

## 4. 测试覆盖

### 4.1 单元测试

**文件**: `tests/usecases/conversation/agent-turn-orchestrator/retry-policy.test.ts`

- `buildAutoRetryMsg('streaming_timeout')` → 包含「超时」「继续」
- `buildAutoRetryMsg('first_byte_timeout')` → 包含「响应超时」
- `buildAutoRetryMsg('circuit_break:*')` → 包含「工具调用异常」
- `buildAutoRetryMsg('unknown')` → 包含「异常」「继续」

### 4.2 集成验证

现有 `agent-invoker-self-restart.test.ts` 测试覆盖了 AgentInvoker → Orchestrator 集成路径。本次修复的 `prepareForRetry` 调用遵循 `handleYieldRetry` 的成熟模式，风险可控。

## 5. 关联文档

- F20260727guar「degenerate-loop-silence-fix」：上游 OutputGuard 超时机制
- `src/usecases/conversation/send-message.ts:371-404`：`prepareForRetry` 实现
- `src/entities/conversation/message.ts:83-85`：`canAppendEvent` 状态约束
- `src/entities/conversation/message.ts:124-133`：`canPrepareForRetry` 状态约束
