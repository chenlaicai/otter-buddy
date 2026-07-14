---
id: F20260714jaup
title: entities-layer-implementation
from_ids: [F20260714zjmk, F20260713e8n4, F20260713o4t8, F20260713m5q3, F20260709p4q7]
tags: [architecture, entities, clean-architecture, conversation, otter, memory, talking-stone]
modules: [src/entities/]
doc_kind: spec
status: implemented
created_at: 2026-07-14
---

# F20260714jaup 整洁架构 Entities 层实现

## [design-time]

> 本文档定义整洁架构 entities 层的实体类型 + 不变量规则函数，遵循 F20260714zjmk 锁定的目录结构和设计决策。

## 背景 [required]

### 当前状态

F20260714zjmk 已完成 Setup（步骤 1-2,6）：
- 旧代码归档至 `reference/old-src/`
- 新建 4 层空目录（`src/entities/`、`src/usecases/`、`src/interface-adapters/`、`src/frameworks/`）
- tsconfig path aliases + ESLint 层依赖规则已配置

本 Issue 对应 F20260714zjmk 实现计划的 Issue 2：entities 层实现。

### 旧代码参考源

| 上下文 | 旧 model.ts | 旧 adapter.ts（不变量提取源） |
|--------|------------|---------------------------|
| conversation | `reference/old-src/domain/conversation/model.ts` | `reference/old-src/domain/conversation/_internal/adapter.ts` |
| otter | `reference/old-src/domain/otter/model.ts` | `reference/old-src/domain/otter/_internal/adapter.ts` |
| memory | `reference/old-src/domain/memory/model.ts` | `reference/old-src/domain/memory/_internal/adapter.ts` |

### 上游设计约束

- **D36**（F20260714zjmk）：entities 层含类型 + 不变量规则函数。纯函数不操作实例状态，但能集中管理领域不变量
- **D31**：保留限界上下文作为模块组织维度（otter、memory、conversation）
- **D42**：Greenfield 实现，旧代码仅作参考
- **ESLint 规则**：`src/entities/**/*.ts` 不可 import usecases/interface-adapters/frameworks（`@frameworks/logger` 除外）

### 用户指令变更（本 Issue 设计阶段）

用户在审视过程中提出以下变更，偏离旧代码设计：

| 变更 | 用户指令 | 理由 |
|------|---------|------|
| 去除对话树 | "先不考虑对话树了，目前conversation只有自己" | 对话树当前不需要，简化模型 |
| 发言石机制 | "发言权必须明确现在在谁呢...必须显式指定mention" | 多 Otter 对话需要有序的发言权传递 |
| 轮次模型 | "一次发言成为一轮...每一轮多个发言者都必须发言完" | 避免发言顺序混乱 |
| Session 链式关系 | "ottersession chain的前后关系如何体现?" | 旧代码 Session 间无显式关联 |
| MemoryEntry 去除 treePath | "现在就去除" | 对话树去除后 treePath 失去意义 |

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "按F20260714zjmk 的整洁架构来" | 对象：F20260714zjmk 整洁架构；方式：按其设计执行 | entities 层实现必须严格遵循 F20260714zjmk 锁定的目录结构、依赖规则和 D36 实体定义 | msg-1 |
| UA-2 | "你本次主要将 entities 做好" | 对象：entities 层；程度：做好；时序：本次 | 本 Issue 的核心交付物是 entities 层，需要完整实现而非部分 | msg-1 |
| UA-3 | "业务场景可以聚焦在 对话能力上" | 对象：对话能力；方式：聚焦 | 三个上下文中 conversation 的实体设计需最完整，otter 和 memory 作为对话的关联上下文也需实现但可更简洁 | msg-1 |
| UA-4 | "其余能力后续可以逐步补起优化" | 对象：其余能力；时序：后续逐步；操作：补起优化 | 非 conversation 的实体可在本次做基础实现，后续 Issue 逐步完善 | msg-1 |
| UA-5 | "先不考虑对话树了，目前conversation只有自己" | 对象：对话树；时序：先不考虑；状态：conversation 只有自己 | 去除 Conversation 的 parentId/treePath，对话是独立实体非树结构 | msg-4917 |
| UA-6 | "mention机制你没设计到" | 对象：mention 机制 | 需要设计 mention 机制，旧代码缺少此功能 | msg-4923 |
| UA-7 | "所有的otter+人都能互相@...发言权必须明确现在在谁呢...必须显式指定mention...发言石头" | 对象：发言权；程度：必须明确；比喻：发言石头；范围：所有参与者互相 @ | 发言权（发言石）必须在参与者间显式传递，每条消息必须指定下一批发言者。用户和 Otter 都能 @ 任何参与者 | msg-4927 |
| UA-8 | "一次发言成为一轮...每一轮多个发言者都必须发言完，才允许开始下一轮" | 对象：轮次；约束：必须全部完成才进入下一轮 | 引入 Turn 实体管理轮次，控制发言顺序 | msg-4927 |
| UA-9 | "不允许为空...对话结束则是由用户自行决定的" | 对象：talkingStonePassedTo；程度：不允许为空 | 发言石传递必填且非空，对话结束独立于发言石传递 | msg-4935 |
| UA-10 | "mentionedParticipantIds改个名字...贯彻《发言石》概念" | 对象：字段命名；方式：贯彻发言石概念 | 字段改名 talkingStonePassedTo，文档/代码/注释统一使用「发言石」术语 | msg-4935 |
| UA-11 | "ottersession chain的前后关系如何体现?" | 对象：Session chain；疑问：如何体现 | OtterSession 需要显式链式关系（previousSessionId） | msg-4923 |

