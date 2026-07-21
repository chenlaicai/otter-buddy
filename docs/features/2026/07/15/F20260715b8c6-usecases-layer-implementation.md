---
id: F20260715b8c6
title: usecases-layer-implementation
doc_type: feature

# 记忆索引
summary: |
  > 本文档定义整洁架构 usecases 层的 Repository/Gateway 接口 + use case class + search-engine，遵循 F20260714zjmk 锁定的目录结构和设计决策。 - F20260714zjmk Setup 已合入（PR #13）：旧代码...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260714zjmk
    - F20260714jaup
    - F20260713e8n4
    - F20260713o4t8
    - F20260713m5q3


# 元数据
status: implemented
change_type: feature
tags: [architecture, usecases, clean-architecture, conversation, otter, memory, talking-stone]
modules: [src/usecases/]

# 时间
created_at: 2026-07-15
---


# F20260715b8c6 整洁架构 Use Cases 层实现

## [design-time]

> 本文档定义整洁架构 usecases 层的 Repository/Gateway 接口 + use case class + search-engine，遵循 F20260714zjmk 锁定的目录结构和设计决策。

## 背景 [required]

### 当前状态

- F20260714zjmk Setup 已合入（PR #13）：旧代码归档、四层目录、ESLint 层依赖规则
- F20260714jaup Entities 已合入（PR #15）：三上下文实体类型 + 不变量规则函数
- 本 Issue 对应 F20260714zjmk 实现计划的 Issue 3：usecases 层

### 旧代码参考源

| 上下文 | 旧 port.ts（接口定义参考） | 旧 adapter.ts（业务逻辑参考） | 旧其他 |
|--------|---------------------------|-----------------------------|--------|
| otter | `reference/old-src/domain/otter/port.ts` | `reference/old-src/domain/otter/_internal/adapter.ts` | `reference/old-src/domain/otter/model.ts`（Input 类型） |
| memory | `reference/old-src/domain/memory/port.ts` | `reference/old-src/domain/memory/_internal/adapter.ts` | `reference/old-src/domain/memory/_internal/search-engine.ts`、`model.ts` |
| conversation | `reference/old-src/domain/conversation/port.ts` | `reference/old-src/domain/conversation/_internal/adapter.ts` | `reference/old-src/domain/conversation/model.ts` |

### 上游设计约束

- **D32**：Repository 接口归属 usecases 层，frameworks 实现
- **D35**：orchestration 从 app 层移到 usecases（UA-12 调整：去除 orchestration 目录，改为 Gateway 接口）
- **D37**：frameworks/db/ 实现 usecases 定义的 Repository 接口（依赖反转）
- **D39**：logger 作为 cross-cutting concern 豁免层依赖规则，usecases 可直接 import `@frameworks/logger`
- **D40**：目录即边界，消费者直接 import use case class，不需要 facade
- **D41**：search-engine.ts 归属 `usecases/memory/`
- **KDR-1**（F20260714zjmk）：use case 形状为 class + execute()
- **Config 注入规则**：usecases 需要的配置值通过 main.ts 构造函数注入，不直接 import frameworks/config.ts

### Entities 层变更对本 Issue 的影响

F20260714jaup 对实体做了以下变更，usecases 设计需相应适配：

| 变更 | 对 usecases 的影响 |
|------|-------------------|
| 去除对话树（parentId, treePath） | 删除 `manage-tree.ts`（F20260714zjmk 原设计文件），所有 tree 相关 use case 逻辑删除 |
| 新增 Turn 实体 + 发言石机制 | 新增 Turn 管理 use case（open/close），send-message 逻辑需集成 turnId 和 talkingStonePassedTo |
| 新增 previousSessionId | manage-session 的 createSession 需设置 previousSessionId |
| MemoryEntry 去除 treePath | SearchEngine 删除 `computeTaskRelevance`，SearchQuery 删除 treePath 字段 |

### Entities 层导出清单（import 路径参照）

| 文件 | 导出 |
|------|------|
| `@entities/conversation/conversation` | Conversation, ConversationStatus, Turn, TurnStatus, KeyFact, LinkedResource, KeyInfo, Attachment, canCompleteConversation, canArchiveConversation, isTurnActive, canAddMessageToTurn, canCloseTurn |
| `@entities/conversation/conversation` (E3 待合入) | **+** ConversationParticipant, ParticipantStatus, canJoinConversation, canLeaveConversation |
| `@entities/conversation/message` | Message, MessageEvent, SenderType, MessageStatus, MessageEventType, isTerminalMessageStatus, canAppendEvent, canCompleteMessage, canFailMessage, isValidCompletedMessageBody, isValidTalkingStonePass |
| `@entities/conversation/message` (E1-E2 待合入) | **+** SenderType 增加 `"system"`；isValidTalkingStonePass 签名变更为 `(recipients, status, senderType)` |
| `@entities/otter/otter` | Otter, OtterType, OtterStatus, OtterRole, canDissolveOtter |
| `@entities/otter/otter-session` | OtterSession, SessionStatus, canArchiveSession, archiveReasonToSessionStatus |
| `@entities/memory/memory-entry` | MemoryEntry, MemoryWeight, MemoryLayer, MemoryContentType, RetrievalGranularity, canTransitionMemoryLayer |

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "entity已合入，你继续按照F20260714zjmk 继续下一步实现" | 时序：entity 已合入后；依据：F20260714zjmk；操作：继续下一步实现 | 用户确认 entities 层完成，要求按 F20260714zjmk 锁定的实现计划推进 Issue 3：usecases 层 | msg-1 |
| UA-2 | "业务场景可以聚焦在 对话能力上" | 对象：对话能力；方式：聚焦（引用自 F20260714jaup UA-3） | conversation 上下文的 use case 需最完整实现（含 Turn/发言石），otter 和 memory 做基础实现 | F20260714jaup UA-3 |
| UA-3 | "其余能力后续可以逐步补起优化" | 时序：后续逐步（引用自 F20260714jaup UA-4） | 非 conversation 的 use case 可做基础实现，后续 Issue 逐步完善 | F20260714jaup UA-4 |
| UA-4 | "otter系统中需要增加一种 系统消息" | 对象：系统消息；范围：otter 系统 | 需要新增 senderType="system" 的消息类型，用于系统事件通知 | msg-5000 |
| UA-5 | "第3turn时，大獭发言此时引入 设计獭 进场，那么此时就应该有一条消息就应该是 系统发的 设计獭进场" | 时序：某 turn 中；触发：大獭发言引入；产物：系统消息 | Otter 进场时自动生成系统消息，消息归属于当前 Turn | msg-5000 |
| UA-6 | "设计獭 的进场时间（轮数是第3turn）也应该有记录，最后可能二十轮次后，设计獭 完成工作，那此时就应该退场了（即退场轮数也应该有记录）" | 对象：进场轮数+退场轮数；程度：都应该有记录 | Otter 参与记录需包含进场 Turn 和退场 Turn | msg-5000 |
| UA-7 | "即otter应该有进场+退场记录，那么《当前在场的獭》这个也得随之变化了" | 对象：进场+退场记录；关联：在场名单随之变化 | 需维护动态在场名单，随进场/退场事件更新 | msg-5000 |
| UA-8 | "豁免；并且，其实在msg streaming过程中，这个字段也允许为空，但completed时不允许为空" | 条件：streaming 可空，completed 不可空，系统消息豁免 | `isValidTalkingStonePass` 规则变更：system 始终豁免；streaming 可为空；completed（user/otter）必须非空。failed 豁免为架构师推断（failed 消息 body 为 null，发言石无意义） | msg-5000 |
| UA-9 | "进场与 发言石 是不相干的两码事，不要混在一起" | 条件：不相干；方式：不要混在一起 | 进场/退场是独立操作，不通过 talkingStonePassedTo 触发 | msg-5000 |
| UA-10 | "准确来说，即使都是'设计獭'，再次进场后也是一个新的獭实例，不需要考虑复用" | 条件：即使同名；结果：新实例；程度：不需要考虑复用 | 每个 Otter 实例只进场/退场一次，重复进场通过 CreateOtter 创建新实例 | msg-5000 |
| UA-11 | "shared严禁存在；因为我遇到过，当有了shared目录后，你（ai）为了快速解决问题的llm思维方式，基本都会导致形成god class，导致代码架构混乱" | 对象：shared 目录；程度：严禁；理由：LLM 形成 god class | usecases 层严禁 shared/ 或任何跨上下文共享目录 | msg-5013 |
| UA-12 | "我认为这个目录不够优雅...我期望 站在业务场景角度来梳理 各个用例场景" + "如果没有循环依赖都是单向依赖，那就应该用gateway依赖倒置的方式来处理" | 对象：orchestration 目录；评价：不够优雅；方式：业务场景角度 + Gateway 依赖倒置 | 去除 orchestration/ 目录，跨上下文依赖全部通过 Gateway 接口处理。每个上下文完全自包含 | msg-5015 |

