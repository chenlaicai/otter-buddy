---
id: F20260716hkv3
title: terminology-library
doc_type: feature

# 记忆索引
summary: |
  > 本文档设计记忆系统的**多库架构**，并将**术语库**作为首个新库实现。 > **架构核心**：每个库是独立的数据源 + 独立的搜索索引 + 独立的检索策略。memory_entries 保持现状，就是对话库的搜索索引。search_memory 是一个路由层，按 library 参数分...


# 因果链路（正向依赖）
causal_links:
  from:
    - F20260713m5q3
    - F20260709x7k3


# 元数据
status: draft
change_type: feature
tags: [design, memory, terminology, glossary, domain-knowledge, multi-library]
modules: [domain/memory, frameworks/db, interface-adapters/agent-runtime]

# 时间
created_at: 2026-07-16
---


# F20260716hkv3 [memory] 记忆系统多库架构 + 术语库

## [design-time]

> 本文档设计记忆系统的**多库架构**，并将**术语库**作为首个新库实现。
>
> **架构核心**：每个库是独立的数据源 + 独立的搜索索引 + 独立的检索策略。memory_entries 保持现状，就是对话库的搜索索引。search_memory 是一个路由层，按 library 参数分发到各库的检索管道。
>
> 本次 PR 分两个 Part：
> - **Part 1**：多库架构定义（LibraryDefinition、search_memory 路由层、三层模型删除）
> - **Part 2**：术语库实现（terminology_entries + terminology_fts、CRUD、检索、Agent 工具、种子数据）

## 背景 [required]

### 多库架构的由来

用户提出记忆系统的数据应该分为多个"库"，每个库有各自的主题和数据形态。现有架构的认知基础需要修正：

**现有架构的本质（CQRS 模式）**：
- `messages` 等表是**数据源**（写入端，权威存储）
- `memory_entries` 是**搜索索引**（读取端，搜索投影），通过 `source_table` + `source_id` 多态外键指向数据源
- 数据单向流动：`数据源表 → memory_entries`（通过 MemoryIndexGateway）

**用户纠正**：每个库应该有自己的数据源表，不是所有数据都塞进 memory_entries。

### 术语库的需求

用户希望新增一个"库"，专门存放项目域内有独特含义的术语定义。类似于设计文档中的《名词解释》章节，但是运行时可查询、可演化的版本。

现有 Feature 文档 F20260709x7k3 中已有"统一语言术语表"，记录了项目启动时的 8 个核心术语（大獭、小獭、对话、重启獭生等）。但该术语表是静态文档，无法在运行时被 Otter 查询或扩展。

### 约束输入