## 目标 [required]

### P1 - 三上下文实体类型定义

参照旧代码 `domain/*/model.ts`，在新 `src/entities/` 下实现全部实体类型、值类型和值对象。包含用户指令的变更（去除对话树、新增 Turn/发言石、Session 链式）。

### P2 - 不变量规则函数

从旧 adapter.ts 中提取领域不变量，实现为纯函数（D36）。conversation 上下文做完整覆盖（含发言石/轮次不变量），otter 和 memory 实现核心不变量。

### P3 - 可编译验证

- `tsc --noEmit` 通过
- `eslint src/entities/` 无违规
- 层依赖规则验证：entities/ 无外层 import

## 非目标 [required]

- 不实现 usecases 层（Repository 接口、Gateway 接口、use case class）
- 不实现 frameworks 层（DB repository、mapper、LLM gateway 等）
- 不实现 interface-adapters 层
- 不实现 main.ts 装配
- 不实现测试（测试随 usecases 层一起实现）
- 不改变数据库 schema（schema 变更随 frameworks 层 Issue 处理）
- 不引入新的第三方依赖

## 设计 [required]

### 文件结构

```
src/entities/
  conversation/
    conversation.ts     -- Conversation(无树) + Turn(轮次) + KeyFact + LinkedResource + KeyInfo + Attachment + 不变量
    message.ts          -- Message(含发言石) + MessageEvent + 不变量
  otter/
    otter.ts            -- Otter + OtterRole + 不变量
    otter-session.ts    -- OtterSession(链式) + 不变量
  memory/
    memory-entry.ts     -- MemoryEntry(无treePath) + MemoryWeight + 不变量
```

### 类型归属规则

| 类别 | 归属层 | 判据 |
|------|--------|------|
| 实体类型（Conversation, Message, Turn, Otter, ...） | entities | 核心业务对象，描述领域实体的数据形状 |
| 值类型/枚举（ConversationStatus, OtterType, TurnStatus, ...） | entities | 领域概念的有限集合 |
| 值对象（Attachment, OtterRole, KeyInfo, ...） | entities | 无独立生命周期的组合类型 |
| 不变量规则函数 | entities | D36：集中管理领域规则 |
| Use case 输入类型（MessageInput, StartMessageInput, MessageEventInput, CompleteMessageInput, KeyFactInput, LinkedResourceInput, CreateOtterInput, ArchiveSessionInput, MemoryEntryInput） | usecases | 应用层 DTO，包含应用关注点（如 CreateOtterInput.systemPrompt） |
| 检索相关类型（SearchQuery, RetrievalResult, RetrievalSource, FTSHit, VecHit, RrfHit, ScoredHit） | usecases | 检索算法实现细节，属应用层 |

