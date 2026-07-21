---
id: F20260713c7p2
title: domain-conversation
doc_type: feature

# 记忆索引
summary: |
  > 以下章节在需求收敛与设计阶段（代码前）完成并锁定。 > 本文档设计 domain/conversation 模块。这是 S3-A8 步骤 ⑥ 的实现，是系统核心域模块 -- 管理对话生命周期、消息 append-only 存储、对话树结构和对话关键信息。依赖仅 infra/db，模块自包含...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260709p4q7
    - F20260709m2n8
    - F20260710b3m9
    - F20260713i5k2
    - F20260713m5q3


# 元数据
status: locked
change_type: feature
tags: [implementation, s4, domain, conversation, message, tree, key-info]
modules: [domain/conversation]

# 时间
created_at: 2026-07-13
---


# F20260713c7p2 [domain/conversation] 对话领域模块

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。
>
> 本文档设计 domain/conversation 模块。这是 S3-A8 步骤 ⑥ 的实现，是系统核心域模块 -- 管理对话生命周期、消息 append-only 存储、对话树结构和对话关键信息。依赖仅 infra/db，模块自包含。

## 背景 [required]

S3-A8 定义 domain/conversation 为"对话 + 消息 + 对话树 + 关键信息（自包含，仅依赖 infra/db）"。本模块实现 ConversationPort 公开接口 + Repository 持久化 + Adapter 业务逻辑。

S3 数据模型已定义全部表结构（conversations, messages, conversation_otters, linked_resources, key_facts），infra/db/schema.ts 已实现 DDL 初始化。本模块实现对话领域全部业务逻辑。

跨模块事务（sendMessage + memory 索引、addKeyFact + memory 索引等）由 app/orchestration 编排，本模块仅负责自身数据写入。

### 约束输入

- S3-A1 DDL -- conversations + messages + conversation_otters + linked_resources + key_facts 表结构
- S3-A2 ConversationRepository 接口 -- create, getById, update, complete, archive, getTree, createChild, getChildren, sendMessage, getMessages, getMessageById, expandMessage, addKeyInfo, getKeyInfo, addKeyFact, linkResource, getLinkedResources
- S3-A2 事务边界 -- 创建对话（单模块事务）、创建子对话（单模块事务）、发送消息（跨模块，app/orchestration 编排）
- S3-A4 消息存储设计 -- append-only（INSERT only, 无 UPDATE/DELETE），sequence_num per-conversation 自增
- S3-A8 ConversationPort 接口 -- 14 方法
- S3-A8 代码目录结构 -- model.ts + port.ts + _internal/{repository, mapper, adapter, initor}
- S2-A3 领域模型 -- Conversation 聚合根（Conversation, Message, KeyInfo, LinkedResource, KeyFact）
- S2-A5 UC7 序列图 -- createChild + navigateTo + updateWeights
- S2-A6 状态机 -- Active -> Completed -> Archived, Archived -> Active（重新激活）
- S2-A8 ConversationService 接口 -- 9 方法
- D25: tree_path 物化路径格式 `/root_id/.../self_id/`
- D29: 全局 4 层 + Provider Port + _internal/ 封装
- F20260710b3m9: infra/base 已完成（db, config, logger）
- F20260713m5q3: domain/memory 已完成（MemoryPort）

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| 模块结构 | model.ts + port.ts + _internal/{repository, mapper, adapter, initor} | S3-A8 D29 |
| ConversationPort 范围 | 13 方法（S3-A8 的 14 方法移除 navigateTo） | 本文档分析 |
| navigateTo 不在 ConversationPort | 纯运行时状态管理，无持久化操作 | S3-A2 委托路径 + D-Mem-1 |
| createChild 复制父对话 otterIds | 子对话继承父对话的 otter 参与者 | 本文档分析 |
| sendMessage 返回 Message | S3-A8 已改进 S2 的 void 返回 | S3-A8 |
| addKeyFact/linkResource 仅写自身表 | memory 索引由 app/orchestration 编排 | S3-A2 事务边界 |
| tree_path 计算 | root: `/${id}/`，child: `${parent.treePath}${id}/` | D25 |
| sequence_num 计算 | MAX(sequence_num) + 1 per conversation | S3-A4 |
| complete/archive 状态校验 | complete 在 status != 'active' 时 throw；archive 在 status != 'completed' 时 throw | S2-A6 状态机，架构师-2 R1 |
| complete/archive 更新 updated_at | SQL 同时更新 updated_at = datetime('now') | 架构师-2 R2 |
| createChild 独立事务 | 单事务内完成读 parent + 读 otterIds + INSERT child + INSERT conversation_otters + UPDATE parent.updated_at | S3-A2 事务边界，架构师-2 G1/A1 |
| getMessages 默认 limit | 无 limit 参数时默认返回最近 50 条 | 架构师-2 G3 |
| expandMessage both 排序 | 合并后按 sequence_num ASC 排序（时间线顺序） | 架构师-2 G2 |
| sendMessage 返回值 | INSERT 后从 DB 读取实际行，而非自行生成时间戳 | 架构师-2 F1，与 otter 模块一致 |
| 测试位置 | tests/domain/conversation/ 统一目录 | F20260710b3m9 用户确认 |

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前讨论 msg#4676 | 你继续来实现，最新pr完成了infra和otter domain的实现，你继续S3-A8的后续模块实现 | 动作：继续实现；范围：S3-A8 后续模块 | 按依赖顺序继续实现，domain/conversation 是下一个 |
| UA-2 | F20260710b3m9 UA-S4-2（引用） | 应该是一个一个模块完整实现，不需要一次性将所有模块都实现 | 粒度：一个一个模块；要求：完整实现 | domain/conversation 需完整实现含对话树 + 消息 + 关键信息 + 测试 |
| UA-3 | S1 讨论（引用） | 这种结构 要在记忆中也要有所侧重，ai知道当前本对话在某一个节点 | 影响：记忆侧重；感知：知道位置 | 对话树 tree_path 必须正确存储，供 MemoryPort 计算 task_relevance |
| UA-4 | S1 讨论（引用） | 除了自身当前session这部分是各个ai专有的，其余的 所有信息，可能都是通用的、大家都可触及到的 | 专有：当前 session；通用：其余所有 | 消息存储为共享数据，通过 memory_entries 索引（跨模块编排） |
| UA-5 | S2 讨论（引用） | 我要的是一个强大的记忆系统 | 程度：强大；对象：记忆系统 | 对话消息是记忆系统的数据源，append-only 存储 + sequence_num 保证完整性 |
| UA-6 | 当前讨论 | 你继续实现后端，当前已实现了 记忆系统，你看下历史特性文档，看下一个要实现，按照S3文档来做 | 动作：继续实现；条件：记忆系统已实现；要求：按 S3 文档 | domain/conversation 是 S3-A8 顺序中 memory 之后的下一个模块 |

