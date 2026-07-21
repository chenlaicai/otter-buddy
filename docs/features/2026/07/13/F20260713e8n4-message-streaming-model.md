---
id: F20260713e8n4
title: message-streaming-model
doc_type: feature

# 记忆索引
summary: |
  > 以下章节在需求收敛与设计阶段（代码前）完成并锁定。 > 本文档重设计 domain/conversation 的消息数据模型，参考 Snail Shell 的两层消息模型（流式过程 event + 最终答复 body），替代 F20260713c7p2 中的单层 `content` 模型。...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260709p4q7
    - F20260709m2n8
    - F20260713c7p2
    - F20260713m5q3
    - F20260713i5k2


# 元数据
status: locked
change_type: feature
tags: [implementation, s4, domain, conversation, message, streaming, events, redesign]
modules: [domain/conversation, infra/db]

# 时间
created_at: 2026-07-13
---


# F20260713e8n4 [message-streaming-model] 消息流式模型重设计

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。
>
> 本文档重设计 domain/conversation 的消息数据模型，参考 Snail Shell 的两层消息模型（流式过程 event + 最终答复 body），替代 F20260713c7p2 中的单层 `content` 模型。对话 CRUD、对话树、关键信息等部分不变，沿用 F20260713c7p2。

## 背景 [required]

### 问题

F20260713c7p2 的消息模型为单层设计：`Message.content: string`（NOT NULL），消息创建即完成，无生命周期状态，无流式过程记录。这意味着：

1. Otter 响应的流式过程（text_delta、tool_call、tool_result）完全丢失——SSE 传输后即消失
2. 无法区分"正在生成"和"已完成"的消息
3. 失败的响应无法记录（LLM 中断时消息根本不会被创建）
4. 无法回溯 Agent 的推理过程

### Snail Shell 的设计

Snail Shell 平台自身的消息模型采用两层设计：

| 概念 | Snail Shell 实现 |
|------|-----------------|
| 消息生命周期 | streaming -> set_final_body -> 结束 |
| 流式内容 | 中间分析过程（tool calls、reasoning），设置 final body 后被**折叠**（保留但不作为主要展示） |
| 最终答复 | `set_final_body(text)` —— 终端操作，设置后消息即完成 |
| 说话者模型 | `from_speaker` + `to_speakers`（路由目标） |
| 层级 | Issue > Stage > Message |

核心洞察：**消息不是一次性写入的静态数据，而是一个从 streaming 到 finalized 的生命周期过程。流式过程中的事件有独立价值（调试、回溯、分析），应当被持久化而非丢弃。**

### 设计目标

站在 Snail Shell 的肩膀上，设计更适合 otter-buddy 场景的消息模型：

1. **采纳**：两层内容模型（流式事件 + 最终 body）、消息生命周期（streaming -> completed/failed）
2. **改进**：事件结构化（typed + payload），而非 Snail Shell 的隐式折叠文本——支持程序化查询和分析
3. **适配**：otter-buddy 的对话树结构、user/otter 双角色模型、memory 索引集成

### 约束输入

- F20260713c7p2：原始对话模块设计（对话 CRUD、树、关键信息部分不变）
- F20260709p4q7 S3 DDL：messages 表结构（本设计修改 messages 表 + 新增 message_events 表）
- F20260709m2n8 S2 D18：消息 append-only 语义（不变，扩展到 events）
- F20260709m2n8 S2 D21：SSE 流式传输（不变，event 持久化与 SSE 传输并行）
- F20260709m2n8 S2 UC1：Agent 事件流（text_delta、tool_call、tool_result、agent_end）
- F20260713i5k2：AgentHandle.stream() —— AsyncIterable<string>，yield text deltas
- D29：全局 4 层 + Provider Port + _internal/ 封装（不变）

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前讨论 | 消息这一部分，我认为你们必须参考好snail shell的设计，核心是msg的数据模型，包括流式过程event，以及最终答复body。而不应该是重头设计。而应该是站在snail shell的肩膀上，设计出更好更优雅的设计！ | 对象：msg 数据模型；核心组成：流式过程 event + 最终答复 body；方法：参考 snail shell 设计而非重头设计；期望：更好更优雅 | 消息模型需采用两层设计（事件 + body），参考 Snail Shell 的流式 + final body 模式，在结构化和可查询性上做得更好 |
| UA-2 | 当前讨论 | 你重新做好设计文档，然后我同意后你再推进 | 动作：重新做设计文档；条件：用户同意后推进 | 需创建新的 Feature 文档，用户审批后才能进入 development |

## 目标 [required]

### P1 - 消息两层模型实现

重设计 domain/conversation 的消息部分，包含：
- 消息生命周期模型（streaming -> completed | failed）
- 两层内容：最终 body + 流式事件（message_events）
- ConversationPort 消息相关方法更新（startMessage、appendEvent、completeMessage、failMessage）
- DDL 变更：messages 表字段更新 + 新增 message_events 表

### P2 - 可独立验证