### 1. entities/conversation/conversation.ts

#### 1.1 类型定义

```typescript
/** 对话状态 */
export type ConversationStatus = "active" | "completed" | "archived";

/** 对话实体（无对话树，独立实体） */
export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

/** 轮次状态 */
export type TurnStatus = "open" | "closed";

/** 对话轮次（发言石轮次模型） */
export interface Turn {
  id: string;
  conversationId: string;
  turnNumber: number;       // 1, 2, 3, ...（对话内自增）
  status: TurnStatus;       // open = 等待发言者完成，closed = 全部完成
  createdAt: string;
  closedAt: string | null;
}

/** 关键事实实体 */
export interface KeyFact {
  id: string;
  conversationId: string;
  content: string;
  category: string | null;
  userFlagged: boolean;
  createdBy: string;
  otterId: string | null;
  createdAt: string;
}

/** 链接资源实体 */
export interface LinkedResource {
  id: string;
  conversationId: string;
  resourceType: string;
  url: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
}

/** 关键信息组合值对象 */
export interface KeyInfo {
  keyFacts: KeyFact[];
  linkedResources: LinkedResource[];
}

/** 附件值对象 */
export interface Attachment {
  type: string;
  url: string;
  name?: string;
}
```

> 与旧代码差异：Conversation 去除 `parentId`、`treePath`；新增 `Turn` 实体；删除 `ConversationTreeNode`。

#### 1.2 不变量规则函数

```typescript
/**
 * 对话状态转换：active -> completed
 * 来源：旧 adapter.ts complete() 方法中的状态校验
 */
export function canCompleteConversation(status: ConversationStatus): boolean {
  return status === "active";
}

/**
 * 对话状态转换：completed -> archived
 * 来源：旧 adapter.ts archive() 方法中的状态校验
 */
export function canArchiveConversation(status: ConversationStatus): boolean {
  return status === "completed";
}

/**
 * 轮次是否仍在进行（接受发言者发言）
 */
export function isTurnActive(status: TurnStatus): boolean {
  return status === "open";
}

/**
 * 消息是否可以添加到该轮次。
 * 仅 open 状态的 Turn 可接受新消息。
 * 来源：UA-8 直接推论--每一轮发言者必须全部完成才进入下一轮
 */
export function canAddMessageToTurn(turnStatus: TurnStatus): boolean {
  return turnStatus === "open";
}

/**
 * 轮次是否可以关闭。
 * 当轮次内所有消息都到达终态时，可以关闭轮次。
 * allMessagesTerminal: 轮次内所有消息是否已到达终态（completed/failed）
 */
export function canCloseTurn(allMessagesTerminal: boolean): boolean {
  return allMessagesTerminal;
}
```

### 2. entities/conversation/message.ts

#### 2.1 类型定义

```typescript
import type { Attachment } from "./conversation";

/** 发送者类型 */
export type SenderType = "user" | "otter";

/** 消息生命周期状态 */
export type MessageStatus = "streaming" | "completed" | "failed";

/** 流式事件类型 */
export type MessageEventType = "text_delta" | "tool_call" | "tool_result" | "error";

/** 消息实体（含发言石传递） */
export interface Message {
  id: string;
  conversationId: string;
  turnId: string;                     // 所属轮次
  senderType: SenderType;
  senderId: string;
  talkingStonePassedTo: string[];     // 发言石传递：必填，非空。指定下一轮发言者
  status: MessageStatus;
  body: string | null;
  attachments: Attachment[] | null;
  sequenceNum: number;
  createdAt: string;
  completedAt: string | null;
}

/** 消息流式事件实体 */
export interface MessageEvent {
  id: string;
  messageId: string;
  eventType: MessageEventType;
  payload: Record<string, unknown>;
  sequenceNum: number;
  createdAt: string;
}
```

> `Attachment` 类型从 `conversation.ts` 导入（同层引用，符合依赖规则）。
>
> 与旧代码差异：Message 新增 `turnId`、`talkingStonePassedTo` 字段。

#### 2.2 不变量规则函数

