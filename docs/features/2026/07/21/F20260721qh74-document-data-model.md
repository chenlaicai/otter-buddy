---
id: F20260721qh74
title: document-data-model
doc_type: feature

# 记忆索引
summary: |
  定义文档数据模型的 frontmatter 规范，支持 Feature 和 Research 两种文档类型。
  文档采用 append-only 模式，通过正向因果链路关联，集成到记忆系统作为独立内容类型。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260709p4q7   # 数据模型设计
    - F20260713m5q3   # domain-memory 实现
    - F20260720n5p1   # merge-key-fact-into-resource

# 元数据
status: draft
change_type: feature
tags: [memory, document, data-model, frontmatter]
modules: [entities/memory, usecases/memory]

# 时间
created_at: 2026-07-21
---

# F20260721qh74 - 文档数据模型设计

## 1. 需求背景

### 1.1 问题陈述

当前文档体系存在以下问题：
- **格式不统一**：存在两种 frontmatter 风格（YAML vs Markdown 元信息）
- **关联机制混乱**：`from_ids` 扁平数组不区分来源类型
- **记忆系统未集成**：文档未作为记忆数据的一部分被索引
- **Research 缺乏规范**：Research 文档没有统一的编号和元数据结构

### 1.2 设计目标

1. 定义统一的 frontmatter 规范
2. 支持 Feature 和 Research 两种文档类型，允许结构差异
3. 实现 append-only 模式，文档不可变
4. 通过正向因果链路关联文档
5. 将文档集成到记忆系统，支持 `summary` 作为索引匹配条件

---

## 2. 设计方案

### 2.1 核心原则

| 原则 | 说明 |
|------|------|
| Append-only | 文档不可变，变更产生新文档 |
| 正向依赖 | 文档只声明"我来自哪里"，不声明"我影响了谁" |
| 业务语义区分 | Feature 和 Research 是记忆系统中的两种独立类型，各有独立的表 |
| Summary 必需 | 作为记忆索引的匹配条件，1-500 字符 |

### 2.2 文档编号体系

```
Feature:  F{YYYYMMDD}{random4}    例：F20260720n5p1
Research: R{YYYYMMDD}{random4}    例：R20260718x2k9
```

- 前缀区分类型：`F` = Feature, `R` = Research
- 日期部分：创建日期
- 随机部分：4 位小写字母+数字，保证唯一性（碰撞时重新生成）

### 2.3 Feature Frontmatter

```yaml
---
id: F20260720n5p1
title: merge-key-fact-into-resource
doc_type: feature

# 记忆索引
summary: |
  将 KeyFact 合并到 LinkedResource，统一制品模型。
  消除三层记忆架构的复杂性，简化为两层。
  (1-500 字符，用于记忆索引匹配)

# 因果链路（正向依赖）
causal_links:
  from:                         # 来源文档（通过 ID 前缀自动区分类型）
    - F20260709p4q7             # 来源于 Feature
    - R20260718x2k9             # 来源于 Research

# 演进关系（独立于因果链路）
supersedes:
  - F20260715abc1               # 取代旧版 Feature

# 元数据
status: locked                  # draft | development | locked | archived
change_type: feature            # feature | refactor | fix
tags: [memory, linked-resource]
modules: [domain/memory, conversation]  # 逻辑模块名

# 时间
created_at: 2026-07-20
---
```

**字段说明**：
- `id`：文档唯一编号
- `title`：简短标题
- `doc_type`：固定为 `feature`
- `summary`：内容总结，用于记忆索引（1-500 字符）
- `causal_links.from`：来源文档列表，通过 ID 前缀（F/R）自动区分类型
- `supersedes`：演进关系，取代哪个旧文档（独立字段，不混入因果链路）
- `status`：生命周期状态
- `change_type`：变更类型
- `tags`：分类标签
- `modules`：影响的代码模块（逻辑名，非物理路径）
- `created_at`：创建时间

### 2.4 Research Frontmatter

```yaml
---
id: R20260718x2k9
title: memory-architecture-exploration
doc_type: research

# 记忆索引
summary: |
  探索三层记忆架构 vs 两层架构的取舍。
  结论：两层 + LinkedResource 统一模型更优。
  (1-500 字符，用于记忆索引匹配)

# 因果链路（正向依赖）
causal_links:
  from:                         # 来源文档（通过 ID 前缀自动区分类型）
    - R20260715abc1             # 来源于 Research
    - F20260709p4q7             # 来源于 Feature（允许跨类型引用）

# 演进关系（独立于因果链路）
supersedes:
  - R20260710abc1               # 取代旧版 Research

# 元数据
status: locked                  # draft | development | locked | archived
exploration_type: technical     # technical | market | user-research
tags: [memory, architecture]
conclusion: 两层架构优于三层    # 一句话结论

# 时间
created_at: 2026-07-18
---
```

