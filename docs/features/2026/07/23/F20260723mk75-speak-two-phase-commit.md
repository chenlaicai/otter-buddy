---
id: F20260723mk75
title: speak-two-phase-commit
doc_type: feature

summary: |
  Speak 两阶段提交重构：body 存储与 message 状态变更分离，
  解决 speak 后事件丢失和实时/历史渲染不一致问题。
  新增发言链自动接力机制和参与者 UI 刷新。

causal_links:
  from:
    - F20260722ta2k

status: draft
change_type: bugfix
tags: [speak, two-phase-commit, streaming, sse, agent, talking-stone]
modules:
  - src/usecases/conversation/
  - src/interface-adapters/agent-runtime/
  - src/interface-adapters/http/
  - src/frameworks/db/conversation/
  - src/frameworks/agent/
  - web/src/pages/conversation/

created_at: 2026-07-23
---

# F20260723mk75 Speak 两阶段提交与发言链

## 术语定义

| 术语 | 定义 |
|------|------|
| **speak** | Agent 的"总结发言"工具，调用后本次回复结束 |
| **setMessageBody** | 两阶段提交 Phase 1：存储 body + talkingStonePassedTo，不改 status |
| **completeMessageFinalize** | 两阶段提交 Phase 2：将 status 从 streaming 改为 completed |
| **发言链** | 大獭 speak 后 talkingStonePassedTo 指向小獭时，系统自动调用小獭 |
| **streamingDone** | Agent loop 结束标志（executeAgentInvocation 返回） |
| **speakBodyReceived** | Speak 工具被调用标志（tool_execution_end 事件到达） |

## 背景

### 问题 1：speak 后事件丢失

之前 `speak` 调用 `SendMessage.complete()` 会原子性地写入 body + 将 status 改为 `completed`。
但 speak 执行后 SDK 的 agent loop 还会产生事件（tool_result、assistant_text 等），
这些事件到达时 message 已是 completed 状态，`appendEvent` 拒绝写入。

### 问题 2：实时/历史渲染不一致

前端 `message.complete` 从最后一个 `assistant_text` 事件提取内容作为 body，
而不是使用 speak 存储的权威 body。导致实时渲染和历史渲染内容不同。

### 问题 3：发言链缺失

大獭 speak 后 `talkingStonePassedTo` 指向小獭，但系统不会自动调用小獭。
小獭需要用户手动发消息才能发言。

### 问题 4：参与者 UI 不刷新

Agent 创建小獭后，前端右侧栏不更新。

## 决策过程

### 决策 1：两阶段提交 vs 原子提交

**方案 A（原方案）**：speak 调 `complete()` 原子写入 body + status=completed
- 优点：简单
- 缺点：后续事件全部丢失

**方案 B（选定）**：拆分为 setMessageBody + completeMessageFinalize
- Phase 1：speak 调 setMessageBody() 只存 body，status 保持 streaming
- Phase 2：agent loop 结束后调 completeMessageFinalize() 完成状态转换
- 优点：所有事件都能正常持久化
- 缺点：需要新增两个 repository 方法

**决策理由**：事件是 agent 行为的真实记录，不应丢失。

### 决策 2：Message complete 的判定条件

**原方案**：speakBodyReceived AND streamingDone 两者都满足才 complete

**最终方案**：只看 streamingDone（agent loop 结束即 complete）
- 如果 body 已设 → completeMessageFinalize 成功
- 如果 body 未设 → completeMessageFinalize 抛错 → handleSpeakRetry

**决策理由**：
- speak 是流式过程中的一个 tool 调用，不是 message 结束的判定条件
- Message 的结束只有一个条件：agent loop 结束（streamingDone）
- Body 是否设置只影响 complete 后的处理路径（成功 vs 重试）

### 决策 3：Event 处理策略

**曾考虑**：speak 后抑制 assistant_text 的持久化（认为是"噪音"）

**最终方案**：所有事件如实持久化，不做任何抑制
- Event 就是 event，反映 agent 实际行为
- Body 就是 body，由 speak 存储
- 两者独立，不互相干扰