```typescript
/**
 * 消息是否处于终态（不可再转换）。
 * completed 和 failed 是终态。
 */
export function isTerminalMessageStatus(status: MessageStatus): boolean {
  return status === "completed" || status === "failed";
}

/**
 * 是否可以追加流式事件。
 * 仅 streaming 状态的消息可接收事件。
 * 来源：旧 adapter.ts appendEvent() 方法中的状态校验
 */
export function canAppendEvent(status: MessageStatus): boolean {
  return status === "streaming";
}

/**
 * 是否可以完成消息。
 * 仅 streaming 状态的消息可被完成。
 * 来源：旧 adapter.ts completeMessage() 方法中的状态校验
 */
export function canCompleteMessage(status: MessageStatus): boolean {
  return status === "streaming";
}

/**
 * 是否可以标记消息失败。
 * 仅 streaming 状态的消息可被标记失败。
 * 来源：旧 adapter.ts failMessage() 方法中的状态校验
 */
export function canFailMessage(status: MessageStatus): boolean {
  return status === "streaming";
}

/**
 * 完成消息时 body 是否合法。
 * completed 状态的 Message 必须有非空 body--这是实体状态不变量，
 * 任何 use case 调用 completeMessage 时都必须遵守。
 * 来源：旧 adapter.ts completeMessage() 方法中的 `if (!completion.body)` 校验
 */
export function isValidCompletedMessageBody(body: string): boolean {
  return body.length > 0;
}

/**
 * 发言石传递是否合法。
 * 每条消息必须将发言石传给至少一个参与者，不允许空数组。
 * 对话结束由用户另行决定（complete/archive conversation），与发言石传递无关。
 */
export function isValidTalkingStonePass(recipients: string[]): boolean {
  return recipients.length > 0;
}
```

### 3. entities/otter/otter.ts

#### 3.1 类型定义

```typescript
/** Otter 类型 */
export type OtterType = "big" | "small";

/** Otter 状态 */
export type OtterStatus = "active" | "dissolved";

/** Otter 角色值对象 */
export interface OtterRole {
  name: string;
  responsibilities: string[];
}

/** Otter 实体 */
export interface Otter {
  id: string;
  name: string;
  type: OtterType;
  status: OtterStatus;
  role: OtterRole | null;
  parentOtterId: string | null;
  createdAt: string;
  dissolvedAt: string | null;
}
```

#### 3.2 不变量规则函数

```typescript
/**
 * 是否可以解散 Otter。
 * 仅 active 状态的 Otter 可被解散。
 * 来源：新增补强，旧 adapter dissolve() 隐含前置条件
 */
export function canDissolveOtter(status: OtterStatus): boolean {
  return status === "active";
}
```

### 4. entities/otter/otter-session.ts

#### 4.1 类型定义

```typescript
/** Session 状态 */
export type SessionStatus = "active" | "archived" | "restarted";

/** Otter Session 实体（链式，记录会话窗口历史） */
export interface OtterSession {
  id: string;
  otterId: string;
  status: SessionStatus;
  previousSessionId: string | null;    // 前序 Session，形成链表。首个 Session 为 null
  startedAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
  isNegativeCase: boolean;
  summary: string | null;
}
```

> 与旧代码差异：新增 `previousSessionId` 字段，形成 Session 链式关系。

#### 4.2 不变量规则函数

```typescript
/**
 * 是否可以归档 Session。
 * 仅 active 状态的 Session 可被归档。
 * 来源：旧 adapter.ts archiveSession() 方法中的状态校验
 */
export function canArchiveSession(status: SessionStatus): boolean {
  return status === "active";
}

/**
 * 归档原因到 Session 状态的映射。
 * 'restart' -> 'restarted'，其余 -> 'archived'
 * 来源：D36 示例 + 旧 repo archiveSession() 逻辑提取（旧 adapter 本身不做映射，映射在 repo 中）
 */
export function archiveReasonToSessionStatus(reason: string): SessionStatus {
  if (reason === "restart") {
    return "restarted";
  }
  return "archived";
}
```

### 5. entities/memory/memory-entry.ts

#### 5.1 类型定义

