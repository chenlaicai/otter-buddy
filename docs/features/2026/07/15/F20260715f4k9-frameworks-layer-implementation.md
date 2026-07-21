---
id: F20260715f4k9
title: frameworks-layer-implementation
doc_type: feature

# 记忆索引
summary: |
  > 本文档定义整洁架构 frameworks 层的完整实现：数据库连接 + Schema + 三个 Repository 实现 + LLM/Embedding/Agent 网关 + Config。遵循 F20260714zjmk 锁定的目录结构和设计决策。 - F20260714zjmk Se...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260714zjmk
    - F20260714jaup
    - F20260715b8c6
    - F20260715r3s2
    - F20260713e8n4
    - F20260713o4t8
    - F20260713m5q3
    - F20260713i5k2


# 元数据
status: locked
change_type: feature
tags: [architecture, frameworks, clean-architecture, db, llm, embedding, agent, incompatible]
modules: [src/frameworks/]

# 时间
created_at: 2026-07-15
---


# F20260715f4k9 整洁架构 Frameworks 层实现

## [design-time]

> 本文档定义整洁架构 frameworks 层的完整实现：数据库连接 + Schema + 三个 Repository 实现 + LLM/Embedding/Agent 网关 + Config。遵循 F20260714zjmk 锁定的目录结构和设计决策。

## 背景 [required]

### 当前状态

- F20260714zjmk Setup 已合入（PR #13）：旧代码归档、四层目录、ESLint 层依赖规则
- F20260714jaup Entities 已合入（PR #15）：三上下文实体类型 + 不变量规则函数（含 E1-E4 变更）
- F20260715b8c6 Use Cases 已合入（PR #17）：Repository/Gateway 接口 + Use Case Class + SearchEngine
- 本 Issue 对应 F20260714zjmk 实现计划的 Issue 4：frameworks 层

### 旧代码参考源

| 模块 | 旧代码路径 | 用途 |
|------|-----------|------|
| DB 连接 | `reference/old-src/infra/db/database.ts` | better-sqlite3 + sqlite-vec 初始化 |
| Schema | `reference/old-src/infra/db/schema.ts` | DDL 定义（需更新） |
| Otter Repository | `reference/old-src/domain/otter/_internal/repository.ts` | SQL 实现参考 |
| Otter Mapper | `reference/old-src/domain/otter/_internal/mapper.ts` | Row ↔ Entity 映射 |
| Memory Repository | `reference/old-src/domain/memory/_internal/repository.ts` | SQL + FTS5 + vec0 实现 |
| Memory Mapper | `reference/old-src/domain/memory/_internal/mapper.ts` | Row ↔ Entity 映射 |
| Conversation Repository | `reference/old-src/domain/conversation/_internal/repository.ts` | SQL 实现（最大） |
| Conversation Mapper | `reference/old-src/domain/conversation/_internal/mapper.ts` | Row ↔ Entity 映射 |
| LLM Gateway | `reference/old-src/infra/llm-gateway.ts` | pi-ai 多 Provider 适配 |
| Embedding Service | `reference/old-src/infra/embedding/service.ts` | Worker Thread 主线程 |
| Embedding Worker | `reference/old-src/infra/embedding/worker.ts` | bge-m3 模型推理 |
| Agent Registry | `reference/old-src/infra/agent-core/registry.ts` | pi-agent-core 生命周期管理 |
| Agent Handle | `reference/old-src/infra/agent-core/agent.ts` | Agent 交互封装 |
| Agent Tool | `reference/old-src/infra/agent-core/tool.ts` | 工具定义类型 |
| Config | `reference/old-src/infra/config.ts` | 配置常量 |
| Logger | `src/frameworks/logger.ts` | ✅ 已存在 |

### 上游设计约束

- **D32**：Repository 接口归属 usecases 层，frameworks 实现
- **D37**：frameworks/db/ 实现 usecases 定义的 Repository 接口（依赖反转）
- **D38**：frameworks/db/ 按限界上下文组织 repository + mapper
- **D39**：logger 作为 cross-cutting concern 豁免层依赖规则（已实现）
- **Config 注入规则**：usecases 需要的配置值通过 main.ts 构造函数注入，不直接 import `@frameworks/config`
- **KDR-6**（F20260714zjmk）：Greenfield 实现，旧代码移至 `reference/old-src/` 作参考

### usecases 层接口清单（frameworks 必须实现）

| 接口 | 定义文件 | 方法数 | frameworks 实现模块 |
|------|---------|--------|-------------------|
| `OtterRepository` | `@usecases/otter/otter-repository` | 10 | `frameworks/db/otter/` |
| `AgentGateway` | `@usecases/otter/agent-gateway` | 3 | `frameworks/agent/` |
| `MemoryRepository` | `@usecases/memory/memory-repository` | 12 | `frameworks/db/memory/` |
| `EmbeddingGateway` | `@usecases/memory/embedding-gateway` | 1 | `frameworks/embedding/` |
| `ConversationRepository` | `@usecases/conversation/conversation-repository` | 31 | `frameworks/db/conversation/` |

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "当前已实现了usecases，你继续按照F20260714zjmk 继续下一步实现" | 时序：usecases 已合入后；依据：F20260714zjmk；操作：继续下一步实现 | 用户确认 usecases 层完成，要求按 F20260714zjmk 锁定的实现计划推进 Issue 4：frameworks 层 | msg-1 |
| UA-2 | "我准备将本项目调整下，改为整洁架构"（引用自 F20260714zjmk UA-3） | 目标：改为整洁架构 | frameworks 层是整洁架构的最外层，实现内层定义的接口（依赖反转） | F20260714zjmk UA-3 |
| UA-3 | "现有代码全都先移除？...然后按照整洁架构从头开始实现"（引用自 F20260714zjmk UA-4） | 方式：从头开始实现；旧代码作参考 | Greenfield 方式实现，参照旧代码的业务逻辑但不直接迁移 | F20260714zjmk UA-4 |

## 目标 [required]

### P1 - 数据库基础设施

实现 `frameworks/db/database.ts`（连接管理）+ `frameworks/db/schema.ts`（DDL，含新表和更新后的 CREATE TABLE），为三个 Repository 提供数据库连接。

### P2 - 三个 Repository 实现

参照旧代码 SQL 实现，在 `frameworks/db/{otter,memory,conversation}/` 下实现 `OtterRepository`、`MemoryRepository`、`ConversationRepository` 接口。每个上下文包含 `sqlite-*-repository.ts`（实现）+ `*-mapper.ts`（Row ↔ Entity 映射）。

### P3 - LLM 网关

创建 `frameworks/llm/models-factory.ts`，提供 pi-ai Models 对象工厂（Provider 路由 + Model 获取），供 AgentHarness 消费。基于 `docs/research/pi-capability-analysis.md` 优化。

### P4 - Embedding 网关

迁移旧代码 `infra/embedding/{service,worker}.ts` 到 `frameworks/embedding/`，实现 `EmbeddingGateway` 接口。

### P5 - Agent 网关

基于 `docs/research/pi-capability-analysis.md` 设计 `frameworks/agent/`：使用 AgentHarness + 冷启动模型 + Pi 内置 Session 管理。实现 `AgentGateway` 接口 + 提供 `invoke()` 方法供 interface-adapters 层使用。

### P6 - Config

迁移旧代码 `infra/config.ts` 到 `frameworks/config.ts`，移除已废弃的 `samePathBoost` 和 `crossPathDecay` 配置项。

### P7 - 可编译验证

- `tsc --noEmit` 通过
- `eslint src/frameworks/` 无违规
- 层依赖规则：frameworks/ 可 import usecases/（实现接口）+ entities/（使用类型），不反向被内层 import（logger 除外）

## 非目标 [required]

- 不实现 interface-adapters 层（HTTP controllers、agent-runtime）
- 不实现 main.ts 装配（DI wiring）
- 不实现测试（测试随 interface-adapters 层 Issue 一起实现）
- 不引入新的第三方依赖
- 不改变 entities 层或 usecases 层代码
- 不实现 web/ 前端