- F20260713m5q3: domain/memory 模块已实现，memory_entries 是对话库的搜索索引（FTS5 + vec0 + RRF + 权重重排）
- F20260709x7k3: 产品形态定义中已有"统一语言术语表"，包含 8 个核心术语
- F20260716szw8: 记忆系统渐进式披露召回机制已实现
- 当前实现：memory_entries 是搜索索引层，通过 MemoryIndexGateway 从 messages/key_facts/linked_resources 投影数据
- 当前实现：三层模型（working/historical/key_info）管理 memory_entries 的生命周期

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| 架构方向 | 多库架构：每个库独立数据源 + 独立搜索索引 + 独立检索策略 | 架构师-1 分析决策 |
| memory_entries 定位 | 保持现状，就是对话库的搜索索引，不加 library 字段 | 架构师-1 分析决策 |
| search_memory 定位 | 路由层，按 library 参数分发到各库的检索管道 | 架构师-1 分析决策 |
| 多库 vs 动态库 | 库固定，不允许动态创建；新增库必须经过设计适配 | 用户明确指令 |
| 召回工具 | search_memory 新增 library 参数 | 用户明确指令 |
| 工作记忆 | pi agent session 自行管理，不属 otter 系统侧 | 用户明确指令 |
| 三层模型 | 直接物理删除，不标 @deprecated | 用户明确指令 |
| 全库搜索策略 | 排名位置归一化 `1/(1+rank)`，跨库混排，同分按库优先级 | 架构师-1 定义完整方案 |
| 命名 | "术语库"（对应 glossary/terminology） | 架构师-1 提议，架构师-2 接受 |
| 术语库向量索引 | 不加 vec0，仅用 FTS5 | 架构师-1 提议，架构师-2 审视确认 |
| 术语库 CRUD | CRUD 语义，支持修改和废弃（deprecated） | 架构师-1 提议，架构师-2 审视确认 |
| 术语库写入权限 | 用户 + 大獭可写入，小獭不可 | 架构师-2 提出，架构师-1 接受 |
| Agent 识别策略 | 保守型：仅用户显式定义时记录，边界模糊时询问确认 | 架构师-2 提出，架构师-1 接受 |
| 种子数据 | F20260709x7k3 术语表作为初始种子导入 | 架构师-1 提议，架构师-2 接受 |
| PR 拆分 | 分两个 Part：Part 1 = 多库架构定义，Part 2 = 术语库实现 | 架构师-2 提出，架构师-1 接受 |
| FTS5 模式 | 非 content-sync，独立 FTS5 表，用 terminology_entry_id 关联 | 架构师-2 提出，架构师-1 接受 |
| 检索工具 | search_terminology（独立）+ search_memory(library="terminology") 共存，底层共享逻辑 | 架构师-2 提出，架构师-1 接受 |
| 删除语义 | 去掉 removeTerm，只保留 deprecateTerm | 架构师-2 提出，架构师-1 接受 |

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前讨论 | 记忆系统数据范围内，我希望新增一个"库"，放着所有的名词说明 | 范围：记忆系统数据范围内；动作：新增；内容：所有的名词说明；形态：一个"库" | 在记忆系统中新增独立的术语存储模块 |
| UA-2 | 当前讨论 | 类似于写设计文档中的《名词解释》章节 | 类比：名词解释章节 | 术语库的形态类似 glossary，每个术语有定义和说明 |
| UA-3 | 当前讨论 | 本系统中，otter是有独特含义的，而不能简单理解为 动物的海獭 | 例子：otter；特殊性：有独特含义；否定：不能简单理解为动物 | 术语在项目域内有专属定义，与通用语义不同 |
| UA-4 | 当前讨论 | 包括说 大獭/小獭/设计獭 这些，都是有含义的 | 例子：大獭/小獭/设计獭；特征：都是有含义的 | 术语不限于单个词，包含项目特有的命名实体 |
| UA-5 | 当前讨论 | 记忆数据 应该有几类，1对话数据（msg）...2.每一个pr的特性文档...3.探索类...4.比如说本次提到的术语库 | 分类：4 类；枚举：对话/特性文档/探索/术语 | 记忆系统的数据分为固定数量的库，每个库有主题 |
| UA-6 | 当前讨论 | agent session就是《工作记忆》、这部分其实是由pi agent自行管理的，严格来说 不属于otter系统侧 | 归属：pi agent 管理；否定：不属于 otter 系统侧 | 工作记忆由 pi agent session 管理，otter 不重复管理 |
| UA-7 | 当前讨论 | otter系统 记录的所有msg（包括了当前session，也包括了历史session），这部分就是 记忆数据中的 对话数据 | 范围：所有 msg（当前+历史）；归属：对话数据 | otter 记录所有 session 的消息作为对话库 |
| UA-8 | 当前讨论 | 记忆系统的记忆数据应该是有《多个库》的，每个库有各自的主题，并且在 召回时允许ai自行决定本次要召回哪一个库、或者全库 | 架构：多个库；每个库有主题；召回：AI 自行决定查哪个库或全库 | 多库架构 + AI 自主选择召回范围 |
| UA-9 | 当前讨论 | 库必然是固定的，不允许动态创建。每次新建都必须适配 记忆系统 | 约束：固定；否定：不允许动态创建；条件：每次新建必须适配 | 库是预定义的，新增库需经过设计 |
| UA-10 | 当前讨论 | 要直接重构。但是只改了 记忆数据的边界，召回机制 这些都不变啊！ | 方式：直接重构；范围：只改数据边界；不变：召回机制 | 直接重构三层→多库，召回引擎不变 |
| UA-11 | 当前讨论 | 直接改，不要残留兼容处理 | 方式：直接改；否定：不要残留兼容处理 | 三层模型代码直接物理删除，不标 @deprecated |
| UA-12 | 当前讨论 | 不同库就是多个 数据源表，都是《记忆数据源》 | 类比：数据源表；归属：记忆数据源 | 每个库有自己的数据源表，都是记忆系统的数据源 |

