---
id: F20260710b3m9
title: infra-base-foundation
doc_type: feature

# 记忆索引
summary: |
  > 以下章节在需求收敛与设计阶段（代码前）完成并锁定。进入实现阶段后不得单方面修改，如需变更须通过问题卡片向用户提出并确认。 > 本文档是 S4 代码实现阶段的第一个模块设计。基于 S3 数据模型设计（F20260709p4q7）的 DDL 和目录结构规划，设计 infra/base 模块的实...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260709p4q7
    - F20260709m2n8
    - F20260710a1b2


# 元数据
status: locked
change_type: feature
tags: [implementation, s4, infra, database, foundation]
modules: [infra]

# 时间
created_at: 2026-07-10
---


# F20260710b3m9 [infra] 基础设施基础层

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。进入实现阶段后不得单方面修改，如需变更须通过问题卡片向用户提出并确认。
>
> 本文档是 S4 代码实现阶段的第一个模块设计。基于 S3 数据模型设计（F20260709p4q7）的 DDL 和目录结构规划，设计 infra/base 模块的实现方案。
> infra/base 包含数据库连接管理、Schema 初始化、配置常量和日志工具，是所有后续模块的基础设施底座。

## 背景 [required]

S3 定义了完整的 SQLite Schema（14 个表/虚拟表）、Repository 接口、检索索引策略和代码目录结构规划（D29）。S4 启动文档（F20260710a1b2）确认了逐模块实现策略。本模块是实现顺序中的第 0 步，零依赖，为所有后续 domain/app/adapter 模块提供数据库基础设施。

### 约束输入

- S3 全部 DDL（F20260709p4q7 S3-A1）-- 7 个领域表 + 3 个索引表 + linked_resources + key_facts + FTS5 + vec0
- S3-A8 代码目录结构规划 -- 全局 4 层架构 + 路径别名 + ESLint _internal/ 规则
- S4 启动文档（F20260710a1b2）-- 逐模块实现，infra/db 为起点
- S3-A6 权重系统 -- config 需包含权重参数常量
- S2 D19 -- bge-m3 1024 维 embedding
- S2 D23 -- FTS5 trigram 分词器

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| 数据库 | better-sqlite3 12.x | 项目初始化（F20260708r6p5） |
| FTS5 分词器 | trigram | S3 D23 |
| vec0 维度 | 1024 (bge-m3) | S2 D19 |
| 权重半衰期 | 7 天 | S3-I2 用户确认 |
| 路径别名 | @infra/@domain/@app/@adapter | S3-A8 |
| ESLint _internal/ | 禁止跨模块 import | S3-A8 D29 |
| 测试模式 | tests/ 统一目录（与 src/ 平行结构） | 用户确认，替代 S3-A8 co-located 方案 |

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-S4-2 | 当前讨论 | 应该是一个一个模块完整实现，不需要一次性将所有模块都实现 | 粒度：一个一个模块；要求：完整实现 | 逐模块完整实现，infra/base 作为第一个模块 |
| UA-S4-4 | 当前讨论 | infra都应该全是基础设施，如果量不大，是否可以一次性做完呢 | 范围：全部 infra；条件：量不大 | 将 infra/db + config + logger 合并为一个模块。infra/embedding 排除原因是技术依赖（依赖 memoryPort，非量的问题），db+config+logger 合并后总量可控 |

## 目标 [required]

### P1 - 基础设施基础层实现

实现 infra/base 模块，包含：
- SQLite 连接管理（better-sqlite3 + WAL + sqlite-vec 扩展加载）
- 完整 Schema 初始化（S3-A1 全部 DDL：14 个表/虚拟表 + 索引）
- 配置常量（数据库路径、端口、权重参数、RRF 参数等）
- 日志工具（console 封装，满足 ESLint no-console 规则）
- 工程基础设施（路径别名、ESLint _internal/ 规则、vitest 测试配置）

### P2 - 可独立验证