**字段说明**：
- `id`：文档唯一编号
- `title`：简短标题
- `doc_type`：固定为 `research`
- `summary`：内容总结，用于记忆索引（1-500 字符）
- `causal_links.from`：来源文档列表，通过 ID 前缀（F/R）自动区分类型
- `supersedes`：演进关系，取代哪个旧文档（独立字段）
- `status`：生命周期状态
- `exploration_type`：探索类型（统一使用连字符）
- `tags`：分类标签
- `conclusion`：一句话结论
- `created_at`：创建时间

### 2.5 结构差异对比

| 字段 | Feature | Research |
|------|---------|----------|
| `summary` | 有 | 有 |
| `causal_links.from` | 有（可引用 F 和 R） | 有（可引用 F 和 R） |
| `supersedes` | 有（只引用 F） | 有（只引用 R） |
| `status` | draft / development / locked / archived | draft / development / locked / archived |
| `change_type` | feature / refactor / fix | 无 |
| `exploration_type` | 无 | technical / market / user-research |
| `conclusion` | 无 | 有 |
| `modules` | 有 | 无 |

**设计说明**：
- `causal_links.from` 统一字段，通过 ID 前缀自动区分类型，支持跨类型引用
- `supersedes` 独立字段，语义与因果链路分离，Feature 只取代 Feature，Research 只取代 Research
- `exploration_type` 统一使用连字符风格（`user-research`）

---

## 3. 数据库设计

### 3.1 双表架构

Feature 和 Research 是两种独立的业务语义，各自拥有独立的表：

```sql
-- Feature 表
CREATE TABLE features (
  id TEXT PRIMARY KEY,                    -- F{YYYYMMDD}{random4}
  title TEXT NOT NULL,
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
  change_type TEXT NOT NULL CHECK(change_type IN ('feature', 'refactor', 'fix')),
  status TEXT NOT NULL CHECK(status IN ('draft', 'development', 'locked', 'archived')),
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON 数组
  modules TEXT NOT NULL DEFAULT '[]',     -- JSON 数组
  causal_links_from TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，来源文档 ID
  supersedes TEXT,                        -- JSON 数组，取代的文档 ID
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(id LIKE 'F%')
);

-- Research 表
CREATE TABLE research (
  id TEXT PRIMARY KEY,                    -- R{YYYYMMDD}{random4}
  title TEXT NOT NULL,
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
  exploration_type TEXT NOT NULL CHECK(exploration_type IN ('technical', 'market', 'user-research')),
  status TEXT NOT NULL CHECK(status IN ('draft', 'development', 'locked', 'archived')),
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON 数组
  conclusion TEXT,
  causal_links_from TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，来源文档 ID
  supersedes TEXT,                        -- JSON 数组，取代的文档 ID
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(id LIKE 'R%')
);

-- 索引
CREATE INDEX idx_features_status ON features(status);
CREATE INDEX idx_features_created_at ON features(created_at);
CREATE INDEX idx_research_status ON research(status);
CREATE INDEX idx_research_created_at ON research(created_at);
CREATE INDEX idx_research_exploration_type ON research(exploration_type);
```

### 3.2 记忆系统集成

```typescript
// src/entities/memory/memory-entry.ts

// 新增两种内容类型
export type MemoryContentType =
  | 'message'
  | 'conversation_summary'
  | 'fact'
  | 'linked_resource'
  | 'feature'      // 新增
  | 'research';    // 新增

// 新增 document 层
export type MemoryLayer = 'working' | 'historical' | 'document';

// Feature 记忆条目的 metadata
interface FeatureMemoryMetadata {
  doc_type: 'feature';
  change_type: 'feature' | 'refactor' | 'fix';
  tags: string[];
  modules: string[];
  from: string[];          // 来源文档 ID
  supersedes?: string[];   // 取代的文档 ID
}

// Research 记忆条目的 metadata
interface ResearchMemoryMetadata {
  doc_type: 'research';
  exploration_type: 'technical' | 'market' | 'user-research';
  tags: string[];
  conclusion: string;
  from: string[];          // 来源文档 ID
  supersedes?: string[];   // 取代的文档 ID
}
```