## 目标 [required]

> **Part 拆分**：本次 PR 分两个 Part，可独立验证和回滚。
> - Part 1：多库架构定义（LibraryDefinition、search_memory 路由层、三层模型删除）
> - Part 2：术语库实现（纯新增）

### P1 - 多库架构定义（Part 1）

定义多库架构的基础框架：
- `LibraryDefinition` 接口：每个库的元信息（key、name、priority）
- `search_memory` 改造为路由层：按 library 参数分发到各库的检索管道
- 全库搜索：排名位置归一化跨库混排
- 三层模型代码（MemoryLayer、canTransitionMemoryLayer 等）直接物理删除

### P2 - 术语库实现（Part 2）

在多库架构下实现术语库：
- 独立数据源表：`terminology_entries`
- 独立搜索索引：`terminology_fts`（FTS5 独立表）
- 完整 CRUD：新增、查询、更新、废弃
- 检索策略：精确匹配 > 前缀匹配 > 全文搜索

### P3 - Agent 工具集成

为 Otter 提供术语查询和录入能力：
- `search_terminology(query)` — 独立工具，直观易用
- `search_memory(query, library="terminology")` — 多库架构一致性
- `add_terminology(term, definition, ...)` — 记录新术语

### P4 - 种子数据导入

将 F20260709x7k3 中的"统一语言术语表"（8 个核心术语）作为初始种子数据导入术语库。

### P5 - 可独立验证

通过集成测试验证：
- 多库架构的库注册和路由机制
- 术语的 CRUD 操作
- 精确/前缀/全文三种检索路径
- search_memory 的 library 参数功能和全库搜索混排
- 种子数据导入

## 非目标 [required]

- 不修改 memory_entries 表结构（它就是对话库的搜索索引，保持现状）
- 不修改对话库的检索引擎（SearchEngine、RRF、权重衰减），仅通过路由层接入
- 不实现特性文档库（后续 Feature）
- 不实现探索库（后续 Feature）
- 不添加向量索引（vec0）
- 不实现术语版本历史链（仅乐观锁覆盖）
- 不实现术语的自动发现（保守策略，仅用户显式定义时记录）

## 设计 [required]

### 多库架构

#### 核心概念：Library

```typescript
/**
 * 库（Library）是记忆系统的顶层数据分区。
 * 每个库有独立的数据源表、搜索索引和检索策略。
 * 库是预定义的，不允许运行时动态创建。
 */
interface LibraryDefinition {
  key: string;                    // 库标识（如 "conversation", "terminology"）
  name: string;                   // 库名（如 "对话库", "术语库"）
  description: string;            // 库描述
  searchable: boolean;            // 是否参与 search_memory 检索
  priority: number;               // 全库搜索时的优先级（数值越大越优先）
}

const LIBRARIES: LibraryDefinition[] = [
  { key: "terminology",  name: "术语库", description: "项目域术语定义", searchable: true, priority: 100 },
  { key: "conversation", name: "对话库", description: "所有 session 的消息记录", searchable: true, priority: 50 },
  // 后续：feature_doc, exploration, ...
];
```

#### 架构全景