## 目标 [required]

### P1 - domain/conversation 模块完整实现

实现 domain/conversation 模块，包含：
- 领域模型定义（Conversation, Message, KeyFact, LinkedResource, KeyInfo, ConversationTreeNode 及相关值对象）
- ConversationPort 公开接口（13 方法）
- SQLite 持久化（Repository：对话 CRUD + 消息 append-only + 对话树 + 关键信息）
- 业务逻辑适配器（Adapter：tree_path 计算、sequence_num 管理、状态转换）
- 工厂函数（Initor：注入 db，返回 port）

### P2 - 可独立验证

通过集成测试验证：
- 对话 CRUD 全流程（create -> getById -> complete -> archive）
- 对话树全流程（create -> createChild -> getTree）
- 消息 append-only 全流程（sendMessage -> getMessages -> expandMessage）
- 关键信息全流程（addKeyFact -> getKeyInfo, linkResource -> getLinkedResources）
- tree_path 物化路径正确性
- sequence_num per-conversation 自增正确性
- conversation_otters 关联正确性

## 非目标 [required]

- 不实现 navigateTo（运行时状态管理，属 app/agent-runtime）
- 不实现 sendMessage 的 memory 索引（跨模块，属 app/orchestration）
- 不实现 addKeyFact 的 memory 索引（跨模块，属 app/orchestration）
- 不实现 linkResource 的 external_resources 注册 + memory 索引（跨模块，属 app/orchestration）
- 不实现对话归档时的 memory layer 变更（跨模块，属 app/orchestration）
- 不实现 app/orchestration 跨模块事务编排（步骤 ⑨）
- 不实现 app/agent-runtime Agent 工具注册（步骤 ⑩）
- 不实现前端 UI
- 不修改 infra 已有代码
- 不修改 S3 已锁定的 DDL
- 不实现对话重新激活（Archived -> Active），S2 状态机允许但 MVP 不需要

## 设计 [required]

### 模块范围

```
src/domain/conversation/
├── model.ts                 # 公开类型（Entity, Value Object, Input types）
├── port.ts                  # 公开接口（ConversationPort）
└── _internal/               # 私有实现（ESLint 禁止跨模块 import）
    ├── repository.ts        # SQLite 持久化
    ├── mapper.ts            # 领域对象 <-> DB 行映射
    ├── adapter.ts           # 业务逻辑（实现 ConversationPort）
    └── initor.ts            # 工厂函数

tests/domain/conversation/
├── repository.test.ts       # 集成测试（real SQLite :memory:）
└── adapter.test.ts          # 单元测试（mock repository）
```


### 1. model.ts -- 领域模型