**决策理由**：
- 抑制事件是在"篡改历史"，不符合数据完整性原则
- 事件是调试和审计的重要依据
- 实时渲染的 SSE 也不应抑制（如实反映 agent 行为）

### 决策 4：speak 重复调用防御

**曾考虑**：setMessageBody 检查 body 已设则拒绝（硬编码防御）

**最终方案**：移除硬编码防御，交给 SKILL.md 行为指导
- SKILL.md 明确 speak 是"总结发言"，一次调用，调完就停
- 如果 agent 多次调用 speak，最后一次的 body 生效

**决策理由**：行为约束应由 prompt 指导，不应由代码硬编码限制。

### 决策 5：Session create 路径的 fs.existsSync 检查

**问题**：`SessionManager.create()` 使用延迟写入，文件路径已计算但文件不立即落盘。
`fs.existsSync(sessionFile)` 检查在 create 路径上必然失败。

**方案**：移除 create 路径的 fs.existsSync 检查，只在 restore 路径检查。

**决策理由**：SDK 的延迟写入是设计行为，不是 bug。

## 设计方案

### 核心架构

```
speak 工具调用 setMessageBody() → body 存入 DB，status 仍为 streaming
    ↓
Agent loop 继续运行（可能产生更多事件）
    ↓
Agent loop 结束（executeAgentInvocation 返回）
    ↓
try completeAgentInvocation → completeMessageFinalize
    ↓ body 已设 → 成功（status=completed + memoryIndex + tryCloseTurn）
    ↓ body 未设 → 抛错 → handleSpeakRetry
```

### 发言链

```
controller.sendMessage()
    ↓
invokeChain(otterIds, depth=0)
    ↓
invokeConversation(otter) → 返回 messageId
    ↓
queryMessage.getMessageById → talkingStonePassedTo
    ↓ 过滤掉 "user" 和已调用的 otter
    ↓ 有新目标 → invokeChain(newTargets, depth+1)
    ↓ 无新目标 → 结束
    ↓
stream.end → close SSE
```

### Repository 新增方法

```sql
-- Phase 1：只存 body，不改 status
UPDATE messages SET body=?, talking_stone_passed_to=?, attachments=?
WHERE id=? AND status='streaming'

-- Phase 2：只改 status，不碰 body
UPDATE messages SET status='completed', completed_at=?, context_tokens=?, context_tokens_max=?
WHERE id=? AND status='streaming' AND body IS NOT NULL
```

### 关键文件

| 文件 | 改动 |
|------|------|
| `conversation-repository.ts` | 接口新增 setMessageBody、completeMessageStatus |
| `sqlite-conversation-repository.ts` | SQL 实现 |
| `send-message.ts` | setMessageBody + completeMessageFinalize |
| `otter-tool-client.ts` | 接口新增 setMessageBody |
| `main.ts` | DI wiring |
| `tool-factory.ts` | speak 改用 setMessageBody |
| `agent-invoker.ts` | 两阶段提交逻辑、事件不抑制 |
| `message-controller.ts` | 发言链 invokeTalkingStoneChain |
| `index.tsx` (前端) | onDone 刷新参与者 + conversation.otterIds |
| `Modals.tsx` | Enter 提交 |
| `SKILL.md` (speak) | 总结发言行为指导 |

## 验收标准

1. speak 后不再有 "Cannot append event to message with status: completed" 错误
2. 所有事件如实持久化到 DB（包括 speak 的 tool_result 和后续 assistant_text）
3. 前端 message.complete 从 SSE 事件的 body 字段获取内容（后端从 DB 取）
4. 历史渲染的事件列表 = 实时渲染的事件列表
5. 发言链：大獭 speak 传给小獭时，小獭自动被调用
6. 发言链跳过 "user" 目标
7. 参与者 UI 在 SSE 流结束后自动刷新
8. 新建/子对话 modal 支持 Enter 提交
9. Agent 创建小獭后自动注册为对话参与者