```
每个库 = 独立数据源 + 独立搜索索引 + 独立检索策略

对话库（conversation）：
  数据源：messages + key_facts + linked_resources
  搜索索引：memory_entries + memory_fts + memory_vec + memory_weights
  检索策略：FTS5 + vec0 + RRF + 权重衰减 + 渐进式披露

术语库（terminology）：
  数据源：terminology_entries（同时承载搜索索引）
  搜索索引：terminology_fts（FTS5 独立表）
  检索策略：精确匹配 > 前缀匹配 > 全文搜索

search_memory（路由层）：
  library="conversation"  → 调用 MemoryRepository.search()
  library="terminology"   → 调用 TerminologyRepository.search()
  不传 library            → 分别查各库，排名位置归一化混排
```

#### search_memory 路由机制

```typescript
// search_memory 不直接查某张表，而是路由到各库的检索管道
interface SearchMemoryParams {
  query: string;
  library?: string;       // 指定库 key，不传则全库搜索
  detail_level?: "summary" | "snippet" | "full";
}

function searchMemory(params: SearchMemoryParams) {
  const { query, library } = params;

  if (library) {
    // 单库搜索：路由到指定库的检索管道
    const lib = LIBRARIES.find(l => l.key === library);
    return lib.repository.search(query, params);
  }

  // 全库搜索：分别查各库，排名位置归一化混排
  const results = [];
  for (const lib of LIBRARIES.filter(l => l.searchable)) {
    const libResults = await lib.repository.search(query, params);
    results.push(...libResults.map((r, rank) => ({
      ...r,
      library: lib.key,
      normalizedScore: 1.0 / (1 + rank),
      priority: lib.priority,
    })));
  }

  // 按归一化分数降序混排，同分时按库优先级排列
  return results.sort((a, b) =>
    b.normalizedScore !== a.normalizedScore
      ? b.normalizedScore - a.normalizedScore
      : b.priority - a.priority
  );
}
```

#### 全库搜索合并策略

各库的检索输出语义不同（术语库是精确/前缀/全文命中，对话库是 RRF 融合分数），需要归一化。

**方案：排名位置归一化**

```
normalized_score = 1.0 / (1 + rank_in_library)
```

- 每个库内部先按各自策略排序
- 取排名位置（0-based），归一化到 (0, 1] 区间
- 跨库按归一化分数降序混排
- 同分时按库优先级排列（terminology:100 > conversation:50）
- 归一化消除了量纲差异，只保留"在本库中的相关性排序"语义

#### 对话库的边界

对话库的数据来源和可见性规则：
- **数据来源**：otter 系统记录的所有 session 的消息
- **当前 session**：只能看到自己的消息（pi agent session 内管理）
- **历史 session**：能看到所有 agent 的发言
- **与 pi agent 的关系**：pi agent session 是"工作记忆"，由 pi agent 自行管理；otter 系统侧不重复管理工作记忆
- **memory_entries 保持现状**：就是对话库的搜索索引，不加 library 字段，不改结构

#### 三层模型的删除

现有三层模型（working/historical/key_info）在多库架构下被直接删除：
- `working` 层 → 由 pi agent session 管理，不再属于 otter 记忆系统
- `historical` 层 → 概念合并到对话库（所有历史 session 的消息）
- `key_info` 层 → 概念保留，归属到对话库（每个对话的关键信息是对话数据的一部分）

**直接删除，不标 @deprecated**。`MemoryLayer` 枚举、`canTransitionMemoryLayer` 函数、以及所有基于三层模型的检索路径在本次 PR 中物理删除。

### 术语库设计

#### TerminologyEntry 实体

```typescript
type TerminologyStatus = "active" | "deprecated";

interface TerminologyEntry {
  id: string;                    // 主键
  term: string;                  // 术语名称（如 "大獭", "重启獭生"）
  aliases: string[];             // 别名列表（如 ["Otter", "海獭"]）
  definition: string;            // 定义文本
  context: string | null;        // 上下文说明（可选）
  examples: string[] | null;     // 用例列表（可选）
  category: string | null;       // 分类（如 "实体", "操作", "机制"）
  status: TerminologyStatus;     // 状态：active / deprecated
  createdAt: string;             // 创建时间
  updatedAt: string;             // 更新时间
  version: number;               // 乐观锁版本号
}
```

#### 核心业务规则