```typescript
// ===== 值对象 =====

type ConversationStatus = 'active' | 'completed' | 'archived';
type SenderType = 'user' | 'otter';

// ===== 实体 =====

interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  parentId: string | null;
  treePath: string;            // 物化路径: /root_id/.../self_id/
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

interface Message {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderId: string;
  content: string;
  attachments: Attachment[] | null;
  sequenceNum: number;
  createdAt: string;
}

interface KeyFact {
  id: string;
  conversationId: string;
  content: string;
  category: string | null;
  userFlagged: boolean;
  createdBy: string;           // 'user' | 'otter'
  otterId: string | null;
  createdAt: string;
}

interface LinkedResource {
  id: string;
  conversationId: string;
  resourceType: string;        // 'pr' | 'worktree' | 'branch' | 'file' | 'url' | ...（开放）
  url: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  linkedBy: string;            // 'user' | 'otter'
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
}

// ===== 组合值对象 =====

interface KeyInfo {
  keyFacts: KeyFact[];
  linkedResources: LinkedResource[];
}

interface ConversationTreeNode {
  conversation: Conversation;
  children: ConversationTreeNode[];
}

// ===== 输入类型 =====

interface MessageInput {
  senderType: SenderType;
  senderId: string;
  content: string;
  attachments?: Attachment[];
}

interface KeyFactInput {
  content: string;
  category?: string;
  createdBy: string;
  otterId?: string;
}

interface LinkedResourceInput {
  resourceType: string;
  url: string;
  title?: string;
  metadata?: Record<string, unknown>;
  linkedBy: string;
  otterId?: string;
}

interface Attachment {
  type: string;
  url: string;
  name?: string;
}
```


### 2. port.ts -- ConversationPort 接口

```typescript
interface ConversationPort {
  // --- Conversation CRUD ---

  /** 创建对话（root 或 child）。otterIds 写入 conversation_otters */
  create(params: { title: string; parentId?: string; otterIds: string[] }): Promise<Conversation>;

  /** 按 ID 查询对话 */
  getById(id: string): Promise<Conversation | null>;

  /** 完成对话（status: active -> completed） */
  complete(id: string): Promise<void>;

  /** 归档对话（status: completed -> archived） */
  archive(id: string): Promise<void>;

  // --- Tree ---

  /** 获取对话树（从 root 递归构建） */
  getTree(rootId: string): Promise<ConversationTreeNode>;

  /** 创建子对话。继承父对话的 otterIds */
  createChild(parentId: string, title: string): Promise<Conversation>;

  // --- Messages (append-only) ---

  /** 发送消息（INSERT only）。返回含 ID/sequenceNum/timestamp 的 Message */
  sendMessage(conversationId: string, message: MessageInput): Promise<Message>;

  /** 获取消息列表（分页，按 sequence_num 倒序，默认 limit=50） */
  getMessages(conversationId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;

  /** 获取消息上下文（前/后/双向） */
  expandMessage(messageId: string, direction: 'before' | 'after' | 'both', count: number): Promise<Message[]>;

  // --- Key Info ---

  /** 添加关键事实。仅写 key_facts 表，memory 索引由 app/orchestration 编排 */
  addKeyFact(conversationId: string, fact: KeyFactInput): Promise<KeyFact>;

  /** 链接资源。仅写 linked_resources 表，external_resources + memory 索引由 app/orchestration 编排 */
  linkResource(conversationId: string, resource: LinkedResourceInput): Promise<LinkedResource>;

  /** 获取对话关键信息（KeyFacts + LinkedResources） */
  getKeyInfo(conversationId: string): Promise<KeyInfo>;

  /** 获取对话链接资源列表 */
  getLinkedResources(conversationId: string): Promise<LinkedResource[]>;
}
```

**方法行为说明**：

| 方法 | 数据库操作 | 说明 |
|------|-----------|------|
| create() | INSERT conversations + INSERT conversation_otters（单事务） | root: treePath=`/${id}/`；child: treePath=`${parent.treePath}${id}/` |
| getById() | SELECT conversations | 纯数据查询 |
| complete() | SELECT conversations WHERE id=? (校验 status='active') -> UPDATE conversations SET status='completed', completed_at=now, updated_at=now | 状态转换：active -> completed。status != 'active' 时 throw |
| archive() | SELECT conversations WHERE id=? (校验 status='completed') -> UPDATE conversations SET status='archived', archived_at=now, updated_at=now | 状态转换：completed -> archived。status != 'completed' 时 throw |
| getTree() | SELECT conversations WHERE tree_path LIKE `${root.treePath}%` | 递归构建树结构 |
| createChild() | 单事务：SELECT parent -> SELECT otterIds -> INSERT child -> INSERT conversation_otters -> UPDATE parent.updated_at | treePath 继承父路径，otterIds 从父复制 |
| sendMessage() | INSERT messages（sequence_num = MAX+1）-> SELECT messages WHERE id=? | append-only，无 UPDATE/DELETE。返回值从 DB 读取 |
| getMessages() | SELECT messages WHERE conversation_id=? [AND sequence_num < ?] ORDER BY sequence_num DESC LIMIT ? | 分页查询，无 limit 时默认 50 |
| expandMessage() | before: sequence_num < ? ORDER BY DESC LIMIT ?; after: sequence_num > ? ORDER BY ASC LIMIT ?; both: 合并后按 sequence_num ASC 排序 | 上下文展开 |
| addKeyFact() | INSERT key_facts | 仅写 key_facts，memory 索引跨模块 |
| linkResource() | INSERT linked_resources | 仅写 linked_resources，external + memory 跨模块 |
| getKeyInfo() | SELECT key_facts + SELECT linked_resources | 返回 KeyInfo 组合 |
| getLinkedResources() | SELECT linked_resources WHERE conversation_id=? | 纯数据查询 |

**不在 ConversationPort 中的方法及原因**：