## 目标 [required]

### P1 - Repository/Gateway 接口定义

在 usecases 层定义 OtterRepository、MemoryRepository、ConversationRepository 接口和 AgentGateway、EmbeddingGateway 接口（D32）。frameworks 层将在后续 Issue 中实现这些接口（D37）。

### P2 - Use case class 实现

参照旧代码 `domain/*/port.ts` + `_internal/adapter.ts`，在新 `src/usecases/` 下实现全部 use case class。每个 use case 为 class + execute() 形状（KDR-1），通过构造函数注入 Repository/Gateway。

### P3 - SearchEngine 迁移

将旧代码 `search-engine.ts` 迁移到 `usecases/memory/search-engine.ts`（D41），删除 treePath 相关逻辑，保留 RRF 融合 + 权重重排核心算法。

### P4 - 跨上下文 Gateway 接口设计

设计跨模块编排 use case（D35），组合多个上下文的 use case 完成业务事务。

### P5 - 可编译验证

- `tsc --noEmit` 通过
- `eslint src/usecases/` 无违规
- 层依赖规则验证：usecases/ 不 import interface-adapters/ 或 frameworks/（`@frameworks/logger` 除外）

## 非目标 [required]

- 不实现 frameworks 层（DB repository 实现、mapper、LLM gateway 等）
- 不实现 interface-adapters 层（HTTP controllers、agent-runtime）
- 不实现 main.ts 装配
- 不实现测试（测试随 interface-adapters 层 Issue 一起实现）
- 不改变已有数据库 schema（表结构、索引不变。新表创建由 frameworks 层处理）
- 不引入新的第三方依赖
- 不直接修改 entities 层代码（entities 变更为前置依赖，见下文）

### Entities 层变更前置依赖

用户在 design 阶段提出系统消息 + Otter 进场/退场需求（UA-4 ~ UA-10），需要 entities 层变更。entities 层已合入（F20260714jaup），变更需创建新 feature 文档并独立合入。

**前置依赖清单**（entities 变更 Issue 合入后才能编译验证 usecases 层）：

| ID | 变更 | 说明 |
|----|------|------|
| E1 | `SenderType` 增加 `"system"` | `@entities/conversation/message.ts` |
| E2 | `isValidTalkingStonePass` 签名变更 | 增加 `status: MessageStatus` 和 `senderType: SenderType` 参数；system 豁免、streaming/failed 可空、completed（user/otter）必须非空 |
| E3 | 新增 `ConversationParticipant` 实体 | `@entities/conversation/conversation.ts`。含 `ParticipantStatus`, `canJoinConversation`, `canLeaveConversation` |
| E4 | `ConversationParticipant` 字段 | `id, conversationId, otterId, joinedAtTurnId, joinedAtTurnNumber, leftAtTurnId, leftAtTurnNumber, status, createdAt, leftAt` |

## 设计 [required]

### 文件结构

```
src/usecases/
  otter/
    otter-repository.ts          -- OtterRepository 接口
    agent-gateway.ts             -- AgentGateway 接口
    create-otter.ts              -- CreateOtter use case
    dissolve-otter.ts            -- DissolveOtter use case
    manage-session.ts            -- ManageSession use case（create/get/archive/history）
    query-otter.ts               -- QueryOtter use case（getById/getBigOtter）
  memory/
    memory-repository.ts         -- MemoryRepository 接口
    embedding-gateway.ts         -- EmbeddingGateway 接口
    search-engine.ts             -- RRF 融合 + 权重重排（纯类，无外部依赖）
    store-memory.ts              -- StoreMemory use case
    search-memory.ts             -- SearchMemory use case（search + searchSimilar）
    manage-memory.ts             -- ManageMemory use case（query/flag/layer transition）
  conversation/
    conversation-repository.ts   -- ConversationRepository 接口
    memory-index-gateway.ts      -- MemoryIndexGateway 接口（跨上下文 Gateway，UA-12）
    send-message.ts              -- SendMessage use case（send/start/append/complete/fail + Turn 管理 + 记忆索引）
    manage-conversation.ts       -- ManageConversation use case（create/get/complete/archive + getIdsByOtterId + 参与者初始化）
    manage-participant.ts        -- ManageParticipant use case（join/leave/getActiveParticipants）[UA-4~UA-10]
    query-message.ts             -- QueryMessage use case（getById/getMessages/getEvents/expand）
    manage-key-info.ts           -- ManageKeyInfo use case（addKeyFact/linkResource/getKeyInfo + 记忆索引）
```

> **与 F20260714zjmk 原设计差异**：
> - `manage-tree.ts` -> 删除（对话树已去除，UA-5），Turn 管理逻辑内聚到 `send-message.ts`
> - 新增 `query-otter.ts`：otter 查询操作（getById/getBigOtter）独立成文件
> - 新增 `manage-memory.ts`：memory 简单 CRUD 操作（getById/getBySource/getWeight/flagMemory/updateLayer）
> - 新增 `query-message.ts`：message 查询操作独立成文件
> - 新增 `manage-key-info.ts`：key fact + linked resource 管理独立成文件
> - 新增 `manage-participant.ts`：Otter 进场/退场管理（UA-4~UA-10）
> - 新增 `memory-index-gateway.ts`：跨上下文记忆索引 Gateway（UA-12）
> - **去除 orchestration/ 目录**（UA-12）：跨上下文协调通过 Gateway 依赖倒置，不使用编排目录
>
> 理由：文件名即意图，LLM 生成时上下文更聚焦（KDR-1 设计原则延伸）
>
> **总计 19 文件**（6 otter + 6 memory + 7 conversation）

### 类型归属规则

| 类别 | 归属文件 | 判据 |
|------|---------|------|
| Use case 输入类型（CreateOtterInput, ArchiveSessionInput, MemoryEntryInput, SearchQuery, SendMessageInput, StartMessageInput, MessageEventInput, CompleteMessageInput, KeyFactInput, LinkedResourceInput） | 各 use case 文件 | 应用层 DTO，含应用关注点 |
| 检索结果类型（RetrievalResult） | `search-memory.ts` | 检索算法实现细节 |
| RetrievalSource, FTSHit, VecHit | `memory-repository.ts` | Repository 返回类型，归属 Repository 文件（R1 修复） |
| RrfHit, ScoredHit | `search-engine.ts` | SearchEngine 内部类型 |
| SearchEngineConfig | `search-engine.ts` | 算法配置 |
| ArchiveSessionParams | `otter-repository.ts` | Repository 接口的参数类型 |
| AgentConfig, AgentContext | `agent-gateway.ts` | Gateway 接口的附属类型 |
| SearchFilters | `memory-repository.ts` | Repository 接口的参数类型 |
| GetMessagesOptions | `conversation-repository.ts` | Repository 接口的参数类型 |

### 1. usecases/otter/

#### 1.1 otter-repository.ts

```typescript
import type { Otter } from "@entities/otter/otter";
import type { OtterSession, SessionStatus } from "@entities/otter/otter-session";

/** archiveSession 的参数类型（Repository 层，不含应用关注点） */
export interface ArchiveSessionParams {
  reason: string;
  isNegativeCase: boolean;
  summary?: string;
}

export interface OtterRepository {
  createOtter(otter: Otter): Promise<void>;
  getById(id: string): Promise<Otter | null>;
  getBigOtter(): Promise<Otter | null>;
  dissolve(otterId: string, dissolvedAt: string): Promise<void>;
  deleteOtter(otterId: string): Promise<void>;  // 回滚用
  createSession(session: OtterSession): Promise<void>;
  getActiveSession(otterId: string): Promise<OtterSession | null>;
  archiveSession(sessionId: string, status: SessionStatus, params: ArchiveSessionParams, archivedAt: string): Promise<void>;
  getSessionHistory(otterId: string): Promise<OtterSession[]>;
  getSessionById(sessionId: string): Promise<OtterSession | null>;
}
```

> `ArchiveSessionParams` 和 `SessionStatus` 均在本文件或 entities 层定义，Repository 接口不依赖 use case 文件（M1 修复）。

#### 1.2 agent-gateway.ts

```typescript
/** Agent 配置（create 时传入） */
export interface AgentConfig {
  systemPrompt: string;
  context?: Record<string, unknown>;
}

/** Agent 重置上下文 */
export interface AgentContext {
  systemPrompt?: string;
  context?: Record<string, unknown>;
}

/** Agent 生命周期网关接口（由 frameworks/agent/ 实现） */
export interface AgentGateway {
  create(otterId: string, config: AgentConfig): Promise<void>;
  destroy(otterId: string): Promise<void>;
  reset(otterId: string, context?: AgentContext): Promise<void>;
}
```

