---
id: F20260810ka24
title: invoker-error-flow-refactor
doc_type: feature

summary: |
  AgentInvoker 中断/重试/错误处理流程完整重构。
  原 handleInvokeError 是 catch-all（5 职责耦合），导致自动重试覆盖用户中断。
  新架构"先分类后路由"：classifyExit → routeByReason → handler，彻底解耦。

causal_links:
  from:
    - F20260807rtry   # 自动重试 + 手动重试
    - F20260805f146   # degenerate_output 梯度介入
  to: []

status: development
change_type: feature
tags: [agent, refactor, error-handling, retry, abort]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
capability_test: "n/a: 纯架构重构（A 类），行为不变（自动重试行为变更为有意设计）"
---

# F20260810ka24: AgentInvoker 错误处理流程重构

## 背景

中断功能、自动重试功能、无 speak 重试功能反复修不好。每次修的都是某个判断顺序，
修完后另一个路径就会被影响。根因是 **整体流程设计缺陷**，不是单点 bug。

### 原架构问题

`handleInvokeError` 是 catch-all 方法，同时承担 5 个职责：

1. 判断是否用户中断（`abortedMessages.has`）
2. 判断是否 guard abort（`_extractAbortReason`）
3. 判断是否可自动重试（`_tryAutoRetry`）
4. 构造 abort 终态（`sendMessage.abort`）
5. 构造 fail 终态（`sendMessage.fail`）

核心 bug：`_tryAutoRetry()` 在检查"用户是否主动中断"之前，先判断了"错误是否可重试"。
用户中断产生的 API error 被误判为可重试，自动重试吞掉了用户中断。

### `abortedMessages` Set 的职责混乱

同一个 Set 被 5+ 处写入：`abort()`、`wrapInternalAbort`、`_handleGuardAbortOrSpeakRetry`、
`_executeAutoRetry`、`executeRetryWithSystemReminder`。读取时无法区分"用户中断"还是"系统 abort"。

## 方案：先分类后路由

### 架构

```
invokeConversation()
  → classifyAndRoute()     # 统一入口
    → tryCompleteSpeaking() # speaking guard（内容交付优先）
    → classifyExit()        # 分类退出原因
    → routeByReason()       # 按分类路由
      → handleUserAbort()   # 用户中断
      → routeGuardAbort()   # 系统保护中断
      → routeApiError()     # API 错误
      → handleSpeakRetry()  # 未调 speak
```

### ExitReason 类型系统

```typescript
type ExitReason =
  | { kind: 'user_abort'; toolCallCount: number }
  | { kind: 'guard_abort'; guardReason: string; toolCallCount: number }
  | { kind: 'api_error'; errorMessage: string; toolCallCount: number }
  | { kind: 'no_speak'; toolCallCount: number };
```

`classifyExit` 的优先级顺序保证了用户中断不被覆盖：
1. `userAbortedMessages.has(messageId)` → `user_abort`（最高优先级）
2. `extractGuardReason()` → `guard_abort`
3. `err` 存在 → `api_error`
4. 默认 → `no_speak`

### 两个 Set 替代 `abortedMessages`

| Set | 写入方 | 读取方 | 语义 |
|-----|--------|--------|------|
| `userAbortedMessages` | `abort()` 唯一写入 | `classifyExit` 第一顺位 | 用户显式中断 |
| `terminalMessages` | `abortTerminal` / `failTerminal` | 入口防重入 | 防止双重终态 |

### extractGuardReason：单一真相源

替代原 4 处重复提取逻辑（`_extractAbortReason`、`_handleGuardAbortOrSpeakRetry`、
`wrapInternalAbort`、`catch` 块 inline），从 3 个来源统一提取：

1. `result._guardAbortReason`（SDK 预捕获）
2. `err._guardAbortReason`（throw 路径）
3. `agentInvoke.getInternalAbortReason()`（activeSessions 查找）

## 行为变更

### guard abort 自动重试

原代码中 `streaming_timeout` 等 guard abort **不会**自动重试（因为 `_extractAbortReason`
在 `handleInvokeError` 中被消费后，`_tryAutoRetry` 找不到 reason）。
新代码中 `routeGuardAbort` 对可重试的 guard abort 统一走自动重试。

**有意变更**：streaming_timeout / first_byte_timeout / circuit_break 触发时，
先 fail + 重试一次，再犯才走 abort 终态。这与 API error 的行为一致。

### degenerate_output 不受影响

`routeGuardAbort` 中 `degenerate_output` 走专门的 `handleDegenerateRetry` 路径
（注入系统提醒 + 重试），不走 `handleAutoRetry`（不注入系统消息的重试）。

## 删除的方法

| 旧方法 | 替代 |
|--------|------|
| `handleInvokeError` | `classifyAndRoute` → `routeByReason` |
| `_tryAutoRetry` | `routeApiError` / `routeGuardAbort` 中的 retry 判断 |
| `_handlePostInvocation` | `classifyAndRoute` + `tryCompleteSpeaking` |
| `_handleGuardAbortOrSpeakRetry` | `routeByReason` switch 分支 |
| `wrapInternalAbort` | `extractGuardReason`（不再修改 Set） |
| `_extractAbortReason` | `extractGuardReason` |
| `_isRetryableAbortReason` | `isRetryableGuardAbort` |
| `_isRetryableApiError` | `isRetryableApiError` |
| `_executeAutoRetry` | `handleAutoRetry` |

## 防护机制

- **防重入**：`abortTerminal` / `failTerminal` 入口检查 `terminalMessages.has()`
- **降级保护**：`handleAutoRetry` 检查 `conversationId` / `userMessageContent` 缺失时降级 `failTerminal`
- **TOCTOU 安全网**：`handleUserAbort` 中 `completeSpeakingMessage` 作为 `tryCompleteSpeaking` 的二次确认
- **异常日志**：`tryCompleteSpeaking` catch 块记录 `logger.warn`

## 验证

- 1036 测试全部通过（含新增 2 个自动重试专项测试）
- TypeScript 编译 + ESLint 零错误
- `first_byte_timeout` / `LLM API error` 自动重试路径专项测试覆盖