| S3-A8 方法 | 不纳入原因 | 实现位置 |
|-----------|----------|---------|
| navigateTo(conversationId) | S3-A2 明确"不涉及持久化"，D-Mem-1 已将 updateWeights 移出 MemoryPort | app/agent-runtime（维护 currentTreePath 状态，传给 MemoryPort.search） |

**S2 ConversationService 方法委托路径**：

| S2 方法 | 委托路径 | 说明 |
|---------|---------|------|
| createConversation({title, parentId, otterIds}) | ConversationPort.create({title, parentId, otterIds}) | 直接映射 |
| sendMessage(conversationId, message) | app/orchestration: ConversationPort.sendMessage + MemoryPort.store | 跨模块编排 |
| getConversation(id) | ConversationPort.getById(id) | 直接映射 |
| getMessages(conversationId, limit, before) | ConversationPort.getMessages(conversationId, {limit, before}) | 直接映射 |
| getTree(rootId) | ConversationPort.getTree(rootId) | 直接映射 |
| createChild(parentId, title) | ConversationPort.createChild(parentId, title) | 直接映射 |
| navigateTo(conversationId) | app/agent-runtime 运行时状态 | 不涉及持久化 |
| completeConversation(id) | ConversationPort.complete(id) | 直接映射 |
| archiveConversation(id) | ConversationPort.archive(id) | 直接映射 |


### 3. _internal/repository.ts -- SQLite 持久化

```typescript
class ConversationRepository {
  constructor(private db: Database.Database) {}

  // --- Conversation CRUD ---
  create(id: string, params: { title: string; parentId: string | null; treePath: string; otterIds: string[] }): void;
  getById(id: string): Conversation | null;
  updateStatus(id: string, status: ConversationStatus): void;  // complete/archive 复用
  getChildren(parentId: string): Conversation[];

  // --- Tree ---
  getByTreePathPrefix(prefix: string): Conversation[];  // LIKE '${prefix}%'

  // --- Messages ---
  sendMessage(id: string, conversationId: string, message: MessageInput, sequenceNum: number): Message;
  getMessages(conversationId: string, opts?: { limit?: number; before?: string }): Message[];
  getMessageById(id: string): Message | null;
  getMaxSequenceNum(conversationId: string): number;

  // --- Key Info ---
  addKeyFact(id: string, conversationId: string, fact: KeyFactInput): KeyFact;
  linkResource(id: string, conversationId: string, resource: LinkedResourceInput): LinkedResource;
  getKeyFacts(conversationId: string): KeyFact[];
  getLinkedResources(conversationId: string): LinkedResource[];

  // --- Otter Association ---
  getOtterIds(conversationId: string): string[];
}
```

**create 事务边界**：

```typescript
create(id: string, params: { title: string; parentId: string | null; treePath: string; otterIds: string[] }): void {
  this.db.exec("BEGIN");
  try {
    // 1. INSERT conversations
    this.db.prepare(`
      INSERT INTO conversations (id, title, status, parent_id, tree_path)
      VALUES (?, ?, 'active', ?, ?)
    `).run(id, params.title, params.parentId, params.treePath);

    // 2. INSERT conversation_otters
    const stmt = this.db.prepare(`
      INSERT INTO conversation_otters (conversation_id, otter_id) VALUES (?, ?)
    `);
    for (const otterId of params.otterIds) {
      stmt.run(id, otterId);
    }

    this.db.exec("COMMIT");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

**createChild 事务边界（独立事务，不复用 create）**：

```typescript
// createChild 在单事务内完成所有操作（S3-A2 事务边界 + 架构师-2 G1/A1）
createChild(parentId: string, childId: string, title: string): Conversation {
  this.db.exec("BEGIN");
  try {
    // 1. 读 parent
    const parent = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(parentId);
    if (!parent) throw new Error(`Parent conversation ${parentId} not found`);

    // 2. 读 otterIds
    const otterRows = this.db.prepare(
      "SELECT otter_id FROM conversation_otters WHERE conversation_id = ?"
    ).all(parentId);
    const otterIds = otterRows.map(r => r.otter_id);

    // 3. 计算 treePath
    const treePath = `${parent.tree_path}${childId}/`;

    // 4. INSERT child conversation
    this.db.prepare(`
      INSERT INTO conversations (id, title, status, parent_id, tree_path)
      VALUES (?, ?, 'active', ?, ?)
    `).run(childId, title, parentId, treePath);

    // 5. INSERT conversation_otters（复制父 otterIds）
    const stmt = this.db.prepare(
      "INSERT INTO conversation_otters (conversation_id, otter_id) VALUES (?, ?)"
    );
    for (const otterId of otterIds) {
      stmt.run(childId, otterId);
    }

    // 6. UPDATE parent.updated_at
    this.db.prepare(
      "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
    ).run(parentId);

    this.db.exec("COMMIT");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }

  return this.getById(childId)!;
}
```

> create 保持不变（用于 root 创建，无 parent 需要读/更新）。createChild 使用独立事务，因为需要在单事务内完成读 parent + 读 otterIds + INSERT child + INSERT conversation_otters + UPDATE parent.updated_at（S3-A2 事务边界）。

**sendMessage 实现（INSERT 后从 DB 读取，架构师-2 F1）**：

```typescript
sendMessage(id: string, conversationId: string, message: MessageInput, sequenceNum: number): Message {
  this.db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, attachments, sequence_num)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, message.senderType, message.senderId,
    message.content,
    message.attachments ? JSON.stringify(message.attachments) : null,
    sequenceNum
  );

  // 从 DB 读取实际行，确保 createdAt 与 DB 一致（与 otter 模块 createOtter 实践一致）
  return this.getMessageById(id)!;
}
```

**getMessages 分页查询**：

```sql
-- before 指定时的分页查询
SELECT * FROM messages
WHERE conversation_id = ?
  AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)
