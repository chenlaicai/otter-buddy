---
id: F20260724dsp0
title: default-dispatch-target
doc_type: feature

summary: |
  用户发言未指定 @ 时的发言石默认派发规则：优先回复最后发言的在场 otter
  （任何状态的 otter 消息都算发言，含 failed/aborted），兜底在场大獭。
  决策权从前端移到后端 usecase 层，旧行为（无 @ 全员广播）废弃。

causal_links:
  from:
    - F20260722c4nv

status: draft
change_type: feature
tags: [talking-stone, dispatch, conversation, mention]
modules:
  - src/usecases/conversation/
  - src/interface-adapters/http/
  - src/frameworks/db/conversation/
  - api-contract/
  - web/src/pages/conversation/

created_at: 2026-07-24
---

# F20260724dsp 无 @ 发言默认派发：回复最后发言者，兜底大獭

## 术语定义

| 术语 | 定义 |
|------|------|
| **默认派发** | 用户消息 `talkingStonePassedTo` 为空时，由后端解析发言石目标的过程 |
| **最后发言者** | 对话中 sequenceNum 最大的一条 `senderType=otter` 消息的发送者，**任何消息状态都算发言**（completed/failed/aborted/streaming） |
| **在场** | `ConversationParticipant.status='active'` 且 otter 实体 `status='active'`（未解散） |

## 规则

用户发言无 @ 时，按优先级解析目标：

1. **回复最后发言者**：最后发言的 otter 仍在场且未解散 → 发给它
2. **兜底大獭**：在场且未解散的 `type=big` otter
3. 都无法解析 → 抛 `DomainError`，**不退化为全员广播**

有 @ 时按 @ 派发（前端解析 mention，传单个目标）。

### 有意为之的设计决策

- **failed/aborted 算发言**：用户明确澄清，最后一条 otter 消息即使是错误/中断也算"它说过话"
- **streaming 也会被选中**：需求字面"任何状态"。用户在 otter 生成中再发消息时，由 agent 层按 otter 的锁串行化（30s 超时），与旧广播行为一致，非回归
- **不回溯**：最后发言者不可用时直接兜底大獭，不往前找倒数第二位发言者（需求只定义两级优先级）
- **DissolveOtter 不级联退场**：解散 otter 不会把 participant 标记为 left（既有架构缺口），因此解析时两个分支都必须校验 otter 实体状态，不能只看 participant

## 实现

- `SendMessage.resolveDefaultTargets()`（usecase 层）：解析规则的唯一实现。`SendMessage` 注入 `OtterRepository` 用于校验 otter 状态与类型
- `GetMessagesOptions.senderType`：SQL 层 `sender_type = ?` 过滤，`LIMIT 1` 取最后一条 otter 消息
- `MessageController.sendMessage`：移除空目标 400 校验；首轮派发以持久化后消息的 `talkingStonePassedTo` 为准（含解析结果）
- 契约：`SendMessageRequestDTO.talkingStonePassedTo` 改为可选，缺省/空数组由后端解析
- 前端：无 @ 传空数组，不再做派发决策（旧行为：广播所有在场 otter）

## 影响面

- 多 otter 对话下无 @ 发言从"全员并发派发"变为"单目标派发"，未被派发的 otter 通过 `lastReadTurnNumber` 累积未读，下次被派发时经 `getUnreadMessages` 补全 backlog（设计内行为）
- scheduler（定时任务）走 `senderType='system'`，短路跳过解析，不受影响
