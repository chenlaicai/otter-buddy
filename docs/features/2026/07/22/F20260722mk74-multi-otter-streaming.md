---
id: F20260722mk74
title: multi-otter-streaming
doc_type: feature

summary: |
  修复启动流程、speak 工具链路、流式消息状态管理共 13 个 bug，
  并重构为多 Otter 并发流式发言架构。

causal_links:
  from:
    - F20260721de6j   # 可观测性与日志基础设施（pino 引入）
    - F20260721x8k9   # 对话定时任务（scheduler 引入）
    - F20260721speak   # speak Skill

status: implemented
change_type: bugfix
tags: [startup, agent, sse, streaming, speak, multi-otter, concurrency]
modules: [scripts, src/main.ts, src/frameworks/agent, src/interface-adapters/agent-runtime, src/interface-adapters/http, web/src/pages/conversation]

created_at: 2026-07-22
---

# F20260722mk74 - 启动修复 + 多 Otter 并发流式发言 + speak 工具链路修复

## 1. 问题描述

### 问题组 A：启动流程

**A1. 启动脚本缺少 npm install**

`otter-buddy.sh start` 直接执行 `npm run build`，从未包含 `npm install`。worktree 开发时手动 install 过所以正常，合入 main 后 `node_modules` 过期就报错 `Cannot find module 'pino'`。

**A2. agentGateway 空对象**

`main.ts` 第 472 行 `initUseCases(repos, {} as PiSessionFactory, embeddingService)` 传入空对象。PR #64 重构 `initAgentAndScheduler` 时破坏了初始化顺序，真正的 `PiSessionFactory` 在后面才创建，但从未回填到 use cases。创建对话时报 `this.agentGateway.create is not a function`。

### 问题组 B：speak 工具链路（3 层 bug）

**B1. customTools 被 SDK 白名单过滤**

`createAgentSession` 的 `tools` 选项是 SDK 的工具白名单（`allowedToolNames`）。当 `tools=["read","write","edit","bash"]` 传入时，SDK 的 `isAllowedTool` 过滤器把所有 customTools（speak、search_memory 等）全部排除。模型根本看不到它们。

**B2. invoke 未传递 messageId**

`executeAgentInvocation` 调用 `agentInvoke.invoke()` 时未传递 `messageId`，导致 `PiSessionFactory.invoke` 中 `options.messageId` 为 undefined，`buildCustomTools` 的 `currentMessageId` 为空字符串。speak 工具执行时报错"当前消息 ID 未设置，无法结束发言"。

**B3. failMessage SQL 参数顺序错误**

`failMessage` 中 `params.push(body)` 导致 body 和 completed_at 参数顺序颠倒。SQL 的第一个 `?`（body）取到了 failedAt，第二个 `?`（completed_at）取到了 body。结果消息 body 是时间戳，error message 写入了 completed_at。

### 问题组 C：流式消息状态管理

**C1. agent.idle fallback 定时器误触发**

`agent.idle` 在 `invoke()` 内部同步触发，`message.complete` 在 `invoke()` 返回后才发送。原 2s fallback 定时器过短，会在 `message.complete` 到达前误触发，导致 streaming 状态被清除（气泡消失）+ Toast "回复已完成"。

**C2. token 使用量始终为 0**

speak 工具直接 complete 消息时未携带 token 数据，`agentInvoke.invoke()` 返回的 tokenUsage 既未写入 DB 也未通过 SSE 发送给前端。

**C3. speak 重试 SSE 事件缺失**

speak 重试时后端不通知前端当前消息失败，导致：流式中的 assistant_text 在刷新后消失（failed 消息的事件不可见），系统消息和新 agent 消息无 SSE 推送。

**C4. msg1+msg2 事件混合**

`message.start` 只更新 `otterMessageId`，不清空 `liveEvents`。重试时 msg1 的 assistant_text 残留，与 msg2 的事件混合显示。

**C5. message.failed 时消息消失**

`message.failed` 直接从 streamingMap 删除，msg1 在重试时消失，用户看不到第一次尝试的内容。

**C6. 多 Otter 并发状态覆盖**

前端 `streaming` 是单一 `useState<StreamingState | null>`，同一时间只能追踪一个 otter 的流式发言。多个 otter 并发时状态互相覆盖。

## 2. 修复方案

### Fix A1：启动脚本加 npm install

在 build 前增加 `npm install`（后端+前端），改为 5 步流程。

### Fix A2：恢复正确的初始化顺序

