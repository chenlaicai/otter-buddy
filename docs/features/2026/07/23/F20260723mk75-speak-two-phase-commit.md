---
id: F20260723mk75
title: speak-two-phase-commit
doc_type: feature

summary: |
  Speak 机制全面修复：两阶段提交、发言链消息已读、prompt 架构重构、
  otter 身份注入、UI 一致性修复。解决了 speak 后事件丢失、实时/历史渲染不一致、
  小獭看不到大獭发言、abort 后消息消失等核心问题。

causal_links:
  from:
    - F20260722ta2k

status: draft
change_type: bugfix
tags: [speak, streaming, sse, agent, talking-stone, prompt, chain, identity]
modules:
  - src/usecases/conversation/
  - src/interface-adapters/agent-runtime/
  - src/interface-adapters/http/
  - src/frameworks/db/conversation/
  - src/frameworks/agent/
  - src/frameworks/db/
  - web/src/pages/conversation/
  - .pi/

created_at: 2026-07-23
---

# F20260723mk75 Speak 机制全面修复

## 术语定义

| 术语 | 定义 |
|------|------|
| **speak** | Agent 的"总结发言"工具，调用后声明发言内容和发言石目标 |
| **startSpeaking** | streaming → speaking 状态转换，暂存 body + talkingStonePassedTo |
| **complete** | speaking → completed 状态转换，触发 turn 关闭 |
| **发言链** | 大獭 speak 后 talkingStonePassedTo 指向小獭时，系统自动调用小獭 |
| **已读位置** | `last_read_turn_number`，记录 otter 在对话中已读到的 turn 编号 |
| **dispatchLoop** | Turn 级调度循环：派发一批 otter → 等待全部完成 → 聚合 turn → 派发下一轮 |

## 背景

### 问题 1：speak 后事件丢失

之前 speak 调用 `complete()` 原子写入 body + status=completed，后续流式事件被拒绝。

### 问题 2：实时/历史渲染不一致

前端从 `assistant_text` 事件提取内容作为 body，而非使用 speak 存储的权威数据。

### 问题 3：发言链断裂

小獭进场后看不到大獭的发言，因为每个 otter 有独立的 Pi SDK session。

### 问题 4：abort 后消息消失

前端 `message.aborted` 处理器直接删除 streaming entry，不保留已有事件。

### 问题 5：agent 不停止

speak 返回后 SDK agent loop 继续运行，agent 看到 `[ok]` 后继续生成。

### 问题 6：小獭有 create_otter 工具

`CreateOtter.execute()` 没有传递 `otterType` 到 `context`，导致小獭被识别为 big。

### 问题 7：全局 allOtters 破坏对话隔离

`allOtters` 是全局数组，跨对话共享，导致同名 otter 重复。

## 决策过程

### 决策 1：两阶段提交 vs speaking 中间状态

**main 分支方案**：引入 `speaking` 中间状态（streaming → speaking → completed）
- speak 调用 `startSpeaking()` 进入 speaking 状态
- agent loop 结束后调 `complete()` 进入 completed 状态

**本分支方案**：两阶段提交（setMessageBody + completeMessageFinalize）

**最终决策**：采用 main 的 `speaking` 状态方案，因为它与现有的 `streaming`/`completed`/`failed`/`aborted` 状态机一致。

### 决策 2：已读位置维度

**方案 A**：`last_read_sequence_num`（消息序列号）
- 问题：join 消息的 sequence_num 可能比 turn 内其他消息大

**方案 B（选定）**：`last_read_turn_number`（turn 编号）
- 小獭进场时已读位置设为当前 turn
- `getUnreadMessages` 用 `turn_number >= lastReadTurnNumber` 查询
- 能看到整个 turn 的所有消息

**决策理由**：turn 是对话的自然分界，用 turn 维度更语义化。

### 决策 3：Prompt 架构

| 层 | 位置 | 内容 |
|---|------|------|
| System Prompt | `.pi/SYSTEM.md`（SDK 注入） | 对话环境 + 原则 + 身份认知 |
| User Message 前缀 | `_executeWithSession`（首次 invoke） | per-otter 身份（name/ID/type） |
| Skills | SDK system prompt 末尾 | speak、participant-management 等目录 |
| Tool descriptions | 工具定义 | 简短描述 |

**关键决策**：platform prompt 移入 `.pi/SYSTEM.md`，不再作为 user message 前缀重复注入。

### 决策 4：speak 返回值

从 `[ok] 发言已结束` 改为 `[系统] 发言已提交成功。你的回合正式结束，直接结束本 loop，不要做任何回应。系统将自动调度下一位发言者。`

