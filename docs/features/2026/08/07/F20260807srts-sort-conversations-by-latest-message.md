---
id: F20260807srts
title: sort-conversations-by-latest-message
doc_type: feature
change_type: feature
status: development
summary: |
  对话列表排序从 created_at 改为最新消息时间：ORDER BY 子句改为
  COALESCE(lm.created_at, c.created_at) DESC，活跃对话排最前面，
  无消息回退创建时间。
capability_test: "n/a: 纯 SQL 排序改动（A 类），无 LLM 参与行为"

# 记忆索引
# 因果链路（正向依赖）
causal_links:
  from:
    - F20260713c7p2   # domain-conversation（对话列表基础实现）

# 元数据
tags: [conversation, sorting, ux, list]
modules:
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts

# 时间
created_at: 2026-08-07
---

# F20260807srts: 对话列表按最新消息时间排序

## 问题现象

对话列表按创建时间（created_at）降序排列，最早创建的对话排最前面，
最新还在进行中的对话被埋在后面，用户难以快速找到活跃对话。

## 设计决策

### 排序逻辑

1. **置顶对话**始终排在最前面（不变）
2. **非置顶对话**按最新消息时间降序排列
3. **无消息的对话**回退到创建时间排序

### 实现方案选择

**方案 A：更新 conversations.updated_at 字段**
- 在每个消息创建/更新方法中添加 UPDATE conversations SET updated_at = ?
- 需要修改 8+ 处消息生命周期方法
- 容易遗漏，维护成本高

**方案 B：复用已有的 last_message_ts（采用）**
- listConversationsWithMeta 已通过 LEFT JOIN messages lm 计算最新消息时间
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

## 影响范围

- **前端**：对话列表展示顺序变化（最新消息的对话排最前）
- **后端**：仅 SQL 查询变更，无业务逻辑改动
- **API**：无变化（返回字段不变）
- **数据库**：无 schema 变更，无需迁移

## 验证

- [ ] 所有测试通过
- [ ] ESLint 检查通过
- [ ] TypeScript 编译通过

## 关联

- 原 PR：#172（chenlaicai）
- 变更文件：src/frameworks/db/conversation/sqlite-conversation-repository.ts