```typescript
/** 记忆层 */
export type MemoryLayer = "working" | "historical" | "key_info";

/** 记忆内容类型 */
export type MemoryContentType =
  | "message"
  | "conversation_summary"
  | "key_fact"
  | "linked_resource";

/** 检索粒度 */
export type RetrievalGranularity = "coarse" | "fine";

/** 记忆条目实体 */
export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId: string | null;
  granularity: RetrievalGranularity;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** 记忆权重实体 */
export interface MemoryWeight {
  memoryEntryId: string;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  userFlagged: boolean;
}
```

> 与旧代码差异：去除 `treePath` 字段（对话树去除后失去意义，用户确认去除）。

#### 5.2 不变量规则函数

```typescript
/**
 * 记忆层转换是否有效。
 * working -> historical：有效（session 归档时工作记忆转历史）
 * 其他转换：无效
 * 来源：新增不变量，基于业务语义（旧 adapter updateLayerByConversation() 直接调用 repo 无校验）
 */
export function canTransitionMemoryLayer(from: MemoryLayer, to: MemoryLayer): boolean {
  return from === "working" && to === "historical";
}
```

### 6. 不变量函数汇总

| 函数 | 所在文件 | 性质 | 对话聚焦 | 来源 |
|------|---------|------|---------|------|
| `canCompleteConversation` | conversation/conversation.ts | 提取 | ✅ | 旧 adapter complete() |
| `canArchiveConversation` | conversation/conversation.ts | 提取 | ✅ | 旧 adapter archive() |
| `isTurnActive` | conversation/conversation.ts | 新增 | ✅ | 轮次模型（UA-8） |
| `canAddMessageToTurn` | conversation/conversation.ts | 新增 | ✅ | 轮次模型（UA-8 推论） |
| `canCloseTurn` | conversation/conversation.ts | 新增 | ✅ | 轮次模型（UA-8） |
| `isTerminalMessageStatus` | conversation/message.ts | 提取 | ✅ | 消息状态机 |
| `canAppendEvent` | conversation/message.ts | 提取 | ✅ | 旧 adapter appendEvent() |
| `canCompleteMessage` | conversation/message.ts | 提取 | ✅ | 旧 adapter completeMessage() |
| `canFailMessage` | conversation/message.ts | 提取 | ✅ | 旧 adapter failMessage() |
| `isValidCompletedMessageBody` | conversation/message.ts | 提取 | ✅ | 旧 adapter completeMessage() body 校验 |
| `isValidTalkingStonePass` | conversation/message.ts | 新增 | ✅ | 发言石模型（UA-7, UA-9） |
| `canDissolveOtter` | otter/otter.ts | 新增补强 | | 旧 adapter dissolve() 隐含前置条件 |
| `canArchiveSession` | otter/otter-session.ts | 提取 | | 旧 adapter archiveSession() |
| `archiveReasonToSessionStatus` | otter/otter-session.ts | 提取 | | D36 示例 + 旧 repo archiveSession() 逻辑 |
| `canTransitionMemoryLayer` | memory/memory-entry.ts | 新增补强 | | 新增不变量，基于业务语义 |

> conversation 上下文 11 个不变量函数（完整覆盖），otter 3 个，memory 1 个。符合 UA-3/UA-4：对话聚焦 + 其余逐步补起。

### 7. 发言石轮次模型

#### 核心概念

| 概念 | 说明 |
|------|------|
| **发言石（Talking Stone）** | 发言权标识。持有发言石的参与者有权发言 |
| **轮次（Turn）** | 一轮发言。包含 1 个或多个 Message。一轮内所有发言者完成后才进入下一轮 |
| **传石头（talkingStonePassedTo）** | 每条消息必须指定下一批发言者，即传递发言石。不允许空数组 |
| **参与者** | 对话参与者 = 用户 + 所有关联的 Otter。所有人都能互相 @ |

#### 轮次流转示例

```
Turn 1: 用户发言
  Message 1: senderType="user", senderId="user-1"
             talkingStonePassedTo=["otter-A", "otter-B"]  ← 传石头给 A 和 B
  -> Turn 1 关闭（唯一发言者已完成）

Turn 2: Otter A 和 Otter B 同时发言
  Message 2: senderType="otter", senderId="otter-A"
             talkingStonePassedTo=["user-1"]               ← A 传石头回用户
  Message 3: senderType="otter", senderId="otter-B"
             talkingStonePassedTo=["user-1"]               ← B 传石头回用户
  -> Turn 2 关闭（所有发言者都 completed）

Turn 3: 用户发言，决定结束对话
  Message 4: senderType="user", senderId="user-1"
             talkingStonePassedTo=["otter-A"]              ← 仍然必须传石头
  -> 用户随后调用 completeConversation 结束对话（与传石头独立）
```