```typescript
function isTerminologySearchable(entry: TerminologyEntry): boolean {
  return entry.status === "active";
}
// deprecated 术语不参与检索，但保留记录避免引用断裂
```

#### 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS terminology_entries (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',          -- JSON 数组
  aliases_flat TEXT NOT NULL DEFAULT '',       -- aliases 展平为纯文本，空格分隔，供 FTS5 索引
  definition TEXT NOT NULL,
  context TEXT,
  examples TEXT,                                 -- JSON 数组
  category TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_terminology_term ON terminology_entries(term);
CREATE INDEX IF NOT EXISTS idx_terminology_status ON terminology_entries(status);
CREATE INDEX IF NOT EXISTS idx_terminology_category ON terminology_entries(category);

-- FTS5 独立表（非 content-sync 模式），参照 memory_fts 设计
CREATE VIRTUAL TABLE IF NOT EXISTS terminology_fts USING fts5(
  terminology_entry_id UNINDEXED,
  term,
  aliases_flat,
  definition,
  context,
  tokenize='trigram'
);
```

**FTS5 设计说明**：采用非 content-sync 模式（独立 FTS5 表），参照现有 `memory_fts` 的设计。`terminology_entry_id UNINDEXED` 列关联回 `terminology_entries` 表。写入时同步插入 FTS5 行，删除时同步删除。`aliases_flat` 列在基表中显式定义，写入时将 `aliases` JSON 数组展平为空格分隔的纯文本。

#### 术语库检索策略

检索优先级：

1. **精确匹配**：`WHERE term = ? OR aliases LIKE ?` — 用户输入完整术语名时
2. **前缀匹配**：`WHERE term LIKE '?%'` — 用户输入部分术语时
3. **全文搜索**：FTS5 `MATCH` 搜索 definition + context — 用户描述概念反查术语时

三种路径按优先级依次尝试，首次命中即返回。不走 RRF 融合，不走权重衰减。

#### 术语库写入/更新语义

| 操作 | 方法 | 语义 |
|------|------|------|
| 新增 | `addTerm(entry)` | 插入新术语，version=1 |
| 更新 | `updateTerm(id, changes)` | 乐观锁更新，version+1 |
| 废弃 | `deprecateTerm(id)` | status 改为 deprecated，不物理删除 |
| 搜索 | `searchTerm(query)` | 按优先级检索，仅返回 active 状态 |

**不提供硬删除**：术语"不存在"的状态用 `deprecated` 表达，避免引用断裂。如需物理清理，通过维护脚本批量清理 deprecated 记录。

#### Agent 工具

**工具关系**：`search_terminology` 和 `search_memory(library="terminology")` 共存，底层共享同一检索逻辑。`search_terminology` 更直观（agent 不需要知道"library"概念），`search_memory(library="terminology")` 保持多库架构一致性。

##### search_terminology（独立工具）

```typescript
{
  name: "search_terminology",
  description: "在术语库中查找项目域内术语的定义。当用户询问某个词的含义时使用。",
  parameters: {
    query: {
      type: "string",
      description: "要查找的术语名称或相关描述"
    }
  }
}
```

##### add_terminology

```typescript
{
  name: "add_terminology",
  description: "在术语库中记录新的项目域术语。仅在用户显式定义术语时使用。",
  parameters: {
    term: { type: "string", description: "术语名称" },
    definition: { type: "string", description: "术语定义" },
    aliases: { type: "array", items: { type: "string" }, description: "别名列表（可选）" },
    category: { type: "string", description: "分类（可选）：实体、操作、机制等" },
    context: { type: "string", description: "上下文说明（可选）" }
  }
}
```

### 种子数据

从 F20260709x7k3 "统一语言术语表"导入以下 8 个术语：

| term | aliases | definition | category |
|------|---------|------------|----------|
| 大獭 | ["Big Otter"] | 用户唯一持久 Otter，带有独占能力 | 实体 |
| 小獭 | ["Small Otter"] | 大獭按需创建的临时 Otter，任务结束解散 | 实体 |
| 对话 | ["Conversation"] | 用户与 Otter 的交互单元。支持树状结构。可以是 1v1 或多 Otter。 | 概念 |
| 重启獭生 | ["Restart Otter Life"] | 用户表达不满时触发的 Otter 个体内部机制：封存当前 session 为反面案例，开新 session 换角度重来。 | 机制 |
| 统一能力库 | ["Unified Capability Library"] | 系统级 Skill 集合 | 模块 |
| 记忆系统 | ["Memory System"] | 系统级模块，标准化接口，多库架构，所有 Otter 主动检索 | 模块 |
| 手脚 | ["Hands & Feet"] | 工具/Skill/外部系统 | 概念 |
| 对话关键信息 | ["Conversation Key Info"] | 每个对话的关键信息（开放机制，大獭和用户可添加） | 概念 |

种子数据在系统初始化时通过 `seedTerminology()` 方法导入，仅在 `terminology_entries` 表为空时执行。

## 偏差记录

| 项目 | 偏差 | 原因 |
|------|------|------|
| 记忆系统架构 | 三层模型（working/historical/key_info）→ 多库架构 | 用户重新定义记忆数据边界，明确工作记忆由 pi agent 管理 |
| memory_entries 定位 | 从"通用记忆表"明确为"对话库的搜索索引" | 每个库有自己的数据源表，memory_entries 是对话库的 CQRS 读端 |

## 硬约束 [required]

- 术语库的数据表和索引使用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE VIRTUAL TABLE IF NOT EXISTS` 语法
- 禁止 ALTER TABLE、迁移脚本或兼容性桥接
- 不兼容变更记录在本文档的"不兼容更新"段落，由人手工处理
- 库列表固定，不允许运行时动态创建新库
- 工作记忆（pi agent session）不纳入 otter 系统管理
- memory_entries 表结构不变，不加 library 字段