> 来源：旧代码 `AgentLifecyclePort`，重命名为 `AgentGateway`（F20260714zjmk 设计文档用语）。

#### 1.3 create-otter.ts

```typescript
import type { Otter, OtterType, OtterRole } from "@entities/otter/otter";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";

export interface CreateOtterInput {
  name: string;
  type: OtterType;
  role?: OtterRole;
  parentOtterId?: string;
  systemPrompt: string;
  context?: Record<string, unknown>;
}

export class CreateOtter {
  constructor(
    private readonly repo: OtterRepository,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(params: CreateOtterInput): Promise<Otter> {
    // 1. 生成 Otter 实体
    // 2. repo.createOtter() 写入 DB
    // 3. agentGateway.create() 创建 Agent
    // 4. Agent 创建失败时：repo.deleteOtter() 回滚 + rethrow（B1 回归守护）
  }
}
```

> 来源：旧 `adapter.ts create()` 方法。核心业务逻辑：DB 写入 + Agent 创建 + 失败回滚。

#### 1.4 dissolve-otter.ts

```typescript
import { canDissolveOtter } from "@entities/otter/otter";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";
import type { ManageSession, ArchiveSessionInput } from "./manage-session";

export class DissolveOtter {
  constructor(
    private readonly repo: OtterRepository,
    private readonly agentGateway: AgentGateway,
    private readonly manageSession: ManageSession,
  ) {}

  /**
   * 解散 Otter（完整业务操作）。
   * 含：归档 active session（含记忆转换 + Agent reset）+ 状态更新 + Agent 销毁。
   */
  async execute(otterId: string): Promise<void> {
    // 1. repo.getById() + 空值检查
    // 2. canDissolveOtter(status) 不变量校验
    // 3. manageSession.getActiveSession(otterId) -> 如有，manageSession.archiveSession()
    //    ArchiveSessionInput: { reason: "dissolve", isNegativeCase: false }
    //    （含记忆层转换 + Agent reset，通过 ManageSession 内部 Gateway 实现）
    // 4. repo.dissolve() 更新状态为 dissolved
    // 5. agentGateway.destroy() 销毁 Agent（B5 回归守护）
    //    注：agent reset 在步骤 3 已执行，此处 destroy 是最终销毁，无害
  }
}
```

> 来源：旧 `adapter.ts dissolve()` 方法。

#### 1.5 manage-session.ts

```typescript
import type { OtterSession, SessionStatus } from "@entities/otter/otter-session";
import { canArchiveSession, archiveReasonToSessionStatus } from "@entities/otter/otter-session";
import type { MemoryLayer } from "@entities/memory/memory-entry";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";

/** Gateway: 查询 otter 关联的对话 ID（由 main.ts 装配 ManageConversation 实现） */
export interface ConversationQueryGateway {
  getIdsByOtterId(otterId: string): Promise<string[]>;
}

/** Gateway: 记忆层转换（由 main.ts 装配 ManageMemory 实现） */
export interface MemoryLayerGateway {
  updateLayer(conversationId: string, from: MemoryLayer, to: MemoryLayer): Promise<void>;
}

export interface ArchiveSessionInput {
  reason: string;
  isNegativeCase: boolean;
  summary?: string;
}

export class ManageSession {
  constructor(
    private readonly repo: OtterRepository,
    private readonly agentGateway: AgentGateway,
    private readonly conversationQuery: ConversationQueryGateway,
    private readonly memoryLayer: MemoryLayerGateway,
  ) {}

  /**
   * 创建新 Session。
   * 前置条件：该 otter 无 active session。
   * previousSessionId 指向前一个 session（链式关系）。
   */
  async createSession(otterId: string): Promise<OtterSession> {
    // 1. repo.getActiveSession(otterId) 检查无 active session（前置条件）
    // 2. 生成新 Session，previousSessionId = 最近一个 session 的 id（如果有）
    // 3. repo.createSession()
  }

  async getActiveSession(otterId: string): Promise<OtterSession | null> {
    // repo.getActiveSession()
  }

  /**
   * 归档 Session（完整业务操作）。
   * 含：状态更新 + 工作记忆转历史 + Agent reset。
   * 通过 Gateway 接口调用跨上下文能力，不直接依赖 conversation/memory 上下文。
   */
  async archiveSession(sessionId: string, params: ArchiveSessionInput): Promise<OtterSession> {
    // 1. repo.getSessionById() + 空值检查
    // 2. canArchiveSession(status) 不变量校验
    // 3. archiveReasonToSessionStatus(reason) 计算目标状态
    // 4. repo.archiveSession()（B3/B4 回归守护）
    // 5. conversationQuery.getIdsByOtterId(session.otterId) -> conversationIds[]
    // 6. 对每个 conversationId：memoryLayer.updateLayer(conversationId, "working", "historical")（B10）
    // 7. agentGateway.reset(session.otterId)（重置 Agent 上下文）
    // 8. 返回 OtterSession
  }

  async getSessionHistory(otterId: string): Promise<OtterSession[]> {
    // repo.getSessionHistory()，按 startedAt 降序
  }
}
```

> 来源：旧 `adapter.ts createSession()/archiveSession()` 方法 + 原 ArchiveSessionFlow 逻辑（已合并到 ManageSession，UA-12）。
>
> **设计决策**（UA-12）：
> - `archiveSession` 是完整业务操作：状态更新 + 记忆层转换 + Agent reset。原 orchestration flow 逻辑合并到 use case 内。
> - 跨上下文能力通过 Gateway 接口调用（`ConversationQueryGateway` + `MemoryLayerGateway`），不直接 import conversation/memory 上下文。
> - Gateway 接口定义在本文件内，由 main.ts 装配具体实现。
> - `archiveSession` 返回 `OtterSession`，供 `DissolveOtter` 获取 `otterId`。

#### 1.6 query-otter.ts

```typescript
import type { Otter } from "@entities/otter/otter";
import type { OtterRepository } from "./otter-repository";

export class QueryOtter {
  constructor(private readonly repo: OtterRepository) {}

  async getById(id: string): Promise<Otter | null> {
    // repo.getById()
  }

  async getBigOtter(): Promise<Otter> {
    // repo.getBigOtter() + 空值检查时 throw（B2 回归守护：大獭必须存在）
  }
}
```

> 来源：旧 `adapter.ts getById()/getBigOtter()` 方法。

### 2. usecases/memory/

#### 2.1 memory-repository.ts

```typescript
import type { MemoryEntry, MemoryWeight, MemoryLayer, RetrievalGranularity } from "@entities/memory/memory-entry";

export interface SearchFilters {
  layer?: MemoryLayer;
  granularity?: RetrievalGranularity;
  conversationId?: string;
}

/** 检索来源标识 */
export type RetrievalSource = "fts" | "vec" | "both";

/** FTS5 全文检索命中 */
export interface FTSHit {
  entryId: string;
  ftsRank: number;
  entry: MemoryEntry;
}

/** vec0 向量检索命中 */
export interface VecHit {
  entryId: string;
  distance: number;
  entry: MemoryEntry;
}

export interface MemoryRepository {
  // 写入
  storeEntry(entry: MemoryEntry): Promise<void>;  // 事务：entries + fts + weights
  storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void>;
  // 查询
  getById(id: string): Promise<MemoryEntry | null>;
  getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null>;
  getEmbedding(memoryEntryId: string): Promise<Float32Array | null>;
  getWeights(memoryEntryIds: string[]): Promise<MemoryWeight[]>;
  // 检索
  searchFTS(query: string, filters: SearchFilters): Promise<FTSHit[]>;
  searchVec(embedding: Float32Array, limit: number, filters: SearchFilters): Promise<VecHit[]>;
  hasVecTable(): boolean;
  // 更新
  incrementRetrievalCounts(memoryEntryIds: string[]): Promise<void>;
  flagMemory(memoryEntryId: string, flagged: boolean): Promise<void>;
  updateLayerByConversation(conversationId: string, from: MemoryLayer, to: MemoryLayer): Promise<void>;
}
```

> `RetrievalSource`、`FTSHit`、`VecHit`、`SearchFilters` 均在本文件定义，作为 Repository 接口的返回类型/参数类型归属 Repository 文件（R1 修复）。`search-memory.ts` 和 `search-engine.ts` 都从本文件导入这些类型，不产生反向依赖或循环依赖。

#### 2.2 embedding-gateway.ts

```typescript
/** Embedding 网关接口（由 frameworks/embedding/ 实现） */
export interface EmbeddingGateway {
  embed(text: string): Promise<Float32Array>;
}
```

> 来源：旧代码 `EmbeddingService`，重命名为 `EmbeddingGateway`。

#### 2.3 search-engine.ts

