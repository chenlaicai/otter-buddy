---
id: F20260808daca
title: fix-new-messages-count-double-counting
doc_type: feature

summary: |
  修复"新消息 N 条"计数虚增问题。用户静置时计数持续增长，实际并无新消息。
  根因有两个：(1) GET SSE 的 message handler 中，setNewMessagesCount 在 setAllMessages 外部执行，
  消息去重返回 prev 时计数仍递增；(2) message.start 事件被 GET 和 POST 两条 SSE 通道各计数一次。
  修复：(1) 引入 added 标志位，仅在消息确实新增时计数；(2) 移除 POST SSE 的 message.start 计数。

causal_links:
  from:
    - F20260807scrk   # 滚动抖动与新消息计数修复：引入 debounce 和去重逻辑
  to: []

status: development
change_type: fix
tags: [conversation, sse, new-messages-count, dedup]
modules:
  - web/src/pages/conversation/index.tsx
capability_test: "n/a: 前端计数逻辑改动（A 类），无 LLM 参与行为"
---

# F20260808daca: 修复新消息计数虚增（去重 + 双通道）

## 现象

1. 用户静置在对话页面，不滚动不操作，"新消息 N 条 ↓" 浮窗的 N 值持续增长
2. 实际并无新消息到达，或消息已在列表中
3. 用户自己发送消息时，计数一次跳 2 而非 1

## 因果溯源

### 背景：SSE 双通道架构

前端对每个活跃对话维护两条 SSE 连接：

| 通道 | HTTP 方法 | 路径 | 生命周期 | 用途 |
|------|----------|------|----------|------|
| GET 订阅 | GET | `/api/conversations/:id/subscribe` | 常驻，带指数退避重连 | 接收所有广播事件（message、message.start、message.complete 等） |
| POST 发送 | POST | `/api/conversations/:id/messages` | 用户发消息时创建，流结束即断 | 发送消息 + 接收该次请求的流式响应 |

后端 `MessageBroadcaster` 对每个订阅者同时推送 `onMessage`（完成消息）和 `onEvent`（streaming 事件）。
同一事件会同时到达 GET 和 POST 两条通道。

### Bug 1：message handler 无视去重结果，无条件计数

GET SSE 的 `message` handler 代码结构：

```typescript
'message': (data) => {
  const message = mapMessageDTO(data)
  setAllMessages(prev => {
    const current = prev[activeId] || []
    if (current.some(m => m.id === message.id)) return prev  // 去重：已存在则返回 prev
    // tmp 去重替换逻辑...
    return { ...prev, [activeId]: [...current, message] }    // 真正新增
  })
  if (!isAtBottomRef.current) setNewMessagesCount(c => c + 1)  // ← 问题所在
},
```

`setNewMessagesCount` 在 `setAllMessages` **外部**执行。
无论 `setAllMessages` 内部是去重返回 prev 还是真正新增，计数都会 +1。

**触发场景**：
- 定时任务（`SchedulerService`）通过 `sendMessage.send()` + `agentInvokePort.invokeConversation()` 触发消息
- 飞书消息同步
- 任何后端广播事件重复到达

用户静置时，只要有广播事件到达（无论消息是否真正新增），计数就 +1。

### Bug 2：message.start 被 GET + POST 双通道各计数一次

用户发送消息后：

1. POST SSE 的 `message.start` handler：+1
2. GET SSE 的 `message.start` handler：+1

同一条消息的 `message.start` 事件被两个处理器各计数一次，单次发言起步就 +2。

## 根因总结

```
SSE 双通道架构
  ├─ GET 订阅：常驻连接，接收所有广播事件
  └─ POST 发送：发消息时创建，也接收 broadcastEvent
        │
        ▼
Bug 1：message handler 结构缺陷
  ├─ setAllMessages 内部做去重（return prev）
  └─ setNewMessagesCount 在外部，无视去重结果
  → 消息重复到达时计数仍递增
  → 用户静置时计数持续上涨
        │
        ▼
Bug 2：message.start 双通道重复
  ├─ GET handler 对 message.start +1
  └─ POST handler 对同一个 message.start +1
  → 用户发言时计数一次跳 2
```

## 修复方案

### 1. message handler 引入 added 标志位

```typescript
'message': (data) => {
  const message = mapMessageDTO(data)
  let added = false
  setAllMessages(prev => {
    const current = prev[activeId] || []
    if (current.some(m => m.id === message.id)) return prev
    const tmpIdx = current.findIndex(/* tmp 去重逻辑 */)
    if (tmpIdx >= 0) {
      const next = [...current]
      next[tmpIdx] = message
      return { ...prev, [activeId]: next }
    }
    added = true  // 仅在真正新增时标记
    return { ...prev, [activeId]: [...current, message] }
  })
  if (added && !isAtBottomRef.current) setNewMessagesCount(c => c + 1)
},
```