通过集成测试验证：
- 用户消息：sendMessage 创建 completed 消息
- Otter 消息全流程：startMessage -> appendEvent -> completeMessage
- 失败消息：startMessage -> failMessage
- 事件查询：getMessageEvents 按 sequence_num ASC 返回
- 消息查询：getMessages 支持状态过滤
- 消息上下文：expandMessage 正常工作

## 非目标 [required]

- 不修改对话 CRUD、对话树、关键信息部分（沿用 F20260713c7p2）
- 不实现 SSE 传输（属 adapter/http，S2 D21 已设计）
- 不实现 app/orchestration 跨模块编排（步骤 ⑨）
- 不实现 app/agent-runtime Agent 工具注册（步骤 ⑩）
- 不实现前端 UI
- 不修改 infra/llm-gateway、infra/agent-core 已有代码
- 不实现事件清理/压缩策略（后续 feature）
- 不实现事件的 memory 索引（事件不索引到 memory，只有 body 索引）

## 设计 [required]

### 与 Snail Shell 的设计对比

| 概念 | Snail Shell | Otter Buddy（本设计） | 改进点 |
|------|-------------|----------------------|--------|
| 消息生命周期 | streaming -> set_final_body | streaming -> completed \| failed | 增加 failed 状态，显式标记失败 |
| 最终答复 | `set_final_body(text)` 终端操作 | `completeMessage(id, body)` | 增加 attachments 参数 |
| 流式内容 | 隐式（中间分析，折叠为文本） | 显式（`message_events` 表，typed + payload） | 结构化事件，可程序化查询 |
| 事件类型 | 无显式分类 | `text_delta` \| `tool_call` \| `tool_result` \| `error` | 类型化，支持差异化处理 |
| 事件持久化 | 折叠但保留（平台管理） | `message_events` 表（append-only） | 独立表，支持索引和查询 |
| 说话者模型 | from_speaker + to_speakers | senderType + senderId | 简化为双角色（user/otter） |
| 层级 | Issue > Stage > Message | Conversation Tree > Message | 对话树 + 物化路径 |

### 模块范围

```
src/domain/conversation/
├── model.ts                 # 更新：Message 模型 + 新增 MessageEvent
├── port.ts                  # 更新：消息相关方法扩展
└── _internal/
    ├── repository.ts        # 更新：消息 CRUD + 新增事件 CRUD
    ├── mapper.ts            # 更新：新字段映射 + 新增事件映射
    ├── adapter.ts           # 更新：消息生命周期逻辑
    └── initor.ts            # 不变

src/infra/db/
└── schema.ts                # 更新：messages 表字段 + 新增 message_events 表

tests/domain/conversation/
├── repository.test.ts       # 更新：新增消息生命周期 + 事件测试
└── adapter.test.ts          # 更新：新增消息生命周期测试
```


### 1. DDL 变更

#### 1.1 messages 表（更新）

```sql
-- 旧（F20260709p4q7 S3 DDL）
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT,
  sequence_num INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- 新（本设计）
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,          -- 'user' | 'otter'
  sender_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',  -- 'streaming' | 'completed' | 'failed'
  body TEXT,                          -- 最终答复 body（NULL while streaming）
  attachments TEXT,                   -- JSON array
  sequence_num INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,                  -- streaming 结束时间（completed 或 failed）
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
```

**变更说明**：

| 变更 | 旧 | 新 | 原因 |
|------|----|----|------|
| `content TEXT NOT NULL` | 消息内容，不可空 | `body TEXT`（可空） | streaming 阶段无最终 body |
| 新增 `status` | 无 | `DEFAULT 'completed'` | 消息生命周期：streaming -> completed \| failed |
| 新增 `completed_at` | 无 | `TEXT`（可空） | 记录 streaming 结束时间 |
| 新增 `idx_messages_status` | 无 | 索引 on status | 按状态查询（如"正在 streaming 的消息"） |

#### 1.2 message_events 表（新增）

```sql
CREATE TABLE IF NOT EXISTS message_events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,           -- 'text_delta' | 'tool_call' | 'tool_result' | 'error'
  payload TEXT NOT NULL,              -- JSON（事件类型相关的结构化数据）
  sequence_num INTEGER NOT NULL,      -- per-message 事件序列
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_message_events_message_seq ON message_events(message_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_message_events_type ON message_events(event_type);
```

**设计要点**：
- Append-only（与 messages 一致，INSERT only，无 UPDATE/DELETE）
- `sequence_num` per-message 自增（不跨消息）
- `payload` 为 JSON 文本，不同事件类型有不同结构
- 外键约束：message_id 必须指向存在的 messages 行

#### 1.3 事件 payload 结构

| event_type | payload 结构 | 说明 |
|------------|-------------|------|
| `text_delta` | `{"text": "delta text"}` | LLM 流式输出的文本片段 |
| `tool_call` | `{"toolName": "memory_search", "args": {...}}` | Agent 调用工具 |
| `tool_result` | `{"toolName": "memory_search", "result": {...}}` | 工具返回结果 |
| `error` | `{"message": "error description", "code": "..."}` | 生成过程中的错误 |