```typescript
import type { MemoryEntry, MemoryWeight } from "@entities/memory/memory-entry";
import type { RetrievalSource, FTSHit, VecHit } from "./memory-repository";

export interface SearchEngineConfig {
  rrfK: number;                    // RRF 常数，默认 60
  weightHalfLifeDays: number;      // 权重时间衰减半衰期，默认 7
  userFlagMultiplier: number;      // 用户标记加权倍数
  frequencyBoostFactor: number;    // 检索频率加权因子
}

export interface RrfHit {
  entryId: string;
  rrfScore: number;
  source: RetrievalSource;  // "fts" | "vec" | "both"
  entry: MemoryEntry;        // 携带实体数据，rerank 需要计算 timeDecay（C2 修复）
}

export interface ScoredHit {
  entryId: string;
  finalScore: number;
  rrfScore: number;
  source: RetrievalSource;
  entry: MemoryEntry;        // 携带实体数据，供 RetrievalResult 组装（C2 修复）
}

export class SearchEngine {
  constructor(private readonly config: SearchEngineConfig) {}

  /** RRF 融合：FTS + Vec 两路结果合并 */
  rrfFusion(ftsHits: FTSHit[], vecHits: VecHit[]): Map<string, RrfHit> { ... }

  /** 单源 RRF（用于 searchSimilar） */
  buildSingleSourceRrfHits(hits: VecHit[]): Map<string, RrfHit> { ... }

  /** 权重重排：rrfScore × timeDecay × frequencyBoost × userFlagMultiplier */
  rerank(hits: Map<string, RrfHit>, weights: Map<string, MemoryWeight>): ScoredHit[] { ... }

  // private computeTimeDecay(createdAt: string): number
  //   - exp(-ln(2) * age_days / half_life_days)
  // private computeFrequencyBoost(retrievalCount: number): number
  //   - log(1 + count) * factor + 1
}
```

> **与旧代码差异**：
> - 删除 `computeTaskRelevance`（依赖 treePath，已去除）
> - 删除 `samePathBoost` 和 `crossPathDecay` 配置项
> - `rerank` 签名移除 `currentTreePath` 参数
> - `computeFinalScore` 简化为：`rrfScore × timeDecay × frequencyBoost × userFlagMultiplier`
> - `RrfHit` 和 `ScoredHit` 保留 `entry: MemoryEntry` 字段（rerank 需要 createdAt 计算 timeDecay）
>
> 来源：旧 `search-engine.ts`，去除 treePath 逻辑。

#### 2.4 store-memory.ts

```typescript
import type { MemoryLayer, MemoryContentType, RetrievalGranularity } from "@entities/memory/memory-entry";
import type { MemoryRepository } from "./memory-repository";
import type { EmbeddingGateway } from "./embedding-gateway";

export interface MemoryEntryInput {
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId?: string;
  granularity: RetrievalGranularity;
  content: string;
  metadata?: Record<string, unknown>;
}

export class StoreMemory {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
  ) {}

  async execute(input: MemoryEntryInput): Promise<string> {
    // 1. 生成 UUID
    // 2. 构造 MemoryEntry 实体
    // 3. repo.storeEntry()（同步事务：entries + fts + weights）
    // 4. fire-and-forget embeddingGateway.embed(content) -> repo.storeEmbedding()
    //    嵌入失败为降级模式（D22：FTS5 仍可检索，entry 不阻塞）
    // 5. 返回 memoryEntryId
  }
}
```

> 来源：旧 `adapter.ts store()` 方法。核心逻辑：同步事务写入 + 异步嵌入 + 降级容错。

#### 2.5 search-memory.ts

```typescript
import type { MemoryEntry, MemoryLayer, RetrievalGranularity } from "@entities/memory/memory-entry";
import type { MemoryRepository, SearchFilters, RetrievalSource, FTSHit, VecHit } from "./memory-repository";
import type { EmbeddingGateway } from "./embedding-gateway";
import type { SearchEngine, RrfHit, ScoredHit } from "./search-engine";

export interface SearchQuery {
  query: string;
  limit: number;
  layer?: MemoryLayer;
  granularity?: RetrievalGranularity;
  conversationId?: string;
}

export interface RetrievalResult {
  entries: Array<MemoryEntry & { score: number; source: RetrievalSource }>;
  total: number;
}

export class SearchMemory {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly searchEngine: SearchEngine,
  ) {}

  async search(query: SearchQuery): Promise<RetrievalResult> {
    // 1. repo.searchFTS()（始终可用）
    // 2. searchVec()（私有，降级容错：失败返回 []）
    // 3. searchEngine.rrfFusion(fts, vec) -> Map<entryId, RrfHit>
    // 4. rerankAndReturn()（私有）
  }

  async searchSimilar(memoryEntryId: string, limit: number): Promise<RetrievalResult> {
    // 1. repo.getEmbedding(memoryEntryId)
    // 2. repo.searchVec(limit + 1) -> 过滤自身
    // 3. searchEngine.buildSingleSourceRrfHits() -> rerankAndReturn()
  }

  // private async searchVec(query: string, filters: SearchFilters): Promise<VecHit[]>
  //   - repo.hasVecTable() 检查 -> embeddingGateway.embed() -> repo.searchVec()
  //   - 失败时 log warning, return []

  // private async rerankAndReturn(hits: Map<string, RrfHit>, limit: number): Promise<RetrievalResult>
  //   - repo.getWeights() 批量获取
  //   - searchEngine.rerank() 重排
  //   - 按 finalScore 降序排序 -> slice(limit)
  //   - repo.incrementRetrievalCounts() 批量更新检索计数
  //   - 组装 RetrievalResult（B6 回归守护）
}
```

> 来源：旧 `adapter.ts search()/searchSimilar()` 方法 + 私有方法 `searchVec()`、`rerankAndReturn()`。
>
> **与旧代码差异**：
> - SearchQuery 移除 `treePath` 字段
> - RetrievalResult 形状从 `{ entries, scores, sources }` 改为 `{ entries: Array<MemoryEntry & { score, source }>, total }`，更符合人体工程学

#### 2.6 manage-memory.ts

```typescript
import type { MemoryEntry, MemoryWeight, MemoryLayer } from "@entities/memory/memory-entry";
import { canTransitionMemoryLayer } from "@entities/memory/memory-entry";
import type { MemoryRepository } from "./memory-repository";

export class ManageMemory {
  constructor(private readonly repo: MemoryRepository) {}

  async getById(id: string): Promise<MemoryEntry | null> {
    // repo.getById()
  }

  async getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null> {
    // repo.getBySource()
  }

  async getWeight(memoryEntryId: string): Promise<MemoryWeight> {
    // repo.getWeights([id]) -> 取第一条
  }

  async flagMemory(memoryEntryId: string, flagged: boolean): Promise<void> {
    // repo.flagMemory()
  }

  async updateLayer(conversationId: string, from: MemoryLayer, to: MemoryLayer): Promise<void> {
    // 1. canTransitionMemoryLayer(from, to) 不变量校验
    // 2. repo.updateLayerByConversation()
  }
}
```

> 来源：旧 `adapter.ts` 中的简单 CRUD 方法。
>
> **设计决策**：`updateLayer` 使用 entities 层的 `canTransitionMemoryLayer` 不变量校验，确保层转换合法。`incrementRetrievalCounts` 和 `storeEmbedding`/`getEmbedding` 是 SearchMemory 和 StoreMemory 的内部调用，不暴露为独立 use case 方法。

### 3. usecases/conversation/

#### 3.1 conversation-repository.ts