## 实现指引 [required]

### 架构层级归属

多库架构跨越三个架构层：

| 层 | 职责 | 文件 |
|---|------|------|
| Entities | LibraryDefinition 定义 | `src/entities/memory/library-definition.ts`（新增） |
| Entities | TerminologyEntry 实体定义和业务规则 | `src/entities/memory/terminology-entry.ts`（新增） |
| Use Cases | 术语 CRUD 和检索用例 | `src/usecases/memory/manage-terminology.ts`（新增） |
| Use Cases | 术语仓库接口 | `src/usecases/memory/terminology-repository.ts`（新增） |
| Use Cases | search_memory 改造为路由层 | `src/usecases/memory/search-memory.ts`（修改） |
| Frameworks | SQLite 实现 | `src/frameworks/db/memory/sqlite-terminology-repository.ts`（新增） |
| Frameworks | 行映射 | `src/frameworks/db/memory/terminology-mapper.ts`（新增） |
| Frameworks | Schema 扩展 | `src/frameworks/db/schema.ts`（修改：新增术语库表定义） |
| Interface Adapters | Agent 工具扩展 | `src/interface-adapters/agent-runtime/tools/tool-factory.ts`（修改） |
| Composition Root | 依赖注入 | `src/main.ts`（修改：新增绑定） |

### 检索实现要点

- 精确匹配使用 SQLite 原生查询（`WHERE term = ?`），不走 FTS5
- 前缀匹配使用 `WHERE term LIKE '?%'`，不走 FTS5
- 全文搜索使用 FTS5 `MATCH` 查询，仅在精确和前缀均未命中时触发
- 三种路径在同一 use case 方法中按优先级串联

### Agent 识别策略

- **显式定义**：用户说"我们把 X 叫做 Y"或"X 的意思是 Y" → agent 自动调用 `add_terminology`
- **边界模糊**：agent 不确定某词是否为术语 → 向用户询问"这是否需要记录为术语？"
- **被动查询**：用户问"大獭是什么" → agent 调用 `search_terminology`
- agent 不得在无用户信号的情况下主动推测和记录术语

### 三层模型删除策略

