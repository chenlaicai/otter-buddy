---
id: F20260801stab
title: agent-stability-batch-fix
doc_type: feature

summary: |
  Agent 稳定性批量修复 5 个问题：1) invocation hang（session 文件丢失 + messages.source NOT NULL
  约束冲突 + processHopResults 静默吞错）；2) 发言名字显示 "Otter" 而非实际名称（subscribe 端点
  遗漏 resolveSenderNames + message.complete 事件缺 otterName）；3) system.message 显示顺序反转；
  4) 发言接龙 20 轮限制过小；5) 浏览历史时自动跳到底部。

causal_links:
  from:
    - F20260724regd   # sender-name-projection：发言名字显示问题是该修复的回归

status: final
change_type: fix
tags: [agent, stability, bugfix, invocation, sender-name, message-ordering, session]
modules:
  - src/usecases/conversation/send-message.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/session-restore.ts
  - src/interface-adapters/http/controllers/message-controller.ts
  - api-contract/sse/events.ts
  - src/frameworks/config-service.ts
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
  - src/entities/conversation/message.ts
  - web/src/pages/conversation/

created_at: 2026-08-01
---

# F20260801stab Agent 稳定性批量修复

> 日期：2026-08-01
> 模块：agent / web / api-contract
> 类型：Bugfix（多个问题合并修复）

## 问题清单

| # | 问题 | 严重度 | 状态 |
|---|------|--------|------|
| 1 | Agent 发言无回复（invocation hang） | P0 | 已修复 |
| 2 | 发言名字显示 "Otter" 而非实际名称 | P1 | 已修复 |
| 3 | `system.message` 显示顺序反转 | P1 | 已修复 |
| 4 | 发言接龙 20 轮限制过小 | P2 | 已修复 |
| 5 | 浏览历史时自动跳到底部 | P2 | 已修复 |

---

## 问题 1：Agent 发言无回复（invocation hang）

### 现象

用户在对话中发送消息后，系统无任何回复。日志显示 "Agent invocation started" 但无后续日志（"LLM request" 从未出现）。

### 根因分析

调用链：`发言链调用 → Agent invocation started → buildDynamicContext() → sendMessage.start() → [HANG]`

三个并行问题导致：

1. **Session 文件丢失**：DB 中 `agent_sessions.session_file` 指向不存在的 `.jsonl` 文件。`SessionManager.create()` 使用延迟写入（首条 assistant 消息后才落盘），进程在写入前退出导致文件永久丢失。重启后 `restoreOrCreate` 走 `recreateFromConfig` 路径重建 session，但过程中存在潜在 hang 点。

2. **`messages.source` NOT NULL 约束冲突**：`send-message.ts` 的 `start()` 和 `sendSystem()` 方法显式设置 `source: null`，但迁移添加的 `source TEXT NOT NULL DEFAULT 'web'` 列在 INSERT 时显式传 NULL 会违反约束。Self-Healing init 的 `sendSystem` 调用因此失败。

3. **`processHopResults` 静默吞错**：`dispatch-chain-engine.ts` 中 `Promise.allSettled` 的 rejected 结果被 `if (r.status !== "fulfilled") continue` 直接跳过，无任何日志。agent invocation 失败时用户只看到"无回复"，无法定位原因。

### 修复

| 文件 | 改动 |
|------|------|
| `send-message.ts` | `start()` 和 `sendSystem()` 中 `source: null` → `source: 'web'` |
| `message.ts` | `MessageSource` 类型保留 `null`（agent/系统消息不需要标记来源） |
| `sqlite-conversation-repository.ts` | INSERT 时 source 为 null 则不带该列，让 DB DEFAULT 生效 |
| `dispatch-chain-engine.ts` | `processHopResults` 中 rejected 的 Promise 加 `logger.error` |
| `agent-invoker.ts` | 关键路径加 debug 日志（`buildDynamicContext` → `sendMessage.start` → `executeAgentInvocation`） |
| `pi-session-factory.ts` | `_invokeInternal` 和 `_executeWithSession` 加 debug 日志 |
| `session-restore.ts` | `restoreOrCreate` 和 `createAndReturnSession` 加 debug 日志 |

### 决策记录

- **source 字段处理**：原始设计是 agent/系统消息不需要 source（广播给所有已连接前端）。DB migration 添加的 `NOT NULL DEFAULT 'web'` 是实现细节。正确做法是 INSERT 时 source 为 null 就不带该列，让 DEFAULT 生效。类型定义保留 `null` 以表达设计意图。
- **日志级别选择 debug**：避免 info 级别日志过多影响正常运行。排查时通过 `LOG_LEVEL=debug` 启用。
- **Session 文件丢失**：`@earendil-works/pi-coding-agent` SDK 的 `SessionManager.create()` 使用延迟写入（首条 assistant 消息后才落盘），进程退出前未生成 assistant 消息则 session 文件永久丢失。本次修复让问题可诊断（debug 日志），但无法从应用层修改 SDK 的文件写入策略。已记录为已知边界。

---

## 问题 2：发言名字显示 "Otter" 而非实际名称

### 现象

大獭创建小獭完成话剧表演后，最后一条大獭发言的发送者名称显示为 "Otter" 而非 "大獭"。

### 根因分析

**回归引入**：commit `70ce5c6`（统一消息广播架构）新增 `subscribe` 方法时，遗漏了 commit `0376938`（发送者名称投影修复）中已修复的 `resolveSenderNames` 调用。

**两个 Gap**：

**Gap A（主因）**：`message-controller.ts` 的 `subscribe` 端点广播消息时调用 `toMessageDTO(message)` 未传 `senderName`。`list` 和 `getById` 端点都有 `resolveSenderNames()` 但 `subscribe` 遗漏。