通过集成测试验证：
- 所有表创建成功（14 个表/虚拟表均可查询）
- 索引生效（EXPLAIN QUERY PLAN 验证索引命中）
- FTS5 trigram 可用（INSERT + MATCH 查询）
- vec0 可用（INSERT + KNN 查询）
- 外键约束生效
- WAL 模式启用

## 非目标 [required]

- 不实现任何 domain 层模块（下一个 PR）
- 不实现 infra/embedding（依赖 domain/memory，排到模块 9）
- 不实现 infra/llm-gateway（依赖 pi-ai，排到模块 7）
- 不修改 S3 已锁定的 DDL 结构（但允许按 D28 记录偏差）
- 不实现 Repository 接口（属于 domain 层各模块）
- 不实现任何业务逻辑

## 设计 [required]

### 模块范围

```
src/infra/
├── db/
│   ├── database.ts      # better-sqlite3 连接管理
│   └── schema.ts        # S3-A1 DDL 初始化
├── config.ts            # 配置常量（单文件，不建子目录）
└── logger.ts            # 日志工具（单文件，不建子目录）

tests/
├── infra/
│   ├── database.test.ts # 集成测试
│   └── schema.test.ts   # 集成测试
└── e2e/                 # 端到端测试（后续模块）
```

**目录组织原则**：
- 2+ 相关文件 → 建子目录（如 `db/`、后续 `embedding/`）
- 单文件 → 保持扁平（如 `config.ts`、`logger.ts`）
- 测试统一放 `tests/` 目录，与 `src/` 平行结构，不与源码混杂

工程基础设施改动：
- `tsconfig.json` -- 新增 paths 别名
- `eslint.config.mjs` -- 新增 _internal/ 封装规则
- `vitest.config.ts` -- 测试扫描路径改为 `tests/**/*.test.ts`

### 1. database.ts -- SQLite 连接管理

**职责**：创建和管理 better-sqlite3 数据库连接，启用 WAL 模式，加载 sqlite-vec 扩展，提供生命周期管理。

**公开 API**：

```typescript
// src/infra/db/database.ts

import Database from "better-sqlite3";

interface DatabaseConfig {
  dbPath: string;
  enableWal?: boolean;      // default: true
  enableForeignKeys?: boolean; // default: true
}

/** 初始化数据库连接（同步） */
function initDatabase(config?: Partial<DatabaseConfig>): Database.Database;

/** 关闭数据库连接 */
function closeDatabase(db: Database.Database): void;
```

**设计要点**：

| 要点 | 决策 | 依据 |
|------|------|------|
| 连接模式 | 单例，main.ts 创建一次 | 单用户本地应用，无需连接池 |
| WAL 模式 | 默认启用 | 提升并发读性能，better-sqlite3 推荐 |
| 外键约束 | 默认启用 | SQLite 默认关闭外键，必须显式 PRAGMA |
| sqlite-vec 加载 | try-catch 包裹，失败仅 warn 不阻塞 | D22 降级策略：sqlite-vec 不可用时降级为纯 FTS5 |
| 同步 vs 异步 | 同步 | better-sqlite3 是原生同步 API，单用户场景无阻塞问题 |
| 内存模式 | 支持 `:memory:` 用于测试 | 测试不依赖文件系统 |

**初始化序列**：

```
1. new Database(dbPath)
2. PRAGMA journal_mode = WAL
3. PRAGMA foreign_keys = ON
4. db.loadExtension(sqlite_vec)  -- try-catch，失败仅 warn
5. 返回 db 实例
```

**sqlite-vec 加载方式**：

```typescript
import sqlite_vec from "sqlite-vec";

// sqlite-vec 导出的是一个函数（或包含 sqlite_vec_init 的对象）
// 必须将模块对象传给 loadExtension，而非传字符串路径
try {
  db.loadExtension(sqlite_vec);
} catch {
  logger.warn("sqlite-vec 加载失败，降级为纯 FTS5 检索");
}
```

