---
id: F20260715k4p2
title: frameworks-layer-implementation
from_ids: [F20260714zjmk, F20260714jaup, F20260715b8c6, F20260715r3s2, F20260713e8n4, F20260713o4t8, F20260713m5q3, F20260713i5k2]
tags: [architecture, frameworks, clean-architecture, db, llm, embedding, agent, pi-agent-core]
modules: [src/frameworks/]
doc_kind: spec
status: locked
created_at: 2026-07-15
---

# F20260715k4p2 整洁架构 Frameworks 层实现

## [design-time]

> 本文档定义整洁架构 frameworks 层的完整实现方案：DB Repository + Mapper + LLM Gateway + Embedding Service + Agent Gateway（Pi AgentHarness 集成）+ Config。遵循 F20260714zjmk 锁定的目录结构和设计决策，参照 F20260715r3s2 Pi Agent 能力探索结论。Schema 直接使用最新版本（UA-2 用户指令）。以下章节在需求收敛与设计阶段（代码前）完成并锁定。进入实现阶段后不得单方面修改，如需变更须通过问题卡片向用户提出并确认。

## 背景 [required]

### 当前状态

- F20260714zjmk Setup 已合入（PR #13）：旧代码归档、四层目录、ESLint 层依赖规则
- F20260714jaup Entities 已合入（PR #15, #16）：三上下文实体类型 + 不变量规则函数 + ConversationParticipant
- F20260715b8c6 Use Cases 已合入（PR #17）：Repository/Gateway 接口 + Use Case Class + SearchEngine
- F20260715r3s2 Pi Agent 探索已完成（PR #26）：Pi 嵌入式架构分析、AgentHarness 选型、冷启动模型、Session 管理方案
- 本 Issue 对应 F20260714zjmk 实现计划的 Issue 4：frameworks 层

### 旧代码参考源

| 模块 | 旧代码路径 | 参考内容 |
|------|-----------|---------|
| DB | `reference/old-src/infra/db/database.ts` | SQLite 初始化 + WAL + sqlite-vec 加载 |
| DB | `reference/old-src/infra/db/schema.ts` | 全部 DDL（表结构 + 索引） |
| DB Otter | `reference/old-src/domain/otter/_internal/repository.ts` + `mapper.ts` | OtterRepository 实现 + Row 映射 |
| DB Memory | `reference/old-src/domain/memory/_internal/repository.ts` + `mapper.ts` | MemoryRepository 实现 + Row 映射 + FTS5/vec0 查询 |
| DB Conversation | `reference/old-src/domain/conversation/_internal/repository.ts` + `mapper.ts` | ConversationRepository 实现 + Row 映射 |
| LLM | `reference/old-src/infra/llm-gateway.ts` | pi-ai 动态 import + Provider 加载 + Models 对象 |
| Embedding | `reference/old-src/infra/embedding/service.ts` + `worker.ts` | Worker Thread + bge-m3 模型加载 |
| Agent | `reference/old-src/infra/agent-core/registry.ts` + `agent.ts` + `tool.ts` | AgentRegistry + AgentHandle（旧 Agent 模式，需替换为 AgentHarness） |
| Config | `reference/old-src/infra/config.ts` | 配置常量 |
| Logger | `src/frameworks/logger.ts` | 已实现（唯一已存在的 frameworks 文件） |

### 上游设计约束

- **D32**：Repository 接口归属 usecases 层，frameworks 实现
- **D37**：frameworks/db/ 实现 usecases 定义的 Repository 接口（依赖反转）
- **D38**：frameworks/db/ 按限界上下文组织 repository + mapper
- **D39**：logger 作为 cross-cutting concern 豁免层依赖规则
- **D42**：Greenfield 实现，旧代码移至 `reference/old-src/` 作参考
- **Config 注入规则**：usecases 需要的配置值通过 main.ts 构造函数注入，不直接 import frameworks/config.ts
- **F20260715r3s2 决策**：
  - Pi 集成入口为 AgentHarness（非 Agent）
  - 冷启动模型：每次发言创建+释放 harness
  - Pi 内置 JsonlSessionRepo 管理 session，Otter 只存 session ID
  - Pi 内置 NodeExecutionEnv，不需要自定义
  - SQLite 不需要额外锁（better-sqlite3 同步 + WAL）
  - 不引入 MCP（Pi 是嵌入式库，函数调用替代跨进程通信）

### usecases 层接口清单（需实现的目标接口）

| 接口 | 类型 | 文件 | 方法数 |
|------|------|------|--------|
| `OtterRepository` | Repository | `usecases/otter/otter-repository.ts` | 10 |
| `MemoryRepository` | Repository | `usecases/memory/memory-repository.ts` | 12 |
| `ConversationRepository` | Repository | `usecases/conversation/conversation-repository.ts` | 31 |
| `EmbeddingGateway` | Gateway | `usecases/memory/embedding-gateway.ts` | 1 |
| `AgentGateway` | Gateway | `usecases/otter/agent-gateway.ts` | 3 |
| `MemoryIndexGateway` | Gateway | `usecases/conversation/memory-index-gateway.ts` | 3 |
| `ConversationQueryGateway` | Gateway | `usecases/otter/manage-session.ts` | 1 |
| `MemoryLayerGateway` | Gateway | `usecases/otter/manage-session.ts` | 1 |

**总计 62 个方法**。

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "当前已实现了framework，你继续按照F20260714zjmk 继续下一步实现" | 时序：framework 已实现后；依据：F20260714zjmk；操作：继续下一步 | 用户确认 framework（指 Pi Agent 探索研究 F20260715r3s2）已完成，要求按 F20260714zjmk 锁定的实现计划推进 Issue 4：frameworks 层 | msg-1 |
| UA-2 | "不需要考虑不兼容修改，当前还是项目快速搭建期，直接修改为最新版本即可、直接改！" | 条件：快速搭建期；方式：直接修改为最新版本；程度：不需要考虑不兼容 | 用户明确指令：schema 直接改，废弃字段直接删除，不考虑向后兼容。不需要 `## 不兼容更新` 章节和 ALTER TABLE 迁移 | msg-2 |

> 注：用户说的"framework"指 F20260715r3s2 Pi Agent 能力探索研究文档，该文档为 frameworks/agent/ 模块提供了设计依据。非修饰语密集型需求，无模糊点。

## 目标 [required]

### P1 - DB 层实现

实现 3 个 SQLite Repository（OtterRepository、MemoryRepository、ConversationRepository）+ 3 个 Mapper，参照旧代码 SQL 逻辑，适配新 usecases 接口签名。

### P2 - LLM 层实现

实现 pi-ai gateway，提供 `Models` 对象供 AgentHarnessFactory 使用，支持 OpenAI/Anthropic provider 动态加载。

### P3 - Embedding 层实现

实现 bge-m3 embedding service（Worker Thread），实现 `EmbeddingGateway.embed()` 接口。

### P4 - Agent 层实现

基于 F20260715r3s2 结论，实现 `AgentGateway`（生命周期管理）+ `AgentHarnessFactory`（调用入口，供 Issue 5 interface-adapters 使用）。

### P5 - Config 实现

迁移旧配置到 `frameworks/config.ts`，保持配置项不变。

### P6 - 跨上下文 Gateway 实现

实现 `MemoryIndexGateway`、`ConversationQueryGateway`、`MemoryLayerGateway` 三个跨上下文 Gateway 接口。

### P7 - Schema 实现

编写新 schema DDL，直接使用最新版本（UA-2）：新增 turns/conversation_participants/agent_sessions 表，messages 新增 turn_id/talking_stone_passed_to 列，otter_sessions 新增 previous_session_id 列，删除 tree_path/parent_id/skills 等废弃字段和表。

### P8 - 可编译验证

- `tsc --noEmit` 通过
- `eslint src/frameworks/` 无违规
- 层依赖规则验证：frameworks/ 不反向引用 interface-adapters/（main.ts 豁免除外）

## 非目标 [required]

