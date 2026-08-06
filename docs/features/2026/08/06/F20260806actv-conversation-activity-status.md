---
id: F20260806actv
title: conversation-activity-status
doc_type: feature

summary: |
  对话列表新增实时活动状态指示器：从 messages 表派生 processing/awaiting_user/idle，
  5 秒轮询 + Page Visibility API 控制，mergeConversations 合并策略。
  无新列、无迁移，SQL CASE 子查询实现。

causal_links:
  from:
    - F20260713c7p2   # 对话领域模型（conversations/messages 表结构）
    - F20260802hybrid  # 混合架构（MPA/SPA 决定了轮询而非全局 SSE）
  to: []

status: development
change_type: feature
tags: [conversation, ux, polling, sql]
modules:
  - api-contract/api/conversation.ts
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
  - src/usecases/conversation/conversation-repository.ts
  - src/usecases/conversation/manage-conversation.ts
  - src/interface-adapters/http/controllers/conversation-controller.ts
  - src/interface-adapters/http/dto/conversation-dto.ts
  - web/src/hooks/use-conversation-list-polling.ts
  - web/src/lib/merge-conversations.ts
  - web/src/lib/mappers.ts
  - web/src/pages/conversation-list/index.tsx
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/LeftPanel.tsx
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260806actv: 对话列表实时活动状态

## 需求

左侧面板对话列表清晰展示海獭是否在说话/处理中，还是等待用户介入。

## 方案

**派生活动状态（无新列、无迁移）**：`listConversationsWithMeta()` SQL 新增 CASE 子查询，从 messages 表状态推导：

| 状态 | 推导逻辑 | UI |
|------|---------|-----|
| `processing` | 存在 streaming/speaking 消息 | 脉动青绿点 |
| `awaiting_user` | active + 无进行中消息 + 至少一条消息 | 琥珀点 |
| `idle` | completed/archived 或无消息 | 无指示器 |

**前端更新机制**：5 秒轮询 `listConversations()`，Page Visibility API 控制（页面不可见时暂停）；合并时保留本地未读数。

## SQL 派生逻辑

```sql
CASE
  WHEN EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id AND status IN ('streaming', 'speaking'))
    THEN 'processing'
  WHEN c.status = 'active' AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)
    THEN 'awaiting_user'
  ELSE 'idle'
END AS activity_status
```

CASE 顺序保证：`processing` 优先于 `awaiting_user`，即使同时满足条件。

## 前端合并策略

`mergeConversations(prev, next)`：
- 以服务端列表为准（新增/归档/排序/实时字段）
- `unreadCount` 服务端权威，本地值仅在字段缺失时兜底（`??` 运算符区分 `0` 与 `undefined`）

## 设计决策

| 决策 | 理由 |
|------|------|
| 轮询而非 SSE | SSE 是对话级连接，列表页无 SSE 通道；轮询是渐进策略，升级到实时需 ~150 行改动 |
| 派生字段而非持久化列 | 避免双重真相源；与 unreadCount/lastMessagePreview 同属派生字段 |
| 可选字段（向后兼容） | 旧客户端忽略未知字段，无需 API 版本号 |
| 归档后整页跳转 | 避免轮询合并移除对话导致 activeConv 为 null、RightPanel 串台 |

## 已知限制

1. **awaiting_user 语义窗口**：用户发消息后、otter message.start 写入前，状态短暂显示 awaiting_user（实际 otter 正在思考）。窗口亚秒级，下一次轮询纠正。
2. **5 秒延迟**：SSE 消息事件实时到达，但侧边栏活动指示器最多 5 秒后更新。V1 验收标准为 <=5s。
3. **无错误退避**：轮询失败时直接重试（5 秒后），与 useScheduledTasks 一致。持续服务器故障时每 5 秒一次请求。

## 对抗审视记录

### 第 1 轮：SQL 派生逻辑（检视 Agent #1）

Q1-Q6 全部通过。EXISTS 布尔语义适合列表场景；reconcileOrphans 兜底崩溃孤儿；archived 被 WHERE 过滤不可达。建议补充 failed/aborted 终态测试——已补充。

### 第 2 轮：前端状态同步（检视 Agent #2）

有效发现：
- 归档 toast 通过 URL 参数传递，`replaceState` 清理防刷新重复——已修复
- In-flight polling 无退避——pre-existing 问题，不在本 PR 范围

### 第 3 轮：整体架构（检视 Agent #3）

- 轮询间隔建议可配置化——当前规模无需
- messages 表 `(conversation_id, status)` 复合索引不存在——当前数据量 `idx_messages_conversation_id` 够用，索引变更是 schema 改动不混入本 PR
- 升级到实时指示器需 ~150-200 行改动，当前架构分层提供良好接缝

## 测试

- 后端：8 个行为测试覆盖派生逻辑（streaming/speaking → processing、completed → awaiting_user、failed → awaiting_user、aborted → awaiting_user、无消息 → idle、completed 对话 → idle、多对话独立派生）
- API：1 个边界测试覆盖 activityStatus HTTP 透传
- 前端：8 个合并策略测试（服务端权威、markRead 清零、字段缺失兜底、unreadCount:0 语义、新增/移除对话、排序保持）
- 全量 968 测试通过、ESLint 通过