> **注**：sqlite-vec 的正确加载方式为 `import sqlite_vec from "sqlite-vec"; db.loadExtension(sqlite_vec);`。需传模块对象给 `db.loadExtension()`，而非字符串路径。建议参考 sqlite-vec 官方 README 确认具体 API。

**依赖**：
- `better-sqlite3` -- 已在 package.json
- `sqlite-vec` -- 需新增到 dependencies

### 2. schema.ts -- DDL 初始化

**职责**：执行 S3-A1 定义的全部 DDL，创建所有表、索引和虚拟表。

**公开 API**：

```typescript
// src/infra/db/schema.ts

import type Database from "better-sqlite3";

/** 初始化全部 Schema（幂等，可重复调用） */
function initSchema(db: Database.Database): void;
```

**设计要点**：

| 要点 | 决策 | 依据 |
|------|------|------|
| 幂等性 | 所有 CREATE 使用 IF NOT EXISTS | S3 硬约束 + 代码仓完美状态原则 |
| 无 ALTER TABLE | 禁止 | S3 硬约束 |
| 执行顺序 | 领域表先于虚拟表 | FTS5/vec0 可能依赖领域表存在 |
| 分组组织 | 按限界上下文分组注释 | 与 S3-A1 DDL 分组一致 |
| 事务 | 整个 initSchema 在单事务内 | 原子性：全部成功或全部回滚 |

**DDL 清单**（14 个表/虚拟表，全部来自 S3-A1）：

| # | 表名 | 类型 | 限界上下文 |
|---|------|------|-----------|
| 1 | conversations | 领域表 | 对话 |
| 2 | messages | 领域表 | 对话 |
| 3 | conversation_otters | 关联表 | 对话 |
| 4 | memory_entries | 领域表 | 记忆 |
| 5 | memory_weights | 领域表 | 记忆 |
| 6 | memory_fts | FTS5 虚拟表 | 记忆 |
| 7 | memory_vec | vec0 虚拟表 | 记忆 |
| 8 | linked_resources | 领域表 | 对话关键信息 |
| 9 | key_facts | 领域表 | 对话关键信息 |
| 10 | otters | 领域表 | Otter |
| 11 | otter_sessions | 领域表 | Otter |
| 12 | skills | 领域表 | 能力 |
| 13 | skill_assignments | 领域表 | 能力 |
| 14 | external_resources | 领域表 | 外部系统 |

**索引清单**（28 个普通索引，全部来自 S3-A1）：

| 索引名 | 表 | 列 |
|--------|----|----|
| idx_conversations_parent_id | conversations | parent_id |
| idx_conversations_status | conversations | status |
| idx_conversations_tree_path | conversations | tree_path |
| idx_messages_conversation_id | messages | conversation_id |
| idx_messages_seq | messages | conversation_id, sequence_num |
| idx_messages_created_at | messages | created_at |
| idx_conversation_otters_otter_id | conversation_otters | otter_id |
| idx_memory_entries_layer | memory_entries | layer |
| idx_memory_entries_content_type | memory_entries | content_type |
| idx_memory_entries_conversation_id | memory_entries | conversation_id |
| idx_memory_entries_source | memory_entries | source_table, source_id |
| idx_memory_entries_created_at | memory_entries | created_at |
| idx_memory_entries_tree_path | memory_entries | tree_path |
| idx_linked_resources_conversation_id | linked_resources | conversation_id |
| idx_linked_resources_type | linked_resources | resource_type |
| idx_key_facts_conversation_id | key_facts | conversation_id |
| idx_key_facts_user_flagged | key_facts | user_flagged |
| idx_otters_type | otters | type |
| idx_otters_status | otters | status |
| idx_otters_parent_otter_id | otters | parent_otter_id |
| idx_otter_sessions_otter_id | otter_sessions | otter_id |
| idx_otter_sessions_status | otter_sessions | status |
| idx_otter_sessions_negative | otter_sessions | is_negative_case |
| idx_skills_type | skills | type |
| idx_skill_assignments_otter_id | skill_assignments | otter_id |
| idx_skill_assignments_skill_id | skill_assignments | skill_id |
| idx_skill_assignments_active | skill_assignments | otter_id, revoked_at |
| idx_external_resources_url | external_resources | url |
| idx_external_resources_type | external_resources | type |