> payload 结构由 app/agent-runtime 生成，domain 层仅负责存储和检索，不解析 payload 语义。


### 2. model.ts -- 领域模型更新

```typescript
// ===== 新增类型 =====

/** 消息生命周期状态 */
type MessageStatus = 'streaming' | 'completed' | 'failed';

/** 流式事件类型 */
type MessageEventType = 'text_delta' | 'tool_call' | 'tool_result' | 'error';

// ===== 更新：Message =====

interface Message {
  id: string;
  conversationId: string;
  senderType: SenderType;        // 'user' | 'otter'
  senderId: string;
  status: MessageStatus;         // 生命周期：streaming -> completed | failed
  body: string | null;           // 最终答复 body（NULL while streaming）
  attachments: Attachment[] | null;
  sequenceNum: number;
  createdAt: string;             // 消息创建时间（streaming 开始时间）
  completedAt: string | null;    // streaming 结束时间（completed 或 failed 时设置）
}

// ===== 新增：MessageEvent =====

interface MessageEvent {
  id: string;
  messageId: string;
  eventType: MessageEventType;
  payload: Record<string, unknown>;  // JSON payload（事件类型相关）
  sequenceNum: number;               // per-message 事件序列
  createdAt: string;
}

// ===== 更新：输入类型 =====

/** 用户消息输入（立即完成，body 必填） */
interface MessageInput {
  senderType: SenderType;
  senderId: string;
  body: string;                      // 重命名：content -> body
  attachments?: Attachment[];
}

/** Otter 消息启动输入（streaming 阶段，无 body） */
interface StartMessageInput {
  senderId: string;                  // senderType 固定为 'otter'
  attachments?: Attachment[];        // 可选，如有预置附件
}

/** 流式事件输入 */
interface MessageEventInput {
  eventType: MessageEventType;
  payload: Record<string, unknown>;
}

/** 完成消息输入 */
interface CompleteMessageInput {
  body: string;                      // 最终答复 body
  attachments?: Attachment[];        // 可选。不提供时保留 startMessage 时的预置 attachments（架构师-2 #1）
}

// ===== 不变：Conversation, KeyFact, LinkedResource, KeyInfo, ConversationTreeNode, Attachment =====
```

**与 F20260713c7p2 的变更对比**：

| 字段 | F20260713c7p2 | 本设计 | 原因 |
|------|---------------|--------|------|
| `Message.content` | `string`（NOT NULL） | `Message.body: string \| null` | streaming 阶段无 body |
| `Message.status` | 无 | `MessageStatus` | 生命周期管理 |
| `Message.completedAt` | 无 | `string \| null` | streaming 结束时间 |
| `MessageInput.content` | `string` | `MessageInput.body: string` | 与 Snail Shell 术语对齐 |
| `MessageEvent` | 无 | 新增 | 流式过程事件持久化 |


### 3. port.ts -- ConversationPort 接口更新

```typescript
interface ConversationPort {
  // === Conversation CRUD（不变，沿用 F20260713c7p2）===
  create(params: { title: string; parentId?: string; otterIds: string[] }): Promise<Conversation>;
  getById(id: string): Promise<Conversation | null>;
  complete(id: string): Promise<void>;
  archive(id: string): Promise<void>;

  // === Tree（不变）===
  getTree(rootId: string): Promise<ConversationTreeNode>;
  createChild(parentId: string, title: string): Promise<Conversation>;

  // === Messages（重设计 —— 两层模型）===

  /**
   * 发送用户消息（立即完成）。
   * 创建 status='completed', body=message.body 的消息。
   * 用于 user 消息——无 streaming 阶段。
   */
  sendMessage(conversationId: string, message: MessageInput): Promise<Message>;

  /**
   * 开始 Otter 消息（进入 streaming 状态）。
   * 创建 status='streaming', body=NULL 的消息。
   * 调用方（app/agent-runtime）随后通过 appendEvent 追加流式事件，
   * 最终通过 completeMessage 设置最终 body。
   */
  startMessage(conversationId: string, sender: StartMessageInput): Promise<Message>;

  /**
   * 追加流式事件到 streaming 消息。
   * 事件 append-only（INSERT only）。
   * sequence_num per-message 自增。
   * 仅当 message.status='streaming' 时允许追加。
   */
  appendEvent(messageId: string, event: MessageEventInput): Promise<MessageEvent>;

  /**
   * 完成消息——设置最终 body（类似 Snail Shell 的 set_final_body）。
   * status: streaming -> completed
   * body 设置为传入文本，completed_at 记录时间。
   * 不可逆。调用后消息即为最终状态。
   */
  completeMessage(messageId: string, completion: CompleteMessageInput): Promise<Message>;

  /**
   * 标记消息失败。
   * status: streaming -> failed
   * completed_at 记录时间。body 保持 NULL。
   * 已有的流式事件保留（用于调试）。
   */
  failMessage(messageId: string): Promise<Message>;

  /**
   * 按 ID 获取消息。
   */
  getMessageById(id: string): Promise<Message | null>;

  /**
   * 获取消息列表（分页，按 sequence_num 倒序，默认 limit=50）。
   * 默认返回所有状态的消息（含 streaming、failed）。
   * 可通过 status 参数过滤。
   */
  getMessages(
    conversationId: string,
    opts?: { limit?: number; before?: string; status?: MessageStatus },
  ): Promise<Message[]>;

  /**
   * 获取消息的流式事件列表（按 sequence_num ASC）。
   * 对应 Snail Shell 中"折叠的流式内容"——此处为展开查询。
   */
  getMessageEvents(messageId: string): Promise<MessageEvent[]>;

  /**
   * 获取消息上下文（前/后/双向，按 sequence_num）。
   * 包含所有状态的消息。
   */
  expandMessage(
    messageId: string,
    direction: 'before' | 'after' | 'both',
    count: number,
  ): Promise<Message[]>;

  // === Key Info（不变，沿用 F20260713c7p2）===
  addKeyFact(conversationId: string, fact: KeyFactInput): Promise<KeyFact>;
  linkResource(conversationId: string, resource: LinkedResourceInput): Promise<LinkedResource>;
  getKeyInfo(conversationId: string): Promise<KeyInfo>;
  getLinkedResources(conversationId: string): Promise<LinkedResource[]>;
}
```

