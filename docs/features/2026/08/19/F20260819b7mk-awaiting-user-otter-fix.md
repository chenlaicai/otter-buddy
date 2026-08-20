---
id: F20260819b7mk
title: 修复发言石传给 otter 时对话状态误判为 awaiting_user
summary: |
  在 listConversationsWithMeta 的派生活动状态中，当最后一条消息是 otter 发出且发言石传给另一个 otter 时，
  状态应为 processing 而非 awaiting_user。
status: draft
change_type: bugfix
tags: ["conversation", "database", "bugfix", "talking-stone", "activity-status"]
modules: ["src/frameworks/db/conversation/sqlite-conversation-repository.ts"]
created_in_conversation: bbcfaa33-f036-4493-94de-3faf1c6df6cf
capability_test: "n/a: 纯 SQL 逻辑修复（A 类），无 LLM 参与行为"
---

# 特性文档：修复发言石传给 otter 时对话状态误判

## 问题

在 `listConversationsWithMeta` 的派生活动状态（activityStatus）中，存在一个误判场景：

当对话的最后一条消息是 otter 发出、且发言石（talking_stone）传递给另一个 otter 时，系统将状态判为 `awaiting_user`，而非预期的 `processing`。

**影响**：多獭协作场景下，对话列表会错误地显示对话"等待用户"，而实际上有 otter 正在处理中。

## 根因分析

SQL CASE 逻辑优先级：
1. 存在 streaming/speaking 消息 → `processing` ✅
2. 对话 active 且有消息 → `awaiting_user` ❌（覆盖了 otter→otter 场景）

遗漏了"otter 发言完毕、发言石传给另一个 otter"的情况——此时既无 streaming/speaking 消息，也不应该判为 awaiting_user。

## 修复方案

在 CASE 逻辑的第 1 条和第 2 条之间插入新条件：

```sql
WHEN EXISTS (
  SELECT 1 FROM messages m2
  WHERE m2.conversation_id = c.id
    AND m2.sender_type = 'otter'
    AND m2.talking_stone_passed_to IS NOT NULL
    AND m2.talking_stone_passed_to != '[]'
    AND m2.talking_stone_passed_to NOT LIKE '%user%'  -- 用户在目标列表中时应为 awaiting_user
    AND m2.talking_stone_passed_to LIKE '%otter%'
    AND m2.id = (
      SELECT id FROM messages WHERE conversation_id = c.id
      ORDER BY sequence_num DESC LIMIT 1
    )
) THEN 'processing'
```

判断逻辑：
1. 最后一条消息的 `sender_type` 是 `otter`
2. `talking_stone_passed_to` 非空且包含 `otter`（即传给其他 otter，不是传回 user）
3. 同时满足 → 状态为 `processing`

## 变更文件

- `src/frameworks/db/conversation/sqlite-conversation-repository.ts` — SQL CASE 增加 otter→otter 发言石条件
- `tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts` — 新增 1 个测试用例 + 修正 3 个已有用例的 talkingStonePassedTo 显式化

## 测试

- 全部 48 个 conversation repository 测试通过
- 新增测试：`active 对话 + otter 消息发言石传给其他 otter → processing（非 awaiting_user）`
- 修正测试：3 个已有用例显式传入 `talkingStonePassedTo: ["user"]`，避免默认值干扰

## 关联

- Issue: #171
- PR: #328