**DDL 完整内容**（从 S3-A1 复制，实现时严格按此执行，不得自行修改列名/类型/约束）：

```sql
-- ============================================================
-- 对话上下文：conversations + messages
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,                        -- ConversationId (UUID)
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',      -- active | completed | archived
  parent_id TEXT,                             -- 父对话 ID (NULL = root)
  tree_path TEXT NOT NULL,                    -- 物化路径: '/root_id/.../self_id/'
  summary TEXT,                               -- 对话摘要 (粗粒度检索用)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_parent_id ON conversations(parent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_tree_path ON conversations(tree_path);

-- messages: append-only (INSERT only, no UPDATE/DELETE)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,                        -- MessageId (UUID)
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,                  -- 'user' | 'otter'
  sender_id TEXT NOT NULL,                    -- OtterId or 'user'
  content TEXT NOT NULL,                      -- 消息文本内容
  attachments TEXT,                           -- JSON array of attachments
  sequence_num INTEGER NOT NULL,              -- per-conversation 消息序号
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- conversation_otters: 对话与 Otter 的关联
CREATE TABLE IF NOT EXISTS conversation_otters (
  conversation_id TEXT NOT NULL,
  otter_id TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, otter_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (otter_id) REFERENCES otters(id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_otters_otter_id ON conversation_otters(otter_id);

-- ============================================================
-- 记忆上下文：memory_entries + memory_weights + FTS5 + vec0
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,                        -- MemoryEntryId (UUID)
  layer TEXT NOT NULL,                        -- 'working' | 'historical' | 'key_info'
  content_type TEXT NOT NULL,                 -- 'message' | 'conversation_summary' | 'key_fact' | 'linked_resource'
  source_id TEXT NOT NULL,                    -- 源对象 ID
  source_table TEXT NOT NULL,                 -- 源表名
  conversation_id TEXT,                       -- 关联对话
  tree_path TEXT,                             -- 冗余: 关联对话的 tree_path
  granularity TEXT NOT NULL DEFAULT 'fine',   -- 'coarse' | 'fine'
  content TEXT NOT NULL,                      -- 可搜索内容
  metadata TEXT,                              -- JSON: 额外元数据
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_layer ON memory_entries(layer);
CREATE INDEX IF NOT EXISTS idx_memory_entries_content_type ON memory_entries(content_type);
CREATE INDEX IF NOT EXISTS idx_memory_entries_conversation_id ON memory_entries(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_source ON memory_entries(source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_created_at ON memory_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_entries_tree_path ON memory_entries(tree_path);

CREATE TABLE IF NOT EXISTS memory_weights (
  memory_entry_id TEXT PRIMARY KEY,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at TEXT,
  user_flagged INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (memory_entry_id) REFERENCES memory_entries(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_entry_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  memory_entry_id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);

-- ============================================================
-- 对话关键信息：linked_resources + key_facts
-- ============================================================

CREATE TABLE IF NOT EXISTS linked_resources (
  id TEXT PRIMARY KEY,                        -- LinkedResourceId (UUID)
  conversation_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,                -- 'pr' | 'worktree' | 'branch' | 'file' | 'url' | ...
  url TEXT NOT NULL,
  title TEXT,
  metadata TEXT,                              -- JSON
  linked_by TEXT NOT NULL,                    -- 'user' | 'otter'
  otter_id TEXT,
  auto_linked INTEGER NOT NULL DEFAULT 0,     -- 0 = manual, 1 = auto
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_linked_resources_conversation_id ON linked_resources(conversation_id);
CREATE INDEX IF NOT EXISTS idx_linked_resources_type ON linked_resources(resource_type);

CREATE TABLE IF NOT EXISTS key_facts (
  id TEXT PRIMARY KEY,                        -- KeyFactId (UUID)
  conversation_id TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  user_flagged INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,                   -- 'user' | 'otter'
  otter_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_key_facts_conversation_id ON key_facts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_key_facts_user_flagged ON key_facts(user_flagged);

-- ============================================================
-- Otter 上下文：otters + otter_sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS otters (
  id TEXT PRIMARY KEY,                        -- OtterId (UUID)
  name TEXT NOT NULL,
  type TEXT NOT NULL,                         -- 'big' | 'small'
  status TEXT NOT NULL DEFAULT 'active',      -- active | dissolved
  role_name TEXT,
  role_responsibilities TEXT,                 -- JSON array of strings
  parent_otter_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dissolved_at TEXT,
  FOREIGN KEY (parent_otter_id) REFERENCES otters(id)
);

CREATE INDEX IF NOT EXISTS idx_otters_type ON otters(type);
CREATE INDEX IF NOT EXISTS idx_otters_status ON otters(status);
CREATE INDEX IF NOT EXISTS idx_otters_parent_otter_id ON otters(parent_otter_id);

CREATE TABLE IF NOT EXISTS otter_sessions (
  id TEXT PRIMARY KEY,                        -- SessionId (UUID)
  otter_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',      -- active | archived | restarted
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  archive_reason TEXT,                        -- 'restart' | 'dissolve' | 'manual'
  is_negative_case INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  FOREIGN KEY (otter_id) REFERENCES otters(id)
);

CREATE INDEX IF NOT EXISTS idx_otter_sessions_otter_id ON otter_sessions(otter_id);
CREATE INDEX IF NOT EXISTS idx_otter_sessions_status ON otter_sessions(status);
CREATE INDEX IF NOT EXISTS idx_otter_sessions_negative ON otter_sessions(is_negative_case);

-- ============================================================
-- 能力上下文：skills + skill_assignments
-- ============================================================

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,                        -- SkillId (UUID)
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  type TEXT NOT NULL,                         -- 'tool' | 'prompt_template' | 'workflow'
  definition TEXT NOT NULL,                   -- JSON: { schema, handlerRef }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skills_type ON skills(type);

CREATE TABLE IF NOT EXISTS skill_assignments (
  id TEXT PRIMARY KEY,                        -- SkillAssignmentId (UUID)
  skill_id TEXT NOT NULL,
  otter_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  FOREIGN KEY (skill_id) REFERENCES skills(id),
  FOREIGN KEY (otter_id) REFERENCES otters(id)
);

CREATE INDEX IF NOT EXISTS idx_skill_assignments_otter_id ON skill_assignments(otter_id);
CREATE INDEX IF NOT EXISTS idx_skill_assignments_skill_id ON skill_assignments(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_assignments_active ON skill_assignments(otter_id, revoked_at);

-- ============================================================
-- 外部系统上下文：external_resources
-- ============================================================

CREATE TABLE IF NOT EXISTS external_resources (
  id TEXT PRIMARY KEY,                        -- ResourceId (UUID)
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  metadata TEXT,                              -- JSON
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_external_resources_url ON external_resources(url);
CREATE INDEX IF NOT EXISTS idx_external_resources_type ON external_resources(type);
```