```typescript
import type {
  Conversation, ConversationStatus,
  Turn,
  KeyFact, LinkedResource, Attachment,
  ConversationParticipant,
} from "@entities/conversation/conversation";
import type {
  Message, MessageEvent, MessageStatus,
} from "@entities/conversation/message";

export interface GetMessagesOptions {
  limit?: number;
  before?: string;   // cursor：返回此 messageId 之前的消息（M3 修复，与 expandMessage 一致）
  status?: MessageStatus;
  turnId?: string;
}

export interface ConversationRepository {
  // Conversation CRUD
  create(conversation: Conversation, otterIds?: string[]): Promise<void>;  // 单事务：conversations + conversation_otters（C5 修复）
  getById(id: string): Promise<Conversation | null>;
  updateStatus(id: string, status: ConversationStatus, timestamp: string): Promise<void>;
  getIdsByOtterId(otterId: string): Promise<string[]>;  // 通过 conversation_otters 关联查询（C3 修复）

  // 对话参与者
  getOtterIds(conversationId: string): Promise<string[]>;  // C5 修复

  // Turn 管理
  createTurn(turn: Turn): Promise<void>;
  getActiveTurn(conversationId: string): Promise<Turn | null>;
  closeTurn(turnId: string, closedAt: string): Promise<void>;
  getMaxTurnNumber(conversationId: string): Promise<number>;
  getMessagesByTurnId(turnId: string): Promise<Message[]>;

  // Message 生命周期
  createCompletedMessage(message: Message): Promise<void>;
  createStreamingMessage(message: Message): Promise<void>;
  completeMessage(messageId: string, body: string, talkingStonePassedTo: string[], attachments: Attachment[] | null, completedAt: string): Promise<void>;  // UA-8: completed 时写入 talkingStonePassedTo
  failMessage(messageId: string): Promise<void>;
  getMaxSequenceNum(conversationId: string): Promise<number>;

  // Message 查询
  getMessageById(id: string): Promise<Message | null>;
  getMessages(conversationId: string, options: GetMessagesOptions): Promise<Message[]>;
  getMessagesBefore(messageId: string, count: number): Promise<Message[]>;
  getMessagesAfter(messageId: string, count: number): Promise<Message[]>;

  // MessageEvent
  appendEvent(event: MessageEvent): Promise<void>;
  getMessageEvents(messageId: string): Promise<MessageEvent[]>;
  getMaxEventSequenceNum(messageId: string): Promise<number>;

  // Key Info
  addKeyFact(keyFact: KeyFact): Promise<void>;
  linkResource(resource: LinkedResource): Promise<void>;
  getKeyFacts(conversationId: string): Promise<KeyFact[]>;
  getLinkedResources(conversationId: string): Promise<LinkedResource[]>;

  // Participant 管理（UA-4~UA-10）
  createParticipant(participant: ConversationParticipant): Promise<void>;
  getParticipant(conversationId: string, otterId: string): Promise<ConversationParticipant | null>;
  getActiveParticipants(conversationId: string): Promise<ConversationParticipant[]>;
  updateParticipantLeave(participantId: string, leftAtTurnId: string, leftAtTurnNumber: number, leftAt: string): Promise<void>;
}
```

> **C5 修复**：`create()` 增加 `otterIds` 参数，在单事务内写入 `conversations` + `conversation_otters`（与旧代码一致）。新增 `getOtterIds()` 和 `getIdsByOtterId()` 方法。
>
> **M3 修复**：`GetMessagesOptions` 使用 cursor 分页（`before?: string`），与 `expandMessage` 一致。

#### 3.2 send-message.ts

```typescript
import type { Attachment } from "@entities/conversation/conversation";
import type { Message, MessageEvent, SenderType, MessageEventType } from "@entities/conversation/message";
import {
  isTerminalMessageStatus, canAppendEvent, canCompleteMessage,
  canFailMessage, isValidCompletedMessageBody, isValidTalkingStonePass,
} from "@entities/conversation/message";
import { canAddMessageToTurn, canCloseTurn } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
import type { MemoryIndexGateway } from "./memory-index-gateway";

/** 用户发送消息输入 */
export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  talkingStonePassedTo: string[];  // completed 用户消息，必须非空（UA-8）
  body: string;
  attachments?: Attachment[];
}

/** Otter 开始流式消息输入 */
export interface StartMessageInput {
  conversationId: string;
  senderId: string;
  talkingStonePassedTo: string[];  // streaming 期间可为空数组（UA-8）
  attachments?: Attachment[];
}

/** 流式事件输入 */
export interface MessageEventInput {
  messageId: string;
  eventType: MessageEventType;
  payload: Record<string, unknown>;
}

/** 完成消息输入 */
export interface CompleteMessageInput {
  body: string;
  talkingStonePassedTo: string[];  // completed 时必须非空（UA-8）
  attachments?: Attachment[];  // 可选，未提供则保留 startMessage 时的值
}

export class SendMessage {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly memoryIndex: MemoryIndexGateway,
  ) {}

  /** 用户发送消息（立即 completed） */
  async send(input: SendMessageInput): Promise<Message> {
    // 1. isValidTalkingStonePass(input.talkingStonePassedTo, "completed", "user") 校验（UA-8）
    // 2. 确保活跃 Turn 存在（无则创建新 Turn，turnNumber = max + 1）
    // 3. canAddMessageToTurn(turn.status) 校验
    // 4. 生成 Message（status="completed", sequenceNum = max + 1）
    // 5. repo.createCompletedMessage()
    // 6. memoryIndex.indexMessage(message.id, message.conversationId, message.body)（记忆索引，B11）
    // 7. 尝试关闭 Turn（检查 Turn 内所有消息是否终态）
    // 8. 返回 Message
  }

  /** Otter 开始流式消息（status="streaming"） */
  async start(input: StartMessageInput): Promise<Message> {
    // 1. isValidTalkingStonePass(input.talkingStonePassedTo, "streaming", "otter") 校验（UA-8，可为空）
    // 2. 确保活跃 Turn 存在
    // 3. canAddMessageToTurn(turn.status) 校验
    // 4. 生成 Message（status="streaming", body=null, sequenceNum = max + 1）
    // 5. repo.createStreamingMessage()
    // 6. 返回 Message
  }

  /** 追加流式事件（仅 streaming 状态可追加） */
  async appendEvent(input: MessageEventInput): Promise<MessageEvent> {
    // 1. repo.getMessageById() + 空值检查
    // 2. canAppendEvent(message.status) 校验
    // 3. 生成 MessageEvent（sequenceNum = max + 1）
    // 4. repo.appendEvent()
  }

  /** 完成流式消息（body 必须非空，talkingStonePassedTo 必须非空 UA-8） */
  async complete(messageId: string, input: CompleteMessageInput): Promise<Message> {
    // 1. repo.getMessageById() + 空值检查
    // 2. canCompleteMessage(message.status) 校验
    // 3. isValidCompletedMessageBody(input.body) 校验
    // 4. isValidTalkingStonePass(input.talkingStonePassedTo, "completed", message.senderType) 校验（UA-8）
    // 5. repo.completeMessage(messageId, body, talkingStonePassedTo, attachments, completedAt)
    // 6. memoryIndex.indexMessage(message.id, message.conversationId, message.body)（记忆索引，B12）
    // 7. 尝试关闭 Turn
    // 8. 返回更新后的 Message
  }

  /** 标记消息失败（body 保持 null） */
  async fail(messageId: string): Promise<void> {
    // 1. repo.getMessageById() + 空值检查
    // 2. canFailMessage(message.status) 校验
    // 3. repo.failMessage()
    // 4. 尝试关闭 Turn
  }

  /** 尝试关闭 Turn（私有） */
  // private async tryCloseTurn(conversationId: string, turnId: string): Promise<void>
  //   1. repo.getMessagesByTurnId(turnId)
  //   2. allMessagesTerminal = messages.every(m => isTerminalMessageStatus(m.status))
  //   3. canCloseTurn(allMessagesTerminal) 校验
  //   4. repo.closeTurn(turnId, now)
}
```

> **C1 修复**：所有 import 路径已修正，与 entities 层实际导出一致。
>
> **C4 修复**：`complete()` 返回 `Message` 而非 `void`，供记忆索引（via MemoryIndexGateway）。
>
> **与旧代码差异**：
> - 新增 Turn 管理逻辑（确保活跃 Turn、tryCloseTurn）
> - 新增 `talkingStonePassedTo` 校验（isValidTalkingStonePass）
> - Message 包含 `turnId` 字段
> - `complete()` 返回 Message（供记忆索引）
> - 删除对话树相关逻辑（无 treePath 计算）

#### 3.3 manage-conversation.ts

```typescript
import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import { canCompleteConversation, canArchiveConversation } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
import type { MemoryIndexGateway } from "./memory-index-gateway";

export interface CreateConversationInput {
  title: string;
  otterIds?: string[];  // 对话参与者（C5 修复）
}

export class ManageConversation {
  constructor(private readonly repo: ConversationRepository) {}

  async create(params: CreateConversationInput): Promise<Conversation> {
    // 1. 生成 UUID
    // 2. 构造 Conversation（status="active"）
    // 3. repo.create(conversation, params.otterIds)（单事务：conversations + conversation_otters）
    // 4. 对每个 otterId 创建 ConversationParticipant（joinedAtTurnId=null, joinedAtTurnNumber=0, status="active"）
    //    表示对话开始前已在场（A6 补充：初始参与者也创建记录，统一查询路径）
    // 5. 返回 Conversation
  }

  async getById(id: string): Promise<Conversation | null> {
    // repo.getById()
  }

  async complete(id: string): Promise<void> {
    // 1. repo.getById() + 空值检查
    // 2. canCompleteConversation(status) 校验
    // 3. repo.updateStatus(id, "completed", now)
  }

  async archive(id: string): Promise<void> {
    // 1. repo.getById() + 空值检查
    // 2. canArchiveConversation(status) 校验
    // 3. repo.updateStatus(id, "archived", now)
  }

  /** 获取 otter 参与的所有对话 ID（供 ManageSession.archiveSession 使用，C3 修复） */
  async getIdsByOtterId(otterId: string): Promise<string[]> {
    // repo.getIdsByOtterId()
  }
}
```