ORDER BY sequence_num DESC
LIMIT ?;

-- 无 before 时的初始查询
SELECT * FROM messages
WHERE conversation_id = ?
ORDER BY sequence_num DESC
LIMIT ?;
```

**expandMessage 查询**：

```sql
-- before: 获取指定消息之前的 N 条
SELECT * FROM messages
WHERE conversation_id = ?
  AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)
ORDER BY sequence_num DESC
LIMIT ?;

-- after: 获取指定消息之后的 N 条
SELECT * FROM messages
WHERE conversation_id = ?
  AND sequence_num > (SELECT sequence_num FROM messages WHERE id = ?)
ORDER BY sequence_num ASC
LIMIT ?;

-- both: 先查 before，再查 after，合并后按 sequence_num ASC 排序（时间线顺序，架构师-2 G2）
-- before 和 after 分别查询后，合并结果集并按 sequence_num ASC 重新排序
```

**getByTreePathPrefix 查询（getTree 实现）**：

```sql
-- 获取对话树全部节点
SELECT * FROM conversations
WHERE tree_path LIKE ?;  -- 参数: `${root.treePath}%`
```

> getTree 先 getById(rootId) 获取根节点 treePath，然后 LIKE 查询所有子节点，在内存中递归构建树结构。


### 4. _internal/adapter.ts -- 业务逻辑

**关键逻辑**：

| 逻辑 | 实现 |
|------|------|
| create | 1. crypto.randomUUID() 生成 ID 2. 计算 treePath: root=`/${id}/`，child=`${parent.treePath}${id}/` 3. 事务写入 conversations + conversation_otters |
| createChild | 1. crypto.randomUUID() 生成 ID 2. repository.createChild(parentId, id, title) -- 独立事务含读 parent + 读 otterIds + INSERT child + INSERT conversation_otters + UPDATE parent.updated_at |
| complete | 1. getById 校验 status='active'，不匹配 throw 2. UPDATE status='completed', completed_at=now, updated_at=now |
| archive | 1. getById 校验 status='completed'，不匹配 throw 2. UPDATE status='archived', archived_at=now, updated_at=now |
| sendMessage | 1. crypto.randomUUID() 生成 ID 2. getMaxSequenceNum + 1 3. INSERT messages 4. 从 DB 读取实际行返回 |
| getMessages | 分页查询，按 sequence_num 倒序，无 limit 时默认 50 |
| expandMessage | before/after/both 查询，both 合并后按 sequence_num ASC 排序 |
| addKeyFact | 1. crypto.randomUUID() 生成 ID 2. INSERT key_facts |
| linkResource | 1. crypto.randomUUID() 生成 ID 2. INSERT linked_resources |
| getKeyInfo | 查询 key_facts + linked_resources，组合返回 |
| getTree | 1. 获取 root 2. LIKE 查询所有子节点 3. 内存递归构建树 |

**依赖注入**：

```typescript
// initor.ts 伪代码
function initConversation({ db }: { db: Database.Database }): ConversationPort {
  const repository = new ConversationRepository(db);
  const adapter = new ConversationAdapter(repository);
  return adapter;
}
```


### 5. _internal/mapper.ts -- 映射规则

| DB 列 | 领域字段 | 转换 |
|-------|---------|------|
| id | Conversation.id / Message.id / KeyFact.id / LinkedResource.id | 直接映射 |
| title | Conversation.title | 直接映射 |
| status | Conversation.status | 直接映射（TEXT -> union type） |
| parent_id | Conversation.parentId | 直接映射（NULL -> null） |
| tree_path | Conversation.treePath | 直接映射 |
| summary | Conversation.summary | 直接映射（NULL -> null） |
| created_at | Conversation.createdAt / Message.createdAt / KeyFact.createdAt / LinkedResource.createdAt | snake_case -> camelCase |
| updated_at | Conversation.updatedAt | snake_case -> camelCase |
| completed_at | Conversation.completedAt | 直接映射（NULL -> null） |
| archived_at | Conversation.archivedAt | 直接映射（NULL -> null） |
| conversation_id | Message.conversationId / KeyFact.conversationId / LinkedResource.conversationId | snake_case -> camelCase |
| sender_type | Message.senderType | snake_case -> camelCase |
| sender_id | Message.senderId | snake_case -> camelCase |
| content | Message.content / KeyFact.content | 直接映射 |
| attachments | Message.attachments | JSON.parse / JSON.stringify（TEXT <-> Attachment[]，NULL -> null） |
| sequence_num | Message.sequenceNum | snake_case -> camelCase |
| resource_type | LinkedResource.resourceType | snake_case -> camelCase |
| url | LinkedResource.url | 直接映射 |
| metadata | LinkedResource.metadata | JSON.parse / JSON.stringify（TEXT <-> Record，NULL -> null） |
| linked_by | LinkedResource.linkedBy | snake_case -> camelCase |
| otter_id | LinkedResource.otterId / KeyFact.otterId | snake_case -> camelCase（NULL -> null） |
| auto_linked | LinkedResource.autoLinked | INTEGER 0/1 <-> boolean |
| category | KeyFact.category | 直接映射（NULL -> null） |
| user_flagged | KeyFact.userFlagged | INTEGER 0/1 <-> boolean |
| created_by | KeyFact.createdBy | snake_case -> camelCase |


### 6. main.ts 装配（更新后）

```typescript
// main.ts 伪代码（更新后）
const db = initDatabase();                          // infra/db ✅
const llm = initLLMGateway();                       // infra/llm-gateway ✅
const { agentRegistry } = initAgentCore({ llm });   // infra/agent-core ✅
const embedding = initEmbedding();                  // infra/embedding ✅

