---
id: F20260727atcc
title: abort-tool-call-count-fix
doc_type: feature

summary: |
  修复中断消息中工具调用计数始终为 0 的 bug。当 SDK 吞掉 abort 正常返回时，
  finally 已清理 activeSessions，getToolCallCount 返回 0。
  改为在 executeAgentInvocation 中通过 onEvent 回调本地跟踪 tool_execution_start 计数，
  供合成 abort error 携带到 handleInvokeError。

causal_links:
  from:
    - F20260717d4ab
    - F20260722ta2k

status: draft
change_type: fix
tags: [abort, tool-call-count, streaming, agent-runtime]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts

created_at: 2026-07-27
---

# F20260727atcc 中断消息工具调用计数修复

## 术语定义

| 术语 | 定义 |
|------|------|
| **Path A** | abort 导致 session.prompt() 抛异常，pi-session-factory catch 块设置 `_toolCallCount` |
| **Path B** | SDK 吞掉 abort 正常返回，finally 已清理 activeSessions，需从事件流获取计数 |
| **toolCallCount** | 一次 invoke 过程中 `tool_execution_start` 事件的累计次数 |

## 背景

用户报告：搭档发言过程中执行了多次工具调用，点击中断后消息显示"经过 0 次工具调用后，搭档强制中断了当前发言。"。

### 根因

`invokeConversation` 有两条 abort 路径：

**Path A（正常）：** `session.prompt()` 抛异常 → pi-session-factory catch 块从 `activeSessions` 读取 `toolCallCount` 附着到 error 的 `_toolCallCount` → `handleInvokeError` 读取。此路径正常工作。

**Path B（异常）：** Pi SDK 吞掉 abort，`session.prompt()` 正常返回 → pi-session-factory `finally` 块清理 `activeSessions` → `invokeConversation` 检测到 `abortedMessages` 标记 → 创建 `new Error("Invocation aborted by user")` 但无 `_toolCallCount` → `handleInvokeError` 回退到 `getToolCallCount()` → `activeSessions` 已被清理 → 返回 0。

```
invokeConversation
├── executeAgentInvocation
│   └── piSessionFactory.invoke
│       ├── session.prompt()  ←── SDK 吞 abort，正常返回
│       └── finally { activeSessions.delete(sessionKey) }  ←── 计数丢失
├── abortedMessages.has(message.id) → true
├── new Error("Invocation aborted by user")  ←── 无 _toolCallCount
└── handleInvokeError → getToolCallCount → 0  ←── bug
```

## 变更

### agent-invoker.ts

1. `executeAgentInvocation` 新增 `toolCallCount` 局部变量，在 `onEvent` 回调中跟踪 `tool_execution_start` 事件
2. 返回值从 `{ result }` 扩展为 `{ result, toolCallCount }`
3. Path B 创建合成 error 时附上 `toolCallCount`：`Object.assign(new Error(...), { _toolCallCount: toolCallCount })`

### 设计决策

**为什么不在 `executeAgentInvocation` 的 catch 块中设置 `_toolCallCount`？**

Path A 的 error 已由 pi-session-factory catch 块设置 `_toolCallCount`（从 `activeSessions` 读取）。如果在 `executeAgentInvocation` catch 块中用 `??` 覆盖，当 error 无 `_toolCallCount` 且本地 `toolCallCount` 为 0 时（mock 未派发事件即抛异常的测试场景），会破坏 Path A 的 `getToolCallCount` 回退逻辑。因此 catch 块不干预 `_toolCallCount`，仅在 Path B 的合成 error 上使用本地计数。

## 测试

| 场景 | 预期 |
|------|------|
| Path A：error 携带 `_toolCallCount: 3`，`getToolCallCount` 返回 0 | abort body 显示 "3 次工具调用" |
| Path B：SDK 吞 abort，事件中有 3 次 tool_execution_start，`getToolCallCount` 返回 0 | abort body 显示 "3 次工具调用" |
| 正常完成（无 abort） | message.complete，无 message.aborted |
| stale abort 标记（abort 被调用但 invoke 成功） | message.complete，stale 标记被清理 |