> 来源：旧 `adapter.ts create()/getById()/complete()/archive()` 方法。删除 `getTree()/createChild()`（对话树已去除）。
>
> **C5 修复**：`CreateConversationInput` 增加 `otterIds`，`create()` 传入 `repo.create()` 写入 `conversation_otters`。
>
> **C3 修复**：新增 `getIdsByOtterId()`，供 ManageSession.archiveSession 获取 otter 的对话列表以批量转换记忆层（via ConversationQueryGateway）。
>
> **A6 补充**：`create()` 同时为每个 otterId 创建 ConversationParticipant 记录（`joinedAtTurnId=null`, `joinedAtTurnNumber=0`, `status="active"`），统一 `getActiveParticipants()` 查询路径。`conversation_otters` 保留为旧代码兼容，ConversationParticipant 是在场名单的唯一真相源。

#### 3.4 manage-participant.ts

```typescript
import type { ConversationParticipant } from "@entities/conversation/conversation";
import { canJoinConversation, canLeaveConversation } from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
import { isValidTalkingStonePass } from "@entities/conversation/message";
import { canAddMessageToTurn } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";

export class ManageParticipant {
  constructor(private readonly repo: ConversationRepository) {}

  /**
   * Otter 进场：创建参与记录 + 系统消息。
   * 前置条件：当前有活跃 Turn（后进场者必须有 Turn）。
   * 系统消息 body 由调用方传入（A1：ManageParticipant 不依赖 OtterRepository）。
   */
  async join(conversationId: string, otterId: string, systemMessageBody: string): Promise<{
    participant: ConversationParticipant;
    systemMessage: Message;
  }> {
    // 1. repo.getParticipant(conversationId, otterId) -> canJoinConversation 校验（UA-10）
    // 2. 确保活跃 Turn 存在（getActiveTurn -> 无则抛错：进场需要活跃 Turn）
    // 3. canAddMessageToTurn(turn.status) 校验
    // 4. 创建 ConversationParticipant（status="active", joinedAtTurnId, joinedAtTurnNumber）
    // 5. 创建系统消息（senderType="system", body=systemMessageBody, talkingStonePassedTo=[], status="completed"）
    //    isValidTalkingStonePass([], "completed", "system") 返回 true（豁免，UA-8）
    // 6. 尝试关闭 Turn（系统消息立即终态，可能触发关闭）
    // 7. 返回 participant + systemMessage
  }

  /**
   * Otter 退场：更新参与记录 + 系统消息。
   * 前置条件：当前有活跃 Turn。
   */
  async leave(conversationId: string, otterId: string, systemMessageBody: string): Promise<{
    participant: ConversationParticipant;
    systemMessage: Message;
  }> {
    // 1. repo.getParticipant(conversationId, otterId) -> canLeaveConversation 校验
    // 2. 确保活跃 Turn 存在
    // 3. canAddMessageToTurn(turn.status) 校验
    // 4. repo.updateParticipantLeave(participantId, leftAtTurnId, leftAtTurnNumber, now)
    // 5. 创建系统消息（senderType="system", body=systemMessageBody, talkingStonePassedTo=[], status="completed"）
    // 6. 尝试关闭 Turn
    // 7. 返回 participant + systemMessage
  }

  /** 获取当前在场的所有 Otter（UA-7） */
  async getActiveParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    // repo.getActiveParticipants()（status="active"）
  }
}
```

> **UA-4~UA-10 新增**。进场/退场是独立操作（UA-9），不通过 talkingStonePassedTo 触发。
>
> **A1**：系统消息 body 由调用方传入，ManageParticipant 仅依赖 ConversationRepository。
>
> **A6**：初始参与者在 `ManageConversation.create()` 中创建（`joinedAtTurnId=null`），后进场者通过 `join()` 创建（`joinedAtTurnId` 指向当前 Turn）。`getActiveParticipants()` 统一返回所有 `status="active"` 的记录。
>
> **conversation_otters 与 ConversationParticipant 关系**：两者并存。`conversation_otters` 为静态关联（旧代码兼容），ConversationParticipant 为动态参与记录（唯一真相源）。`getOtterIds()` 返回静态关联，`getActiveParticipants()` 返回动态在场名单。

#### 3.5 query-message.ts

```typescript
import type { Message, MessageEvent } from "@entities/conversation/message";
import type { ConversationRepository, GetMessagesOptions } from "./conversation-repository";

export class QueryMessage {
  constructor(private readonly repo: ConversationRepository) {}

  async getMessageById(id: string): Promise<Message | null> {
    // repo.getMessageById()
  }

  async getMessages(conversationId: string, options: GetMessagesOptions): Promise<Message[]> {
    // repo.getMessages()（cursor 分页 + 状态过滤 + turnId 过滤）
  }

  async getMessageEvents(messageId: string): Promise<MessageEvent[]> {
    // repo.getMessageEvents()
  }

  async expandMessage(messageId: string, direction: "before" | "after" | "both", count: number): Promise<Message[]> {
    // before: repo.getMessagesBefore()
    // after: repo.getMessagesAfter()
    // both: 合并 + 按 sequenceNum 升序
  }
}
```

> 来源：旧 `adapter.ts getMessageById()/getMessages()/getMessageEvents()/expandMessage()` 方法。
>
> **M3 修复**：`getMessages()` 使用 cursor 分页（`before?: string`），与 `expandMessage` 一致。

#### 3.6 manage-key-info.ts

```typescript
import type { KeyFact, LinkedResource, KeyInfo } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";
import type { MemoryIndexGateway } from "./memory-index-gateway";

export interface KeyFactInput {
  conversationId: string;
  content: string;
  category?: string;
  createdBy: string;
  otterId?: string;
}

export interface LinkedResourceInput {
  conversationId: string;
  resourceType: string;
  url: string;
  title?: string;
  metadata?: Record<string, unknown>;
  linkedBy: string;
  otterId?: string;
  autoLinked: boolean;
}

export class ManageKeyInfo {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly memoryIndex: MemoryIndexGateway,
  ) {}

  async addKeyFact(input: KeyFactInput): Promise<KeyFact> {
    // 1. 生成 UUID
    // 2. 构造 KeyFact
    // 3. repo.addKeyFact()
    // 4. memoryIndex.indexKeyFact(keyFact.id, keyFact.conversationId, keyFact.content)（记忆索引，B13）
    // 5. 返回 KeyFact
  }

  async linkResource(input: LinkedResourceInput): Promise<LinkedResource> {
    // 1. 生成 UUID
    // 2. 构造 LinkedResource
    // 3. repo.linkResource()
    // 4. memoryIndex.indexLinkedResource(resource.id, resource.conversationId, resource.url)（记忆索引）
    // 5. 返回 LinkedResource
  }

  async getKeyInfo(conversationId: string): Promise<KeyInfo> {
    // 1. repo.getKeyFacts() + repo.getLinkedResources()
    // 2. 组装 KeyInfo
  }
}
```

> 来源：旧 `adapter.ts addKeyFact()/linkResource()/getKeyInfo()` 方法。use case 层不暴露 `getLinkedResources()` 独立方法（合并到 getKeyInfo）；Repository 接口仍保留 `getLinkedResources()` 供 getKeyInfo 内部调用（m3 修复）。

### 4. 跨上下文 Gateway 接口

> 跨上下文依赖通过 Gateway 依赖倒置处理（用户指令 UA-12）。每个上下文定义自己需要的 Gateway 接口，main.ts 装配具体实现。无 orchestration 目录，无跨上下文 import。

#### 4.1 otter 上下文 Gateway（定义在 manage-session.ts 内）

```typescript
import type { MemoryLayer } from "@entities/memory/memory-entry";

/** Gateway: 查询 otter 关联的对话 ID（由 main.ts 装配 ManageConversation 实现） */
export interface ConversationQueryGateway {
  getIdsByOtterId(otterId: string): Promise<string[]>;
}

/** Gateway: 记忆层转换（由 main.ts 装配 ManageMemory 实现） */
export interface MemoryLayerGateway {
  updateLayer(conversationId: string, from: MemoryLayer, to: MemoryLayer): Promise<void>;
}
```

> `MemoryLayer` 从 entities 层导入（共享内层，非跨上下文依赖）。两个 Gateway 接口定义在 `manage-session.ts` 内，因为只有 ManageSession 使用它们。

#### 4.2 conversation 上下文 Gateway（独立文件 memory-index-gateway.ts）