const otterPort = initOtter({ db, agentRegistry }); // domain/otter ✅
const memoryPort = initMemory({ db, embedding });   // domain/memory ✅
const conversationPort = initConversation({ db });  // domain/conversation (NEW)

// 待实现
// const capabilityPort = initCapability({ db });
// const externalPort = initExternal({ db });
```

## 偏差记录 [required]

### D-Conv-1: navigateTo 移出 ConversationPort

**偏差对象**：S3-A8 ConversationPort 接口（14 方法）

| 项目 | S3-A8 设计 | 本文档设计 |
|------|-----------|-----------|
| navigateTo | ConversationPort.navigateTo(conversationId) | 不在 ConversationPort |

**依据**：
1. S3-A2 委托路径明确 navigateTo "不涉及持久化"，是"Service 层运行时状态管理"
2. D-Mem-1 已将 updateWeights 移出 MemoryPort（查询时计算 task_relevance）
3. navigateTo 的唯一作用是维护 currentTreePath 变量，传递给 MemoryPort.search(SearchQuery.treePath)
4. 在 domain 层实现 navigateTo 是空操作，无持久化、无副作用
5. app/agent-runtime 维护 currentTreePath 状态，调用 MemoryPort.search 时传入

**影响**：ConversationPort 从 14 方法减少到 13 方法。navigateTo 的运行时状态管理职责由 app/agent-runtime 承担。

### D-Conv-2: createChild 独立事务 + 继承父对话 otterIds + 更新 parent.updated_at

**偏差对象**：S3-A8 ConversationPort.createChild 接口 + S3-A2 事务边界

| 项目 | S3-A8 设计 | 本文档设计 |
|------|-----------|-----------|
| createChild otterIds | 接口不包含 otterIds 参数 | 内部从父对话复制 otterIds 到 conversation_otters |
| createChild 事务 | 复用 create 事务 | 独立事务（含读 parent + 读 otterIds + INSERT child + INSERT conversation_otters + UPDATE parent.updated_at） |
| parent.updated_at | 未提及 | 更新为 datetime('now') |

**依据**：
1. S3-A8 createChild 不接收 otterIds 参数
2. S2 UC7 中子对话由大獭创建，大獭应参与子对话
3. conversation_otters 表需要显式关联，不支持隐式继承
4. 复制父 otterIds 是最简方案，避免查询时递归查找父链
5. S3-A2 事务边界明确要求"创建子对话"包含 `conversations UPDATE (parent updated_at)`
6. 读操作（getById, getOtterIds）在 create 事务外执行会破坏原子性，需独立事务

**影响**：createChild 使用独立事务（不复用 create），在单事务内完成全部操作。create 保持不变（用于 root 创建）。

## 硬约束 [required]

- 所有表使用 `CREATE TABLE IF NOT EXISTS`，禁止 ALTER TABLE
- 消息存储为 append-only，禁止 UPDATE 和 DELETE（S3-A4 硬约束）
- create + conversation_otters 写入必须在单事务内（S3-A2 事务边界）
- createChild + conversation_otters 写入必须在单事务内
- tree_path 物化路径格式为 `/root_id/.../self_id/`，以 `/` 开头和结尾（D25）
- sequence_num per-conversation 自增，不跨对话
- domain 模块间不互相依赖，跨模块操作在 app/orchestration 编排（D29）
- ConversationPort 是 domain/conversation 唯一的公开接口
- ESLint 禁止跨模块 import `_internal/`（main.ts 豁免）
- addKeyFact/linkResource 仅写自身表，memory 索引由 app/orchestration 编排
- 对话状态转换遵循 S2 状态机：active -> completed -> archived
- complete 在 status != 'active' 时 throw（状态校验，架构师-2 R1）
- archive 在 status != 'completed' 时 throw（状态校验，架构师-2 R1）
- complete/archive 必须同时更新 updated_at（架构师-2 R2）
- createChild 必须在单事务内更新 parent.updated_at（S3-A2 事务边界，架构师-2 G1）

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| navigateTo 不在 Port | app/agent-runtime 维护状态 | ConversationPort 空操作方法 | domain 层方法应有持久化语义，空操作违背职责 |
| createChild 复制 otterIds | 从父对话复制 conversation_otters | 不创建 otterIds / 查询时递归 | 子对话参与者与父对话一致，复制避免查询复杂度 |
| getTree 用 LIKE 查询 | tree_path LIKE '${prefix}%' | 递归 CTE 查询 parent_id | 物化路径前缀匹配更高效，D25 已决定 |
| expandMessage 基于 sequence_num | sequence_num </> 比较 | 基于 created_at 时间戳 | sequence_num 保证 per-conversation 唯一有序 |
| sendMessage 不触发 memory | 仅写 messages 表 | 内部调用 MemoryPort.store | D29: domain 模块间不互相依赖 |
| 不实现 reactivate | MVP 不需要 Archived -> Active | 实现 reactivate 方法 | S2 状态机允许但 S3-A8 未定义 |
| complete/archive 不自动级联 | 仅更新当前对话 | 级联完成/归档子对话 | S2 明确"子对话不自动标记父对话完成" |
| complete/archive 状态校验 | 非法状态 throw | 静默覆盖 | S2-A6 状态机不可逆，非法转换是 bug |
| createChild 独立事务 | 单事务含读+写+parent 更新 | 复用 create 事务 | S3-A2 要求 parent.updated_at 更新，需在事务内读 parent |
| sendMessage 从 DB 读取返回值 | getMessageById(id) | 自行构造时间戳 | 与 otter 模块一致，避免 JS/SQLite 时间精度差异 |
| getMessages 默认 limit=50 | 无 limit 时返回 50 条 | 无限制 | 避免长对话返回全部消息 |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/domain/conversation/model.ts` | 新增 | 领域模型类型定义 |
| `src/domain/conversation/port.ts` | 新增 | ConversationPort 接口 |
| `src/domain/conversation/_internal/repository.ts` | 新增 | SQLite 持久化 |
| `src/domain/conversation/_internal/mapper.ts` | 新增 | 领域对象映射 |
| `src/domain/conversation/_internal/adapter.ts` | 新增 | 业务逻辑 |
| `src/domain/conversation/_internal/initor.ts` | 新增 | 工厂函数 |
| `tests/domain/conversation/repository.test.ts` | 新增 | 集成测试 |
| `tests/domain/conversation/adapter.test.ts` | 新增 | 单元测试（mock repository） |