- 不实现 interface-adapters 层（HTTP controllers、agent-runtime tools、SSE streamer）
- 不实现 main.ts 装配（Composition Root 在 Issue 5 实现）
- 不实现测试（测试随 interface-adapters 层 Issue 一起实现）
- 不实现 AgentTool（tools/ 在 interface-adapters/agent-runtime/ 中实现，Issue 5）
- 不实现 system-prompt-builder 的动态内容获取（动态内容由 interface-adapters 提供，frameworks 只提供组合框架）
- 不引入新的第三方依赖

## Schema 变更

> **用户指令**：项目快速搭建期，直接修改 schema 为最新版本，不考虑兼容性。废弃字段直接删除，新增字段直接写入 CREATE TABLE。

### 已有表字段变更

| 表 | 变更 | 说明 |
|----|------|------|
| `messages` | **新增** `turn_id TEXT NOT NULL` + FK + 索引 | `Message.turnId` 必填字段（F20260714jaup Turn 实体） |
| `messages` | **新增** `talking_stone_passed_to TEXT` | `Message.talkingStonePassedTo`，JSON 数组字符串（UA-8 发言石） |
| `otter_sessions` | **新增** `previous_session_id TEXT` + 索引 | `OtterSession.previousSessionId`，Session Chain（F20260715r3s2 R9） |
| `conversations` | **删除** `tree_path` 列 + 相关索引 | 新架构无对话树（F20260714jaup UA-5） |
| `conversations` | **删除** `parent_id` 列 + 相关索引 | 新架构无对话树父子关系 |
| `memory_entries` | **删除** `tree_path` 列 + 相关索引 | SearchEngine 已去除 treePath 逻辑（F20260715b8c6） |

### 新增表

| 表 | 用途 |
|----|------|
| `turns` | Turn 实体存储（F20260714jaup 新增 Turn 实体，旧 schema 无此表） |
| `conversation_participants` | ConversationParticipant 实体存储（UA-4~UA-10 进场/退场记录） |
| `agent_sessions` | Pi session ID 持久化映射（冷启动模型，F20260715r3s2 R2/R12） |

### 删除表

| 表 | 原因 |
|----|------|
| `skills` | Pi 从文件系统加载 skills，不需要数据库表 |
| `skill_assignments` | 同上 |
| `external_resources` | 新架构无此 use case |

## 设计 [required]

### 文件结构

```
src/frameworks/
  config.ts                                    -- 配置常量（原 infra/config.ts）
  logger.ts                                    -- 已实现
  db/
    database.ts                                -- SQLite 初始化 + WAL + sqlite-vec
    schema.ts                                  -- 全部 DDL（旧表 + 新表）
    otter/
      sqlite-otter-repository.ts               -- 实现 OtterRepository
      otter-mapper.ts                          -- Row <-> Entity 映射
    memory/
      sqlite-memory-repository.ts              -- 实现 MemoryRepository
      memory-mapper.ts                         -- Row <-> Entity 映射
    conversation/
      sqlite-conversation-repository.ts        -- 实现 ConversationRepository
      conversation-mapper.ts                   -- Row <-> Entity 映射
  llm/
    pi-ai-gateway.ts                           -- pi-ai 初始化 + Models 对象
  embedding/
    embedding-service.ts                       -- 实现 EmbeddingGateway（Worker Thread 主线程侧）
    bge-m3-worker.ts                           -- Worker Thread（bge-m3 模型加载）
  agent/
    pi-agent-gateway.ts                        -- 实现 AgentGateway（生命周期：create/destroy/reset）
    pi-harness-factory.ts                      -- AgentHarnessFactory（调用入口，供 Issue 5 使用）
    pi-session-store.ts                        -- Pi session ID 持久化（agent_sessions 表）
  ~~gateways/~~                                -- D55 后废弃：跨上下文 Gateway 由 main.ts 装配实现
```

> **与 F20260714zjmk 原设计差异**：
> - F20260714zjmk 原设计 `frameworks/agent/` 下为 `pi-agent-registry.ts` + `agent-handle.ts`（旧 Agent 模式）
> - F20260715r3s2 探索结论：使用 AgentHarness（非 Agent），冷启动模型（无 registry），Pi 内置 session 管理
> - 新设计：`pi-agent-gateway.ts`（AgentGateway 实现）+ `pi-harness-factory.ts`（调用工厂）+ `pi-session-store.ts`（session ID 持久化）
> - ~~新增 `frameworks/gateways/` 目录~~ D55 后废弃：跨上下文 Gateway 由 main.ts 装配实现
>
> 理由：F20260715r3s2 的 21 项修订记录和 12 章节分析为 agent 模块提供了完整的设计依据，原设计的 AgentRegistry/AgentHandle 已被 AgentHarness + 冷启动模型替代。

### 1. frameworks/config.ts

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
  },
  embedding: {
    dimensions: 1024,
    modelPath: "Xenova/bge-m3",
  },
  llm: {
    provider: (process.env.OTTER_BUDDY_LLM_PROVIDER ?? "openai") as "openai" | "anthropic",
    model: process.env.OTTER_BUDDY_LLM_MODEL ?? "gpt-4o",
  },
  agent: {
    sessionsRoot: ".pi/sessions",
  },
} as const;
```

> 与旧代码 `infra/config.ts` 一致，新增 `agent.sessionsRoot` 配置项。`samePathBoost` 和 `crossPathDecay` 已删除（SearchEngine 去除 treePath 逻辑）。

### 2. frameworks/db/

#### 2.1 database.ts

```typescript
import Database from "better-sqlite3";
import { loadSqliteVec } from "sqlite-vec";
import { config } from "@frameworks/config";
import { logger } from "@frameworks/logger";

export function initDatabase(dbPath?: string): Database.Database {
  // 1. new Database(path ?? config.db.path)
  // 2. pragma WAL + foreign_keys
  // 3. loadSqliteVec(db) -- graceful degradation: 失败只 warn
  // 4. return db
}

export function closeDatabase(db: Database.Database): void {
  // db.close()
}
```

> 来源：旧 `infra/db/database.ts`，逻辑不变。

#### 2.2 schema.ts

```typescript
import type Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  // 单事务 BEGIN/COMMIT/ROLLBACK
  // 表创建顺序（FK 依赖序）：
  //   conversations -> turns -> messages -> message_events -> conversation_otters -> conversation_participants
  //   memory_entries -> memory_weights -> memory_fts -> memory_vec
  //   linked_resources -> key_facts
  //   otters -> otter_sessions -> agent_sessions
}
```

**完整 DDL（变更部分已标注）**：

```sql
-- conversations（删除 tree_path, parent_id）
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

-- turns（新增表）
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_conversation_number ON turns(conversation_id, turn_number);