现有三层模型的代码在本次 PR 中直接物理删除：
- `MemoryLayer` 枚举删除
- `canTransitionMemoryLayer` 函数删除
- `working`/`historical`/`key_info` 相关的检索路径删除
- `memory_entries` 表保留，明确为对话库的搜索索引
- `MemoryContentType` 中属于对话库的类型保留

## 设计取舍 [required]

| 决策点 | 选择 | 替代方案 | 理由 |
|--------|------|---------|------|
| 架构方向 | 多库架构：每个库独立数据源 + 独立搜索索引 | memory_entries 统一索引所有库 | 术语库的 CRUD、无衰减、无层转换语义与 memory_entries 的 append-only + 衰减 + 层转换冲突，强行塞入会污染整洁架构 |
| memory_entries 定位 | 保持现状，就是对话库的搜索索引 | 加 library 字段索引所有库 | 不同库的 schema 和检索策略差异太大，共享表会导致大量 nullable 字段和条件分支 |
| search_memory 定位 | 路由层，按 library 分发到各库 | 直接查 memory_entries | 每个库有自己的检索管道，路由层是最干净的分发方式 |
| 库创建方式 | 固定预定义 | 运行时动态创建 | 每个库需适配记忆系统（独立表、索引、检索策略），不是简单操作 |
| 三层模型处理 | 直接物理删除 | 标记 deprecated 保留 | 用户明确指令：直接改，不残留兼容处理 |
| 全库搜索 | 排名位置归一化后跨库混排 | 按库分组返回 | 排名位置归一化消除量纲差异，保留"本库内相关性排序"语义 |
| 术语库向量索引 | 不加 vec0 | 加 vec0 | 术语量级小（50-200 条），检索以精确/前缀为主；向量搜索引入噪音 |
| 术语库 CRUD | CRUD（含 deprecated 状态） | Append-only | 术语定义可演化，需要修改能力；deprecated 避免硬删除导致引用断裂 |
| 术语库写入权限 | 用户 + 大獭 | 所有 Otter | 小獭是任务导向的临时实体，允许写入会引入噪音 |
| FTS5 模式 | 独立表（非 content-sync），参照 memory_fts | content-sync 模式 | content-sync 要求虚拟表列对应基表列，TEXT PK 的 rowid 关联有技术风险 |
| 删除语义 | 只保留 deprecateTerm，去掉 removeTerm | 同时保留硬删除和软删除 | deprecated 已解决引用断裂问题，硬删除增加复杂度无实际收益 |
| PR 结构 | 分两个 Part（架构定义 + 术语库） | 单一 PR | 架构变更是高风险操作，拆分可独立验证和回滚 |