## 设计 [required]

### 文件结构

```
src/frameworks/
  logger.ts                                    -- ✅ 已存在
  config.ts                                    -- 配置常量（原 infra/config.ts）
  db/
    database.ts                                -- better-sqlite3 连接管理
    schema.ts                                  -- DDL 定义（含新表 + 更新后的 CREATE TABLE）
    otter/
      sqlite-otter-repository.ts               -- 实现 OtterRepository（10 方法）
      otter-mapper.ts                          -- DB Row ↔ Otter/OtterSession 映射
    memory/
      sqlite-memory-repository.ts              -- 实现 MemoryRepository（12 方法）
      memory-mapper.ts                         -- DB Row ↔ MemoryEntry/MemoryWeight 映射
    conversation/
      sqlite-conversation-repository.ts        -- 实现 ConversationRepository（31 方法）
      conversation-mapper.ts                   -- DB Row ↔ Conversation/Message/Turn/Participant 映射
  llm/
    models-factory.ts                          -- pi-ai Models 对象工厂（Provider 路由 + Model 获取）
  embedding/
    embedding-service.ts                       -- 实现 EmbeddingGateway（Worker Thread 主线程）
    bge-m3-worker.ts                           -- bge-m3 模型推理（Worker Thread）
  agent/
    pi-harness-factory.ts                      -- 实现 AgentGateway + 冷启动 invoke()（AgentHarness 工厂）
    system-prompt-builder.ts                   -- 动态 system prompt 组合函数（静态层 + 动态层）
    tool-registry.ts                           -- AgentTool 注册表（activeToolNames 按 Otter 类型筛选）
    agent-session-store.ts                     -- otter_id ↔ pi_session_id 映射管理（agent_sessions 表）
```

> **总计 15 个新文件** + 1 个已存在（logger.ts）= 16 个文件
>
> **与初版设计差异**（基于 `docs/research/pi-capability-analysis.md` 优化）：
> - `pi-agent-registry.ts` + `agent-handle.ts` -> `pi-harness-factory.ts` + `system-prompt-builder.ts` + `tool-registry.ts` + `agent-session-store.ts`
> - 使用 Pi 的 **AgentHarness**（非 Agent），支持 Session/Skill/Compaction/动态 Prompt
> - **冷启动模型**（R17）：每次发言创建 harness，完成后释放，无持久化 AgentHandle
> - **Pi 自管理 Session**（R12）：使用 Pi 内置 `JsonlSessionRepo`，Otter 只存 `pi_session_id`
> - **Pi 内置 NodeExecutionEnv**（R13）：不需要自定义 ExecutionEnv
> - `frameworks/llm/pi-ai-gateway.ts` -> `frameworks/llm/models-factory.ts`：简化为 Models 工厂，不再需要 LLMGateway 接口（chat/streamChat 由 harness 处理）
> - AgentTool 实现归属于 interface-adapters 层（Issue 5），本 Issue 只提供 tool-registry 基础设施

### Schema 变更

#### 新增表

**1. `turns` 表**（Turn 实体，F20260715b8c6 新增）

```sql
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_turns_conversation_id ON turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);
```

**2. `conversation_participants` 表**（ConversationParticipant 实体，E3/E4 新增）

```sql
CREATE TABLE IF NOT EXISTS conversation_participants (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  otter_id TEXT NOT NULL,
  joined_at_turn_id TEXT,
  joined_at_turn_number INTEGER NOT NULL DEFAULT 0,
  left_at_turn_id TEXT,
  left_at_turn_number INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  left_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (otter_id) REFERENCES otters(id),
  FOREIGN KEY (joined_at_turn_id) REFERENCES turns(id),
  FOREIGN KEY (left_at_turn_id) REFERENCES turns(id)
);

CREATE INDEX IF NOT EXISTS idx_participants_conversation_id ON conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_participants_otter_id ON conversation_participants(otter_id);
CREATE INDEX IF NOT EXISTS idx_participants_status ON conversation_participants(status);
```

