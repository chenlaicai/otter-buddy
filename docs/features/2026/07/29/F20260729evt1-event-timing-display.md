---
id: F20260729evt1
title: event-timing-display
doc_type: feature

summary: |
  流式事件耗时显示 + 实时计时：
  - message.start SSE 携带 createdAt，前端用服务端时间替代客户端 nowTs()
  - 每个流式事件（toolcall/tool.result/assistant_text）携带时间戳，EventItem 显示与前一个 event 的时间差
  - 流式进行中 StreamingProcess 实时计时（100ms 刷新）
  - 消息头部流式中显示开始时间（不再只显示"正在回复..."）

status: final
change_type: feature
tags: [ui, streaming, timing, sse]
modules:
  - api-contract/sse/events.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - web/src/lib/mappers.ts
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/MessageList.tsx

created_at: 2026-07-29
---

# F20260729evt1 流式事件耗时显示 + 实时计时

## 背景

此前 UI 对流式过程的耗时展示存在三个断点：

1. **message.start 不带时间戳**：前端创建占位消息用 `nowTs()`（客户端时间），服务端 `createdAt` 未传递
2. **中间事件无时间信息**：每个 `MessageEvent` 在 DB 有 `created_at`，但 DTO 映射时被丢弃，前端 `LocalMessageEvent` 只有 `eventType` + `payload`
3. **流式中无实时耗时**：`startTime` 是 agent-invoker 内部局部变量，既不持久化也不通过 SSE 推送；UI 仅显示"正在回复..."

## 数据流分析

### 原有链路

| 数据 | 存储位置 | 是否传到前端 | 是否展示 |
|------|---------|-------------|---------|
| 消息开始时间 | `Message.createdAt` → DTO `ts` | 是 | 完成后展示，流式中不展示 |
| 消息总耗时 | 完成后计算 `completedAt - createdAt` → `dur` | 是 | 完成后展示 |
| 每个 event 时间戳 | `MessageEvent.createdAt`（DB） | **否** | 否 |
| 流式实时耗时 | agent-invoker `Date.now() - startTime` | **否** | 否 |

### 断点位置

- `agent-invoker.ts:148`：`message.start` 事件只传 `messageId, otterId, otterName, seq`，未传 `createdAt`
- `mappers.ts:22-25`：`LocalMessageEvent` 接口只有 `eventType` + `payload`，无 `ts`
- `index.tsx:35-38`：`mapMessageDTOs` 映射 event 时丢弃 `createdAt`

## 变更

### 1. 后端：message.start 携带 createdAt

**agent-invoker.ts:148** — `sendMessage.start()` 返回的 `Message` 对象已有 `createdAt`（`send-message.ts:169`），直接传递：

```typescript
onSSEEvent?.({ event: "message.start", data: {
  messageId: message.id, otterId, otterName: otter?.name ?? otterId,
  seq: message.sequenceNum, createdAt: message.createdAt  // 新增
} });
```

**api-contract/sse/events.ts** — SSE 类型定义同步更新。

### 2. 前端类型：LocalMessageEvent 加 ts

**mappers.ts** — 接口新增 `ts: string` 字段。

### 3. 前端映射：保留 event 时间戳

**index.tsx mapMessageDTOs** — DTO 已含 `createdAt`（`message-dto.ts:42`），映射到 `ts`。

**index.tsx SSE handler** — 中间事件（toolcall/tool.result/assistant_text）push 时携带 `nowTs()`；`message.start` 用 `data.createdAt`。

### 4. 前端 UI：EventItem 耗时

**MessageList.tsx EventItem** — 接收 `prevTs` prop，计算与前一个 event 的时间差，显示 `+0.3s` 格式。

### 5. 前端 UI：实时计时

**MessageList.tsx StreamingProcess** — `inFlight` 时 `setInterval(100ms)` 实时更新 elapsed，标题显示 `进行中 · 2.3s`。

### 6. 前端 UI：消息头部开始时间

**MessageList.tsx** — 流式中消息头部从 `正在回复...` 改为 `2026-07-29 17:00:00 · 正在回复...`。

## 设计决策

1. **中间事件用客户端时间 `nowTs()` 而非扩展 SSE 契约**：event 间耗时差异在秒级，客户端时钟偏差不影响可读性；扩展每个 SSE 事件携带 `createdAt` 改动面大，当前不需要。
2. **`nowTs()` 统一使用 ISO 8601 格式**：原先 `toLocaleString('zh-CN')` 返回的 locale 格式（`"2026/7/29 17:00:00"`）在 Safari 中无法被 `Date.parse()` 解析（返回 NaN），且与服务端 ISO 格式混用会导致时区偏移。统一改为 `toISOString()`。
3. **实时计时 100ms 刷新间隔**：视觉流畅（~10fps），CPU 开销可忽略（单个 `Date.now()` + DOM 更新）。
4. **消息头部显示服务端 createdAt**：保证刷新后重新加载的时间一致性。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `api-contract/sse/events.ts` | `message.start` 类型加 `createdAt` |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | `message.start` 事件加 `createdAt` |
| `web/src/lib/utils.ts` | `nowTs()` 改为 ISO 8601 格式 |
| `web/src/lib/mappers.ts` | `LocalMessageEvent` 加 `ts` |
| `web/src/pages/conversation/index.tsx` | SSE handler 事件携带时间戳 + message.start 用服务端时间 + DB 事件 createdAt null guard |
| `web/src/pages/conversation/MessageList.tsx` | EventItem 耗时 + StreamingProcess 实时计时 + 消息头部开始时间 + useEffect 依赖优化 |
| `tests/api/message.test.ts` | message.start mock 补齐 createdAt |
| `tests/interface-adapters/agent-invoker.test.ts` | 断言 message.start 携带 createdAt |

## 测试

- `npm run build` — 无报错
- `npm test` — 695/695 通过