```typescript
/** Gateway: 记忆索引（由 main.ts 装配 StoreMemory 实现） */
export interface MemoryIndexGateway {
  /** 索引消息内容到记忆系统 */
  indexMessage(messageId: string, conversationId: string, content: string): Promise<void>;
  /** 索引关键事实到记忆系统 */
  indexKeyFact(keyFactId: string, conversationId: string, content: string): Promise<void>;
  /** 索引链接资源到记忆系统 */
  indexLinkedResource(resourceId: string, conversationId: string, url: string): Promise<void>;
}
```

> 独立文件，因为 `send-message.ts` 和 `manage-key-info.ts` 共同使用。Gateway 接口使用原始类型参数（string），不依赖 memory 上下文的类型（如 MemoryEntryInput），实现真正的上下文隔离。

### 5. 依赖关系

```
usecases/otter/
  create-otter.ts        ──> OtterRepository + AgentGateway + entities/otter
  dissolve-otter.ts      ──> OtterRepository + AgentGateway + ManageSession + entities/otter
  manage-session.ts      ──> OtterRepository + AgentGateway + ConversationQueryGateway + MemoryLayerGateway + entities/otter-session
  query-otter.ts         ──> OtterRepository + entities/otter

usecases/memory/
  store-memory.ts        ──> MemoryRepository + EmbeddingGateway + entities/memory
  search-memory.ts       ──> MemoryRepository + EmbeddingGateway + SearchEngine + entities/memory
  manage-memory.ts       ──> MemoryRepository + entities/memory
  search-engine.ts       ──> entities/memory（MemoryEntry, MemoryWeight 类型）

usecases/conversation/
  send-message.ts        ──> ConversationRepository + MemoryIndexGateway + entities/conversation + entities/conversation/message
  manage-conversation.ts ──> ConversationRepository + entities/conversation
  manage-participant.ts  ──> ConversationRepository + entities/conversation + entities/conversation/message
  query-message.ts       ──> ConversationRepository + entities/conversation/message
  manage-key-info.ts     ──> ConversationRepository + MemoryIndexGateway + entities/conversation
```

所有 usecases 文件不依赖 interface-adapters/ 或 frameworks/（`@frameworks/logger` 除外）。**无跨上下文 import** -- 跨上下文能力通过 Gateway 接口表达，由 main.ts 装配具体实现（UA-12）。

### 6. 与旧代码的差异

| 维度 | 旧代码 | 新代码 | 变因 |
|------|--------|-------|------|
| Otter 查询 | 在 OtterAdapter 内 | 独立 QueryOtter use case | 文件名即意图 |
| OtterPort | 单一接口含所有方法 | 拆分为 OtterRepository + AgentGateway | D32 依赖反转 |
| archiveSession | adapter 内直接调用 agentLifecycle.reset | use case 内通过 Gateway 编排 | 完整业务操作内聚到 ManageSession（UA-12） |
| archiveSession 返回值 | void | 返回 OtterSession | C3：供 DissolveOtter 获取 otterId |
| MemoryPort | 单一接口含所有方法 | 拆分为 MemoryRepository + EmbeddingGateway | D32 依赖反转 |
| Memory 简单 CRUD | 在 MemoryAdapter 内 | 独立 ManageMemory use case | 文件名即意图 |
| SearchEngine treePath | computeTaskRelevance 使用 treePath | 删除 treePath 逻辑 | UA-5 对话树去除 |
| SearchEngine RrfHit/ScoredHit | 含 entry: MemoryEntry | 保留 entry 字段 | C2：rerank 需要 createdAt |
| RetrievalResult 形状 | `{ entries, scores, sources }` | `{ entries: Array<MemoryEntry & { score, source }>, total }` | 更符合人体工程学 |
| ConversationPort | 单一接口含所有方法 | 拆分为 ConversationRepository | D32 依赖反转 |
| conversation_otters 管理 | Repository.create 单事务写入 | Repository.create(conversation, otterIds?) 单事务写入 | C5 修复，保持旧代码行为 |
| manage-tree.ts | F20260714zjmk 原设计文件 | 删除，Turn 管理内聚到 send-message.ts | UA-5 对话树去除 |
| Turn 管理 | 不存在（旧代码无 Turn） | send-message.ts 内集成 Turn open/close | UA-7/UA-8 发言石轮次 |
| 发言石校验 | 不存在 | isValidTalkingStonePass 校验 | UA-7/UA-9 |
| complete() 返回值 | void | 返回 Message | C4：供记忆索引（via MemoryIndexGateway） |
| Orchestration | 未实现（app/ 层空） | 无独立目录，跨上下文通过 Gateway 接口（UA-12） | D35 调整：Gateway 替代编排目录 |
| Config 注入 | initor 直接 import @infra/config | 构造函数注入（main.ts 装配） | F20260714zjmk config 注入规则 |
| getMessages 分页 | cursor（messageId） | cursor（before?: string） | M3：与 expandMessage 一致 |
| SenderType | "user" \| "otter" | "user" \| "otter" \| "system" | UA-4 系统消息 |
| isValidTalkingStonePass 签名 | `(recipients: string[])` | `(recipients, status, senderType)` | UA-8：system 豁免、streaming/failed 可空、completed 非空 |
| CompleteMessageInput | 无 talkingStonePassedTo | 必须包含 talkingStonePassedTo | UA-8：completed 时非空 |
| completeMessage Repository 签名 | 无 talkingStonePassedTo | 增加 talkingStonePassedTo 参数 | UA-8 |
| ConversationParticipant | 不存在 | 新增实体 + ManageParticipant use case | UA-4~UA-10 进场/退场 |
| 在场名单查询 | 无 | getActiveParticipants() 返回 status="active" 的参与者 | UA-7 动态在场名单 |
| 初始参与者 | 仅 conversation_otters 静态关联 | 同时创建 ConversationParticipant 记录 | A6 统一查询路径 |

## 设计取舍

| 取舍点 | 正方 | 反方 | 最终选择 |
|--------|------|------|---------|
| archiveSession 是否调用 AgentGateway | 内聚：archive + reset 一体 | 解耦：不依赖 AgentGateway | 内聚（UA-12 调整）。archiveSession 是完整业务操作，通过 Gateway 调用跨上下文能力 |
| Turn 管理归属文件 | 独立 manage-turn.ts | 内聚到 send-message.ts | 内聚。Turn open/close 由消息生命周期触发，紧耦合 |
| Memory 简单 CRUD 是否独立成 use case | 放在 search-memory.ts 或 store-memory.ts | 独立 manage-memory.ts | 独立。文件名即意图，避免单文件过大 |
| Otter 查询是否独立成 use case | 放在 create-otter.ts 或 manage-session.ts | 独立 query-otter.ts | 独立。查询与创建/管理语义不同 |
| 跨上下文协调方式 | orchestration flow 文件 | Gateway 接口 + use case 内聚 | Gateway（UA-12）。跨上下文能力通过接口表达，use case 完整业务操作内聚 |
| SearchEngine 是否保留 treePath 相关代码 | 保留但传入 null | 删除 | 删除。treePath 已从实体中去除，保留空逻辑增加认知负担 |
| ManageSession.archiveSession 中 conversationId 来源 | OtterSession 增加 conversationId 字段 | 通过 ConversationQueryGateway.getIdsByOtterId 查询 | 查询。不需要改变 entities 层，Gateway 接口查询 |
| createSession 是否自动归档旧 session | 自动归档 | 前置条件检查 | 前置条件。调用方负责正确调用顺序，createSession 只检查不归档 |
| DissolveOtter 中 session 归档方式 | 直接调用 manageSession.archiveSession | 调用 ManageSession.archiveSession（含 Gateway 编排） | 调用 ManageSession.archiveSession。复用完整归档流程（含记忆层转换），避免遗漏 |
| 系统消息 body 谁决定 | ManageParticipant 查询 Otter 名字构造 | 调用方传入 body | 调用方传入。ManageParticipant 保持单一上下文依赖（A1） |
| 进场/退场是 use case 还是跨上下文编排 | 简单（仅 conversation 内部） | 需要 cross-module 编排 | use case。进场/退场仅涉及 conversation 上下文 |
| conversation_otters 与 ConversationParticipant | 二选一 | 并存 | 并存。conversation_otters 为静态关联（兼容），ConversationParticipant 为动态参与记录（唯一真相源） |
| 初始参与者是否创建 ConversationParticipant | 不创建，合并查询 | 创建，统一查询路径 | 创建。getActiveParticipants() 返回单一查询结果，无需合并（A6 补充） |
| 系统消息是否索引到记忆 | 完整性 | 系统消息是事件标记非内容 | 不索引。body 是事件描述，不含可检索内容 |
| usecases/shared/ 共享目录 | 提取共享概念减少重复 | LLM 倾向形成 god class | **严禁**（UA-11） |
| orchestration/ 编排目录 | 集中管理跨上下文流程 | 边界不清，技术命名非业务场景 | **去除**（UA-12）。跨上下文依赖通过 Gateway 接口处理 |
| 跨上下文依赖方式 | 直接 import 其他上下文 use case | Gateway 依赖倒置 | Gateway（UA-12）。消费方定义接口，main.ts 装配实现 |