#### 发言石概念贯穿方式（类似「重启獭生」）

- 文档：统一使用「发言石」术语
- 代码：字段名 `talkingStonePassedTo`，不变量函数 `isValidTalkingStonePass`
- 注释：`// 发言石传递：指定下一轮发言者`

### 8. 依赖关系

```
entities/conversation/message.ts
  └── imports Attachment from entities/conversation/conversation.ts  (同层引用 ✅)

entities/otter/otter.ts           -- 无内部依赖
entities/otter/otter-session.ts   -- 无内部依赖
entities/memory/memory-entry.ts   -- 无内部依赖
```

所有实体文件不依赖任何外层（usecases/interface-adapters/frameworks），符合 ESLint 层依赖规则。

### 9. 与旧代码的差异

| 维度 | 旧代码 | 新代码 | 变因 |
|------|--------|-------|------|
| Conversation 字段 | 含 parentId, treePath | 去除 | UA-5 用户指令 |
| ConversationTreeNode | 存在 | 删除 | UA-5 用户指令 |
| Turn 实体 | 不存在 | 新增 | UA-7/UA-8 发言石轮次模型 |
| Message 字段 | 无 turnId, 无 talkingStonePassedTo | 新增两个必填字段 | UA-7/UA-8/UA-9 |
| MemoryEntry 字段 | 含 treePath | 去除 | UA-5 对话树去除 |
| OtterSession 字段 | 无 previousSessionId | 新增 | UA-11 Session 链式 |
| 不变量 | 散落在 adapter.ts | 集中为纯函数（D36） | F20260714zjmk D36 |
| Input 类型 | 在 model.ts 中 | 移至 usecases 层 | 整洁架构分层 |
| 检索类型 | 在 model.ts 中 | 移至 usecases/memory/ | 整洁架构分层 |

## 设计取舍

| 取舍点 | 正方 | 反方 | 最终选择 |
|--------|------|------|---------|
| Input 类型归属 | 放 entities 与实体类型内聚 | 放 usecases 保持 entities 纯粹 | 放 usecases。Input 类型含应用关注点，不是纯实体关注 |
| 不变量函数 vs 方法 | 纯函数（D36 已决策） | 实体方法 | 纯函数。D36 已锁定 |
| 文件粒度 | 每实体一个文件 | 每上下文一个文件 | 每实体一个文件（Turn 放 conversation.ts，与 Conversation 同文件） |
| memory 不变量覆盖 | 完整实现 | 仅 layer 转换 | 仅 layer 转换。UA-4 允许逐步补起 |
| KeyFact/LinkedResource 归属 | 独立文件 | 放 conversation.ts | 放 conversation.ts。对话上下文附属实体 |
| senderType 保留 | 自描述来源，无需查表 | 通过 senderId 查 otters 表判断 | 保留。用户消息和 Otter 消息有不同的生命周期状态机 |
| Turn 归属文件 | 独立 turn.ts | 放 conversation.ts | 放 conversation.ts。Turn 是对话级概念，与 Conversation 内聚 |
| 发言石字段命名 | mentionedParticipantIds | talkingStonePassedTo | talkingStonePassedTo。UA-10 贯彻发言石概念 |

## 关键决策记录

### KDR-1：body 非空校验归属（R1 决策）

- **决策点**：`completeMessage` 的 body 非空校验是实体不变量还是输入校验？
- **正方论点（架构师-2）**："completed message 必须有非空 body"定义实体合法状态，与调用方式无关，属领域不变量
- **反方论点（A1 替代方案）**：可作为输入校验放在 usecases，通过实现指引约束
- **最终决策**：增加为实体不变量函数 `isValidCompletedMessageBody`
- **决策依据**：该规则定义 Message 在 completed 状态下的合法状态，任何 use case 都应遵守
- **参与者**：架构师-1、架构师-2