### 3. config.ts -- 配置常量

**职责**：集中管理基础设施配置常量，避免魔法数字散布在代码中。

**公开 API**：

```typescript
// src/infra/config.ts

export const config = {
  db: {
    path: process.env.OTTER_BUDDY_DB_PATH ?? "./otter-buddy.db",
    walMode: true,
    foreignKeys: true,
  },
  server: {
    port: Number(process.env.OTTER_BUDDY_PORT ?? 3000),
  },
  memory: {
    /** RRF 融合参数 k（S3-A5） */
    rrfK: 60,
    /** 权重半衰期天数（S3-I2 用户确认） */
    weightHalfLifeDays: 7,
    /** 同路径 task_relevance 加成（S3-A6） */
    samePathBoost: 1.5,
    /** 跨路径 task_relevance 衰减（S3-A6） */
    crossPathDecay: 0.8,
    /** 用户标记加成（S3-A6） */
    userFlagMultiplier: 2.0,
    /** frequency_boost 系数（S3-A6） */
    frequencyBoostFactor: 0.1,
  },
  embedding: {
    /** bge-m3 向量维度（S2 D19） */
    dimensions: 1024,
  },
} as const;
```

**设计要点**：

| 要点 | 决策 | 依据 |
|------|------|------|
| 环境变量 | 仅 DB 路径和端口支持环境变量覆盖 | S1 NFR：单用户本地，配置简单 |
| 不可变 | `as const` 断言 | 配置在运行时不应被修改 |
| 权重参数 | 集中在 config.memory | S3-A6 权重公式中的常量系数 |
| 无 .env 文件 | 不创建 | S1 D6：不创建 config 示例文件 |