```typescript
// subscribe — 修复前：无 sn
push({ event: "message", data: toMessageDTO(message) })

// list — 已有 sn
const senderNames = await this.resolveSenderNames(messages)
const dtos = messages.map(msg => toMessageDTO(msg, senderNames.get(msg.senderId)))
```

**Gap B**：`message.complete` SSE 事件未携带 `otterName`（`message.start` 和 `message.aborted` 都有）。前端依赖 `liveMeta`（由 `message.start` 填充）恢复名称，`liveMeta` 丢失（页面刷新、SSE 重连）时回退到硬编码 `'Otter'`。

**前端回退链**：`m.sn || otter?.name || 'Otter'`

- `m.sn`：来自 DTO（subscribe 广播时为 undefined）
- `otter?.name`：从 `allOtters` 状态查找（新建的小獭可能还未加入）
- `'Otter'`：硬编码兜底

### 修复

| 文件 | 改动 |
|------|------|
| `message-controller.ts` | `subscribe` 回调加 `queryOtter.getById` 解析发送者名称 |
| `agent-invoker.ts` | `completeAgentInvocation` 中 `message.complete` 事件加 `otterId` + `otterName` |
| `events.ts` | SSE contract `message.complete` 类型加 `otterId` + `otterName` |
| `index.tsx` | 两处 `message.complete` handler 用 `data.otterName` 作 `liveMeta` 的 fallback |

### 决策记录

- **subscribe 端点同步查询 otter 名称**：每个消息回调调一次 `queryOtter.getById`，性能开销可接受（单条消息查询，非批量）。
- **message.complete 携带 otterName**：与 `message.start`/`message.aborted` 保持一致，消除对 `liveMeta` 的单一依赖。

---

## 问题 3：`system.message` 显示顺序反转

### 现象

speak 重试流程中，用户短暂看到 `大獭发言1 > 大獭发言2 > 系统提醒`（错误顺序），随后自动纠正为 `大獭发言1 > 系统提醒 > 大獭发言2`。

### 根因分析

**SSE 双通道竞态**：前端有两个独立的 SSE 通道同时接收事件：

1. **GET 订阅**（`/api/conversations/:id/subscribe`）：长连接，有 `message.start` handler 但**无 `system.message` handler**
2. **POST 流**（`/api/conversations/:id/messages`）：per-send，有 `system.message` handler

`system.message` handler 直接 append 到列表末尾（无 `seq`，不使用 `insertBySeq`）。当 GET 通道先处理 `message.start`（seq=4）、POST 通道后处理 `system.message`（无 seq）时，system message 被追加到 message2 之后。

**时序**：
```
POST: message.failed → upsert message1
GET:  message.start(seq=4) → insertBySeq → append（无更高 seq）
POST: system.message → append to end（在 message2 之后）
```

### 修复

| 文件 | 改动 |
|------|------|
| `agent-invoker.ts` | `system.message` 事件加 `seq: sysMsg.sequenceNum` |
| `events.ts` | SSE contract `system.message` 类型加 `seq: number` |
| `index.tsx` | `system.message` handler 从 `[...list, msg]` 改为 `insertBySeq(list, msg)` |

### 决策记录

- **复用 insertBySeq**：与 `message.start` 保持一致的插入逻辑，利用 `seq` 保证有序。
- **不合并双 SSE 通道**：当前架构下 GET 订阅用于实时推送、POST 流用于 per-send 事件，合并需要较大重构。通过统一 `seq` 语义解决竞态。

---

## 问题 4：发言接龙 20 轮限制过小

### 现象

大獭拉小獭演话剧时，发言链达到 20 轮深度上限被强制终止。

### 修复

| 文件 | 改动 |
|------|------|
| `config-service.ts` | `maxChainDepth` 默认值从 20 改为 100 |
| `dispatch-chain-engine.ts` | fallback 值从 20 改为 100 |

### 决策记录

- **仅改默认值，不改机制**：当前 `maxChainDepth` 是硬性安全阀。实际场景中 agent 通过 `speak` 的 `talkingStonePassedTo: ['user']` 自然结束发言链。话剧场景中小獭之间互相传发言石导致轮数膨胀。
- **TODO：探索更优雅的终止机制**：纯轮数限制不够智能。后续可探索"静默检测"（连续 N 轮无新内容时自动终止）或"token 预算"等替代方案。

---

## 问题 5：浏览历史时自动跳到底部

### 现象

对话消息较多时，用户向上滚动查看历史消息，会突然自动跳到最下方。

### 根因

`MessageList.tsx` 的 `useEffect` 在 `messages` 变化时无条件执行 `scrollTop = scrollHeight`：

```typescript
useEffect(() => {
  if (scrollRef.current) {
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }
}, [messages])
```

任何 `messages` 状态更新（SSE 事件、轮询快照合并等）都会触发此 effect，强制滚到底部。

### 修复

| 文件 | 改动 |
|------|------|
| `MessageList.tsx` | 加 100px 阈值判断，仅当用户已在底部附近时自动滚底 |

```typescript
useEffect(() => {
  const el = scrollRef.current
  if (!el) return
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  if (isNearBottom) {
    el.scrollTop = el.scrollHeight
  }
}, [messages])
```

### 决策记录

- **100px 阈值**：经验值，覆盖大部分设备的触摸/鼠标滚动精度。用户滚动超过 100px 即视为"在浏览历史"，不打断。
- **不引入"新消息提示"气泡**：当前修复足够解决用户痛点。如后续需要更精细的体验（如"有新消息"浮动按钮），可在此基础上扩展。

---

## 测试覆盖

- 826 个后端测试全部通过
- 70 个前端测试全部通过
- `subscribe-sse.test.ts` 补充了 `queryOtter` mock 以适配新增的名称解析逻辑