**方法行为说明（仅消息相关）**：

| 方法 | 数据库操作 | 状态约束 | 说明 |
|------|-----------|---------|------|
| sendMessage() | INSERT messages (status='completed', body=message.body) → SELECT messages WHERE id=? | 无 | 用户消息，立即完成 |
| startMessage() | INSERT messages (status='streaming', body=NULL) → SELECT messages WHERE id=? | 无 | Otter 消息开始 |
| appendEvent() | INSERT message_events → SELECT message_events WHERE id=? | message.status='streaming' | 仅 streaming 状态可追加事件 |
| completeMessage() | SELECT messages (校验 status='streaming') → UPDATE messages SET status='completed', body=?, completed_at=now | status='streaming' | 终端操作，不可逆 |
| failMessage() | SELECT messages (校验 status='streaming') → UPDATE messages SET status='failed', completed_at=now | status='streaming' | 终端操作，不可逆 |
| getMessageById() | SELECT messages WHERE id=? | 无 | 纯查询 |
| getMessages() | SELECT messages WHERE conversation_id=? [AND status=?] [AND sequence_num < ?] ORDER BY sequence_num DESC LIMIT ? | 无 | 分页 + 可选状态过滤 |
| getMessageEvents() | SELECT message_events WHERE message_id=? ORDER BY sequence_num ASC | 无 | 事件按时间线顺序 |
| expandMessage() | before: seq < ? ORDER BY DESC LIMIT ?; after: seq > ? ORDER BY ASC LIMIT ?; both: 合并后按 seq ASC | 无 | 上下文展开 |

**消息生命周期状态机**：

```
                    sendMessage                          ┌─────────┐
                 ┌──────────────────────────────────────>│completed│
                 │                                      └─────────┘
                 │
┌──────────┐    │ startMessage      ┌──────────┐
│ (created)│────┼──────────────────>│streaming │
└──────────┘    │                   └────┬─────┘
                │                        │
                │           completeMessage │ failMessage
                │                        │              │
                │                        v              v
                │                   ┌─────────┐    ┌──────┐
                │                   │completed│    │failed│
                │                   └─────────┘    └──────┘
                │
                └─ 仅 user 消息走此路径
                   otter 消息走 startMessage 路径
```

**状态转换规则**：
- `streaming` -> `completed`：通过 `completeMessage`，设置 body
- `streaming` -> `failed`：通过 `failMessage`，body 保持 NULL
- `completed` / `failed`：终态，不可转换
- 对非 `streaming` 状态的消息调用 `completeMessage` 或 `failMessage`：throw


### 4. _internal/repository.ts -- 持久化更新

```typescript
class ConversationRepository {
  constructor(private db: Database.Database) {}

  // === Conversation CRUD（不变）===
  // ... 沿用 F20260713c7p2 ...

  // === Messages（更新）===

  /** 创建已完成消息（用户消息） */
  createCompletedMessage(id: string, conversationId: string, message: MessageInput, sequenceNum: number): Message;

  /** 创建 streaming 消息（Otter 消息开始） */
  createStreamingMessage(id: string, conversationId: string, sender: StartMessageInput, sequenceNum: number): Message;

  /** 更新消息状态为 completed（设置 body + completed_at） */
  completeMessage(messageId: string, body: string, attachments: Attachment[] | null): Message;

  /** 更新消息状态为 failed（设置 completed_at） */
  failMessage(messageId: string): Message;

  /** 获取消息 */
  getMessageById(id: string): Message | null;

  /** 获取消息列表（分页 + 可选状态过滤） */
  getMessages(conversationId: string, opts?: { limit?: number; before?: string; status?: MessageStatus }): Message[];

  /** 获取最大 sequence_num */
  getMaxSequenceNum(conversationId: string): number;

  /** 上下文展开 */
  expandMessage(messageId: string, direction: 'before' | 'after' | 'both', count: number): Message[];

  // === Message Events（新增）===

  /** 追加事件 */
  appendEvent(id: string, messageId: string, event: MessageEventInput, sequenceNum: number): MessageEvent;

  /** 获取事件列表（按 sequence_num ASC） */
  getMessageEvents(messageId: string): MessageEvent[];

  /** 获取事件最大 sequence_num */
  getMaxEventSequenceNum(messageId: string): number;

  // === Key Info（不变）===
  // ... 沿用 F20260713c7p2 ...
}
```