**3. `agent_sessions` 表**（Otter ↔ Pi Session 映射，基于 `docs/research/pi-capability-analysis.md` R12）

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  otter_id TEXT PRIMARY KEY,
  pi_session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (otter_id) REFERENCES otters(id)
);
```

> Otter 只存 `pi_session_id`，Pi 自行管理 JSONL session 文件（`JsonlSessionRepo`）。冷启动模型下，每次发言通过 `pi_session_id` 打开 session -> 创建 AgentHarness -> prompt -> 释放。

#### 修改的已有表（不兼容变更）

**4. `messages` 表** - 新增 `turn_id` 和 `talking_stone_passed_to` 列

```sql
-- 更新后的 CREATE TABLE（新数据库直接创建完整表）
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  body TEXT,
  attachments TEXT,
  sequence_num INTEGER NOT NULL,
  turn_id TEXT,                                    -- 新增：FK to turns
  talking_stone_passed_to TEXT,                    -- 新增：JSON array of otter IDs
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (turn_id) REFERENCES turns(id)
);
```

**5. `otter_sessions` 表** — 新增 `previous_session_id` 列

```sql
-- 更新后的 CREATE TABLE
CREATE TABLE IF NOT EXISTS otter_sessions (
  id TEXT PRIMARY KEY,
  otter_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  archive_reason TEXT,
  is_negative_case INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  previous_session_id TEXT,                        -- 新增：链式 Session 关系
  FOREIGN KEY (otter_id) REFERENCES otters(id),
  FOREIGN KEY (previous_session_id) REFERENCES otter_sessions(id)
);
```

#### 保留但不使用的旧列

以下列在旧 Schema 中存在，新代码不再使用但保留在 CREATE TABLE 中：

| 表 | 列 | 旧约束 | 新约束 | 说明 |
|----|-----|--------|--------|------|
| `conversations` | `parent_id` | `TEXT`（可空） | 不变 | 对话树已去除，Repository 写 NULL |
| `conversations` | `tree_path` | `TEXT NOT NULL` | **`TEXT`（可空）** | **不兼容变更**：旧约束 NOT NULL 与 Repository 写 NULL 冲突。新 CREATE TABLE 移除 NOT NULL |
| `memory_entries` | `tree_path` | `TEXT`（可空） | 不变 | Repository 写 NULL |

> **注意**：`conversations.tree_path` 的 NOT NULL -> NULL 变更是不兼容更新。已有数据库需手动处理：`UPDATE conversations SET tree_path=NULL WHERE tree_path=''` 后重建表，或直接保留 NOT NULL 并在 Repository 写空字符串 `''` 替代 NULL。

#### Schema 组织

`schema.ts` 维持旧代码的函数组织结构（按表分组），新增 `createTurnTables()`、`createParticipantTables()` 和 `createAgentSessionsTable()` 函数。`initSchema()` 在单事务内执行所有 DDL。

#### `conversation_otters` 与 `conversation_participants` 双表关系

两个表并存，职责不同：

| 表 | 职责 | 写入方 | 查询方 |
|----|------|--------|--------|
| `conversation_otters` | 静态关联：对话关联了哪些 Otter | `ConversationRepository.create()` | `getOtterIds()`, `getIdsByOtterId()` |
| `conversation_participants` | 动态参与状态：跟踪进场/退场时间和 Turn 绑定 | `createParticipant(s)`, `updateParticipantLeave()` | `getParticipant()`, `getActiveParticipants()` |

`ManageConversation.create()` use case 创建对话时同时写入两个表：`conversation_otters`（静态关联）+ `conversation_participants`（初始参与者，`joinedAtTurnId=null`）。后续进场/退场通过 `ManageParticipant` 操作 `conversation_participants`。`getActiveParticipants()` 返回在场名单的唯一真相源。

#### 不在本 Issue 范围内的表

旧 schema 中的 `skills`、`skill_assignments`、`external_resources` 表不在本 Issue 范围内。usecases 层未定义对应接口，schema.ts **不创建**这些表。后续 Issue 需要时再添加。

### frameworks/db/ 模块设计

#### database.ts

**职责**：better-sqlite3 连接初始化 + sqlite-vec 扩展加载 + 连接关闭。

**导出**：
- `initDatabase(config?: DatabaseConfig): Database.Database` — 同步工厂，WAL 模式 + FK 开启 + sqlite-vec 尝试加载（失败降级为 FTS5-only）
- `closeDatabase(db: Database.Database): void`
- `interface DatabaseConfig { path?: string; walMode?: boolean; foreignKeys?: boolean }` - 字段名与 `config.db` 一致，main.ts 可直接传入 `config.db`

**旧代码参考**：`reference/old-src/infra/db/database.ts`（几乎直接迁移，调整 import 路径）

**设计决策**：
- 保持同步 API（better-sqlite3 是同步设计）
- sqlite-vec 加载失败为降级模式（D22），不影响整体启动
- `DatabaseConfig` 使用 `@frameworks/config` 的 `db` 配置段

#### db/otter/sqlite-otter-repository.ts

**职责**：实现 `OtterRepository` 接口（10 方法）。

**接口实现映射**：

| 接口方法 | SQL 操作 | 旧代码参考 |
|---------|---------|-----------|
| `createOtter(otter: Otter)` | INSERT INTO otters | 旧 `create(id, input)` — 签名变更：接收完整 entity |
| `getById(id)` | SELECT FROM otters WHERE id = ? | 旧代码一致 |
| `getBigOtter()` | SELECT FROM otters WHERE type='big' AND status='active' LIMIT 1 | 旧代码一致 |
| `dissolve(otterId, dissolvedAt)` | UPDATE otters SET status='dissolved', dissolved_at=? | 旧代码使用 `datetime('now')`，新代码接收参数 |
| `deleteOtter(otterId)` | DELETE FROM otters WHERE id = ? | 旧代码一致（回滚用） |
| `createSession(session: OtterSession)` | INSERT INTO otter_sessions | 旧代码内部生成 ID + 时间戳，新代码接收完整 entity（含 previousSessionId） |
| `getActiveSession(otterId)` | SELECT FROM otter_sessions WHERE otter_id=? AND status='active' LIMIT 1 | 旧代码一致 |
| `archiveSession(sessionId, status, params, archivedAt)` | UPDATE otter_sessions SET status=?, archived_at=?, archive_reason=?, is_negative_case=?, summary=? | 旧代码合并了状态计算，新代码接收已计算的 status |
| `getSessionHistory(otterId)` | SELECT FROM otter_sessions WHERE otter_id=? ORDER BY started_at DESC | 旧代码一致 |
| `getSessionById(sessionId)` | SELECT FROM otter_sessions WHERE id = ? | 旧代码一致 |

**关键设计决策**：
- `createOtter` 接收完整 `Otter` entity（含 ID、时间戳），Repository 不再生成 ID — ID 生成由 use case 层负责
- `createSession` 同理，接收完整 `OtterSession` entity（含 `previousSessionId`）
- `dissolve` 和 `archiveSession` 接收时间戳参数，不使用 `datetime('now')` — 时间来源由 use case 控制
- `roleResponsibilities` 存储为 JSON TEXT
- `is_negative_case` 存储为 INTEGER (0/1)

#### db/otter/otter-mapper.ts

**职责**：`OtterRow` ↔ `Otter`、`SessionRow` ↔ `OtterSession` 双向映射。

**新增映射字段**：
- `SessionRow` 新增 `previous_session_id: string | null`
- `rowToSession()` 映射 `previous_session_id` → `previousSessionId`

#### db/memory/sqlite-memory-repository.ts

**职责**：实现 `MemoryRepository` 接口（12 方法）。

**接口实现映射**：

| 接口方法 | SQL 操作 | 旧代码参考 |
|---------|---------|-----------|
| `storeEntry(entry)` | 事务：INSERT memory_entries + memory_fts + memory_weights | 旧代码一致（tree_path 写 NULL） |
| `storeEmbedding(id, embedding)` | 事务：DELETE + INSERT memory_vec | 旧代码一致（vec0 不支持 INSERT OR REPLACE） |
| `getById(id)` | SELECT FROM memory_entries WHERE id = ? | 旧代码一致 |
| `getBySource(table, id)` | SELECT FROM memory_entries WHERE source_table=? AND source_id=? | 旧代码一致 |
| `getEmbedding(id)` | SELECT embedding FROM memory_vec WHERE memory_entry_id=? | 旧代码一致（Buffer → Float32Array） |
| `getWeights(ids)` | SELECT FROM memory_weights WHERE memory_entry_id IN (...) | 旧代码返回 `Map<string, MemoryWeight>`，新接口返回 `Promise<MemoryWeight[]>`（usecases 层有意变更） |
| `searchFTS(query, filters)` | FTS5 MATCH + JOIN + 可选过滤 | 旧代码一致（`? IS NULL OR column = ?` 过滤模式） |
| `searchVec(embedding, limit, filters)` | vec0 MATCH + JOIN + 可选过滤 | 旧代码一致（hasVecTable 检查 + 降级） |
| `hasVecTable()` | 返回构造时缓存的 vec 可用性 | 旧代码一致 |
| `incrementRetrievalCounts(ids)` | 事务：批量 UPDATE memory_weights | 旧代码一致 |
| `flagMemory(id, flagged)` | UPDATE memory_weights SET user_flagged=? | 旧代码一致 |
| `updateLayerByConversation(convId, from, to)` | UPDATE memory_entries SET layer=? WHERE conversation_id=? AND layer=? | 旧代码一致 |

**关键设计决策**：
- `storeEntry` 接收完整 `MemoryEntry` entity（含 ID），Repository 不生成 ID
- `tree_path` 列在 INSERT 时写 NULL（列保留但不使用）
- vec0 可用性在构造时缓存（`checkVecTable()` 探测 `SELECT 1 FROM memory_vec LIMIT 1`）
- FTS5 查询使用 `escapeFtsQuery()` 转义为 phrase query
- 嵌入存储使用 `Buffer` → `Float32Array` 转换（sqlite-vec 返回 Buffer）

#### db/memory/memory-mapper.ts

**职责**：`MemoryEntryRow` ↔ `MemoryEntry`、`MemoryWeightRow` ↔ `MemoryWeight`、`bufferToFloat32Array()` 转换。

**旧代码直接迁移**，无新增字段。

#### db/conversation/sqlite-conversation-repository.ts

**职责**：实现 `ConversationRepository` 接口（31 方法）。这是最大的 Repository 文件。

**接口实现映射**（按分类）：

**Conversation CRUD（4 方法）**：

| 接口方法 | SQL 操作 | 说明 |
|---------|---------|------|
| `create(conversation, otterIds?)` | 事务：INSERT conversations + INSERT conversation_otters (batch) | 旧代码一致；otterIds 可选 |
| `getById(id)` | SELECT FROM conversations WHERE id = ? | 旧代码一致 |
| `updateStatus(id, status, timestamp)` | UPDATE conversations SET status=?, completed_at/archived_at=?, updated_at=? | 旧代码使用 `datetime('now')`，新代码接收时间戳 |
| `getIdsByOtterId(otterId)` | SELECT conversation_id FROM conversation_otters WHERE otter_id=? | 新方法（C3 修复） |

**Participants（1 方法）**：

| 接口方法 | SQL 操作 | 说明 |
|---------|---------|------|
| `getOtterIds(conversationId)` | SELECT otter_id FROM conversation_otters WHERE conversation_id=? | 旧代码一致 |

**Turn 管理（5 新方法）**：

| 接口方法 | SQL 操作 | 说明 |
|---------|---------|------|
| `createTurn(turn)` | INSERT INTO turns | 新增（Turn 实体） |
| `getActiveTurn(conversationId)` | SELECT FROM turns WHERE conversation_id=? AND status='open' LIMIT 1 | 新增 |
| `closeTurn(turnId, closedAt)` | UPDATE turns SET status='closed', closed_at=? WHERE id=? | 新增 |
| `getMaxTurnNumber(conversationId)` | SELECT MAX(turn_number) FROM turns WHERE conversation_id=? | 新增 |
| `getMessagesByTurnId(turnId)` | SELECT FROM messages WHERE turn_id=? ORDER BY sequence_num ASC | 新增 |

**Message 生命周期（5 方法）**：

| 接口方法 | SQL 操作 | 说明 |
|---------|---------|------|
| `createCompletedMessage(message)` | INSERT INTO messages (含 turn_id, talking_stone_passed_to) | 旧代码签名变更：接收完整 entity |
| `createStreamingMessage(message)` | INSERT INTO messages (body=NULL, 含 turn_id, talking_stone_passed_to) | 旧代码签名变更 |
| `completeMessage(messageId, body, talkingStonePassedTo, attachments, completedAt)` | UPDATE messages SET status='completed', body=?, talking_stone_passed_to=?, attachments=?, completed_at=? WHERE id=? AND status='streaming' | 新增 talking_stone_passed_to 字段 |
| `failMessage(messageId)` | UPDATE messages SET status='failed', completed_at=datetime('now') WHERE id=? AND status='streaming' | 旧代码一致（加并发守护）。**例外**：usecases 接口未定义 `failedAt` 参数，此方法使用 `datetime('now')` |
| `getMaxSequenceNum(conversationId)` | SELECT MAX(sequence_num) FROM messages WHERE conversation_id=? | 旧代码一致 |

**Message 查询（4 方法）**：

| 接口方法 | SQL 操作 | 说明 |
|---------|---------|------|
| `getMessageById(id)` | SELECT FROM messages WHERE id = ? | 旧代码一致 |
| `getMessages(conversationId, options)` | SELECT FROM messages WHERE conversation_id=? [AND status=?] [AND turn_id=?] [AND sequence_num < (subquery)] ORDER BY sequence_num DESC LIMIT ? | 旧代码扩展：新增 turnId 过滤 |
| `getMessagesBefore(messageId, count)` | SELECT FROM messages WHERE conversation_id=(subquery) AND sequence_num < (subquery) ORDER BY sequence_num DESC LIMIT ? | 旧代码签名变更：移除 conversationId 参数，用子查询推导 |
| `getMessagesAfter(messageId, count)` | SELECT FROM messages WHERE conversation_id=(subquery) AND sequence_num > (subquery) ORDER BY sequence_num ASC LIMIT ? | 同上 |

**MessageEvent（3 方法）**：

| 接口方法 | SQL 操作 | 说明 |
|---------|---------|------|
| `appendEvent(event)` | INSERT INTO message_events | 旧代码签名变更：接收完整 entity |
| `getMessageEvents(messageId)` | SELECT FROM message_events WHERE message_id=? ORDER BY sequence_num ASC | 旧代码一致 |
| `getMaxEventSequenceNum(messageId)` | SELECT MAX(sequence_num) FROM message_events WHERE message_id=? | 旧代码一致 |

**Key Info（4 方法）**：

| 接口方法 | SQL 操作 | 说明 |
|---------|---------|------|
| `addKeyFact(keyFact)` | INSERT INTO key_facts | 旧代码签名变更：接收完整 entity |
| `linkResource(resource)` | INSERT INTO linked_resources | 旧代码签名变更：接收完整 entity |
| `getKeyFacts(conversationId)` | SELECT FROM key_facts WHERE conversation_id=? ORDER BY created_at ASC | 旧代码一致 |
| `getLinkedResources(conversationId)` | SELECT FROM linked_resources WHERE conversation_id=? ORDER BY created_at ASC | 旧代码一致 |

**Participant 管理（5 新方法）**：

| 接口方法 | SQL 操作 | 说明 |
|---------|---------|------|
| `createParticipant(participant)` | INSERT INTO conversation_participants | 新增 |
| `createParticipants(participants)` | 事务：批量 INSERT INTO conversation_participants | 新增（批量创建初始参与者） |
| `getParticipant(conversationId, otterId)` | SELECT FROM conversation_participants WHERE conversation_id=? AND otter_id=? LIMIT 1 | 新增 |
| `getActiveParticipants(conversationId)` | SELECT FROM conversation_participants WHERE conversation_id=? AND status='active' | 新增 |
| `updateParticipantLeave(participantId, leftAtTurnId, leftAtTurnNumber, leftAt)` | UPDATE conversation_participants SET status='left', left_at_turn_id=?, left_at_turn_number=?, left_at=? WHERE id=? | 新增 |

**关键设计决策**：
- Repository 方法接收完整 entity 或具名参数，不再接收 `(id, input)` 形式 — ID 生成由 use case 负责
- `talking_stone_passed_to` 存储为 JSON TEXT（`JSON.stringify(string[])`）
- `attachments` 存储为 JSON TEXT（`JSON.stringify(Attachment[])`）
- `completeMessage` 和 `failMessage` 使用 `WHERE status='streaming'` 并发守护（`changes === 0` 时抛错）
- `getMessagesBefore/After` 使用子查询推导 `conversationId`，无需调用方传入
- `createParticipants` 使用事务批量插入（用于 `ManageConversation.create()` 创建初始参与者）
- `updateStatus` 接收时间戳参数，不使用 `datetime('now')` — 时间来源由 use case 控制
- `failMessage` 是例外：usecases 接口 `failMessage(messageId)` 未定义时间戳参数，此方法使用 `datetime('now')`。这是接口缺陷但不在本 Issue 修复范围内
- `tree_path` 和 `parent_id` 在 INSERT conversations 时写 NULL（列保留但不使用）

**ESLint 注意**：`sqlite-conversation-repository.ts` 包含 31 个方法实现，可能超过 `max-lines: 450` 限制。需要 ESLint override 或通过提取辅助函数控制行数。这是实现层关注点，开发者自行判断。

#### db/conversation/conversation-mapper.ts

**职责**：6 种 Row ↔ Entity 映射。

| Row 类型 | Entity 类型 | 新增字段 |
|---------|------------|---------|
| `ConversationRow` | `Conversation` | 无变化（parent_id, tree_path 保留但不映射） |
| `MessageRow` | `Message` | +`turn_id`, +`talking_stone_passed_to` |
| `MessageEventRow` | `MessageEvent` | 无变化 |
| `KeyFactRow` | `KeyFact` | 无变化 |
| `LinkedResourceRow` | `LinkedResource` | 无变化 |
| `TurnRow` | `Turn` | 新增 |
| `ParticipantRow` | `ConversationParticipant` | 新增 |

**新增映射**：
- `MessageRow` 新增 `turn_id: string | null`、`talking_stone_passed_to: string | null`
- `rowToMessage()` 新增：`turnId = row.turn_id`、`talkingStonePassedTo = JSON.parse(row.talking_stone_passed_to) || []`
- `TurnRow`：`id, conversation_id, turn_number, status, created_at, closed_at`
- `rowToTurn()`：直接映射 + status 类型转换
- `ParticipantRow`：`id, conversation_id, otter_id, joined_at_turn_id, joined_at_turn_number, left_at_turn_id, left_at_turn_number, status, created_at, left_at`
- `rowToParticipant()`：直接映射 + status 类型转换

### frameworks/llm/models-factory.ts

**职责**：创建 pi-ai `Models` 对象（Provider 路由 + Model 获取），供 AgentHarness 消费。

**导出**：
- `async function initModels(config?): Promise<Models>` - 异步工厂，返回 pi-ai 的 `Models` 对象
- `async function initFauxModels(responses): Promise<{ models: Models; faux: unknown }>` - 测试用工厂

**旧代码参考**：`reference/old-src/infra/llm-gateway.ts`（提取 Models 创建逻辑，移除 chat/streamChat）

**与旧代码差异**（基于 `docs/research/pi-capability-analysis.md`）：
- 旧代码导出 `LLMGateway` 接口（chat/streamChat/getModel）-> 新代码只导出 `Models` 工厂
- LLM 交互（chat/streamChat）由 `AgentHarness` 内部处理，不需要独立 LLMGateway
- `Models` 对象通过构造函数注入到 `PiHarnessFactory`，由 harness 消费
- 移除 `LLMMessage`, `LLMChatOptions`, `LLMResponse`, `LLMStreamChunk` 类型（pi-ai 内部类型，不需要重新定义）
- 保留 `loadPiAi()` 单例缓存 + `loadProvider()` 多 Provider 适配逻辑
- 保留 `initFauxModels()` 测试工厂（返回 `{ models, faux }` 供测试断言）

**关键设计决策**：
- `Models` 是 pi-ai 的类型，不需要在 frameworks 层重新定义接口
- 异步工厂模式（pi-ai 是 ESM-only，需要 dynamic import）
- 配置来源：`@frameworks/config` 的 `llm` 配置段（provider, model）

### frameworks/embedding/

> Embedding 模块设计不变，与初版一致。

#### embedding-service.ts

**职责**：实现 `EmbeddingGateway` 接口，通过 Worker Thread 调用 bge-m3 模型。

**导出**：
- `class EmbeddingServiceImpl implements EmbeddingGateway` - `embed(text): Promise<Float32Array>`
- `async function initEmbeddingService(config?): Promise<{ service: EmbeddingGateway; dispose: () => void }>` - 异步工厂
  - 返回 service + dispose 方法（dispose 不在 `EmbeddingGateway` 接口中，供 main.ts 调用）

**旧代码参考**：`reference/old-src/infra/embedding/service.ts`

**关键设计决策**：
- Worker Thread 模式：主线程 postMessage -> Worker 推理 -> 返回 Float32Array
- Promise-based 请求/响应关联（数字 ID）
- 就绪跟踪 + 等待队列（模型加载完成前请求排队）
- `dispose()` 不在 `EmbeddingGateway` 接口中，通过工厂返回值暴露
- 降级处理：Worker 加载失败时 `embed()` 抛错（调用方 catch 后降级为 FTS5-only）

#### bge-m3-worker.ts

**职责**：Worker Thread 内运行 bge-m3 模型推理。

**旧代码参考**：`reference/old-src/infra/embedding/worker.ts`（直接迁移）

**关键设计决策**：
- 懒加载模型：首次 `embed` 调用时 `pipeline("feature-extraction", "Xenova/bge-m3", { dtype: "fp32" })`
- 启动时预加载：`getExtractor()` 立即调用，加载完成后 post `ready` 消息
- `{ pooling: "cls", normalize: true }` 推理选项
- `Float32Array` 通过 structured clone 传输（无需 transferList）

### frameworks/agent/

> **基于 `docs/research/pi-capability-analysis.md` 重新设计**。使用 Pi 的 **AgentHarness**（非 Agent），采用**冷启动模型**，Session 管理委托给 Pi 内置 `JsonlSessionRepo`。

#### pi-harness-factory.ts

**职责**：实现 `AgentGateway` 接口（3 方法）+ 提供冷启动 `invoke()` 方法供 interface-adapters 层使用。

**导出**：
- `class PiHarnessFactory implements AgentGateway` - 实现 `create()`, `destroy()`, `reset()`
- `async invoke(otterId: string, message: string, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult>` - 冷启动调用：打开 session -> 创建 AgentHarness -> prompt -> 释放
- `async function initAgentCore(config): Promise<PiHarnessFactory>` - 异步工厂

**接口实现映射**：

| 接口方法 | 实现（冷启动模型） | 旧代码对比 |
|---------|-------------------|-----------|
| `create(otterId, config)` | `JsonlSessionRepo.create()` 创建 Pi session -> `agent_session_store.set(otterId, piSessionId)` 存储映射 | 旧代码创建 Agent 实例存入 Map |
| `destroy(otterId)` | 可选 `JsonlSessionRepo.delete()` 删除 Pi session -> `agent_session_store.delete(otterId)` | 旧代码从 Map 删除 Agent |
| `reset(otterId, context?)` | `JsonlSessionRepo.create()` 创建新 Pi session（chain）-> 更新映射。旧 Pi session JSONL 文件保留作为历史存档 | 旧代码调用 agent.reset() + 重建 prompt |

**冷启动 invoke() 流程**（R17）：
1. `agent_session_store.get(otterId)` 获取 `pi_session_id`
2. `JsonlSessionRepo.open(piSessionId)` 加载 Pi session
3. 创建 `AgentHarness`（配置 tools, skills, systemPrompt 函数, model）
4. `harness.prompt(message)` 执行 + `onEvent` 回调推送事件
**system-prompt-builder 调用链**（CR-11 修复）：
1. `create(otterId, config)` 时存储 `config.systemPrompt` 作为静态层
2. `invoke(otterId, message, options?)` 时，`options.dynamicContext` 由 interface-adapters 层从 use case 获取并传入
3. `buildSystemPrompt(storedStaticPrompt, options.dynamicContext)` 构建 prompt 函数
4. frameworks 层不做记忆检索等 DB 访问，动态内容由上层准备

5. 检查 token 用量，超阈值则 `harness.compact()`
6. 释放 harness 引用（GC 回收），session 数据已通过 JSONL 持久化

**关键设计决策**：
- **冷启动模型**（R17）：每次发言创建 harness，完成后释放。无空闲内存占用，不需要 LRU 淘汰
- **Pi 自管理 Session**（R12）：使用 Pi 内置 `JsonlSessionRepo`，Otter 只存 `pi_session_id`
- **Pi 内置 NodeExecutionEnv**（R13）：不需要自定义 ExecutionEnv
- `AgentGateway` 接口语义变更：create/destroy/reset 管理 Pi session 生命周期，不再管理 Agent 实例
- `invoke()` 是 frameworks-internal 方法，供 interface-adapters 层调用（不在 usecases 接口中）
- 依赖 `Models` 对象（通过构造函数注入）+ `Database`（用于 agent_sessions 表）
- **不需要 AgentHandle**：冷启动模型下无持久化句柄，interface-adapters 通过 `invoke()` 交互
- **不需要 AgentToolDef**：AgentTool 类型由 pi-agent-core 定义，frameworks 层不重新定义
- 异步工厂模式（pi-agent-core 是 ESM-only）

#### system-prompt-builder.ts

**职责**：组合动态 system prompt 函数（静态层 + 动态层）。

**导出**：
- `function buildSystemPrompt(staticPrompt: string, dynamicContext?: DynamicContext): (ctx: HarnessContext) => string` - 返回动态 prompt 函数
- `interface DynamicContext { memoryRetrieval?: string; sessionSummary?: string }` - 动态内容

**设计**（基于研究文档第 2 节 + R10）：
- **静态层**：Otter 角色定义 + Skill 声明（来自 `AgentConfig.systemPrompt`，变化频率低）
- **动态层**：会话摘要 + 记忆检索结果 + 系统提醒（变化频率高）
- systemPrompt 函数在**每次 LLM API 调用前**执行（无缓存）
- 稳定内容放 systemPrompt 函数；每轮变化内容建议通过 `transformContext` 注入（保留 prefix caching）

**关键设计决策**：
- systemPrompt 函数模式（非静态字符串）：Pi 在每轮 LLM 调用前重新求值
- 静态层来自 use case 传入的 `AgentConfig.systemPrompt`
- 动态层内容由 use case 通过 invoke() 参数传入（如记忆检索结果、会话摘要），frameworks 层只负责格式化，不做 DB 访问
- `transformContext` 注入点用于每轮变化的提醒（研究文档第 3 节注入点 B）

#### tool-registry.ts

**职责**：管理 AgentTool 注册和 `activeToolNames` 按 Otter 类型筛选。

**导出**：
- `class ToolRegistry` - `register(tool)`, `unregister(toolId)`, `getActiveTools(otterType: string): TTool[]`
- `interface OtterToolConfig { otterType: string; activeToolNames: string[] }` - 按 Otter 类型配置工具可见性

**设计**（基于研究文档第 4-5 节）：
- 所有工具统一注册到 `ToolRegistry`（`tools` Map）
- 每个 Otter 类型有不同的 `activeToolNames` 子集（研究文档决策表）
- `getActiveTools(otterType)` 返回该类型 Otter 可见的工具列表
- 运行时可通过 `harness.setActiveTools()` 动态切换（空闲时立即生效，运行中下一轮生效）

**Otter 工具配置**（研究文档第 5 节）：

| 工具名 | 大獭 | 设计獭 | 检视獭 |
|--------|------|--------|--------|
| `send_message` | yes | yes | yes |
| `pass_talking_stone` | yes | - | - |
| `search_memory` | yes | yes | yes |
| `store_memory` | yes | - | - |
| `create_otter` | yes | - | - |
| `dissolve_otter` | yes | - | - |
| `create_linked_resource` | - | yes | yes |

> AgentTool 实现归属于 interface-adapters 层（Issue 5）。本 Issue 只提供 ToolRegistry 基础设施。工具通过 main.ts 注册到 ToolRegistry。

#### agent-session-store.ts

**职责**：管理 `otter_id` ↔ `pi_session_id` 映射（`agent_sessions` 表）。

**导出**：
- `class AgentSessionStore` - `set(otterId, piSessionId)`, `get(otterId): string | null`, `delete(otterId)`, `update(otterId, newPiSessionId)`
- `function createAgentSessionStore(db: Database.Database): AgentSessionStore` - 工厂函数

**SQL 操作**：

| 方法 | SQL |
|------|-----|
| `set(otterId, piSessionId)` | INSERT OR REPLACE INTO agent_sessions (otter_id, pi_session_id) VALUES (?, ?) |
| `get(otterId)` | SELECT pi_session_id FROM agent_sessions WHERE otter_id = ? |
| `delete(otterId)` | DELETE FROM agent_sessions WHERE otter_id = ? |
| `update(otterId, newPiSessionId)` | UPDATE agent_sessions SET pi_session_id = ?, updated_at = datetime('now') WHERE otter_id = ? |

**关键设计决策**：
- 独立于 `OtterRepository`：`pi_session_id` 是 frameworks-internal 数据，不属于 Otter 实体
- `AgentSessionStore` 被 `PiHarnessFactory` 通过构造函数注入
- 不需要 Mapper（数据结构简单，直接在 Store 内处理）
### frameworks/config.ts

**职责**：不可变配置对象。

**导出**：`const config`（`as const`）

**配置结构**：

```typescript
export const config = {
  db: {
    path: process.env.OTTER_BUDDY_DB_PATH ?? "./otter-buddy.db",
    walMode: true,
    foreignKeys: true,
  },
  server: {
    port: Number(process.env.OTTER_BUDDY_PORT ?? "3000"),
  },
  memory: {
    rrfK: 60,
    weightHalfLifeDays: 7,
    userFlagMultiplier: 2.0,
    frequencyBoostFactor: 0.1,
    // samePathBoost 和 crossPathDecay 已移除（treePath 去除，F20260715b8c6）
  },
  embedding: {
    dimensions: 1024,
    modelPath: "Xenova/bge-m3",
  },
  llm: {
    provider: process.env.OTTER_BUDDY_LLM_PROVIDER ?? "openai",
    model: process.env.OTTER_BUDDY_LLM_MODEL ?? "gpt-4o",
  },
} as const;
```

**与旧代码差异**：
- 移除 `memory.samePathBoost`（1.5）— treePath 已去除
- 移除 `memory.crossPathDecay`（0.8）— 同上

### 依赖关系

```
frameworks/db/database.ts        ──> better-sqlite3, sqlite-vec, @frameworks/logger, @frameworks/config
frameworks/db/schema.ts           ──> better-sqlite3 (type only)
frameworks/db/otter/              ──> @usecases/otter/otter-repository (impl), @entities/otter/*, @frameworks/logger
frameworks/db/memory/             ──> @usecases/memory/memory-repository (impl), @entities/memory/*, @frameworks/logger
frameworks/db/conversation/       ──> @usecases/conversation/conversation-repository (impl), @entities/conversation/*, @frameworks/logger
frameworks/llm/models-factory.ts    ──> @earendil-works/pi-ai (dynamic), @frameworks/config, @frameworks/logger
frameworks/embedding/             ──> worker_threads, @huggingface/transformers (dynamic, worker only), @frameworks/logger
frameworks/agent/                 ──> @usecases/otter/agent-gateway (impl), @earendil-works/pi-agent-core (dynamic), @frameworks/llm/models-factory, @frameworks/db (agent_sessions), @frameworks/logger
frameworks/config.ts              ──> (无依赖，纯常量)
```

**层依赖方向**：
- frameworks → usecases（实现接口）✅
- frameworks → entities（使用类型）✅
- frameworks → frameworks（内部依赖）✅
- usecases → frameworks（除 logger）❌ 禁止
- entities → frameworks（除 logger）❌ 禁止

## 不兼容更新

| 变更 | 影响范围 | 处理方式 |
|------|---------|---------|
| `messages` 表新增 `turn_id` 列 | 已有数据库的 messages 表缺少此列 | 新数据库：CREATE TABLE 包含；已有数据库：手动 `ALTER TABLE messages ADD COLUMN turn_id TEXT` |
| `messages` 表新增 `talking_stone_passed_to` 列 | 同上 | 同上：`ALTER TABLE messages ADD COLUMN talking_stone_passed_to TEXT` |
| `otter_sessions` 表新增 `previous_session_id` 列 | 已有数据库的 otter_sessions 表缺少此列 | 同上：`ALTER TABLE otter_sessions ADD COLUMN previous_session_id TEXT` |
| 新增 `turns` 表 | 不影响已有数据库 | `CREATE TABLE IF NOT EXISTS`（幂等） |
| 新增 `conversation_participants` 表 | 不影响已有数据库 | `CREATE TABLE IF NOT EXISTS`（幂等） |
| 新增 `agent_sessions` 表 | 不影响已有数据库 | `CREATE TABLE IF NOT EXISTS`（幂等）。存储 otter_id ↔ pi_session_id 映射 |
| `config.ts` 移除 `samePathBoost` 和 `crossPathDecay` | 使用旧 config 的代码编译失败 | 旧代码已归档至 `reference/old-src/`，不影响新代码 |
| `conversations.tree_path` 约束从 `NOT NULL` 改为可空 | 已有数据库的 tree_path 列有 NOT NULL 约束 | 新数据库：CREATE TABLE 使用 `TEXT`（可空）；已有数据库：手动处理或 Repository 写空字符串 `''` 替代 NULL |

> **注意**：本项目采用 Greenfield 方式（D42），数据库将全新创建。以上不兼容变更仅影响复用已有数据库的场景。

## 核心业务行为

> 以下行为条目是 frameworks 层实现后必须保持的业务行为，作为 interface-adapters 层测试的回归守护。frameworks 层本身不改变业务行为，但 Repository 实现必须正确支持这些行为。

| ID | 触发条件 | 预期行为 | 追溯 |
|----|---------|---------|------|
| B1 | 创建 Otter 记录后，Agent 创建失败时 | DB 记录应被回滚删除（`deleteOtter` 必须正确执行硬 DELETE） | ← F20260714zjmk B1, F20260715b8c6 B1 |
| B2 | 查询大獭且系统中不存在大獭时 | 应抛出错误（use case 层行为，Repository `getBigOtter` 返回 null 即可） | ← F20260714zjmk B2, F20260715b8c6 B2 |
| B3 | 归档 session 且 reason='restart' 时 | session 状态变为 'restarted'（`archiveSession` 正确写入 status） | ← F20260714zjmk B3, F20260715b8c6 B3 |
| B4 | 归档 session 且 reason 不为 'restart' 时 | session 状态变为 'archived' | ← F20260714zjmk B4, F20260715b8c6 B4 |
| B5 | 解散 Otter 时 | Otter 状态变为 'dissolved'，对应 Agent 被销毁（`dissolve` + `AgentGateway.destroy`） | ← F20260714zjmk B5, F20260715b8c6 B5 |
| B6 | 混合检索记忆时 | FTS5 + vec0 结果通过 RRF 融合后返回（`searchFTS` + `searchVec` + `hasVecTable` 正确实现） | ← F20260714zjmk B6, F20260715b8c6 B6 |
| B7 | 用户发送消息时 | 消息写入 DB（含 turn_id, talking_stone_passed_to），status="completed" | ← F20260715b8c6 B7 |
| B8 | Otter 开始流式消息时 | 消息写入 DB（body=NULL, status="streaming"），turn_id 正确关联 | ← F20260715b8c6 B8 |
| B9 | Turn 内所有消息到达终态时 | Turn 被关闭（`closeTurn` 正确执行） | ← F20260715b8c6 B9 |
| B10 | 归档 session 时 | 工作记忆转为历史记忆（`updateLayerByConversation` 正确执行批量 UPDATE） | ← F20260715b8c6 B10 |
| B14 | Session 创建时 | previousSessionId 写入 DB（`createSession` 正确写入 `previous_session_id`） | ← F20260715b8c6 B14 |
| B15 | 完成消息时 body 为空 | use case 层校验，Repository 不需守护 | ← F20260715b8c6 B15 |
| B17 | 标记消息失败后 | body 保持 NULL（`failMessage` 不设置 body） | ← F20260715b8c6 B17 |
| B18 | Otter 进场时 | 系统消息写入 DB（sender_type="system", turn_id 关联），ConversationParticipant 记录创建 | ← F20260715b8c6 B18 |
| B19 | Otter 退场时 | 系统消息写入 DB，ConversationParticipant 记录更新（status='left', left_at_turn_id/number） | ← F20260715b8c6 B19 |
| B20 | 查询在场名单 | 返回所有 status="active" 的 ConversationParticipant 记录 | ← F20260715b8c6 B20 |
| B26 | 创建对话时 | 初始参与者 ConversationParticipant 记录创建（joined_at_turn_id=NULL, joined_at_turn_number=0） | ← F20260715b8c6 B26 |
| F1 | 嵌入存储时 | memory_vec 表正确存储 Float32Array（Buffer 转换正确） | ← 新增（frameworks 层特有） |
| F2 | vec0 检索时 | 返回正确的 distance 值和关联的 MemoryEntry | ← 新增 |
| F3 | sqlite-vec 不可用时 | `hasVecTable()` 返回 false，`searchVec()` 返回空数组，FTS5 正常工作 | ← D22 降级模式 |
| F4 | AgentHarness 创建时 | harness 正确配置 systemPrompt 函数、tools（activeToolNames）、model | ← R17 冷启动模型 |
| F8 | Agent 发言时（冷启动） | 创建 AgentHarness -> prompt -> 释放。Session 通过 JSONL 持久化，不丢数据 | ← R17 冷启动模型 |
| F9 | Agent 发言完成后 token 超阈值 | 调用 `harness.compact()` 压缩上下文 | ← R1 手动 compaction |
| F10 | AgentGateway.create() 时 | 创建 Pi session（JsonlSessionRepo），存储 pi_session_id 到 agent_sessions 表 | ← R12 Pi 自管理 Session |
| F11 | AgentGateway.reset() 时 | 创建新 Pi session（chain），更新 pi_session_id 映射 | ← R9 Otter chain |
| F12 | 不同 Otter 类型 | activeToolNames 筛选不同工具子集（大獭 6 工具，设计獭 3 工具，检视獭 3 工具） | ← 研究文档第 5 节 |

## 硬约束

1. frameworks/ 不可被 entities/ 或 usecases/ 直接 import（`@frameworks/logger` 除外）
2. Repository 实现必须 `implements` usecases 层定义的接口（依赖反转，D37）
3. 不使用 ALTER TABLE（schema 变更只允许 `CREATE TABLE IF NOT EXISTS`，F2026052204）
4. 不引入新的第三方依赖（使用已有的 better-sqlite3, sqlite-vec, pi-ai, pi-agent-core, @huggingface/transformers）
5. `tsc --noEmit` 通过
6. `eslint src/frameworks/` 无违规（如需 override，必须在 PR 中说明理由）
7. Config 值不直接被 usecases import（通过 main.ts 构造函数注入）
8. `talking_stone_passed_to` 存储为 JSON TEXT（`JSON.stringify(string[])`）
9. `attachments` 存储为 JSON TEXT（`JSON.stringify(Attachment[])`）
10. Boolean 字段存储为 INTEGER (0/1)
11. `completeMessage` 和 `failMessage` 必须包含 `WHERE status='streaming'` 并发守护
12. `storeEntry` 必须在单事务内写入 memory_entries + memory_fts + memory_weights
13. `create(conversation, otterIds?)` 必须在单事务内写入 conversations + conversation_otters
14. `createParticipants` 必须在单事务内批量写入
15. sqlite-vec 加载失败时必须降级为 FTS5-only（D22），不阻塞启动
16. `EmbeddingGateway.embed()` 失败时由调用方（use case）catch，frameworks 层不吞错
17. `AgentGateway.create()` 在 otterId 已存在时抛错（防止 Agent 泄漏）
18. 旧代码列（`conversations.parent_id`, `conversations.tree_path`, `memory_entries.tree_path`）保留在 Schema 中但 Repository 不写入（写 NULL）。`conversations.tree_path` 的 NOT NULL 约束必须移除为可空

## 设计取舍

| 取舍点 | 正方 | 反方 | 最终选择 |
|--------|------|------|---------|
| Repository 方法接收完整 entity vs 具名参数 | 完整 entity 更简洁，ID 生成由 use case 控制 | 具名参数更灵活 | 完整 entity。use case 层已经定义了接口签名，frameworks 层适配 |
| `getMessagesBefore/After` 是否需要 conversationId 参数 | 旧代码传入 conversationId，查询更高效 | 新接口不传，用子查询推导 | 不传（遵循 usecases 接口定义）。子查询性能开销可接受（SQLite 子查询优化好） |
| `EmbeddingGateway.dispose()` 处理 | 放入接口 | 通过工厂返回值暴露 | 工厂返回值。dispose 是生命周期关注点，不属于业务接口 |
| 冷启动模型 vs 持久化 Agent 实例 | 无空闲内存占用，自然限制并发 | 持久化实例响应更快 | 冷启动（R17 用户决策）。Session 通过 JSONL 持久化，drop 后不丢数据
| Pi Session 存储方式 | Otter 自定义 SqliteSessionStorage | Pi 内置 JsonlSessionRepo，Otter 只存 session ID | Pi 内置（R12 用户决策）。零自定义实现，边界清晰
| AgentTool 归属层 | frameworks/agent/tools/（与 harness 同层） | interface-adapters/agent-runtime/tools/ | interface-adapters。AgentTool 是适配器，与 HTTP Controller 同层级
| LLM 模块形态 | 完整 LLMGateway 接口（chat/streamChat/getModel） | 简化为 Models 工厂 | Models 工厂。LLM 交互由 harness 处理
| 旧列（parent_id, tree_path）是否从 Schema 移除 | 移除更干净 | 保留兼容已有数据库 | 保留。Greenfield 数据库无影响，已有数据库避免破坏 |
| `config.ts` 是否保留 `server` 段 | 保留供 interface-adapters 使用 | 当前不使用，可后续添加 | 保留。配置是全局的，提前定义避免后续添加时遗漏 |
| `database.ts` 是否支持连接池 | SQLite 单连接足够 | 连接池支持并发 | 单连接。better-sqlite3 是同步设计，单连接足够。WAL 模式支持并发读 |
| Schema 中 `turns` 和 `conversation_participants` 的外键 | 完整外键约束保证数据完整性 | 外键影响插入性能 | 完整外键。数据完整性 > 性能，SQLite 外键开销可接受 |

## 实现指引

> 以下为开发者实现时的参考指引，非硬性约束。

### Repository 实现顺序建议

1. `database.ts` + `schema.ts`（基础设施先行）
2. `otter-mapper.ts` + `sqlite-otter-repository.ts`（最简单，10 方法）
3. `memory-mapper.ts` + `sqlite-memory-repository.ts`（中等，12 方法，含 FTS5/vec0）
4. `conversation-mapper.ts` + `sqlite-conversation-repository.ts`（最复杂，31 方法，含新表）
5. `config.ts`（独立，无依赖）
6. `models-factory.ts`（独立，依赖 pi-ai）
7. `embedding-service.ts` + `bge-m3-worker.ts`（独立，依赖 transformers）
8. `system-prompt-builder.ts` + `tool-registry.ts` + `agent-session-store.ts` + `pi-harness-factory.ts`（依赖 Models 工厂）

### Mapper 实现模式

参照旧代码 mapper 的统一模式：
- Row 接口使用 snake_case（匹配 DB 列名）
- Entity 使用 camelCase（匹配 entities 层定义）
- Boolean: DB INTEGER (0/1) ↔ Entity boolean
- JSON: DB TEXT ↔ Entity object/array（`JSON.parse` with null check）
- Enum-like: DB TEXT ↔ Entity union type（`as` 类型转换）
- Buffer: DB BLOB ↔ Entity Float32Array（`bufferToFloat32Array`）

### 事务模式

参照旧代码的显式事务管理：
```typescript
const tx = this.db.transaction(() => {
  // 多条 SQL
});
tx();
```
或显式 `BEGIN`/`COMMIT`/`ROLLBACK`（旧代码风格，更直观）。

### 异步工厂模式

LLM/Embedding/Agent 模块使用异步工厂（ESM dynamic import）：
```typescript
export async function initXxx(config): Promise<Xxx> {
  const mod = await import("esm-only-package");
  // 初始化...
  return new XxxImpl(...);
}
```

### ESLint max-lines 风险

`sqlite-conversation-repository.ts`（31 方法）可能超过 `max-lines: 450`。解决方案（开发者自行选择）：
1. 提取辅助函数到同目录的 `_helpers.ts` 文件
2. 在 `eslint.config.mjs` 中为该文件添加 override
3. 拆分为多个文件（不推荐，破坏单一 Repository 语义）

## 验证

### 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] `eslint src/frameworks/` 无违规
- [ ] `frameworks/db/database.ts` 导出 `initDatabase()` + `closeDatabase()` + `DatabaseConfig`
- [ ] `frameworks/db/schema.ts` 导出 `initSchema(db)`，包含所有表（含 `turns` + `conversation_participants` + `agent_sessions`）+ 所有索引
- [ ] `frameworks/db/otter/sqlite-otter-repository.ts` `implements OtterRepository`（10 方法）
- [ ] `frameworks/db/memory/sqlite-memory-repository.ts` `implements MemoryRepository`（12 方法）
- [ ] `frameworks/db/conversation/sqlite-conversation-repository.ts` `implements ConversationRepository`（31 方法）
- [ ] 三个 mapper 文件导出正确的 Row 接口 + `rowTo*()` 函数
- [ ] `frameworks/llm/models-factory.ts` 导出 `initModels()` + `initFauxModels()`
- [ ] `frameworks/embedding/embedding-service.ts` 导出 `EmbeddingGateway` 实现 + `initEmbeddingService()`
- [ ] `frameworks/embedding/bge-m3-worker.ts` 导出 Worker 逻辑
- [ ] `frameworks/agent/pi-harness-factory.ts` `implements AgentGateway`（3 方法）+ 导出 `invoke()` + `initAgentCore()`
- [ ] `frameworks/agent/system-prompt-builder.ts` 导出 `buildSystemPrompt()` + `DynamicContext`
- [ ] `frameworks/agent/tool-registry.ts` 导出 `ToolRegistry` + `OtterToolConfig`
- [ ] `frameworks/agent/agent-session-store.ts` 导出 `AgentSessionStore` + `createAgentSessionStore()`
- [ ] `agent_sessions` 表存在（含 `otter_id`, `pi_session_id`, `updated_at`）
- [ ] `PiHarnessFactory.invoke()` 实现冷启动流程（open session -> create harness -> prompt -> release）
- [ ] `PiHarnessFactory.create()` 创建 Pi session 并存储 `pi_session_id` 到 `agent_sessions` 表
- [ ] `PiHarnessFactory.reset()` 创建新 Pi session 并更新映射
- [ ] `system-prompt-builder.ts` 使用函数模式（非静态字符串）
- [ ] `tool-registry.ts` 支持 `activeToolNames` 按 Otter 类型筛选
- [ ] `frameworks/config.ts` 导出 `config` 对象（不含 `samePathBoost` 和 `crossPathDecay`）
- [ ] messages 表包含 `turn_id` 和 `talking_stone_passed_to` 列
- [ ] otter_sessions 表包含 `previous_session_id` 列
- [ ] turns 表和 conversation_participants 表存在
- [ ] 无 entities/ → frameworks/（logger 除外）或 usecases/ → frameworks/（logger 除外）的引用
- [ ] `storeEntry` 在单事务内写入 3 张表
- [ ] `create(conversation, otterIds?)` 在单事务内写入 2 张表
- [ ] `completeMessage` 包含 `WHERE status='streaming'` 并发守护
- [ ] `talking_stone_passed_to` 存储/读取为 JSON TEXT
- [ ] sqlite-vec 不可用时降级为 FTS5-only

## 研究文档对齐

> 本文档的 agent/ 和 llm/ 模块设计基于 `docs/research/pi-capability-analysis.md`（F20260715r3s2）的研究成果。

| 研究结论 | 本文档应用 |
|---------|-----------|
| Pi 是嵌入式 Agent 库，不需要 MCP（R14） | AgentTool 通过依赖注入直接调用 usecase，不需要跨进程协议 |
| 使用 AgentHarness（非 Agent） | `pi-harness-factory.ts` 创建 AgentHarness，支持 Session/Skill/Compaction |
| 冷启动模型（R17） | `invoke()` 每次创建 harness，完成后释放。无持久化 AgentHandle |
| Pi 自管理 Session（R12） | 使用 Pi 内置 `JsonlSessionRepo`，Otter 只存 `pi_session_id` |
| Pi 内置 NodeExecutionEnv（R13） | 不需要自定义 ExecutionEnv |
| System Prompt 函数模式（R10） | `system-prompt-builder.ts` 返回动态函数，两层组合 |
| activeToolNames 控制工具可见性 | `tool-registry.ts` 按 Otter 类型筛选工具子集 |
| Tool vs Skill 边界（R15） | AgentTool 实现归属 interface-adapters 层（Issue 5） |
| Compaction 手动触发（R1） | `invoke()` 完成后检查 token 用量，超阈值调用 `harness.compact()` |
| SQLite 不需要额外锁（R18） | better-sqlite3 同步 + WAL 模式已够 |
| **偏离**：pi_session_id 存储位置 | 研究文档建议存入 otter_sessions 表 | 选择独立 agent_sessions 表 | 理由：避免修改 entities/usecases 层 |
| Otter chain 而非 Pi fork（R9） | `reset()` 创建新 Pi session（chain），不使用 `session.fork()` |


## 关联

- **整洁架构 Feature 文档**：[F20260714zjmk](./F20260714zjmk-clean-architecture-restructuring.md)（目录结构、依赖规则、D30-D42 决策）
- **Entities 层实现**：[F20260714jaup](./F20260714jaup-entities-layer-implementation.md)（实体类型 + 不变量函数）
- **Use Cases 层实现**：[F20260715b8c6](./F20260715b8c6-usecases-layer-implementation.md)（Repository/Gateway 接口 + Use Case Class）
- **消息流式模型**：[F20260713e8n4](../13/F20260713e8n4-message-streaming-model.md)（Message/MessageEvent 类型定义）
- **Otter 领域模块**：[F20260713o4t8](../13/F20260713o4t8-domain-otter.md)（Otter/OtterSession 类型定义）
- **Memory 领域模块**：[F20260713m5q3](../13/F20260713m5q3-domain-memory.md)（MemoryEntry/MemoryWeight 类型定义）
- **Infra 基础设施**：[F20260713i5k2](../13/F20260713i5k2-infra-base.md)（LLM/Agent/Embedding 原始实现）
- **Pi Agent 能力探索**：[F20260715r3s2](../../research/pi-capability-analysis.md)（AgentHarness 选型、冷启动模型、Session 管理、Tool/Skill 边界）