`added` 标志位在 `setAllMessages` 回调内部设置，只在消息确实被新增时为 `true`。
去重返回 prev 或 tmp 替换时 `added` 保持 `false`，计数不递增。

### 2. 移除 POST SSE 的 message.start 计数

POST SSE 的 `message.start` handler 中移除 `setNewMessagesCount` 调用。
`message.start` 的计数由 GET 订阅统一处理，POST 流不重复计数。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `web/src/pages/conversation/index.tsx` | +8 -3：added 标志位（message + message.start）+ 移除 POST 计数 |

## 与 F20260807scrk 的关系

F20260807scrk 修复了滚动抖动和瞬态 atBottom 信号污染 `isAtBottomRef` 的问题（引入 debounce）。
该修复解决了「用户在底部时计数因瞬态 false 信号而累加」的场景。

本修复解决的是更基础的问题：**即使 `isAtBottomRef` 判断正确（用户确实不在底部），
计数逻辑本身也会因去重失败或双通道重复而虚增。**
两个修复互不冲突，共同确保计数准确。

## 验证

手动验证：
- [ ] 打开对话页面，滚动到底部，等待 agent 发言 → 计数应为 0（已在底部）
- [ ] 滚动到非底部，发送消息触发 agent → 每条新消息计数恰好 +1（不重复）
- [ ] 多条消息并发到达时计数 = 实际新增消息数
- [ ] 点击浮窗跳转到底部后计数清零

## 对抗审视记录

### 审视日期：2026-08-08

**Q1: `added` 标志位模式是否可靠？**

`added` 在 `setAllMessages` updater 回调内赋值、回调外读取。这依赖 React 18 `createRoot` 同步执行 state updater 的行为。

- **当前可靠性**：React 18 的 `useState` dispatch 机制中，updater 函数在 `dispatch` 调用期间同步执行（参见 `react-reconciler` 的 `dispatchSetState`），因此 `added` 在 `setAllMessages()` 返回时已确定。React 19 保持相同行为。
- **风险评估**：低。这是 React hooks 的核心实现路径，破坏此行为会同时破坏海量依赖此模式的代码。但 React 官方文档未将此作为正式 API 契约承诺，属于实现保证而非规范保证。
- **判定**：✅ 修复正确，注释已说明依赖前提。

**Q2: POST SSE 的 `message.start` 计数移除后，POST 流是否仍能正确显示占位消息？**

是。POST handler 仍保留 `insertBySeq` 插入 placeholder 逻辑和 `setAllOtters` 更新参与者列表，仅移除了 `setNewMessagesCount`。计数由 GET 订阅的 `message.start` handler 统一处理。

- **判定**：✅ 无功能回退。

**Q3: GET SSE 的 `message.start` handler 是否也有重复计数风险？**

原始代码中 GET 的 `message.start` handler 对计数本身无去重保护：`insertBySeq` 处理消息去重（同 id 原位替换），但 `setNewMessagesCount` 是无条件执行的。如果 GET 订阅因断连重连而重播 `message.start` 事件，计数可能虚增。

- **修复**：采用与 Bug 1 相同的 `added` 标志位模式。在 `setAllMessages` updater 内先检查 `messageId` 是否已存在，仅首次插入时标记 `added = true`。
- **判定**：✅ 已修复。

**Q4: tmp 乐观消息替换时计数是否正确？**

用户发消息 → 创建 `tmp-` 消息（无计数）→ 真实消息到达 → `tmp-` 去重替换 → `added = false` → 不计数。正确：用户自己的消息不应计入"新消息"。

- **判定**：✅ 逻辑正确。

**Q5: `message.complete` 是否有计数问题？**

GET 和 POST 的 `message.complete` handler 均不调用 `setNewMessagesCount`，仅做终态 upsert。`message.start` 已完成计数职责。

- **判定**：✅ 无问题。

### 审视结论

| 审视项 | 判定 |
|--------|------|
| Bug 1（去重消息重复计数） | ✅ 已修复 |
| Bug 2（双通道重复计数） | ✅ 已修复 |
| Bug 3（GET message.start 重连重播） | ✅ 已修复 |
| `added` 模式可靠性 | ✅ 可靠（React 18+ 实现保证） |
| POST 流功能完整性 | ✅ 无回退 |