## 验证 [required]

### 验收标准

- [ ] `npm run check` 通过（lint + build）
- [ ] `npm run test` 通过
- [ ] create: 创建 root 对话，treePath=`/${id}/`
- [ ] create: 创建含 parentId 的 child 对话，treePath 正确继承
- [ ] create: otterIds 写入 conversation_otters
- [ ] create + getById: 创建后可按 ID 查询
- [ ] complete: status active -> completed, completed_at 非空, updated_at 更新
- [ ] complete: 对非 active 对话调用 complete 抛出异常
- [ ] archive: status completed -> archived, archived_at 非空, updated_at 更新
- [ ] archive: 对非 completed 对话调用 archive 抛出异常
- [ ] createChild: treePath = `${parent.treePath}${childId}/`
- [ ] createChild: 父对话 otterIds 复制到子对话
- [ ] createChild: parent.updated_at 被更新
- [ ] createChild: 全部操作在单事务内（原子性验证）
- [ ] getTree: 返回完整树结构，children 递归嵌套
- [ ] sendMessage: sequence_num per-conversation 自增
- [ ] sendMessage: 返回含 id/sequenceNum/createdAt 的 Message，createdAt 从 DB 读取
- [ ] getMessages: 按 sequence_num 倒序返回
- [ ] getMessages: 无 limit 参数时默认返回 50 条
- [ ] getMessages: before 分页正确
- [ ] expandMessage before: 返回指定消息之前的 N 条
- [ ] expandMessage after: 返回指定消息之后的 N 条
- [ ] expandMessage both: 合并前后结果，按 sequence_num ASC 排序
- [ ] addKeyFact: 写入 key_facts，返回 KeyFact
- [ ] linkResource: 写入 linked_resources，返回 LinkedResource
- [ ] getKeyInfo: 返回 keyFacts + linkedResources 组合
- [ ] getLinkedResources: 返回指定对话的链接资源列表
- [ ] attachments JSON 序列化/反序列化正确
- [ ] metadata JSON 序列化/反序列化正确
- [ ] auto_linked INTEGER 0/1 <-> boolean 正确
- [ ] user_flagged INTEGER 0/1 <-> boolean 正确
- [ ] 外键约束生效（conversation_id 不存在时 INSERT message 抛出异常）
- [ ] ESLint 对 `_internal/` 跨模块 import 报错

### 测试设计

