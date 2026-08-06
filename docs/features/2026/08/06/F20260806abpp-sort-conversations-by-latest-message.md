---
id: F20260806abpp
title: sort-conversations-by-latest-message
doc_type: feature

# 记忆索引
summary: |
  对话列表排序逻辑从按创建时间改为按最新消息时间：listConversationsWithMeta 的 ORDER BY
  从 c.created_at DESC 改为 COALESCE(lm.created_at, c.created_at) DESC，确保最新
  还在进行中的对话排在最前面，无消息的对话回退到创建时间排序。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260713c7p2   # domain-conversation（对话列表基础实现）

# 元数据
status: development
change_type: feature
tags: [conversation, sorting, ux, list]
modules:
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts

# 时间
created_at: 2026-08-06
---

# F20260806abpp: 对话列表按最新消息时间排序

## 问题现象

对话列表按创建时间（created_at）降序排列，导致最早创建的对话排在最前面，
而最新还在进行中的对话被埋在后面，用户难以快速找到活跃对话。

## 设计决策

### 排序逻辑

1. **置顶对话**始终排在最前面（不变）
2. **非置顶对话**按最新消息时间降序排列
3. **无消息的对话**回退到创建时间排序

### 实现方案选择

**方案 A：更新 conversations.updated_at 字段**
- 在每个消息创建/更新方法中添加 UPDATE conversations SET updated_at = ?
- 需要修改 8+ 处消息生命周期方法（createCompletedMessage, createStreamingMessage, startSpeaking, completeMessage, failMessage, abortMessage, failInFlightMessages 等）
- 容易遗漏，维护成本高

**方案 B：复用已有的 last_message_ts（采用）**
- listConversationsWithMeta 已通过 LEFT JOIN 计算 last_message_ts
- 只需修改 ORDER BY 子句，一处改动覆盖所有场景
- 无消息的对话通过 COALESCE 回退到 created_at

**决策**：采用方案 B，改动最小、风险最低、逻辑最清晰。

## 技术实现

修改 `sqlite-conversation-repository.ts` 的 `listConversationsWithMeta` SQL：

```sql
-- Before
ORDER BY c.pinned DESC, c.created_at DESC

-- After
ORDER BY c.pinned DESC, COALESCE(lm.created_at, c.created_at) DESC
```

### SQL 执行顺序说明

1. LEFT JOIN messages lm 计算最新消息时间
2. WHERE c.status != 'archived' 过滤已归档对话
3. ORDER BY 按置顶状态 + 最新消息时间排序
4. LIMIT/OFFSET 分页

## 影响范围

- **前端**：对话列表展示顺序变化（最新消息的对话排最前）
- **后端**：仅 SQL 查询变更，无业务逻辑改动
- **API**：无变化（返回字段不变）
- **数据库**：无 schema 变更，无需迁移

## 验证

- [x] 所有 957 个测试通过
- [x] ESLint 检查通过
- [x] TypeScript 编译通过
- [x] CI 检查通过（GitHub Actions）

## 关联

- PR：#172
- 变更文件：src/frameworks/db/conversation/sqlite-conversation-repository.ts