### KDR-2：不变量来源标注精确性（G2 决策）

- **决策点**：不变量汇总表是否需要区分"提取自旧代码"与"新增补强"？
- **正方论点（架构师-2）**：精确标注可避免开发者到旧 adapter 找不到对应逻辑时困惑，且"新增"不变量需要额外验证语义正确性
- **反方论点（原设计）**：统一标注来源即可，不需要额外区分性质
- **最终决策**：增加"性质"列，区分"提取"(9 项) + "新增"(4 项) + "新增补强"(2 项) = 15 项
- **决策依据**：降低实现歧义，明确哪些不变量有旧代码对应、哪些需要独立验证
- **参与者**：架构师-1、架构师-2

### KDR-3：发言石轮次模型（用户指令）

- **决策点**：是否引入 Turn 实体和发言石机制？
- **正方论点（用户）**：多 Otter 对话需要有序的发言权传递，避免发言顺序混乱。发言石比喻清晰传达"谁有权发言"语义
- **反方论点（原设计）**：旧代码无 Turn/发言石，消息直接属于 Conversation，顺序由 sequenceNum 控制
- **最终决策**：引入 Turn 实体 + `talkingStonePassedTo` 必填字段
- **决策依据**：UA-5/UA-6/UA-7/UA-8/UA-9 用户明确要求。发言石模型确保对话有序，所有参与者（人+Otter）都能互相 @
- **参与者**：用户、架构师-1

### KDR-4：对话树去除（用户指令）

- **决策点**：是否保留 Conversation 的 parentId/treePath？
- **正方论点（用户）**：当前不需要对话树，conversation 只有自己。去除简化模型
- **反方论点（旧设计）**：对话树支持子对话继承父对话上下文
- **最终决策**：去除 parentId、treePath、ConversationTreeNode
- **决策依据**：UA-5 用户明确指令。MemoryEntry.treePath 同步去除（UA-5 确认）
- **参与者**：用户、架构师-1

### KDR-5：Session 链式关系（用户指令）

- **决策点**：OtterSession 间是否需要显式链式关系？
- **正方论点（用户）**：旧代码 Session 间无显式关联，无法体现 chain 前后关系
- **反方论点（旧设计）**：可通过 startedAt 排序推断顺序
- **最终决策**：新增 `previousSessionId` 字段，形成显式链表
- **决策依据**：UA-11 用户明确要求。显式链表比时间排序更可靠，支持回溯
- **参与者**：用户、架构师-1

## 核心业务行为

> entities 层是纯类型 + 纯函数层，不含业务编排。以下行为条目是"不变量函数必须保证的规则"，作为 usecases 层测试的回归守护。