**关键 SQL**：

```sql
-- 创建已完成消息（用户消息）
INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body, attachments, sequence_num)
VALUES (?, ?, ?, ?, 'completed', ?, ?, ?);

-- 创建 streaming 消息（Otter 消息开始）
INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body, attachments, sequence_num)
VALUES (?, ?, ?, 'otter', 'streaming', NULL, ?, ?);

-- 完成消息（streaming -> completed）
-- 检查 result.changes === 0 时 throw（防御性，与 adapter 校验双重保障，架构师-2 #3）
UPDATE messages
SET status = 'completed', body = ?, attachments = ?, completed_at = datetime('now')
WHERE id = ? AND status = 'streaming';

-- 失败消息（streaming -> failed）
-- 检查 result.changes === 0 时 throw（同上）
UPDATE messages
SET status = 'failed', completed_at = datetime('now')
WHERE id = ? AND status = 'streaming';

-- 追加事件
INSERT INTO message_events (id, message_id, event_type, payload, sequence_num)
VALUES (?, ?, ?, ?, ?);

-- 获取事件列表
SELECT * FROM message_events WHERE message_id = ? ORDER BY sequence_num ASC;

-- 获取消息列表（带状态过滤）
SELECT * FROM messages
WHERE conversation_id = ?
  [AND status = ?]
  [AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)]
ORDER BY sequence_num DESC
LIMIT ?;
```

> **注意**：messages 表的 append-only 约束（D18）适用于 **消息内容**——即 `body` 一旦设置不可修改。但 `status` 和 `completed_at` 的 UPDATE 是生命周期管理操作，不违反 append-only 语义。append-only 的核心是"消息内容不可变"，而非"行不可更新"。这与 S2 D18 的设计意图一致：消息是不可变的记录，但消息的生命周期状态是可变的元数据。


### 5. _internal/adapter.ts -- 业务逻辑更新

**消息相关逻辑**：

| 方法 | 逻辑 |
|------|------|
| sendMessage | 1. crypto.randomUUID() 生成 ID 2. getMaxSequenceNum + 1 3. repository.createCompletedMessage 4. 返回 Message |
| startMessage | 1. crypto.randomUUID() 生成 ID 2. getMaxSequenceNum + 1 3. repository.createStreamingMessage 4. 返回 Message（status='streaming'） |
| appendEvent | 1. getMessageById 校验 status='streaming' 2. getMaxEventSequenceNum + 1 3. repository.appendEvent 4. 返回 MessageEvent |
| completeMessage | 1. getMessageById 校验 status='streaming' 2. attachments 缺省时保留 existing.attachments（架构师-2 #1） 3. repository.completeMessage(id, body, attachments) 4. 返回更新后的 Message |
| failMessage | 1. getMessageById 校验 status='streaming' 2. repository.failMessage(id) 3. 返回更新后的 Message |
| getMessageById | repository.getMessageById |
| getMessages | repository.getMessages（默认 limit=50） |
| getMessageEvents | repository.getMessageEvents |
| expandMessage | repository.expandMessage |

**状态校验**：
- `appendEvent` 对非 streaming 消息：throw Error
- `completeMessage` 对非 streaming 消息：throw Error
- `failMessage` 对非 streaming 消息：throw Error


### 6. _internal/mapper.ts -- 映射更新

**Message 映射**：

| DB 列 | 领域字段 | 转换 |
|-------|---------|------|
| id | Message.id | 直接映射 |
| conversation_id | Message.conversationId | snake_case -> camelCase |
| sender_type | Message.senderType | 直接映射 |
| sender_id | Message.senderId | snake_case -> camelCase |
| status | Message.status | 直接映射（TEXT -> union type） |
| body | Message.body | 直接映射（NULL -> null） |
| attachments | Message.attachments | JSON.parse / JSON.stringify |
| sequence_num | Message.sequenceNum | snake_case -> camelCase |
| created_at | Message.createdAt | snake_case -> camelCase |
| completed_at | Message.completedAt | snake_case -> camelCase（NULL -> null） |

**MessageEvent 映射**：