## 变更范围 [required]

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/entities/memory/library-definition.ts` | LibraryDefinition 接口和预定义库列表 |
| `src/entities/memory/terminology-entry.ts` | TerminologyEntry 实体、类型定义、业务规则 |
| `src/usecases/memory/terminology-repository.ts` | TerminologyRepository 接口 |
| `src/usecases/memory/manage-terminology.ts` | 术语 CRUD 和检索用例 |
| `src/frameworks/db/memory/sqlite-terminology-repository.ts` | SQLite 实现 |
| `src/frameworks/db/memory/terminology-mapper.ts` | 行到实体映射 |
| `tests/usecases/memory/manage-terminology.test.ts` | 术语库集成测试 |

### 修改文件

| 文件 | 变更说明 |
|------|---------|
| `src/frameworks/db/schema.ts` | 新增 terminology_entries 表和 terminology_fts 虚拟表定义 |
| `src/usecases/memory/search-memory.ts` | 改造为路由层：新增 library 参数，按库分发检索 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 新增 search_terminology 和 add_terminology 工具；search_memory 新增 library 参数 |
| `src/main.ts` | 新增术语库相关依赖注入绑定 |
| `src/entities/memory/memory-entry.ts` | 删除 MemoryLayer 枚举、canTransitionMemoryLayer 函数 |

## 验收标准 [required]

### 多库架构

- [ ] `library-definition.ts` 定义了预定义库列表，包含 conversation 和 terminology
- [ ] `search_memory` 工具支持 `library` 参数，路由到各库的检索管道
- [ ] 传入 `library: "terminology"` 时只搜索术语库
- [ ] 不传 `library` 时搜索所有 `searchable=true` 的库，按排名位置归一化混排
- [ ] 三层模型代码已物理删除（MemoryLayer、canTransitionMemoryLayer、相关检索路径）

### 术语库存储与检索

- [ ] 术语可通过 `addTerm` 写入，`version` 初始为 1
- [ ] 术语可通过 `updateTerm` 更新，`version` 递增，乐观锁冲突时拒绝
- [ ] 术语可通过 `deprecateTerm` 标记为 deprecated
- [ ] deprecated 术语不出现在检索结果中
- [ ] 不提供硬删除（removeTerm），术语"不存在"用 deprecated 表达
- [ ] 精确匹配：输入完整术语名，直接返回对应条目
- [ ] 前缀匹配：输入术语名前缀，返回匹配条目
- [ ] 全文搜索：输入描述性文本（如"临时创建的小 otter"），通过 definition/context 反查术语
- [ ] 三种检索路径按优先级串联：精确 > 前缀 > 全文

### Agent 工具

- [ ] `search_terminology` 工具可被 agent 调用，返回术语定义
- [ ] `add_terminology` 工具可被 agent 调用，成功写入新术语
- [ ] `add_terminology` 仅在用户显式定义术语时由 agent 调用

### 种子数据

- [ ] 系统初始化时，F20260709x7k3 中的 8 个核心术语被导入术语库
- [ ] 种子数据仅在表为空时导入（幂等）

### 非回归

- [ ] memory_entries 表结构不变，对话库的检索引擎不受影响
- [ ] 已有的渐进式披露机制不受影响
- [ ] 已有的对话库检索（SearchEngine、RRF、权重衰减）不受影响

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-1 | 用户问"大獭是什么" | agent 调用 search_terminology，返回"大獭"的定义 | ← UA-3 |
| B-2 | 用户说"我们把这种重启机制叫'獭生重启'" | agent 调用 add_terminology，记录新术语 | ← UA-4 |
| B-3 | agent 不确定某词是否为术语 | agent 向用户询问确认，不自动记录 | 架构师补充 |
| B-4 | 术语定义发生变化 | 通过 updateTerm 更新，version 递增 | 架构师补充 |
| B-5 | 术语不再适用 | 通过 deprecateTerm 标记废弃，不硬删除 | 架构师补充 |
| B-6 | 系统首次初始化 | 8 个核心术语从种子数据导入 | 架构师补充 |
| B-7 | search_memory 指定 library="terminology" | 路由到术语库检索管道，返回术语结果 | ← UA-8 |
| B-8 | search_memory 不指定 library | 分别查各库，排名位置归一化混排返回 | ← UA-8 |
| B-9 | 工作记忆相关操作 | pi agent session 自行管理，otter 系统不干预 | ← UA-6 |

## 不兼容更新

| 项目 | 变更 | 迁移方式 |
|------|------|---------|
| MemoryLayer 枚举 | 物理删除 | 直接删除，引用处同步清理 |
| canTransitionMemoryLayer 函数 | 物理删除 | 直接删除，引用处同步清理 |
| working/historical/key_info 检索路径 | 物理删除 | 直接删除 |
| search_memory 接口 | 新增 library 可选参数 | 向后兼容（不传时行为不变） |

## 关联 [required]

| 类型 | ID/链接 | 说明 |
|------|---------|------|
| 前置 Feature | F20260713m5q3 | domain/memory 模块，本次重构的基础 |
| 前置 Feature | F20260709x7k3 | 产品形态定义，术语表种子数据来源 |
| 前置 Feature | F20260716szw8 | 渐进式披露召回机制，本次不修改 |
| 后续 Feature | 待定 | 特性文档库实现 |
| 后续 Feature | 待定 | 探索库实现 |
| Issue | 12c17da4-b4f8-4eed-855b-6c0476b0f883 | 本 Issue |