| ID | 触发条件 | 预期行为 | 追溯 |
|----|---------|---------|------|
| B1 | 对话状态为 active 时调用 canCompleteConversation | 返回 true | ← UA-2, UA-3 |
| B2 | 对话状态非 active 时调用 canCompleteConversation | 返回 false | ← UA-2, UA-3 |
| B3 | 对话状态为 completed 时调用 canArchiveConversation | 返回 true | ← UA-2, UA-3 |
| B4 | 对话状态非 completed 时调用 canArchiveConversation | 返回 false | ← UA-2, UA-3 |
| B5 | 调用 isTurnActive 传入 "open" | 返回 true | ← UA-2, UA-3, UA-8 |
| B6 | 调用 isTurnActive 传入 "closed" | 返回 false | ← UA-2, UA-3, UA-8 |
| B7 | 调用 canCloseTurn 传入 true（所有消息终态） | 返回 true | ← UA-2, UA-3, UA-8 |
| B8 | 调用 canCloseTurn 传入 false（仍有非终态消息） | 返回 false | ← UA-2, UA-3, UA-8 |
| B9 | 调用 canAddMessageToTurn 传入 "open" | 返回 true | ← UA-2, UA-3, UA-8 |
| B10 | 调用 canAddMessageToTurn 传入 "closed" | 返回 false | ← UA-2, UA-3, UA-8 |
| B11 | 消息状态为 streaming 时调用 canAppendEvent/canCompleteMessage/canFailMessage | 均返回 true | ← UA-2, UA-3 |
| B12 | 消息状态为 completed 或 failed 时调用 canAppendEvent/canCompleteMessage/canFailMessage | 均返回 false | ← UA-2, UA-3 |
| B13 | 消息状态为 completed 或 failed 时调用 isTerminalMessageStatus | 返回 true | ← UA-2, UA-3 |
| B14 | 调用 isValidCompletedMessageBody 传入空字符串 | 返回 false | ← UA-2, UA-3 |
| B15 | 调用 isValidCompletedMessageBody 传入非空字符串 | 返回 true | ← UA-2, UA-3 |
| B16 | 调用 isValidTalkingStonePass 传入非空数组 | 返回 true | ← UA-2, UA-3, UA-7, UA-9 |
| B17 | 调用 isValidTalkingStonePass 传入空数组 | 返回 false | ← UA-2, UA-3, UA-7, UA-9 |
| B18 | 归档原因为 'restart' 时调用 archiveReasonToSessionStatus | 返回 'restarted' | ← UA-2 |
| B19 | 归档原因非 'restart' 时调用 archiveReasonToSessionStatus | 返回 'archived' | ← UA-2 |
| B20 | Session 状态为 active 时调用 canArchiveSession | 返回 true | ← UA-2 |
| B21 | Session 状态非 active 时调用 canArchiveSession | 返回 false | ← UA-2 |
| B22 | 记忆层从 working 转换到 historical 时调用 canTransitionMemoryLayer | 返回 true | ← UA-4 |
| B23 | 记忆层从 historical 或 key_info 转换时调用 canTransitionMemoryLayer | 返回 false | ← UA-4 |

## 硬约束

1. entities/ 不可 import usecases/、interface-adapters/、frameworks/（`@frameworks/logger` 除外，但本层不需要）
2. 所有不变量函数为纯函数：无副作用、无 I/O、无状态修改
3. `talkingStonePassedTo` 不允许为空数组（UA-9）
4. Conversation 不含 parentId、treePath（UA-5）
5. MemoryEntry 不含 treePath（UA-5）
6. OtterSession 必须含 previousSessionId（UA-11）
7. `tsc --noEmit` 通过
8. `eslint src/entities/` 无违规

## 验证

### 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] `eslint src/entities/` 无违规
- [ ] `src/entities/conversation/conversation.ts` 包含 Conversation(无parentId/treePath), Turn, KeyFact, LinkedResource, KeyInfo, Attachment 类型 + canCompleteConversation, canArchiveConversation, isTurnActive, canAddMessageToTurn, canCloseTurn 函数
- [ ] `src/entities/conversation/message.ts` 包含 Message(含turnId/talkingStonePassedTo), MessageEvent 类型 + isTerminalMessageStatus, canAppendEvent, canCompleteMessage, canFailMessage, isValidCompletedMessageBody, isValidTalkingStonePass 函数
- [ ] `src/entities/otter/otter.ts` 包含 Otter, OtterRole 类型 + canDissolveOtter 函数
- [ ] `src/entities/otter/otter-session.ts` 包含 OtterSession(含previousSessionId) 类型 + canArchiveSession, archiveReasonToSessionStatus 函数
- [ ] `src/entities/memory/memory-entry.ts` 包含 MemoryEntry(无treePath), MemoryWeight 类型 + canTransitionMemoryLayer 函数
- [ ] 无 entities/ -> 外层引用
- [ ] message.ts 通过同层 import 引用 Attachment 类型

## 关联

- **整洁架构 Feature 文档**：[F20260714zjmk](./F20260714zjmk-clean-architecture-restructuring.md)（目录结构、依赖规则、D30-D42 决策）
- **消息流式模型**：[F20260713e8n4](../13/F20260713e8n4-message-streaming-model.md)（Message/MessageEvent 类型定义）
- **Otter 领域模块**：[F20260713o4t8](../13/F20260713o4t8-domain-otter.md)（Otter/OtterSession 类型定义）
- **Memory 领域模块**：[F20260713m5q3](../13/F20260713m5q3-domain-memory.md)（MemoryEntry/MemoryWeight 类型定义）
- **S3 数据模型**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)（DDL schema 定义）