### 4. logger.ts -- 日志工具

**职责**：封装 console 方法，满足 ESLint `no-console: warn` 规则，提供统一日志接口。

**公开 API**：

```typescript
// src/infra/logger.ts

export const logger = {
  info(message: string, ...args: unknown[]): void,
  warn(message: string, ...args: unknown[]): void,
  error(message: string, ...args: unknown[]): void,
  debug(message: string, ...args: unknown[]): void,
};
```

**设计要点**：

| 要点 | 决策 | 依据 |
|------|------|------|
| 实现方式 | 直接封装 console | S1 NFR：无 SLA 要求，不需要结构化日志 |
| 日志级别 | info/warn/error/debug | 基本够用 |
| 无第三方依赖 | 不引入 winston/pino | 用户要求少造轮子，但这里量极小不值得引入 |
| ESLint 豁免 | logger.ts 内部使用 console 允许 | 集中一处，ESLint 可以用 eslint-disable 或注释豁免 |

### 5. 工程基础设施改动

#### 5.1 tsconfig.json -- 路径别名

新增 `paths` 配置，与 S3-A8 一致：

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@infra/*": ["src/infra/*"],
      "@domain/*": ["src/domain/*"],
      "@app/*": ["src/app/*"],
      "@adapter/*": ["src/adapter/*"]
    }
  }
}
```

#### 5.2 eslint.config.mjs -- _internal/ 封装规则

新增 `no-restricted-imports` 规则，禁止跨模块 import `_internal/`，main.ts 豁免：

```javascript
// 新增规则块
{
  files: ["src/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: ["*/_internal/*"]
    }]
  }
},
{
  files: ["src/main.ts"],
  rules: {
    "no-restricted-imports": "off"
  }
}
```

#### 5.3 vitest.config.ts -- 无需修改

测试统一放 `tests/` 目录后，当前 vitest 配置已满足需求：

```typescript
// 当前配置（无需修改）
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // ...
  },
});
```

#### 5.4 package.json -- 新增依赖

| 依赖 | 版本 | 类型 | 用途 |
|------|------|------|------|
| `sqlite-vec` | ^0.1.6 | dependencies | vec0 虚拟表支持（sqlite-vec 加载扩展） |

> **注**：better-sqlite3、hono、vitest 等已在项目初始化时安装，无需重复添加。

## 硬约束 [required]

以下约束来自 S3，本模块实现时必须遵守：

- 所有表使用 `CREATE TABLE IF NOT EXISTS`，禁止 ALTER TABLE
- 外键约束必须启用（SQLite 默认关闭）
- FTS5 使用 trigram 分词器
- vec0 维度为 1024（bge-m3）
- 路径别名格式为 `@infra/*`、`@domain/*`、`@app/*`、`@adapter/*`
- ESLint 禁止跨模块 import `_internal/`（main.ts 豁免）

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| sqlite-vec 加载失败 | warn + 继续启动 | 抛出异常阻止启动 | D22 降级策略：纯 FTS5 仍可用 |
| 日志方案 | console 封装 | 引入 pino/winston | 量极小，不值得引入第三方依赖 |
| config 结构 | 单一 config 对象 | 分散的 env 文件 + dotenv | S1 NFR 单用户本地，配置简单 |
| Schema 初始化 | 单事务全量执行 | 分步执行，每步独立事务 | 原子性保证：全部成功或全部回滚 |
| 测试位置 | tests/ 统一目录（单元+集成在 tests/infra/，e2e 在 tests/e2e/） | co-located（源码混杂） | 用户明确要求测试不与源码混杂；tests/ 统一目录更干净，构建排除更简单 |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/infra/db/database.ts` | 新增 | SQLite 连接管理 |
| `src/infra/db/schema.ts` | 新增 | DDL 初始化 |
| `src/infra/config.ts` | 新增 | 配置常量 |
| `src/infra/logger.ts` | 新增 | 日志工具 |
| `tests/infra/database.test.ts` | 新增 | 集成测试 |
| `tests/infra/schema.test.ts` | 新增 | 集成测试 |
| `tsconfig.json` | 修改 | 新增 paths 别名 |
| `eslint.config.mjs` | 修改 | 新增 _internal/ 封装规则 |
| `vitest.config.ts` | 修改 | 修改前: `include: ['tests/**/*.test.ts']` → 修改后不变（测试统一放 tests/ 目录，无需新增 src 扫描） |
| `package.json` | 修改 | 新增 sqlite-vec 依赖 |

