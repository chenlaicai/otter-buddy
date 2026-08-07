---
id: F20260807rpcv
title: recruiting-conversation-auto-pin
doc_type: feature

summary: |
  求职助手对话启动时未置顶，导致用户在置顶区看不到该对话。
  根因是 ensureRecruitingConversation 创建对话时 pinned=false 且缺少 pin 调用。
  对齐 Self-Healing 对话的 pin 模式，创建和复用时都调用 manageConversation.pin()。

causal_links:
  from:
    - F20260805rbrg
  to: []

status: development
change_type: fix
tags: [recruiting, conversation, pin]
modules:
  - src/usecases/recruiting/ensure-recruiting-conversation.ts
  - src/bootstrap/platforms.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260807rpcv: 求职助手对话启动时自动置顶

## 根因分析

Self-Healing 对话在 `ensure-healing-conversation.ts` 中有两个 pin 调用点：

1. **创建后**：`createHealingConversation()` 第 38 行调用 `pinHealing(manageConversation, conversation.id, logger)`
2. **复用时**：`tryReuseExisting()` 第 81 行调用 `pinHealing(manageConversation, existingId, logger)`

求职助手对话的 `ensure-recruiting-conversation.ts` 缺少对应的 pin 逻辑：

- `createConversationAndParticipant()` 第 68 行硬编码 `pinned: false`
- `tryReuseExisting()` 和主函数中没有任何 `manageConversation.pin()` 调用
- `ensureRecruitingConversation` 的 deps 类型签名中没有 `manageConversation` 字段

## 修复方案

1. **`ensure-recruiting-conversation.ts`**：
   - 新增 `ManageConversation` 类型导入
   - 新增 `pinRecruiting()` 辅助函数（与 healing 的 `pinHealing` 对齐，失败不中断只记日志）
   - `tryReuseExisting` 签名增加 `manageConversation` + `logger`，复用时调用 pin
   - `ensureRecruitingConversation` deps 增加 `manageConversation`，创建对话后调用 pin

2. **`platforms.ts`**：`ensureRecruitingConversation` 调用处传入 `manageConversation: uc.manageConversation`

3. **测试同步**：两个用例增加 `manageConversation` mock 和 `pin()` 断言

## 验证

```
npx vitest run tests/usecases/recruiting/ensure-recruiting-conversation.test.ts
# 2 passed
npx vitest run
# 961 passed
```