用"系统"前缀让 agent 认为这是系统指令而非对话响应。用"结束本 loop"比"停止生成"更明确。

### 决策 5：Event 处理策略

**最终方案**：所有事件如实持久化，不做任何抑制。
- Event 就是 event，反映 agent 实际行为
- Body 就是 body，由 speak 存储
- 两者独立，不互相干扰

### 决策 6：allOtters 重构

从全局 `LocalOtter[]` 改为 per-conversation 的 `Record<string, LocalOtter[]>`。
每个对话独立维护参与者列表，不再跨对话共享。

## 设计方案

### 发言链调度循环

```
controller.sendMessage()
    ↓
dispatchLoop(firstTurnTargets)
    ↓ 循环
invokeConversation(otter) + 未读消息注入
    ↓
Promise.allSettled → 聚合 aggregatedTargets
    ↓ 过滤 user
dispatchLoop(nextTargets)
    ↓ 无目标 → 结束
stream.end → close SSE
```

### 已读位置机制

```
participant.join() → lastReadTurnNumber = turn.turnNumber
    ↓
invokeChain → getUnreadMessages(otterId)
    ↓ JOIN turns WHERE turn_number >= lastReadTurnNumber
格式化为上下文注入 userMessageContent
    ↓
发言后 → updateLastReadTurnNumber(currentTurn)
```

### 身份注入

```
首次 invoke → _executeWithSession 检测 isFirstInvoke
    ↓ 查询 otters 表获取 name/type
注入身份前缀到 user message
    ↓ SDK session 持久化
后续 invoke → 从 session 历史恢复，不重复注入
```

### Prompt 层次

```
SDK System Prompt:
  .pi/SYSTEM.md（对话环境 + 原则 + 身份认知）
  + Skills catalog（7 个 skill 目录）
  + CWD

User Message:
  [首次] 身份前缀 + otter prompt + session summary + 用户消息
  [后续] otter prompt + session summary + 用户消息
```

## 关键文件

| 文件 | 改动 |
|------|------|
| `.pi/SYSTEM.md` | 新增：对话环境 + 原则 + 身份认知 |
| `.pi/skills/speak/SKILL.md` | 重写：回合交接、系统信号风格 |
| `.pi/skills/participant-management/SKILL.md` | 精简：移除 pass_talking_stone 引用 |
| `src/frameworks/db/migration.ts` | 新增 `last_read_turn_number` 列 |
| `src/frameworks/db/conversation/conversation-mapper.ts` | 新增 `last_read_turn_number` 映射 |
| `src/frameworks/db/conversation/conversation-repository-mixins.ts` | 新增 `updateLastReadTurnNumber`、`getUnreadMessages` |
| `src/usecases/conversation/conversation-repository.ts` | 接口新增已读位置方法 |
| `src/usecases/conversation/manage-participant.ts` | join 时设置 `lastReadTurnNumber` |
| `src/usecases/otter/create-otter.ts` | 传递 `otterType` 到 context |
| `src/frameworks/agent/pi-session-factory.ts` | 身份注入（首次 invoke）+ LLM request 日志 |
| `src/interface-adapters/http/controllers/message-controller.ts` | dispatchLoop + 未读消息注入 + Logger |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | speaking 状态检查 + SSE body 传递 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | speak 返回值 + create_otter 同名去重 |
| `src/main.ts` | Logger 注入 + wiring |
| `web/src/pages/conversation/index.tsx` | per-conversation otters + abort 事件保留 + turn 分割线 |
| `web/src/pages/conversation/MessageList.tsx` | 时间格式 fmtTime + StreamingState.otterName |
| `web/src/pages/conversation/MessageInput.tsx` | @ 提及按 ID 去重 |
| `web/src/lib/utils.ts` | fmtTime 工具函数 |
| `web/src/lib/mappers.ts` | LocalMessage 新增 turnId |
| `web/src/api/client.ts` | 新增 getMessage 方法 |

## 验收标准

1. speak 后事件正常持久化，无 "Cannot append event" 错误
2. 实时渲染和历史渲染一致（body 来自 SSE 事件的 body 字段）
3. 小獭进场后能看到大獭的发言（turn 维度已读位置）
4. 发言链自动接力：大獭 → 小獭 → 大獭（depth 限制 5 层）
5. abort 后消息不消失（事件保留到 allMessages）
6. 小獭没有 create_otter 工具（otterType 正确传递）
7. @ 提及列表无重复（per-conversation otters + ID 去重）
8. 新建/子对话 modal 支持 Enter 提交
9. 消息时间格式统一为 yyyy-MM-dd HH:mm:ss（本地时区）
10. turn 之间有视觉分割线
11. 身份注入只在首次 invoke 时执行