## 验证 [required]

### 验收标准

- [ ] `npm run check` 通过（lint + build）
- [ ] `npm run test` 通过（所有集成测试）
- [ ] 数据库文件创建成功，所有 14 个表/虚拟表存在
- [ ] FTS5 trigram 可 INSERT + MATCH 查询
- [ ] vec0 可 INSERT + KNN 查询（如果 sqlite-vec 加载成功）
- [ ] 外键约束生效（违反时抛出异常）
- [ ] WAL 模式启用（PRAGMA journal_mode 返回 'wal'）
- [ ] 路径别名 `@infra/*` 可正常 import
- [ ] ESLint 对 `_internal/` 跨模块 import 报错
- [ ] logger.ts 不触发 ESLint no-console 警告

### 测试设计

#### tests/infra/database.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| 初始化数据库连接 | db 实例非 null，可执行 SQL |
| WAL 模式启用 | PRAGMA journal_mode 返回 'wal' |
| 外键约束启用 | PRAGMA foreign_keys 返回 1 |
| 内存模式 | `:memory:` 创建成功，无文件残留 |
| 关闭连接 | closeDatabase 后 db 不可操作 |
| sqlite-vec 加载 | vec0 虚拟表可创建（如扩展可用） |

#### tests/infra/schema.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| initSchema 创建全部表 | 14 个表/虚拟表均可 SELECT |
| 幂等性 | 重复调用不报错 |
| FTS5 可用 | INSERT + MATCH 查询返回结果 |
| vec0 可用 | INSERT + KNN 查询返回结果（如扩展可用） |
| 索引存在 | sqlite_master 中可查到索引定义 |
| 外键约束 | 违反外键时抛出 SQLITE_CONSTRAINT |

## 关联 [required]

- **S3 数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **S2 能力模块架构设计**：[F20260709m2n8](../09/F20260709m2n8-capability-module-architecture.md)
- **S4 代码实现启动**：[F20260710a1b2](./F20260710a1b2-s4-code-implementation.md)
- **项目实施计划**：[otter-buddy#5](https://github.com/chenlaicai/otter-buddy/issues/5)