-- messages（新增 turn_id, talking_stone_passed_to）
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,                    -- 新增
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  body TEXT,
  talking_stone_passed_to TEXT,             -- 新增（JSON 数组字符串）
  attachments TEXT,
  sequence_num INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (turn_id) REFERENCES turns(id) -- 新增
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages(turn_id);  -- 新增
CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- message_events（不变）
CREATE TABLE IF NOT EXISTS message_events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  sequence_num INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS idx_message_events_message_seq ON message_events(message_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_message_events_type ON message_events(event_type);

-- conversation_otters（不变）
CREATE TABLE IF NOT EXISTS conversation_otters (
  conversation_id TEXT NOT NULL,
  otter_id TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, otter_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (otter_id) REFERENCES otters(id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_otters_otter_id ON conversation_otters(otter_id);

-- conversation_participants（新增表）
CREATE TABLE IF NOT EXISTS conversation_participants (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  otter_id TEXT NOT NULL,
  joined_at_turn_id TEXT,
  joined_at_turn_number INTEGER NOT NULL DEFAULT 0,
  left_at_turn_id TEXT,
  left_at_turn_number INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  left_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (otter_id) REFERENCES otters(id),
  UNIQUE(conversation_id, otter_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_conversation ON conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_participants_otter ON conversation_participants(otter_id);
CREATE INDEX IF NOT EXISTS idx_participants_status ON conversation_participants(status);

-- memory_entries（删除 tree_path）
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  content_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  conversation_id TEXT,
  granularity TEXT NOT NULL DEFAULT 'fine',
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_memory_entries_layer ON memory_entries(layer);
CREATE INDEX IF NOT EXISTS idx_memory_entries_content_type ON memory_entries(content_type);
CREATE INDEX IF NOT EXISTS idx_memory_entries_conversation_id ON memory_entries(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_source ON memory_entries(source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_created_at ON memory_entries(created_at);

-- memory_weights, memory_fts, memory_vec（不变）
CREATE TABLE IF NOT EXISTS memory_weights (
  memory_entry_id TEXT PRIMARY KEY,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at TEXT,
  user_flagged INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (memory_entry_id) REFERENCES memory_entries(id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_entry_id UNINDEXED, content, tokenize = 'trigram'
);
-- memory_vec: vec0 虚拟表，sqlite-vec 不可时跳过

-- linked_resources, key_facts（不变）

-- otters（不变）

-- otter_sessions（新增 previous_session_id）
CREATE TABLE IF NOT EXISTS otter_sessions (
  id TEXT PRIMARY KEY,
  otter_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  previous_session_id TEXT,                 -- 新增
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  archive_reason TEXT,
  is_negative_case INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  FOREIGN KEY (otter_id) REFERENCES otters(id)
);
CREATE INDEX IF NOT EXISTS idx_otter_sessions_otter_id ON otter_sessions(otter_id);
CREATE INDEX IF NOT EXISTS idx_otter_sessions_status ON otter_sessions(status);
CREATE INDEX IF NOT EXISTS idx_otter_sessions_previous ON otter_sessions(previous_session_id); -- 新增

-- agent_sessions（新增表）
CREATE TABLE IF NOT EXISTS agent_sessions (
  otter_id TEXT PRIMARY KEY,
  pi_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

> **变更说明**：
> - `conversations`：删除 `tree_path`、`parent_id` 列及索引（新架构无对话树）
> - `messages`：新增 `turn_id`（FK -> turns）和 `talking_stone_passed_to`（JSON 数组字符串）
> - `memory_entries`：删除 `tree_path` 列及索引（SearchEngine 已去除 treePath）
> - `otter_sessions`：新增 `previous_session_id`（Session Chain）
> - 删除 `skills`、`skill_assignments`、`external_resources` 表（新架构不使用）
> - 新增 `turns`、`conversation_participants`、`agent_sessions` 表
>
> **默认 limit**：`searchFTS` 和 `searchVec` 的默认 limit 为 50（旧代码 `SearchOpts.limit` 默认值）

#### 2.3 db/otter/sqlite-otter-repository.ts

```typescript
import type Database from "better-sqlite3";
import type { Otter } from "@entities/otter/otter";
import type { OtterSession, SessionStatus } from "@entities/otter/otter-session";
import type { OtterRepository, ArchiveSessionParams } from "@usecases/otter/otter-repository";
import { rowToOtter, rowToSession, type OtterRow, type SessionRow } from "./otter-mapper";

export class SqliteOtterRepository implements OtterRepository {
  constructor(private readonly db: Database.Database) {}

  async createOtter(otter: Otter): Promise<void> {
    // INSERT INTO otters (id, name, type, status, role_name, role_responsibilities, parent_otter_id, created_at)
    // role_name/role_responsibilities 序列化为 JSON
  }

  async getById(id: string): Promise<Otter | null> {
    // SELECT * FROM otters WHERE id = ?
  }

  async getBigOtter(): Promise<Otter | null> {
    // SELECT * FROM otters WHERE type = 'big' AND status = 'active' LIMIT 1
  }

  async dissolve(otterId: string, dissolvedAt: string): Promise<void> {
    // UPDATE otters SET status = 'dissolved', dissolved_at = ? WHERE id = ?
  }

  async deleteOtter(otterId: string): Promise<void> {
    // DELETE FROM otters WHERE id = ?（回滚用）
  }

  async createSession(session: OtterSession): Promise<void> {
    // INSERT INTO otter_sessions (id, otter_id, status, previous_session_id, started_at)
  }

  async getActiveSession(otterId: string): Promise<OtterSession | null> {
    // SELECT * FROM otter_sessions WHERE otter_id = ? AND status = 'active'
  }

  async archiveSession(sessionId: string, status: SessionStatus, params: ArchiveSessionParams, archivedAt: string): Promise<void> {
    // UPDATE otter_sessions SET status = ?, archived_at = ?, archive_reason = ?, is_negative_case = ?, summary = ?
    // WHERE id = ?
  }

  async getSessionHistory(otterId: string): Promise<OtterSession[]> {
    // SELECT * FROM otter_sessions WHERE otter_id = ? ORDER BY started_at DESC
  }

  async getSessionById(sessionId: string): Promise<OtterSession | null> {
    // SELECT * FROM otter_sessions WHERE id = ?
  }
}
```

> 来源：旧 `domain/otter/_internal/repository.ts`，逻辑不变，适配新接口签名。

#### 2.4 db/otter/otter-mapper.ts

```typescript
import type { Otter, OtterRole } from "@entities/otter/otter";
import type { OtterSession, SessionStatus } from "@entities/otter/otter-session";

export interface OtterRow { /* snake_case 字段 */ }
export interface SessionRow { /* snake_case 字段 */ }

export function rowToOtter(row: OtterRow): Otter {
  // snake_case -> camelCase
  // role_name + role_responsibilities (JSON) -> OtterRole | null
}

export function rowToSession(row: SessionRow): OtterSession {
  // snake_case -> camelCase
  // is_negative_case: 0/1 -> boolean
  // status: string -> SessionStatus
}
```

> 来源：旧 `domain/otter/_internal/mapper.ts`，逻辑不变。

#### 2.5 db/memory/sqlite-memory-repository.ts

```typescript
import type Database from "better-sqlite3";
import type { MemoryEntry, MemoryWeight, MemoryLayer } from "@entities/memory/memory-entry";
import type { MemoryRepository, SearchFilters, FTSHit, VecHit } from "@usecases/memory/memory-repository";
import { rowToMemoryEntry, rowToMemoryWeight, bufferToFloat32Array, type MemoryEntryRow, type MemoryWeightRow } from "./memory-mapper";

export class SqliteMemoryRepository implements MemoryRepository {
  private hasVec: boolean;

  constructor(private readonly db: Database.Database) {
    // 检查 memory_vec 表是否可访问（graceful degradation）
    this.hasVec = checkVecTable(db);
  }

  async storeEntry(entry: MemoryEntry): Promise<void> {
    // 单事务：memory_entries + memory_fts + memory_weights
  }

  async storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void> {
    // DELETE + INSERT into memory_vec（vec0 不支持 INSERT OR REPLACE）
  }

  async getById(id: string): Promise<MemoryEntry | null> { /* ... */ }
  async getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null> { /* ... */ }

  async getEmbedding(memoryEntryId: string): Promise<Float32Array | null> {
    // SELECT embedding FROM memory_vec WHERE entry_id = ?
    // bufferToFloat32Array(row.embedding)
  }

  async getWeights(memoryEntryIds: string[]): Promise<MemoryWeight[]> {
    // SELECT * FROM memory_weights WHERE entry_id IN (...)
  }

  async searchFTS(query: string, filters: SearchFilters): Promise<FTSHit[]> {
    // FTS5 MATCH + JOIN memory_entries 过滤 layer/granularity/conversationId
    // ORDER BY fts.rank
    // escapeFtsQuery(): 双引号包裹防注入
  }

  async searchVec(embedding: Float32Array, limit: number, filters: SearchFilters): Promise<VecHit[]> {
    // vec0 MATCH + JOIN memory_entries 过滤
    // !this.hasVec -> return []
  }

  hasVecTable(): boolean { return this.hasVec; }

  async incrementRetrievalCounts(memoryEntryIds: string[]): Promise<void> {
    // 单事务批量 UPDATE memory_weights SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?
  }

  async flagMemory(memoryEntryId: string, flagged: boolean): Promise<void> {
    // UPDATE memory_weights SET user_flagged = ? WHERE entry_id = ?
  }

  async updateLayerByConversation(conversationId: string, from: MemoryLayer, to: MemoryLayer): Promise<void> {
    // UPDATE memory_entries SET layer = ? WHERE conversation_id = ? AND layer = ?
  }
}
```

> 来源：旧 `domain/memory/_internal/repository.ts`，逻辑不变，适配新接口签名。`searchFTS` 的 `escapeFtsQuery` 保留（防注入）。`hasVecTable()` 为同步方法（接口定义同步）。

#### 2.6 db/memory/memory-mapper.ts

```typescript
import type { MemoryEntry, MemoryWeight, MemoryLayer, MemoryContentType, RetrievalGranularity } from "@entities/memory/memory-entry";

export interface MemoryEntryRow { /* snake_case */ }
export interface MemoryWeightRow { /* snake_case */ }

export function rowToMemoryEntry(row: MemoryEntryRow): MemoryEntry {
  // snake_case -> camelCase
  // metadata: JSON string -> Record
  // layer/contentType/granularity: string -> union type
}

export function rowToMemoryWeight(row: MemoryWeightRow): MemoryWeight {
  // user_flagged: 0/1 -> boolean
}

export function bufferToFloat32Array(buffer: Buffer): Float32Array {
  // buffer.byteOffset + buffer.byteLength / 4 -> new Float32Array(arrayBuffer, byteOffset, length)
}
```

> 来源：旧 `domain/memory/_internal/mapper.ts`，逻辑不变。

#### 2.7 db/conversation/sqlite-conversation-repository.ts

```typescript
import type Database from "better-sqlite3";
import type { Conversation, ConversationStatus, Turn, KeyFact, LinkedResource, Attachment, ConversationParticipant } from "@entities/conversation/conversation";
import type { Message, MessageEvent } from "@entities/conversation/message";
import type { ConversationRepository, GetMessagesOptions } from "@usecases/conversation/conversation-repository";
import { rowToConversation, rowToMessage, rowToMessageEvent, rowToKeyFact, rowToLinkedResource, rowToParticipant, type ConversationRow, type MessageRow, type MessageEventRow, type KeyFactRow, type LinkedResourceRow, type ParticipantRow } from "./conversation-mapper";

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  // Conversation CRUD
  async create(conversation: Conversation, otterIds?: string[]): Promise<void> {
    // 单事务：conversations + conversation_otters
  }
  async getById(id: string): Promise<Conversation | null> { /* ... */ }
  async updateStatus(id: string, status: ConversationStatus, timestamp: string): Promise<void> { /* ... */ }
  async getIdsByOtterId(otterId: string): Promise<string[]> {
    // SELECT conversation_id FROM conversation_otters WHERE otter_id = ?
  }
  async getOtterIds(conversationId: string): Promise<string[]> {
    // SELECT otter_id FROM conversation_otters WHERE conversation_id = ?
  }

  // Turn 管理
  async createTurn(turn: Turn): Promise<void> { /* INSERT INTO turns... */ }
  async getActiveTurn(conversationId: string): Promise<Turn | null> { /* ... */ }
  async closeTurn(turnId: string, closedAt: string): Promise<void> { /* ... */ }
  async getMaxTurnNumber(conversationId: string): Promise<number> { /* ... */ }
  async getMessagesByTurnId(turnId: string): Promise<Message[]> { /* ... */ }

  // Message 生命周期
  async createCompletedMessage(message: Message): Promise<void> { /* ... */ }
  async createStreamingMessage(message: Message): Promise<void> { /* ... */ }
  async completeMessage(messageId: string, body: string, talkingStonePassedTo: string[], attachments: Attachment[] | null, completedAt: string): Promise<void> {
    // UPDATE messages SET status='completed', body=?, talking_stone_passed_to=?, attachments=?, completed_at=?
    // talkingStonePassedTo 序列化为 JSON
    // 检查 result.changes === 0（并发保护）
  }
  async failMessage(messageId: string): Promise<void> { /* ... */ }
  async getMaxSequenceNum(conversationId: string): Promise<number> { /* ... */ }

  // Message 查询
  async getMessageById(id: string): Promise<Message | null> { /* ... */ }
  async getMessages(conversationId: string, options: GetMessagesOptions): Promise<Message[]> {
    // cursor 分页（before?: string）+ status 过滤 + turnId 过滤
  }
  async getMessagesBefore(messageId: string, count: number): Promise<Message[]> { /* ... */ }
  async getMessagesAfter(messageId: string, count: number): Promise<Message[]> { /* ... */ }

  // MessageEvent
  async appendEvent(event: MessageEvent): Promise<void> { /* ... */ }
  async getMessageEvents(messageId: string): Promise<MessageEvent[]> { /* ... */ }
  async getMaxEventSequenceNum(messageId: string): Promise<number> { /* ... */ }

  // Key Info
  async addKeyFact(keyFact: KeyFact): Promise<void> { /* ... */ }
  async linkResource(resource: LinkedResource): Promise<void> { /* ... */ }
  async getKeyFacts(conversationId: string): Promise<KeyFact[]> { /* ... */ }
  async getLinkedResources(conversationId: string): Promise<LinkedResource[]> { /* ... */ }

  // Participant 管理（UA-4~UA-10）
  async createParticipant(participant: ConversationParticipant): Promise<void> {
    // INSERT INTO conversation_participants
  }
  async createParticipants(participants: ConversationParticipant[]): Promise<void> {
    // 单事务批量 INSERT
  }
  async getParticipant(conversationId: string, otterId: string): Promise<ConversationParticipant | null> {
    // SELECT * FROM conversation_participants WHERE conversation_id = ? AND otter_id = ?
  }
  async getActiveParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    // SELECT * FROM conversation_participants WHERE conversation_id = ? AND status = 'active'
  }
  async updateParticipantLeave(participantId: string, leftAtTurnId: string, leftAtTurnNumber: number, leftAt: string): Promise<void> {
    // UPDATE conversation_participants SET status='left', left_at_turn_id=?, left_at_turn_number=?, left_at=?
  }
}
```

> 来源：旧 `domain/conversation/_internal/repository.ts`，适配新接口签名。新增 Participant 方法对应 `conversation_participants` 新表。`talking_stone_passed_to` 存储为 JSON 数组字符串。
>
> **Turn 表说明**：旧 schema 中 Turn 不是独立表，Turn 信息存储在 `messages` 表中。但新 entities 层有 `Turn` 实体（含 `id`, `turnNumber`, `status`, `closedAt`），需要独立表。新增 `turns` 表：

```sql
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  created_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_conversation_number ON turns(conversation_id, turn_number);
```

> 旧 schema 无 `turns` 表（旧代码无 Turn 概念）。这是新 entities 层引入的需求。

#### 2.8 db/conversation/conversation-mapper.ts

```typescript
import type { Conversation, ConversationStatus, Turn, TurnStatus, KeyFact, LinkedResource, Attachment, ConversationParticipant, ParticipantStatus } from "@entities/conversation/conversation";
import type { Message, MessageEvent, SenderType, MessageStatus, MessageEventType } from "@entities/conversation/message";

export interface ConversationRow { /* snake_case */ }
export interface TurnRow { /* snake_case */ }
export interface MessageRow { /* snake_case */ }
export interface MessageEventRow { /* snake_case */ }
export interface KeyFactRow { /* snake_case */ }
export interface LinkedResourceRow { /* snake_case */ }
export interface ParticipantRow { /* snake_case */ }

export function rowToConversation(row: ConversationRow): Conversation { /* ... */ }
export function rowToTurn(row: TurnRow): Turn { /* ... */ }
export function rowToMessage(row: MessageRow): Message {
  // attachments: JSON string -> Attachment[]
  // talking_stone_passed_to: JSON string -> string[]
  // status/senderType: string -> union type
}
export function rowToMessageEvent(row: MessageEventRow): MessageEvent {
  // payload: JSON string -> Record
}
export function rowToKeyFact(row: KeyFactRow): KeyFact {
  // user_flagged: 0/1 -> boolean
}
export function rowToLinkedResource(row: LinkedResourceRow): LinkedResource {
  // auto_linked: 0/1 -> boolean
  // metadata: JSON string -> Record
}
export function rowToParticipant(row: ParticipantRow): ConversationParticipant {
  // status: string -> ParticipantStatus
}
```

> 来源：旧 `domain/conversation/_internal/mapper.ts` + 新增 Turn/Participant 映射。`talking_stone_passed_to` 新增反序列化（JSON string -> string[]）。

### 3. frameworks/llm/pi-ai-gateway.ts

```typescript
import type { Models, Model } from "@earendil-works/pi-ai";
import { config } from "@frameworks/config";
import { logger } from "@frameworks/logger";

export interface LLMGateway {
  getModels(): Models;
  getModel(): Model<any>;
}

export async function initLLMGateway(): Promise<LLMGateway> {
  // 1. 动态 import("@earendil-works/pi-ai") -- ESM-only
  // 2. 动态 import provider: openai 或 anthropic
  // 3. 创建 Models 对象，添加 provider
  // 4. 返回 { getModels, getModel }
}

// 测试用 faux gateway
export function initFauxLLMGateway(responses: string[]): LLMGateway { /* ... */ }
```

> 来源：旧 `infra/llm-gateway.ts`。简化：去除 `chat()`/`streamChat()` 方法（AgentHarness 直接使用 Models 对象调用 LLM，不需要 gateway 包装）。`LLMGateway` 接口仅提供 `getModels()` 和 `getModel()`，供 AgentHarnessFactory 使用。
>
> **设计决策**：旧代码的 `LLMGateway` 包装了 LLM 调用，但 Pi 的 AgentHarness 直接消费 `Models` 对象。中间包装层是冗余的。frameworks/llm/ 的职责是初始化 pi-ai 并提供 Models 对象，不是重复封装 LLM 调用接口。
>
> Compaction 等非 Agent LLM 调用也通过 Models 对象直接发起，不需要 gateway 包装。

### 4. frameworks/embedding/

#### 4.1 embedding-service.ts

```typescript
import { Worker } from "worker_threads";
import path from "path";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";

export class EmbeddingService implements EmbeddingGateway {
  private worker: Worker;
  private ready: Promise<void>;
  private pending: Map<number, { resolve: (e: Float32Array) => void; reject: (e: Error) => void }>;
  private requestId: number;

  constructor(workerPath?: string) {
    // 创建 Worker
    // 监听 "ready" / "result" / "error" 消息
    // 初始化 ready Promise
  }

  async embed(text: string): Promise<Float32Array> {
    // 1. await ready
    // 2. postMessage({ type: "embed", text, id: requestId++ })
    // 3. 返回 Promise（存入 pending Map）
  }

  dispose(): void {
    // worker.terminate()
    // reject all pending
  }
}
```

> 来源：旧 `infra/embedding/service.ts`，逻辑不变，实现 `EmbeddingGateway` 接口。

#### 4.2 bge-m3-worker.ts

```typescript
import { workerData, parentPort } from "worker_threads";

// 1. 动态 import("@huggingface/transformers")
// 2. pipeline("feature-extraction", "Xenova/bge-m3", { dtype: "fp32" })
// 3. 发送 "ready" 消息
// 4. 监听 "embed" 消息 -> 运行 pipeline -> 发送 "result"
```

> 来源：旧 `infra/embedding/worker.ts`，逻辑不变。

### 5. frameworks/agent/

#### 5.1 pi-session-store.ts

```typescript
import type Database from "better-sqlite3";

/** Pi session ID 持久化（agent_sessions 表） */
export class PiSessionStore {
  constructor(private readonly db: Database.Database) {}

  /** 获取 otter 对应的 Pi session ID */
  get(otterId: string): string | null {
    // SELECT pi_session_id FROM agent_sessions WHERE otter_id = ?
  }

  /** 创建或更新映射 */
  upsert(otterId: string, piSessionId: string): void {
    // INSERT OR REPLACE INTO agent_sessions (otter_id, pi_session_id, created_at, updated_at)
  }

  /** 删除映射 */
  delete(otterId: string): void {
    // DELETE FROM agent_sessions WHERE otter_id = ?
  }
}
```

> 持久化 otterId -> piSessionId 映射。冷启动模型下进程重启不丢失关联。

#### 5.2 pi-agent-gateway.ts

```typescript
import type { AgentGateway, AgentConfig, AgentContext } from "@usecases/otter/agent-gateway";
import type { JsonlSessionRepo } from "@earendil-works/pi-agent-core";  // S3: import type
import type { PiSessionStore } from "./pi-session-store";
import { logger } from "@frameworks/logger";

/**
 * AgentGateway 实现：基于 Pi AgentHarness 的冷启动模型。
 *
 * 生命周期：
 * - create(): 创建 Pi session（JsonlSessionRepo.create），存储 piSessionId
 * - destroy(): 删除 Pi session 文件 + 删除映射
 * - reset(): 创建新 Pi session（chain），更新映射
 *
 * 注意：此 Gateway 只管理 session 生命周期，不负责 harness 调用。
 * Harness 调用由 PiHarnessFactory 负责（供 interface-adapters 使用）。
 */
export class PiAgentGateway implements AgentGateway {
  // S3: Pi 类型通过 import type 声明，实例由 main.ts 注入
  constructor(
    private readonly sessionRepo: JsonlSessionRepo,
    private readonly store: PiSessionStore,
  ) {}

  async create(otterId: string, config: AgentConfig): Promise<void> {
    // 1. sessionRepo.create() -> 获取 piSessionId
    // 2. store.upsert(otterId, piSessionId)
    // 3. 不创建 harness（冷启动：调用时才创建）
    // S5: config 参数为接口契约要求，当前不持久化。
    //     实际配置（systemPrompt, tools, skills）由 interface-adapters
    //     在调用 PiHarnessFactory.invoke() 时传入。
    //     create() 的主要作用是创建 Pi session + 存储映射。
    if (!config.systemPrompt) {
      logger.warn(`AgentGateway.create: systemPrompt is empty for otter ${otterId}`);
    }
  }

  async destroy(otterId: string): Promise<void> {
    // 1. store.get(otterId) -> piSessionId
    // 2. sessionRepo.delete(piSessionId) -- 删除 JSONL 文件
    // 3. store.delete(otterId)
  }

  async reset(otterId: string, context?: AgentContext): Promise<void> {
    // 1. 获取旧 piSessionId（不删除旧 session 文件，保留为历史归档）
    // 2. sessionRepo.create() -> 新 piSessionId（chain，不 fork）
    // 3. store.upsert(otterId, newPiSessionId)
  }
}
```

> **S3 修复**：`JsonlSessionRepo` 通过 `import type` 声明（编译时擦除），构造函数接收的实例由 main.ts 通过动态 import 创建后注入。
>
> **S5 修复**：`config` 参数为 `AgentGateway` 接口契约要求。当前实现不持久化 config，仅做 basic validation（systemPrompt 非空检查 + warn 日志）。实际配置由 interface-adapters 在 `invoke()` 时提供。`create()` 的核心作用是创建 Pi session 和存储映射。

#### 5.3 pi-harness-factory.ts

```typescript
// S3: Pi 类型使用 import type（编译时擦除，避免 ESM 运行时 import）
import type { Models, Model } from "@earendil-works/pi-ai";
import type { AgentHarness, JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core";
import type { PiSessionStore } from "./pi-session-store";
import { logger } from "@frameworks/logger";

/** Agent 事件（供 SSE 流式推送） */
export interface AgentEvent {
  type: "text_delta" | "tool_start" | "tool_result" | "message_complete" | "turn_complete" | "error";
  data: Record<string, unknown>;
}

/** Agent 调用结果 */
export interface AgentRunResult {
  response: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/** AgentHarness 工厂配置 */
export interface HarnessConfig {
  // S1: systemPrompt 支持函数模式（Pi R10：每轮 LLM 调用前执行）
  // interface-adapters 负责将 AgentConfig.systemPrompt (string) 包装为 (ctx) => string
  // 动态内容（记忆检索、会话摘要）在函数内组装
  systemPrompt: string | ((ctx: any) => string | Promise<string>);
  // M3: tools 实际类型为 AgentTool[]（from @earendil-works/pi-agent-core）
  // 使用 any[] 是因为 Pi 库 ESM-only，类型在动态 import 后才可用
  tools?: any[];
  activeToolNames?: string[];
  // M3: skills 实际类型为 Skill[]（from @earendil-works/pi-agent-core）
  skills?: any[];
  model: Model<any>;
}

/**
 * AgentHarness 工厂（冷启动模型）。
 *
 * 供 interface-adapters/agent-runtime/ 调用（Issue 5）。
 */
export class PiHarnessFactory {
  // S3: Pi 类型作为构造函数参数，使用 import type 声明
  constructor(
    private readonly sessionRepo: JsonlSessionRepo,
    private readonly store: PiSessionStore,
    private readonly env: NodeExecutionEnv,
  ) {}

  // S2: 暴露 session 信息查询（供 interface-adapters 检查 agent 是否存在）
  getSessionInfo(otterId: string): { piSessionId: string } | null {
    const piSessionId = this.store.get(otterId);
    return piSessionId ? { piSessionId } : null;
  }

  async invoke(
    otterId: string,
    message: string,
    config: HarnessConfig,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    // 1. store.get(otterId) -> piSessionId（不存在则 throw）
    // 2. sessionRepo.open(piSessionId) -> session
    // 3. new AgentHarness({ env, session, models, tools, activeToolNames, resources: { skills }, systemPrompt, model })
    // 4. harness.subscribe() -> onEvent 回调映射
    // 5. await harness.prompt(message)
    // 6. 返回 AgentRunResult
    // 7. harness 引用自然 drop（GC 回收）
  }
}
```

> **F20260715r3s2 决策依据**：
> - 冷启动模型（R17）：每次发言创建 harness，完成后释放
> - Pi 内置 JsonlSessionRepo + NodeExecutionEnv（R2, R5, R13）
> - 事件映射（R20）：onEvent 回调支持 SSE 流式推送
> - 嵌套场景（R21）：大獭在 tool execute 中创建设计獭 harness 时，外层 harness 不释放
>
> **S1 修复**：`HarnessConfig.systemPrompt` 支持 `string | function`（Pi R10 动态 prompt）。`AgentGateway.create()` 接收的 `AgentConfig.systemPrompt` 是 `string`，interface-adapters 在调用 `invoke()` 时负责将其包装为 `(ctx) => string` 函数，并在函数内组装动态内容（记忆检索、会话摘要等）。
>
> **S2 修复**：新增 `getSessionInfo(otterId)` 方法，委托 `PiSessionStore.get()`。interface-adapters 通过此方法检查 agent session 是否存在，不需要直接访问 `PiSessionStore`。
>
> **S3 修复**：`JsonlSessionRepo`、`NodeExecutionEnv`、`AgentHarness` 等 Pi 类型通过 `import type` 声明（编译时擦除），构造函数接收的实例由 main.ts 通过动态 import 创建后注入。
>
> **M2 修复**：删除 `createSession()` 方法。Session 创建由 `PiAgentGateway` 直接调用 `sessionRepo.create()` 完成，`PiHarnessFactory` 只负责 invoke 和 getSessionInfo。
>
> **M3 修复**：`tools` 和 `skills` 类型为 `any[]`，添加注释说明实际类型为 `AgentTool[]` 和 `Skill[]`（Pi ESM-only 限制）。
>
> **与 Issue 5 的边界**：
> - `PiHarnessFactory` 定义在 frameworks/agent/（基础设施）
> - `HarnessConfig.tools` 和 `skills` 由 interface-adapters 提供（AgentTool 适配 use case 接口）
> - `HarnessConfig.systemPrompt` 由 interface-adapters 构建（string -> function 包装 + 动态内容注入）
> - `invoke()` 的调用方是 interface-adapters/agent-runtime/

### 6. ~~frameworks/gateways/~~ （D55 后废弃）

> **D55 决策**：跨上下文 Gateway 由 main.ts 装配实现，不作为独立类存在于 frameworks 层。以下内容为原始设计参考，不再作为实现依据。

<details>
<summary>原始设计（已废弃）</summary>

原设计要求在 `frameworks/gateways/` 下实现三个独立类：
- `memory-index-gateway-impl.ts`：实现 MemoryIndexGateway，注入 MemoryRepository + EmbeddingGateway
- `conversation-query-gateway-impl.ts`：实现 ConversationQueryGateway，委托 ConversationRepository
- `memory-layer-gateway-impl.ts`：实现 MemoryLayerGateway，委托 MemoryRepository

D55 后，这些接口的实现由 main.ts 装配时通过包装其他 use case 类完成。

</details>

### 7. 依赖关系

```
frameworks/
  config.ts             -- 无依赖（纯常量）
  logger.ts             -- 无依赖（已实现）
  db/
    database.ts         ──> @frameworks/config, @frameworks/logger, better-sqlite3, sqlite-vec
    schema.ts           ──> better-sqlite3 (type only)
    otter/              ──> @entities/otter, @usecases/otter/otter-repository, better-sqlite3
    memory/             ──> @entities/memory, @usecases/memory/memory-repository, better-sqlite3
    conversation/       ──> @entities/conversation, @usecases/conversation/conversation-repository, better-sqlite3
  llm/
    pi-ai-gateway.ts    ──> @frameworks/config, @frameworks/logger, @earendil-works/pi-ai (dynamic import)
  embedding/
    embedding-service.ts ──> @usecases/memory/embedding-gateway, worker_threads
    bge-m3-worker.ts     ──> @huggingface/transformers (dynamic import)
  agent/
    pi-session-store.ts  ──> better-sqlite3 (type only)
    pi-agent-gateway.ts  ──> @usecases/otter/agent-gateway, ./pi-session-store, @frameworks/logger, @earendil-works/pi-agent-core (dynamic import)
    pi-harness-factory.ts ──> ./pi-session-store, @frameworks/logger, @earendil-works/pi-agent-core (dynamic import), @earendil-works/pi-ai
  ~~gateways/~~          ──> D55 后废弃：跨上下文 Gateway 由 main.ts 装配实现
```

> 所有 frameworks 文件不依赖 interface-adapters/。agent/ 和 llm/ 依赖 Pi 库（通过动态 import）。跨上下文 Gateway（MemoryIndexGateway、ConversationQueryGateway、MemoryLayerGateway）由 main.ts 装配实现（D55），不在 frameworks 层。

### 8. 与旧代码的差异

| 维度 | 旧代码 | 新代码 | 变因 |
|------|--------|-------|------|
| Agent 实现 | Agent + AgentHandle + AgentRegistry | AgentHarness + 冷启动模型 | F20260715r3s2：AgentHarness 提供 Session/Skill/Compaction |
| Agent 状态 | 内存 Map 持有 AgentHandle | 冷启动：每次调用创建+释放 | F20260715r3s2 R17 |
| Session 管理 | 无（旧 Agent 无 session） | Pi JsonlSessionRepo + agent_sessions 表 | F20260715r3s2 R2/R12 |
| LLM Gateway | chat() + streamChat() + getModel() | getModels() + getModel() | Pi AgentHarness 直接消费 Models 对象 |
| Repository 实现 | domain/_internal/repository.ts | frameworks/db/{context}/sqlite-{context}-repository.ts | D37/D38 依赖反转 + 按上下文组织 |
| Mapper | domain/_internal/mapper.ts | frameworks/db/{context}/{context}-mapper.ts | D38 同目录组织 |
| Config | infra/config.ts（直接 import） | frameworks/config.ts（构造函数注入） | D39 config 注入规则 |
| 跨上下文 Gateway | 无（domain 间直接 import） | main.ts 装配实现（D55） | UA-12 Gateway 依赖倒置 |
| schema | infra/db/schema.ts | frameworks/db/schema.ts（直接修改为最新版本） | 新增 turns/conversation_participants/agent_sessions；messages 新增 turn_id/talking_stone_passed_to；otter_sessions 新增 previous_session_id；删除 conversations.tree_path/parent_id、memory_entries.tree_path、skills/skill_assignments/external_resources 表（UA-2） |
| Embedding | infra/embedding/service.ts | frameworks/embedding/embedding-service.ts | 位置迁移，逻辑不变 |
| talking_stone_passed_to | 不存在 | 新字段，JSON 数组存储 | UA-8 发言石机制 |

## 关键设计决策

| ID | 决策 | 理由 |
|----|------|------|
| D43 | LLM Gateway 简化为 Models 提供者 | Pi AgentHarness 直接消费 Models 对象，chat()/streamChat() 包装层冗余。非 Agent LLM 调用（compaction）也通过 Models 直接发起 |
| D44 | AgentGateway 实现为 Pi session 生命周期管理 | create() 创建 Pi session + 存储映射；destroy() 删除 session + 映射；reset() 创建新 session（chain）。不负责 harness 调用 |
| D45 | PiHarnessFactory 独立于 AgentGateway | AgentGateway 管 session 生命周期（usecases 调用）；PiHarnessFactory 管 harness 调用（interface-adapters 调用）。职责分离 |
| D46 | agent_sessions 表持久化 otterId -> piSessionId 映射 | 冷启动模型下进程重启不丢失关联 |
| D47 | AgentConfig 不持久化到数据库 | systemPrompt/tools/skills 由 interface-adapters 在 invoke() 时提供。AgentGateway.create() 的 config 参数仅做 basic validation（S5 修复） |
| D48 | ~~MemoryIndexGatewayImpl 直接调用 MemoryRepository + EmbeddingGateway~~ | D55 后废弃：跨上下文 Gateway 由 main.ts 装配实现，不在 frameworks 层 |
| D49 | 新增 turns 表 | entities 层引入 Turn 实体，需独立表存储 |
| D50 | 新增 conversation_participants 表 | entities 层引入 ConversationParticipant 实体（UA-4~UA-10） |
| D52 | Schema 直接修改为最新版本 | 用户指令：项目快速搭建期，不考虑兼容性。废弃字段（tree_path, parent_id）直接删除，新增字段直接写入 CREATE TABLE |
| D53 | 删除 skills/skill_assignments/external_resources 表 | 新架构不使用（Pi 从文件系统加载 skills，external_resources 无对应 use case） |
| D54 | HarnessConfig.systemPrompt 支持函数模式 | Pi R10：每轮 LLM 调用前执行函数。interface-adapters 负责 string -> function 包装 + 动态内容注入（S1 修复） |
| D55 | 跨上下文 Gateway 由 main.ts 装配实现 | 三个 Gateway 接口（MemoryIndexGateway、ConversationQueryGateway、MemoryLayerGateway）在 main.ts 装配时通过包装其他 use case 类实现，不需要 frameworks 层独立的 gateways/ 目录。减少文件数，简化架构 |

## 设计取舍

| 取舍点 | 正方 | 反方 | 最终选择 |
|--------|------|------|---------|
| LLM Gateway 是否保留 chat/streamChat | 统一 LLM 调用入口 | Pi AgentHarness 直接消费 Models，包装冗余 | 简化（D43）。非 Agent 调用也通过 Models 直接发起 |
| AgentConfig 是否持久化 | create() 时存储，invoke() 时读取 | 配置由调用方在 invoke() 时提供，更灵活 | 不持久化（D47）。冷启动模型下每次调用都重新配置 harness，config 存数据库无意义 |
| PiSessionStore 是否独立类 | 独立类职责清晰 | 内联到 PiAgentGateway 减少文件数 | 独立（D46）。PiHarnessFactory 也需要读取 session ID，共享 store |
| Gateway 实现是否经过 use case | 经过 StoreMemory use case 保持逻辑一致 | frameworks 不能调用 use case class | D55：由 main.ts 装配实现，不在 frameworks 层 |
| turns 表是否需要 | Turn 信息可从 messages 表推导 | 独立表查询效率高，Turn 有独立状态 | 独立表（D49）。Turn 有 status（open/closed）和 closedAt，独立管理更清晰 |
| Pi session 文件删除策略 | destroy 时删除 | 保留为历史归档 | destroy 时删除（清理资源）。reset 时保留旧 session（chain 历史） |

## 核心业务行为

> 以下行为条目是 frameworks 层实现后必须保持的业务行为，作为 interface-adapters 层测试的回归守护。延续 F20260714zjmk B1-B6 和 F20260715b8c6 B1-B26。

| ID | 触发条件 | 预期行为 | 追溯 |
|----|---------|---------|------|
| B1 | 创建 Otter 记录后，Agent 创建失败时 | DB 记录应被回滚删除（AgentGateway.create 抛错 -> CreateOtter 回滚） | ← F20260714zjmk B1 |
| B2 | 查询大獭且系统中不存在大獭时 | 应抛出错误（SqliteOtterRepository.getBigOtter 返回 null -> QueryOtter throw） | ← F20260714zjmk B2 |
| B3 | 归档 session 且 reason='restart' 时 | session 状态变为 'restarted'（SqliteOtterRepository.archiveSession 写入） | ← F20260714zjmk B3 |
| B4 | 归档 session 且 reason 不为 'restart' 时 | session 状态变为 'archived' | ← F20260714zjmk B4 |
| B5 | 解散 Otter 时 | Otter 状态变为 'dissolved'，Agent session 被删除（PiAgentGateway.destroy） | ← F20260714zjmk B5 |
| B6 | 混合检索记忆时 | FTS5 + vec0 结果通过 RRF 融合返回（SqliteMemoryRepository.searchFTS + searchVec） | ← F20260714zjmk B6 |
| B27 | AgentGateway.create() 调用后 | agent_sessions 表存在 otterId -> piSessionId 映射，Pi session JSONL 文件已创建 | ← UA-1 |
| B28 | AgentGateway.reset() 调用后 | agent_sessions 表更新为新 piSessionId，旧 session 文件保留 | ← UA-1 |
| B29 | AgentGateway.destroy() 调用后 | agent_sessions 表映射删除，Pi session JSONL 文件删除 | ← UA-1 |
| B30 | MemoryIndexGateway.indexMessage() 调用后 | memory_entries 表新增记录（contentType="message"），memory_fts 索引更新，异步 embedding 写入 memory_vec | ← F20260715b8c6 B11 |
| B31 | sqlite-vec 未加载时 | hasVecTable() 返回 false，searchVec 返回空数组，FTS5 检索正常工作 | ← 旧代码 graceful degradation |
| B32 | completeMessage 并发调用 | result.changes === 0 时不重复更新（并发保护） | ← 旧代码并发保护 |
| B33 | main.ts 装配的 MemoryIndexGateway 和 StoreMemory 的 embedding 逻辑 | 两处实现必须保持一致：同步 storeEntry + fire-and-forget embed + 降级容错。D55 后由 main.ts 装配时确保一致性 | ← S4 审视修复 |

## 硬约束

1. Schema 直接使用最新版本（用户指令：项目快速搭建期，不考虑兼容性。废弃字段直接删除，新增字段直接写入 CREATE TABLE）
2. 不引入新的第三方依赖
3. `tsc --noEmit` 通过
4. `eslint src/frameworks/` 无违规
5. frameworks/ 不 import interface-adapters/（main.ts 豁免除外）
6. frameworks/ 可 import usecases/（仅限实现接口）和 entities/（类型引用）
7. frameworks/ 可 import `@frameworks/logger` 和 `@frameworks/config`（同层引用）
8. Pi 库通过动态 import 加载（ESM-only），不在顶层 import；Pi 类型通过 `import type` 声明
9. AgentGateway 实现 AgentHarness 冷启动模型（F20260715r3s2 R17）
10. Pi session 通过 JsonlSessionRepo 管理（F20260715r3s2 R2），不自定义 session 存储
11. NodeExecutionEnv 使用 Pi 内置（F20260715r3s2 R13），不自定义
12. SQLite 不引入额外锁（F20260715r3s2 R18，better-sqlite3 同步 + WAL）
13. 所有 Repository 实现对应 usecases 层接口，不增减方法
14. Mapper 的 Row 类型不导出给外部（仅 repository 内部使用）
15. `talking_stone_passed_to` 存储为 JSON 数组字符串
16. main.ts 装配的 MemoryIndexGateway 的 storeEntry + fire-and-forget embedding 逻辑必须与 StoreMemory use case 保持一致（B33 约束，D55 后由 main.ts 负责）

## 验证

### 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] `eslint src/frameworks/` 无违规
- [ ] frameworks/db/otter/ 包含 SqliteOtterRepository + otter-mapper
- [ ] frameworks/db/memory/ 包含 SqliteMemoryRepository + memory-mapper
- [ ] frameworks/db/conversation/ 包含 SqliteConversationRepository + conversation-mapper
- [ ] frameworks/db/database.ts 导出 initDatabase + closeDatabase
- [ ] frameworks/db/schema.ts 导出 initSchema，包含全部表（删除 tree_path/parent_id/skills 等，新增 turns/conversation_participants/agent_sessions 等）
- [ ] schema.ts 中 messages 表包含 turn_id 和 talking_stone_passed_to 列
- [ ] schema.ts 中 otter_sessions 表包含 previous_session_id 列
- [ ] schema.ts 中 conversations 表不含 tree_path 和 parent_id
- [ ] schema.ts 中 memory_entries 表不含 tree_path
- [ ] frameworks/llm/pi-ai-gateway.ts 导出 initLLMGateway + LLMGateway 接口
- [ ] frameworks/embedding/ 包含 EmbeddingService + bge-m3-worker
- [ ] frameworks/agent/ 包含 PiAgentGateway + PiHarnessFactory + PiSessionStore
- [ ] PiHarnessFactory 包含 getSessionInfo() 方法（S2 修复）
- [ ] PiHarnessFactory 不包含 createSession() 方法（M2 修复）
- [ ] Pi 类型使用 import type 声明（S3 修复）
- [ ] ~~frameworks/gateways/ 包含 MemoryIndexGatewayImpl + ConversationQueryGatewayImpl + MemoryLayerGatewayImpl~~ D55 后废弃
- [ ] ~~MemoryIndexGatewayImpl 构造函数注入 MemoryRepository + EmbeddingGateway（S4 修复）~~ D55 后废弃
- [ ] frameworks/config.ts 包含全部配置项（含 agent.sessionsRoot）
- [ ] 所有 Repository implements 对应 usecases 接口
- [ ] 跨上下文 Gateway 由 main.ts 装配实现（D55）
- [ ] Pi 库通过动态 import 加载
- [ ] frameworks/ 不 import interface-adapters/
- [ ] 新增表使用 CREATE TABLE IF NOT EXISTS

## 关联

- **整洁架构 Feature 文档**：[F20260714zjmk](../14/F20260714zjmk-clean-architecture-restructuring.md)（目录结构、依赖规则、D30-D42 决策）
- **Entities 层实现**：[F20260714jaup](../14/F20260714jaup-entities-layer-implementation.md)（实体类型 + 不变量函数）
- **Use Cases 层实现**：[F20260715b8c6](./F20260715b8c6-usecases-layer-implementation.md)（Repository/Gateway 接口 + Use Case Class）
- **Pi Agent 能力探索**：`docs/research/pi-capability-analysis.md`（F20260715r3s2，Pi 嵌入式架构分析）
- **消息流式模型**：[F20260713e8n4](../13/F20260713e8n4-message-streaming-model.md)（Message/MessageEvent 类型定义）
- **Otter 领域模块**：[F20260713o4t8](../13/F20260713o4t8-domain-otter.md)（Otter/OtterSession 类型定义）
- **Memory 领域模块**：[F20260713m5q3](../13/F20260713m5q3-domain-memory.md)（MemoryEntry/MemoryWeight 类型定义）
- **Infra 实现**：[F20260713i5k2](../13/F20260713i5k2-infra-llm-agent-embedding.md)（旧 infra 层实现参考）

## 查缺补漏报告（F20260715f4k9 合入后）

> **背景**：F20260715f4k9 已合入 main，实现了 frameworks 层。本章节记录对照设计文档与实际代码的差异分析结果。

### 跨上下文 Gateway 架构决策修正（D55）

**原设计（F20260715k4p2）**：要求在 `frameworks/gateways/` 目录下实现 `MemoryIndexGatewayImpl`、`ConversationQueryGatewayImpl`、`MemoryLayerGatewayImpl` 三个独立类。

**实际实现（F20260715f4k9）**：三个 Gateway 接口均标注"由 main.ts 装配 XXX 实现"，跨上下文逻辑通过在 main.ts 装配时包装其他 use case 类来实现，不需要 frameworks 层单独的实现类。

**D55 决策**：跨上下文 Gateway 由 main.ts 装配实现，不作为独立类存在于 frameworks 层。理由：减少文件数，简化架构，main.ts 作为 Composition Root 统一管理跨上下文依赖。

**原 P0 判断（跨上下文 Gateway 实现缺失）已撤回**：这是架构选择差异，不是缺陷。

### 有效问题清单（9 项）— 已全部修复

| 优先级 | # | 问题 | 类型 | 说明 | 状态 |
|--------|---|------|------|------|------|
| **P1** | 1.1 | `messages.turn_id` 缺 NOT NULL | 数据一致性 | `Message.turnId` 是必填字段（`string` 非可空），DDL 应为 `turn_id TEXT NOT NULL` | ✅ 已修复 |
| **P1** | 1.3 | `conversations` 仍含 `tree_path` + `parent_id` | 用户指令 | UA-2 指令"直接改"，应删除废弃字段 | ✅ 已修复 |
| **P1** | 1.4 | `memory_entries` 仍含 `tree_path` | 用户指令 | UA-2 指令"直接改"，应删除废弃字段 | ✅ 已修复 |
| **P1** | 2 | `conversation_participants` 缺 UNIQUE 约束 | 数据一致性 | UA-10 要求"一个 otter 在一个对话中只参与一次" | ✅ 已修复 |
| **P1** | 7 | `turns` 表缺 UNIQUE(conversation_id, turn_number) | 数据一致性 | Turn 实体 turnNumber 唯一性约束 | ✅ 已修复 |
| **P2** | 1.2 | `otter_sessions.previous_session_id` 缺索引 | 查询效率 | Session Chain 查询无索引 | ✅ 已修复 |
| **P2** | 3 | `agent_sessions` 缺 `created_at` | 完整性 | 仅有 `updated_at`，缺创建时间记录 | ✅ 已修复 |
| **P3** | 5 | PiHarnessFactory 缺 `getSessionInfo()` | 增强 | interface-adapters 无法检查 agent session 是否存在 | ✅ 已修复 |
| **P3** | 6 | `config.ts` 缺 `agent.sessionsRoot` | 配置化 | session 目录硬编码，应提取到 config | ✅ 已修复 |

### 验证依据

所有发现通过 `git show origin/main:src/frameworks/db/schema.ts` 和相关文件逐项验证。跨上下文 Gateway 的架构决策通过 `git show origin/main:src/usecases/otter/manage-session.ts` 和 `git show origin/main:src/usecases/conversation/memory-index-gateway.ts` 的接口注释确认。
