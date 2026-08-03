# F20260803vmsg: 对话消息展示机制

## 概述

完整重建对话消息展示机制，解决进入会话停在顶部、无分页、无未读定位、无搜索等问题。引入 react-virtuoso 虚拟滚动、双向游标分页、消息级未读追踪、FTS5 搜索跳转，支撑成百上千条消息的流畅交互。

## 背景

### 原有问题

1. **进入会话停在顶部**：`MessageList.tsx:167-175` 的 `isNearBottom` 检查在首次加载时 `scrollTop` 恒为 0，条件永远不满足，滚动到底部的代码被跳过
2. **无虚拟滚动**：全量 `.map()` 渲染 + CSS `content-visibility: auto` 估算高度（90px）不可靠，消息多了卡顿
3. **无向上分页**：后端 `before` 游标已实现但前端从未传 `before` 参数，固定拉 100 条，更旧的历史看不到
4. **轮询吞历史**：`mergeMessages`（message-stream.ts:52 注释"窗口外终态可丢弃"）在用户 prepend 历史后会静默丢弃
5. **无新消息提示**：查看历史时新消息静默追加，无"新消息 N 条"浮窗
6. **无未读定位**：后端有 turn 级已读（给 otter agent 用），但 Web 用户无已读追踪
7. **无搜索**：后端 FTS5 已实现但只给 agent 工具用，无 HTTP 端点
8. **permalink 失效**：`getElementById('msg-${id}')` 找不到元素（MessageList 没设 DOM id），`.highlight-message` CSS 未定义

### 需求

一次性建立完整的、长期正确的消息展示机制：进入展示最新、向上拉分页加载历史、查看历史时新消息提示可跳转、未读定位、消息搜索。消息量会成百上千，不考虑浏览器兼容性。

## 架构决策

经三轮独立 agent 对抗审视定稿。

| 决策 | 选择 | 理由 |
|------|------|------|
| 虚拟滚动 | 开源 react-virtuoso | 原生支持 firstItemIndex 前置插入保持滚动位置、followOutput 底部跟随、initialTopMostItemIndex 初始定位、动态高度 AA 树。痛点（流式跟随、prepend）可通过 autoscrollToBottom + computeItemKey 手动解决，不值得引入商业包 |
| 轮询改造 | 增量查询（after 游标） | mergeMessages 会丢弃 prepend 的历史，补丁式改不彻底；增量查询根除问题且与双向分页共用 after 端点 |
| 未读粒度 | 消息级（last_read_message_seq） | turn 级粒度太粗，消息级体验最佳；seq 字段已存在 |
| 用户模型 | 单用户预留多用户 | 新建 conversation_user_read_state 表带 user_id，当前固定 "web-user"，多用户扩展时按 user 隔离 |
| markRead 分层 | 新建 ManageReadState use case | QueryMessage 全是只读方法，放写操作违反 CQRS |
| 会话列表查询 | 一条 SQL JOIN 批量 | N+1 达 200 次查询不可接受，JOIN 降到 1 次 |

## 技术方案

### 后端

复用已有基础设施（FTS5 trigram、before 游标、expandMessage、getMessagesAfter、迁移机制），主要工作是暴露 HTTP 端点 + 新建已读状态表。

**新建 `conversation_user_read_state` 表**（schema.ts）：
```sql
CREATE TABLE conversation_user_read_state (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  last_read_message_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, conversation_id)
);
```

**新增 HTTP 端点**：
- `GET /api/conversations/:id/messages/after?after=&limit=` — after 游标向下分页（复用 getMessagesAfter）
- `GET /api/conversations/:id/messages/search?q=&limit=` — FTS5 搜索（复用 searchMessages）
- `GET /api/conversations/:id/unread` — 未读状态（firstUnread + count）
- `POST /api/conversations/:id/read` — 标记已读（MAX 只前进不后退）
- `GET /api/messages/:id/expand?direction=&count=` — 加载目标消息上下文（复用 expandMessage）

**list 端点响应改为包裹对象**：`{ messages, hasMore }`，`hasMore = messages.length === limit && last.seq > 1`

**会话列表批量查询**：一条 SQL LEFT JOIN conversation_user_read_state + 子查询 last_message + GROUP_CONCAT otter_ids，替代 N+1

**会话列表 DTO 扩展**：增加 unreadCount / lastMessagePreview / lastMessageTs

### 前端

**react-virtuoso 配置**：
- `computeItemKey={(_, item) => item.id}` — prepend/重排时 key 稳定
- `firstItemIndex={100000}` — 虚拟基数，prepend 时递减，足够 2000 页
- `initialTopMostItemIndex` — `{index:'LAST'}`（底部）或未读 index
- `key={conversationId}` — 切换会话强制 remount 重新消费 initialTopMostItemIndex
- `followOutput={(atBottom) => atBottom ? 'smooth' : false}` — 底部跟随
- `startReached` / `endReached` — 双向分页触发
- `rangeChanged` — 视口最大 seq 检测标记已读

**双向分页**：向上 `listMessages(before)` prepend + firstItemIndex 递减；向下 `listMessagesAfter(after)` append

**增量轮询**：`refreshMessages` 改用 `listMessagesAfter(newestId)` 只拉新消息，用 `insertBySeq` 合并，不触碰 prepend 历史

**新消息提示**：`isAtBottomRef`（useRef 镜像避免 SSE handler 闭包陷阱）+ `newMessagesCount`；SSE handler 末尾 `autoscrollToBottom`（followOutput 不触发 in-place 更新）

**未读定位**：进入会话查 `getUnreadState`；未读在窗口内定位 + 分隔线；不在窗口（大量未读）用 `expandMessage` 加载未读附近；`rangeChanged` debounce 500ms 标记已读，清除分隔线 + 更新列表 badge

**搜索跳转**：已加载 `scrollToIndex` + 高亮 2s；未加载 `expandMessage` 替换列表后定位

## 对抗审视修正

三轮独立 agent 审视发现并修正的关键 bug：

1. **followOutput 不触发流式滚动**：in-place 更新（events 累积、状态变化）data.length 不变，followOutput 完全不触发。改用 SSE handler 手动 `autoscrollToBottom`
2. **itemContent index off-by-one**：`messages[index - firstItemIndex]` 取到当前条，修正为 `-1` 取前一条画 turnId 分隔线
3. **Header inline remount**：`components={{ Header: () => ... }}` 每次渲染新建引用导致滚动时 remount，提取到外部用 context prop 传值
4. **firstItemIndex 初始 1000 太小**：只够 19 页 prepend，改为 100000
5. **rangeChanged 全局索引**：startIndex/endIndex 含 firstItemIndex 偏移，需转换；且含 overscan 区域
6. **轮询吞历史**：mergeMessages 丢弃窗口外终态，改增量查询根除
7. **N+1 查询爆炸**：会话列表 50 conv × 4 查询 = 200 次，改 SQL JOIN

## 验证

- 后端 tsc --noEmit 通过
- 前端 tsc --noEmit + vite build 通过
- 全量测试 826 passed（65 files）
- 边界场景：1000+ 条滚动、动态高度（代码块+表格+HtmlCard）、流式状态流转、搜索命中最旧消息、空会话首条消息、连续快速上滚、切换会话重置、标记已读后切回、expand 后双向分页