| DB 列 | 领域字段 | 转换 |
|-------|---------|------|
| id | MessageEvent.id | 直接映射 |
| message_id | MessageEvent.messageId | snake_case -> camelCase |
| event_type | MessageEvent.eventType | snake_case -> camelCase |
| payload | MessageEvent.payload | JSON.parse / JSON.stringify（TEXT <-> Record） |
| sequence_num | MessageEvent.sequenceNum | snake_case -> camelCase |
| created_at | MessageEvent.createdAt | snake_case -> camelCase |


### 7. Memory 索引集成

消息的 memory 索引时机变更：

| 消息类型 | 索引时机 | 索引内容 | 编排位置 |
|---------|---------|---------|---------|
| 用户消息 | `sendMessage` 时 | `body` | app/orchestration |
| Otter 消息 | `completeMessage` 时 | `body`（非 events） | app/orchestration |
| 失败消息 | 不索引 | 无 | - |

> streaming 中的消息不索引到 memory——只有最终 body 才是可检索的内容。流式事件是过程记录，不是记忆内容。


### 8. 与 app/agent-runtime 的协作

```
用户发送消息
  │
  ▼
app/orchestration:
  1. ConversationPort.sendMessage(userMessage)  ← 用户消息立即完成
  2. MemoryPort.store(message body)             ← memory 索引
  3. AgentRuntime.run(otterId, conversationId)  ← 触发 Otter 响应
  │
  ▼
app/agent-runtime:
  4. ConversationPort.startMessage(convId, {otterId})  ← 创建 streaming 消息
  5. for each LLM stream chunk:
       a. SSE: yield text_delta to browser             ← 实时传输
       b. ConversationPort.appendEvent(msgId, {         ← 持久化事件
            eventType: 'text_delta',
            payload: { text: delta }
          })
  6. for each tool_call:
       a. ConversationPort.appendEvent(msgId, {         ← 持久化工具调用
            eventType: 'tool_call',
            payload: { toolName, args }
          })
       ... execute tool ...
       b. ConversationPort.appendEvent(msgId, {         ← 持久化工具结果
            eventType: 'tool_result',
            payload: { toolName, result }
          })
  7. on success:
       a. ConversationPort.completeMessage(msgId, {     ← 设置最终 body
            body: fullResponseText
          })
       b. SSE: done
       c. app/orchestration: MemoryPort.store(body)     ← memory 索引
  8. on error:
       a. ConversationPort.failMessage(msgId)           ← 标记失败
       b. SSE: error
```

> **设计要点**：事件持久化与 SSE 传输是并行的——SSE 负责实时交付，event 持久化负责过程记录。两者独立，互不阻塞。


## 偏差记录 [required]

### D-Msg-1: messages 表 content -> body 重命名 + status/completed_at 新增

**偏差对象**：F20260709p4q7 S3 DDL messages 表 + F20260713c7p2 Message 模型

| 项目 | S3 / F20260713c7p2 | 本设计 |
|------|---------------------|--------|
| 消息内容字段 | `content TEXT NOT NULL` | `body TEXT`（可空） |
| 消息状态 | 无 | `status TEXT NOT NULL DEFAULT 'completed'` |
| 完成时间 | 无 | `completed_at TEXT` |

**依据**：用户明确要求参考 Snail Shell 的"最终答复 body"模型。streaming 阶段无 body，因此 body 必须可空。status 字段管理生命周期，completed_at 记录 streaming 结束时间。

**影响**：
1. DDL 变更：messages 表结构修改（不兼容更新，见下文）
2. 代码变更：model.ts、port.ts、repository.ts、mapper.ts、adapter.ts 全部更新
3. 测试变更：新增消息生命周期测试用例

### D-Msg-2: 新增 message_events 表

**偏差对象**：S3 DDL（无此表）

| 项目 | S3 | 本设计 |
|------|----|--------|
| 流式事件持久化 | 无 | `message_events` 表（append-only） |

**依据**：用户明确要求参考 Snail Shell 的"流式过程 event"模型。Snail Shell 将流式内容折叠保留，本设计改进为结构化事件表，支持程序化查询。

### D-Msg-3: messages 表 append-only 语义扩展

**偏差对象**：S2 D18 append-only 语义

| 项目 | S2 D18 | 本设计 |
|------|--------|--------|
| append-only 范围 | messages 表 INSERT only | messages 表 content 不可变；status/completed_at 可 UPDATE（生命周期管理） |

**依据**：D18 的核心是"消息内容不可变"（Chat as Substrate）。status 和 completed_at 是生命周期元数据，不是消息内容。UPDATE status='completed' 不改变消息内容，只标记消息状态。这与 D18 的设计意图一致。

## 不兼容更新 [required]

遵循"代码仓完美状态原则"，DDL 变更直接修改 `CREATE TABLE IF NOT EXISTS` 语句，无迁移脚本、无兼容性桥接。

