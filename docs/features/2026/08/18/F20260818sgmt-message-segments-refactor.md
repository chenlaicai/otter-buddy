---
id: F20260818sgmt
title: "消息内容模型重构：messages.body → message_segments 子表"
date: 2026-08-18
status: implemented
---

# 消息内容模型重构：messages.body → message_segments 子表

## 背景

speak/yield 工具拆分后，一条消息的内容由多次 speak 调用累积而成。原数据模型中 `messages.body` 是单个 `TEXT` 列，与"多次 speak"的语义不匹配。

### 问题

1. speak 内存在 ToolContext buffer 中，yield 才落库 → agent 崩溃时内容丢失
2. 单 body 列无法表达"一条消息有多段发言"的语义
3. fail/abort body 直接覆盖 speak body → 原始内容丢失

## 方案

### 数据模型

```
messages (移除 body 列)
├── id, conversation_id, turn_id, sender_type, sender_id
├── status, sequence_num, talking_stone_passed_to
├── context_tokens, context_tokens_max, source, metadata
├── created_at, completed_at
│
└── message_segments (新增子表)
    ├── id (PK, UUID)
    ├── message_id (FK → messages, ON DELETE CASCADE)
    ├── body TEXT NOT NULL — 单次 speak/fail/abort 的内容
    ├── sequence_num INTEGER NOT NULL — 同一 message 内的顺序
    └── created_at TEXT NOT NULL
```

### 核心 API

| 方法 | 行为 |
|------|------|
| `appendSegment(messageId, body)` | 追加一条 segment，自动刷新 FTS |
| `getSegments(messageId)` | 获取消息所有 segments（按 sequence_num 排序） |
| `startSpeaking(messageId, body, targets)` | INSERT segment + UPDATE status（同一事务） |
| `failMessage(messageId, failedAt, body?, targets?)` | 可选 INSERT segment + UPDATE status（同一事务） |
| `abortMessage(messageId, body, targets, abortedAt)` | INSERT segment + UPDATE status（同一事务） |

### 聚合函数

```typescript
export function aggregateBody(segments: MessageSegment[]): string {
  return segments.map(s => s.body).join("\n\n");
}
```

所有读路径统一使用 `aggregateBody(msg.segments)` 获取完整 body。

## 迁移策略

1. `migrateMessageSegments`：幂等迁移
   - 创建 `message_segments` 表
   - 存量 `messages.body` → `message_segments`（sequence_num=0）
   - settings key 标记完成（在 DROP COLUMN 之前，避免 livelock）
   - DROP COLUMN body（SQLite 3.35+，降级时跳过）

2. `rebuildMessagesFtsStripped`：兼容新旧模型
   - 检测 `message_segments` 表是否存在
   - 存在：从 segments 聚合后重建 FTS
   - 不存在：从 `messages.body` 重建（旧库兼容）

## 对抗检视发现并修复的问题

| 轮次 | 严重度 | 问题 | 修复 |
|------|--------|------|------|
| R1 | P0 | speak 的 appendSegment + startSpeaking 非原子 | 合并为同一事务 |
| R1 | BUG-1 | migration DROP COLUMN 失败导致 livelock | settings key 写入移到 DROP 之前 |
| R1 | BUG-2 | schema.ts 仍声明 body TEXT | 移除 body 列 |
| R1 | P1 | speak.intermediate SSE 死代码 | 移除事件定义 + 前端 handler |
| R1 | P3 | speakBodyBuffer/pendingYieldTargets 死代码 | 移除 |
| R2 | P1 | fail/abort 的 appendSegment + 状态变更非原子 | 合并为同一事务 |

## 不需要改动的部分

| 层 | 原因 |
|---|---|
| DTO | `aggregateBody(msg.segments)` 替代 `msg.body`，接口不变 |
| 前端 | `LocalMessage.content` 来自 SSE/DTO，不变 |
| 飞书 | `projectForChannel` 在聚合 body 上工作正常 |
| agent tools | `get_message`/`list_messages` 用 `aggregateBody` 替代 `msg.body` |
| dispatch-chain | 无感知，segments 在 repo 层处理 |
| turn-utils | streaming 状态的 msg 无 segments → turn 不会提前关闭 |