```typescript
// 先创建 agentGateway
const agentGateway = await initAgentSessionFactory({...}, logger);
// 传入 initUseCases
const uc = initUseCases(repos, agentGateway, embeddingService);
// 构建 otterToolClient 并注入
const otterToolClient = buildOtterToolClient(uc);
agentGateway.setOtterToolClient(otterToolClient);
```

### Fix B1：tools 白名单合并 customTools

```typescript
tools: [...codingTools, ...customTools.map(t => t.name)],
```

### Fix B2：invoke 传递 messageId

```typescript
const result = await this.agentInvoke.invoke(params.otterId, params.userMessageContent, {
  messageId: params.messageId,  // 新增
  ...
});
```

### Fix B3：failMessage 参数顺序

`params.push(body)` 改为 `params.unshift(body)`。

### Fix C1：移除 agent.idle fallback 定时器

所有路径（正常完成、speak 重试、异常）最终都会发送 `message.complete` 或触发 SSE `onError`，定时器是多余的。

### Fix C2：token 使用量写入 DB + SSE

- `ConversationRepository` 新增 `updateTokenUsage` 方法
- `completeAgentInvocation` 在 SSE `message.complete` 事件中携带 `ctx`/`ctxMax`
- invoke 完成后异步写入 `context_tokens`/`context_tokens_max`

### Fix C3：speak 重试 SSE 事件

新增 `message.failed` 和 `system.message` SSE 事件，通知前端当前消息失败和系统提醒。

### Fix C4：message.start 时清空 liveEvents

```typescript
'message.start': (data) => {
  liveEvents.length = 0
  setStreaming({ otterId, duration: 0, events: [] })
},
```

### Fix C5：message.failed 保存消息内容

在删除 streamingMap entry 前，将 liveEvents 中的内容保存到 allMessages。

### Fix C6：多 Otter 并发架构重构

**核心架构决策：后端扇出（单 SSE 流）**

一次 `sendMessage` POST，后端对每个 targetOtter 并发调用 `invokeConversation`，所有事件通过同一个 SSE 流多路复用，用 `messageId` 区分。

**SSE 事件契约变更：**
- 中间事件加 `messageId`：`assistant_toolcall`、`tool.result`、`assistant_text`
- 补全缺失事件：`message.failed`、`system.message`
- 新增终端事件：`stream.end`（唯一关闭 SSE 流的事件）

**前端状态变更：**
- `streaming: StreamingState | null` → `Map<messageId, StreamingState>`
- SSE 事件按 `messageId` 分发到对应的 streamingMap entry
- MessageList 渲染多个 StreamingMessage

**后端变更：**
- controller 并发扇出所有 otter，`Promise.allSettled` 后关闭流
- `activeSessions` 用 `${otterId}:${messageId}` 复合 key 避免并发覆盖
- `message.complete`/`message.failed`/`error` 不再自动关闭流

## 3. 影响范围

| 文件 | 变更 |
|------|------|
| `scripts/otter-buddy.sh` | 启动脚本加 npm install，改为 5 步 |
| `src/main.ts` | 恢复正确的初始化顺序 |
| `api-contract/sse/events.ts` | SSE 事件加 messageId，补全新事件 |
| `src/interface-adapters/http/sse-streamer.ts` | 终端事件改为 stream.end，加 close() |
| `src/interface-adapters/agent-runtime/agent-invoke-port.ts` | abort/getToolCallCount 加 messageId |
| `src/frameworks/agent/pi-session-factory.ts` | 白名单合并 customTools，activeSessions 复合 key |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 注入 messageId，不 re-throw，补全 SSE 事件 |
| `src/interface-adapters/http/controllers/message-controller.ts` | 后端并发扇出 |
| `src/frameworks/db/conversation/sqlite-conversation-repository.ts` | failMessage 参数顺序，新增 updateTokenUsage |
| `src/usecases/conversation/conversation-repository.ts` | 接口新增 updateTokenUsage |
| `src/usecases/conversation/send-message.ts` | 新增 updateTokenUsage 方法 |
| `web/src/pages/conversation/MessageList.tsx` | StreamingState 加 messageId，多 StreamingMessage 渲染 |
| `web/src/pages/conversation/ChatView.tsx` | 透传 streamingMessages Map |
| `web/src/pages/conversation/index.tsx` | streaming 改为 Map，SSE 按 messageId 分发 |

## 4. 已知遗留问题

1. **Pi SDK session 冷启动设计**：每次 invoke 创建新 session 对象，工具重新创建。需要重构 session 生命周期。
2. **speak 重试系统消息未注入 agent 上下文**：系统消息只写 Otter DB，Pi session 看不到。
3. **模型不主动调用 speak**：mimo-v2.5-pro 不主动调用 speak 工具，需要优化 prompt。