| 变更 | 说明 |
|------|------|
| `messages.content` -> `messages.body`（可空） | 字段重命名 + 约束变更（NOT NULL -> 可空） |
| `messages` 新增 `status` 列 | DEFAULT 'completed' |
| `messages` 新增 `completed_at` 列 | NULL 默认值 |
| 新增 `message_events` 表 | `CREATE TABLE IF NOT EXISTS`（自动创建） |

> 无需手工处理。DDL 变更直接修改 schema.ts 中的 CREATE 语句，重建数据库即生效。

## 硬约束 [required]

- messages 表 body 一旦设置（completeMessage）不可修改（D18 append-only 语义扩展）
- message_events 表 append-only，INSERT only，无 UPDATE/DELETE
- message_events.sequence_num per-message 自增，不跨消息
- 消息状态转换：streaming -> completed | failed，不可逆
- 对非 streaming 状态的消息调用 completeMessage/failMessage/appendEvent：throw
- sendMessage 创建的消息 status='completed'（用户消息无 streaming 阶段）
- startMessage 创建的消息 status='streaming'，body=NULL
- completeMessage 必须设置 body（非空字符串）
- failMessage 不设置 body（保持 NULL）
- 所有表使用 CREATE TABLE IF NOT EXISTS，禁止 ALTER TABLE（DDL 变更直接修改 CREATE 语句）
- domain 模块间不互相依赖，跨模块操作在 app/orchestration 编排（D29）
- ConversationPort 是 domain/conversation 唯一的公开接口
- ESLint 禁止跨模块 import `_internal/`（main.ts 豁免）
- 消息 memory 索引仅在 completed 时触发（streaming/failed 不索引）
- 事件不索引到 memory（只有 body 是可检索的记忆内容）

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 事件独立表 | message_events 表 | messages 表增加 events JSON 列 | 独立表支持索引查询、append-only 语义独立、避免 messages 表 UPDATE |
| 事件类型 | 4 种（text_delta/tool_call/tool_result/error） | 仅 tool_call + error | text_delta 支持完整回放，tool_result 与 tool_call 配对 |
| text_delta 持久化 | 持久化每个 delta | 仅持久化累积文本 | 完整回放能力，代价是存储量（单用户本地部署可接受） |
| status 默认值 | 'completed' | 'streaming' | 向后兼容：已有数据（无 status）视为已完成 |
| body 可空 | streaming 阶段 NULL | 空字符串占位 | NULL 语义清晰：未设置 vs 空内容 |
| sendMessage 保留 | 用户消息立即完成 | 统一用 startMessage + completeMessage | 用户消息无 streaming 阶段，两步操作多余 |
| failed 状态 | 显式标记 | 删除 streaming 消息 | 保留失败消息和事件用于调试 |
| completeMessage 设置 attachments | 完成时设置 | startMessage 时设置 | Otter 可能在生成过程中产生附件 |
| expandMessage 不过滤状态 | 返回所有状态消息 | 仅返回 completed | 上下文展开需包含所有消息（含 streaming/failed） |
| getMessages 默认含所有状态 | 不过滤 | 默认仅 completed | 前端需显示 streaming 指示器和失败消息 |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/infra/db/schema.ts` | 修改 | messages 表字段更新 + 新增 message_events 表 |
| `src/domain/conversation/model.ts` | 修改 | Message 模型更新 + 新增 MessageEvent 等类型 |
| `src/domain/conversation/port.ts` | 修改 | 消息相关方法扩展（6 个新方法 + 2 个更新） |
| `src/domain/conversation/_internal/repository.ts` | 修改 | 消息 CRUD 更新 + 事件 CRUD |
| `src/domain/conversation/_internal/mapper.ts` | 修改 | 新字段映射 + 事件映射 |
| `src/domain/conversation/_internal/adapter.ts` | 修改 | 消息生命周期逻辑 |
| `tests/domain/conversation/repository.test.ts` | 修改 | 新增消息生命周期 + 事件测试 |
| `tests/domain/conversation/adapter.test.ts` | 修改 | 新增消息生命周期测试 |

## 验证 [required]

### 验收标准

- [ ] `npm run check` 通过（lint + build）
- [ ] `npm run test` 通过
- [ ] sendMessage: 创建 status='completed', body=非空 的消息
- [ ] startMessage: 创建 status='streaming', body=NULL 的消息
- [ ] appendEvent: 事件写入 message_events，sequence_num per-message 自增
- [ ] appendEvent: 对非 streaming 消息调用抛出异常
- [ ] completeMessage: status streaming -> completed, body 设置, completed_at 非空
- [ ] completeMessage: 对非 streaming 消息调用抛出异常
- [ ] completeMessage: 设置 attachments
- [ ] failMessage: status streaming -> failed, completed_at 非空, body 保持 NULL
- [ ] failMessage: 对非 streaming 消息调用抛出异常
- [ ] completeMessage/failMessage: repository UPDATE 0 rows 时 throw（并发保护，架构师-2 #3）
- [ ] completeMessage: 不提供 attachments 时保留 startMessage 时的预置（架构师-2 #1）
- [ ] getMessageById: 返回消息（含所有新字段）
- [ ] getMessages: 按 sequence_num 倒序返回
- [ ] getMessages: status 过滤正确
- [ ] getMessages: before 分页正确
- [ ] getMessages: 无 limit 时默认 50 条
- [ ] getMessageEvents: 按 sequence_num ASC 返回
- [ ] getMessageEvents: 空事件列表返回空数组
- [ ] expandMessage before/after/both: 正确返回上下文消息
- [ ] message_events 外键约束：message_id 不存在时 INSERT 抛出异常
- [ ] body NULL 映射正确（DB NULL -> null）
- [ ] status 映射正确（TEXT -> union type）
- [ ] completed_at 映射正确（NULL -> null）
- [ ] payload JSON 序列化/反序列化正确
- [ ] 事件 append-only（无 UPDATE/DELETE 方法）

### 测试设计

#### repository.test.ts 新增用例

| 测试用例 | 验证点 |
|---------|--------|
| sendMessage 创建完成消息 | status='completed', body 非空, completed_at=NULL |
| startMessage 创建 streaming 消息 | status='streaming', body=NULL |
| appendEvent 写入事件 | 事件正确写入，sequence_num 自增 |
| appendEvent 多事件 sequence_num 连续 | 1, 2, 3... |
| appendEvent 对非 streaming 消息 | throw Error |
| completeMessage | status -> 'completed', body 设置, completed_at 非空 |
| completeMessage 对非 streaming | throw Error |
| completeMessage 设置 attachments | attachments 正确写入 |
| failMessage | status -> 'failed', body=NULL, completed_at 非空 |
| failMessage 对非 streaming | throw Error |
| getMessageEvents | 按 sequence_num ASC 返回 |
| getMessageEvents 空列表 | 返回空数组 |
| getMessages status 过滤 | 仅返回指定状态的消息 |
| message_events 外键约束 | message_id 不存在时 INSERT 抛出异常 |
| payload JSON 序列化 | 存储 Record，读取回 Record |
| failed 消息后 appendEvent | throw Error（status != streaming） |
| completeMessage 后 appendEvent | throw Error（status != streaming） |

#### adapter.test.ts 新增用例

| 测试用例 | 验证点 |
|------|--------|
| sendMessage sequence_num | getMaxSequenceNum + 1 |
| startMessage sequence_num | getMaxSequenceNum + 1 |
| startMessage senderType | 固定为 'otter' |
| appendEvent 状态校验 | mock repo，非 streaming 时 throw |
| completeMessage 状态校验 | mock repo，非 streaming 时 throw |
| failMessage 状态校验 | mock repo，非 streaming 时 throw |
| appendEvent sequence_num | getMaxEventSequenceNum + 1 |

## 关联 [required]

- **S3 数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)（messages 表原始 DDL）
- **S2 能力模块架构设计**：[F20260709m2n8](../09/F20260709m2n8-capability-module-architecture.md)（D18 append-only、D21 SSE、UC1 事件流）
- **原始对话模块设计**：[F20260713c7p2](./F20260713c7p2-domain-conversation.md)（对话 CRUD、树、关键信息不变）
- **domain/memory 设计**：[F20260713m5q3](./F20260713m5q3-domain-memory.md)
- **infra LLM/Agent/Embedding**：[F20260713i5k2](./F20260713i5k2-infra-llm-agent-embedding.md)（AgentHandle.stream）
- **项目实施计划**：[otter-buddy#5](https://github.com/chenlaicai/otter-buddy/issues/5)

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-Msg-1 | 当用户发送消息时 | 创建 status='completed', body=消息内容, completed_at=NULL 的消息，无 streaming 阶段（created_at 即为完成时间，架构师-2 #4） | ← UA-1 |
| B-Msg-2 | 当 Otter 开始响应时 | 创建 status='streaming', body=NULL 的消息，分配 sequence_num | ← UA-1 |
| B-Msg-3 | 当 Otter 流式生成时 | 每个 text_delta/tool_call/tool_result/error 事件被 append-only 写入 message_events 表 | ← UA-1 |
| B-Msg-4 | 当 Otter 完成响应时 | status: streaming -> completed，body 设置为最终答复文本，completed_at 记录时间。不可逆 | ← UA-1 |
| B-Msg-5 | 当 Otter 响应失败时 | status: streaming -> failed，body 保持 NULL，completed_at 记录时间。已有事件保留 | ← UA-1 |
| B-Msg-6 | 当对非 streaming 消息调用 completeMessage/failMessage/appendEvent 时 | throw Error | 不适用（架构师决策） |
| B-Msg-7 | 当查询消息事件时 | 按 sequence_num ASC 返回事件列表（时间线顺序） | ← UA-1 |
| B-Msg-8 | 当查询消息列表时 | 按 sequence_num 倒序返回，支持 status 过滤，默认返回所有状态 | 不适用（架构师决策） |
| B-Msg-9 | 当消息完成时 | memory 索引由 app/orchestration 编排，仅索引 body（非事件） | 不适用（S3 D27） |