## 核心业务行为

> 以下行为条目是 usecases 层实现后必须保持的业务行为，作为 frameworks/interface-adapters 层测试的回归守护。

| ID | 触发条件 | 预期行为 | 追溯 |
|----|---------|---------|------|
| B1 | 创建 Otter 记录后，Agent 创建失败时 | DB 记录应被回滚删除，不残留孤立 Otter 记录 | ← UA-1（F20260714zjmk B1） |
| B2 | 查询大獭且系统中不存在大獭时 | 应抛出错误（系统不变量：大獭必须存在） | ← UA-1（F20260714zjmk B2） |
| B3 | 归档 session 且 reason='restart' 时 | session 状态变为 'restarted' | ← UA-1（F20260714zjmk B3） |
| B4 | 归档 session 且 reason 不为 'restart' 时 | session 状态变为 'archived' | ← UA-1（F20260714zjmk B4） |
| B5 | 解散 Otter 时 | Otter 状态变为 'dissolved'，对应 Agent 被销毁 | ← UA-1（F20260714zjmk B5） |
| B6 | 混合检索记忆时 | FTS5 全文匹配 + vec0 向量检索结果通过 RRF 融合后返回 | ← UA-1（F20260714zjmk B6） |
| B7 | 用户发送消息时 | 消息 status="completed"，自动创建/关联 Turn，talkingStonePassedTo 非空 | ← UA-2（发言石轮次） |
| B8 | Otter 开始流式消息时 | 消息 status="streaming"，body=null，自动创建/关联 Turn | ← UA-2 |
| B9 | Turn 内所有消息到达终态时 | Turn 自动关闭（status="closed"） | ← UA-2（UA-8 轮次模型） |
| B10 | 归档 session 时 | 工作记忆自动转为历史记忆（working -> historical） | ← UA-1（ManageSession via MemoryLayerGateway） |
| B11 | 用户发送消息后 | 消息内容自动索引到记忆系统（contentType="message"） | ← UA-1（SendMessage via MemoryIndexGateway） |
| B12 | Otter 完成流式消息后 | 消息 body 内容自动索引到记忆系统（contentType="message"） | ← UA-1（SendMessage.complete via MemoryIndexGateway） |
| B13 | 添加关键事实后 | 关键事实自动索引到记忆系统（contentType="key_fact"） | ← UA-1（ManageKeyInfo via MemoryIndexGateway） |
| B14 | Session 创建时 | previousSessionId 指向前一个 session（链式关系） | ← UA-1（UA-11 链式） |
| B15 | 完成消息时 body 为空 | 应抛出错误（isValidCompletedMessageBody 不变量） | ← UA-2 |
| B16 | 对非 streaming 状态消息追加事件 | 应抛出错误（canAppendEvent 不变量） | ← UA-2 |
| B17 | 标记消息失败后 | body 保持 null（failMessage 不设置 body） | ← UA-2 |
| B18 | Otter 进场时 | 创建系统消息（senderType="system"），记录进场 Turn | ← UA-4, UA-5, UA-6 |
| B19 | Otter 退场时 | 创建系统消息，记录退场 Turn | ← UA-4, UA-6 |
| B20 | 查询在场名单 | 返回所有 status="active" 的 ConversationParticipant | ← UA-7 |
| B21 | 系统消息创建 | talkingStonePassedTo 为空数组（豁免） | ← UA-8 |
| B22 | streaming 消息创建 | talkingStonePassedTo 可为空数组 | ← UA-8 |
| B23 | completed 消息（user/otter） | talkingStonePassedTo 必须非空 | ← UA-8 |
| B24 | Otter 进场前置校验 | 无已有参与记录（canJoinConversation） | ← UA-10 |
| B25 | Otter 退场前置校验 | 当前状态为 active（canLeaveConversation） | ← UA-7 |
| B26 | 创建对话时 | 初始参与者创建 ConversationParticipant 记录（joinedAtTurnId=null） | ← UA-7（A6 补充） |

## 硬约束

1. usecases/ 不可 import interface-adapters/ 或 frameworks/（`@frameworks/logger` 除外）
2. 每个 use case 为 class + execute() 形状（KDR-1），通过构造函数注入依赖
3. Repository 接口定义在 usecases 层，不由 frameworks 层定义（D32）
4. Repository 接口不依赖 use case 文件的类型（类型定义在 repository 自身或 entities 层）
5. SearchEngine 不含 treePath 相关逻辑
6. `talkingStonePassedTo` 校验必须使用 entities 层的 `isValidTalkingStonePass` 函数
7. 所有 entities 层不变量函数在 use case 中被调用时必须使用，不得内联重写
8. Config 值通过构造函数注入，不直接 import `@frameworks/config`
9. `tsc --noEmit` 通过
10. `eslint src/usecases/` 无违规
11. 系统消息 `senderType="system"`，`talkingStonePassedTo` 为空数组（UA-8）
12. `isValidTalkingStonePass` 必须传入 status 和 senderType 参数（E2 前置依赖）
13. `CompleteMessageInput` 必须包含 `talkingStonePassedTo`（completed 时非空，UA-8）
14. 每个 Otter 实例在一个对话中只进场/退场一次（UA-10）
15. Entities 层变更（E1-E4）合入后才能编译验证 usecases 层
16. **严禁** `usecases/shared/` 或任何形式的跨上下文共享目录（UA-11）
17. **严禁** `usecases/orchestration/` 或任何技术命名的"杂物间"目录（UA-12）
18. 跨上下文依赖**必须**通过 Gateway 接口处理，不得直接 import 其他上下文的 use case（UA-12）
19. Gateway 接口定义在消费方上下文，使用原始类型参数，不依赖其他上下文的类型

## 验证

### 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] `eslint src/usecases/` 无违规
- [ ] usecases/otter/ 包含 OtterRepository 接口 + AgentGateway 接口 + CreateOtter + DissolveOtter + ManageSession + QueryOtter use case
- [ ] usecases/memory/ 包含 MemoryRepository 接口 + EmbeddingGateway 接口 + SearchEngine + StoreMemory + SearchMemory + ManageMemory use case
- [ ] usecases/conversation/ 包含 ConversationRepository 接口 + MemoryIndexGateway 接口 + SendMessage + ManageConversation + ManageParticipant + QueryMessage + ManageKeyInfo use case
- [ ] **无 orchestration/ 目录**（UA-12）
- [ ] **无跨上下文 import**（所有跨上下文依赖通过 Gateway 接口，UA-12）
- [ ] SearchEngine 无 treePath 相关代码
- [ ] RrfHit 和 ScoredHit 包含 entry: MemoryEntry 字段
- [ ] 所有 use case class 有 constructor 注入 + execute()/方法
- [ ] 无 usecases/ -> interface-adapters/ 或 frameworks/ 引用（`@frameworks/logger` 除外）
- [ ] entities 层不变量函数在 use case 中被调用
- [ ] 所有 import 路径与 entities 层实际导出一致
- [ ] ConversationRepository.create 接受 otterIds 参数
- [ ] ManageSession.archiveSession 返回 OtterSession
- [ ] getMessages 使用 cursor 分页（before?: string）
- [ ] completeMessage Repository 方法签名包含 talkingStonePassedTo 参数
- [ ] CompleteMessageInput 包含 talkingStonePassedTo（UA-8）
- [ ] send() 校验使用 isValidTalkingStonePass(..., "completed", "user")
- [ ] start() 校验使用 isValidTalkingStonePass(..., "streaming", "otter")
- [ ] complete() 校验使用 isValidTalkingStonePass(..., "completed", message.senderType)
- [ ] ManageParticipant.join/leave 接受 systemMessageBody 参数（A1）
- [ ] ManageConversation.create 为初始参与者创建 ConversationParticipant 记录（A6）

## 关联

- **整洁架构 Feature 文档**：[F20260714zjmk](./F20260714zjmk-clean-architecture-restructuring.md)（目录结构、依赖规则、D30-D42 决策）
- **Entities 层实现**：[F20260714jaup](./F20260714jaup-entities-layer-implementation.md)（实体类型 + 不变量函数）
- **消息流式模型**：[F20260713e8n4](../13/F20260713e8n4-message-streaming-model.md)（Message/MessageEvent 类型定义）
- **Otter 领域模块**：[F20260713o4t8](../13/F20260713o4t8-domain-otter.md)（Otter/OtterSession 类型定义）
- **Memory 领域模块**：[F20260713m5q3](../13/F20260713m5q3-domain-memory.md)（MemoryEntry/MemoryWeight 类型定义）