#### tests/domain/conversation/repository.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| create root + getById | treePath=`/${id}/`，可按 ID 查询 |
| create child + getById | treePath 正确继承父路径 |
| create 含 otterIds | conversation_otters 正确写入 |
| complete | status -> 'completed', completed_at 非空, updated_at 更新 |
| complete 非active | 对 completed/archived 对话调用 complete 抛出异常 |
| archive | status -> 'archived', archived_at 非空, updated_at 更新 |
| archive 非completed | 对 active/archived 对话调用 archive 抛出异常 |
| createChild | treePath 正确，otterIds 从父复制，parent.updated_at 更新 |
| createChild 父不存在 | throw Error |
| createChild 事务原子性 | INSERT child 失败时 parent.updated_at 不更新 |
| getChildren | 返回直接子对话 |
| getByTreePathPrefix | 返回所有匹配的对话 |
| sendMessage + getMessages | 消息写入和查询，sequence_num 自增 |
| sendMessage sequence_num 连续 | 多条消息 sequence_num 1, 2, 3... |
| getMessages 分页 | before 参数正确分页 |
| expandMessage before | 返回前 N 条消息 |
| expandMessage after | 返回后 N 条消息 |
| expandMessage both | 合并前后消息，按 sequence_num ASC 排序 |
| getMaxSequenceNum | 返回当前最大 sequence_num |
| sendMessage 返回值 | createdAt 从 DB 读取，与 datetime('now') 一致 |
| addKeyFact + getKeyFacts | 关键事实写入和查询 |
| linkResource + getLinkedResources | 链接资源写入和查询 |
| attachments JSON | 存储 Attachment[]，读取回 Attachment[] |
| metadata JSON | 存储 Record，读取回 Record |
| auto_linked 映射 | INTEGER 0/1 <-> boolean |
| user_flagged 映射 | INTEGER 0/1 <-> boolean |
| 外键约束 | conversation_id 不存在时 INSERT message 抛出异常 |

#### tests/domain/conversation/adapter.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| create root | treePath 计算正确 = `/${id}/` |
| create child | treePath 计算正确 = `${parent.treePath}${id}/` |
| create 生成 UUID | 返回的 Conversation.id 为有效 UUID |
| createChild 复制 otterIds | mock repo，验证 createChild 被调用（含独立事务） |
| createChild 父不存在 | throw Error |
| complete 状态校验 | mock repo.getById 返回 completed，验证 throw |
| complete 正常 | mock repo.getById 返回 active，验证 updateStatus('completed') |
| archive 状态校验 | mock repo.getById 返回 active，验证 throw |
| archive 正常 | mock repo.getById 返回 completed，验证 updateStatus('archived') |
| sendMessage sequence_num | mock repo.getMaxSequenceNum，验证 +1 |
| complete 状态转换 | mock repo，验证 updateStatus('completed') |
| archive 状态转换 | mock repo，验证 updateStatus('archived') |
| getTree 构建 | mock repo，验证树结构递归构建 |
| getKeyInfo 组合 | mock repo，验证 keyFacts + linkedResources 组合返回 |

## 关联 [required]

- **S3 数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **S2 能力模块架构设计**：[F20260709m2n8](../09/F20260709m2n8-capability-module-architecture.md)
- **infra/base 基础设施基础层**：[F20260710b3m9](../10/F20260710b3m9-infra-base-foundation.md)
- **domain/otter 设计**：[F20260713o4t8](./F20260713o4t8-domain-otter.md)
- **domain/memory 设计**：[F20260713m5q3](./F20260713m5q3-domain-memory.md)
- **项目实施计划**：[otter-buddy#5](https://github.com/chenlaicai/otter-buddy/issues/5)

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-Conv-1 | 当创建根对话时 | treePath=`/${id}/`，status='active'，otterIds 写入 conversation_otters | ← UA-2 |
| B-Conv-2 | 当创建子对话时 | treePath 继承父路径，otterIds 从父对话复制，parent.updated_at 更新 | ← UA-3, UA-2 |
| B-Conv-3 | 当发送消息时 | sequence_num per-conversation 自增，INSERT only（不可修改不可删除），返回值从 DB 读取 | ← UA-4, UA-5 |
| B-Conv-4 | 当查询消息列表时 | 按 sequence_num 倒序返回，支持 before 分页，无 limit 时默认 50 条 | 不适用（架构师决策） |
| B-Conv-5 | 当展开消息上下文时 | 基于 sequence_num 返回前/后/双向 N 条消息，both 按 sequence_num ASC 排序 | 不适用（架构师决策） |
| B-Conv-6 | 当添加关键事实时 | 仅写 key_facts 表，memory 索引由 app/orchestration 编排 | ← UA-5 |
| B-Conv-7 | 当链接资源时 | 仅写 linked_resources 表，external_resources + memory 索引由 app/orchestration 编排 | ← UA-5 |
| B-Conv-8 | 当完成对话时 | status active -> completed，completed_at + updated_at 记录时间。非 active 状态 throw | 不适用（S2 状态机） |
| B-Conv-9 | 当归档对话时 | status completed -> archived，archived_at + updated_at 记录时间。非 completed 状态 throw | 不适用（S2 状态机） |
| B-Conv-10 | 当获取对话树时 | 从 root 开始递归构建，children 嵌套结构 | ← UA-3 |
| B-Conv-11 | 当获取关键信息时 | 返回 KeyInfo（KeyFacts + LinkedResources 组合） | 不适用（架构师决策） |
| B-Conv-12 | 当所有子对话完成时 | 父对话不自动标记为完成 | 不适用（S2 决策） |