**记忆条目关键字段**：
- `layer`：`'document'`（新增层，区别于 working/historical）
- `granularity`：`'coarse'`（文档是结构化高层信息，不需要细粒度匹配）
- `conversationId`：`null`（文档独立于对话）
- `sourceTable`：`'features'` 或 `'research'`（对应双表）
- `sourceId`：文档 ID（如 `F20260720n5p1`）
- `contentType`：`'feature'` 或 `'research'`
- `content`：使用 frontmatter 中的 `summary` 字段
- `metadata`：包含完整的因果链路和元数据

### 3.3 MemoryIndexGateway 接口扩展

```typescript
// src/usecases/conversation/memory-index-gateway.ts

export interface MemoryIndexGateway {
  // 现有方法
  indexMessage(message: Message): Promise<void>;
  indexLinkedResource(resource: LinkedResource): Promise<void>;

  // 新增方法
  indexFeature(feature: FeatureDocument): Promise<void>;
  indexResearch(research: ResearchDocument): Promise<void>;
}

// 文档数据结构
export interface FeatureDocument {
  id: string;
  title: string;
  summary: string;
  change_type: 'feature' | 'refactor' | 'fix';
  status: 'draft' | 'development' | 'locked' | 'archived';
  tags: string[];
  modules: string[];
  from: string[];
  supersedes?: string[];
  file_path: string;
  created_at: string;
}

export interface ResearchDocument {
  id: string;
  title: string;
  summary: string;
  exploration_type: 'technical' | 'market' | 'user-research';
  status: 'draft' | 'development' | 'locked' | 'archived';
  tags: string[];
  conclusion?: string;
  from: string[];
  supersedes?: string[];
  file_path: string;
  created_at: string;
}
```

---

## 4. 检索场景

| 查询意图 | 检索方式 |
|---------|---------|
| 找到某个 Feature 的设计来源 | `causal_links.from` 链路追溯（递归查询） |
| 找到某个特性的最新版本 | `supersedes` 链追踪 + 时间排序（支持反向索引） |
| 按模块查找相关文档 | `modules` 过滤（仅 Feature） |
| 按技术领域查找探索 | `exploration_type` + `tags` 过滤（仅 Research） |
| 跨类型全文搜索 | 同时查询 `features` 和 `research` 表 |

**反向追溯**（查询"谁依赖了我"）：
- 在数据库层面：`SELECT * FROM features WHERE causal_links_from LIKE '%F20260709p4q7%'`
- 在记忆索引层面：搜索 `from` 包含目标 ID 的记忆条目
- 这是查询时计算，不是存储时维护

---

## 5. 文档演进示例

```
R20260715abc1 (探索：三层 vs 两层)
    ↓ causal_links.from
R20260718x2k9 (探索：统一制品模型)
    ↓ causal_links.from (Research 引用 Research)
F20260709p4q7 (Feature：数据模型设计)
    ↓ causal_links.from (Feature 引用 Research)
F20260713m5q3 (Feature：domain-memory 实现)
    ↓ causal_links.from (Feature 引用 Feature)
F20260720n5p1 (Feature：合并 KeyFact)
    ↓ supersedes (Feature 取代 Feature)
F20260725xyz1 (Feature：V2 演进)
```

---

## 6. 实现计划

### 6.1 阶段一：类型定义

1. 在 `src/entities/memory/memory-entry.ts` 中新增 `MemoryContentType` 和 `MemoryLayer`
2. 定义 `FeatureMemoryMetadata` 和 `ResearchMemoryMetadata` 接口
3. 更新 `MemoryEntry` 接口的 `metadata` 类型

### 6.2 阶段二：数据库设计

1. 创建 `features` 表和 `research` 表的 DDL
2. 在 `src/frameworks/db/schema.ts` 中添加表定义
3. 创建对应的 Repository 接口和实现

### 6.3 阶段三：索引集成

1. 扩展 `MemoryIndexGateway` 接口，新增 `indexFeature` 和 `indexResearch` 方法
2. 实现文档索引函数，解析 frontmatter 并创建记忆条目
3. 更新搜索逻辑，支持 `feature` 和 `research` 内容类型

---

## 7. 关联文档

- **数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **domain-memory 实现**：[F20260713m5q3](../13/F20260713m5q3-domain-memory.md)
- **merge-key-fact-into-resource**：[F20260720n5p1](../20/F20260720n5p1-merge-key-fact-into-resource.md)

---

## 8. 偏差记录

无偏差。
